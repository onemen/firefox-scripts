// test/shared/webUiSandbox.mjs — node:vm harness for the installer's web UI
// (installer/web/script/*.js).
//
// The tab ships as ONE concatenated IIFE (installer/src/script.built.js, built
// by embed.mjs — see test/unit/installer/concatGate.test.mjs): the fragments are
// IIFE bodies, so none of them is individually parseable or importable, and
// every helper they call (qs, fetchJSON, renderBrowsers, …) shares one closure.
// A test that wants to drive real tab code therefore has to evaluate the
// fragments inside a context it controls.
//
// This module is that context, shared so each suite does not grow its own
// slightly different DOM stub.  It provides:
//
//   * a DOM built from the SHIPPED markup (installer/web/index.html): real
//     element tree, classes, data-* attributes and parent/child structure, so
//     what the fragments query is what the user gets.  A selector that resolves
//     in a test resolves in the tab, and one that does not fails the test
//     instead of silently returning a fresh blank stub;
//   * a tolerant HTML parser for `innerHTML` assignments, because the render
//     path injects markup as strings (badges, the progress bar, folder
//     buttons) rather than building elements;
//   * a route registry for `fetch` — a URL maps to a handler returning a
//     Response-like object; unstubbed URLs resolve 404 (what production code
//     already handles gracefully) and are recorded in `unstubbed`;
//   * recording of the effects a test wants to assert on: window.open, anchor
//     clicks (blob downloads), object-URL create/revoke, every fetch, and every
//     id the tab looked up but the markup does not contain;
//   * `settle()` — the tab's promise chains cross realms, so a bare `await` on
//     the fragment's own promise can return before its continuations run;
//   * `fireDOMContentLoaded()` — 50-init.js starts the whole UI from a
//     DOMContentLoaded listener.
//
// It is deliberately NOT a browser: only the DOM surface the fragments actually
// touch is modelled, so the harness stays small enough to be obviously correct.
// A selector or property the tab starts using and the harness lacks shows up as
// a clear "not a function" rather than a plausible wrong answer.
//
// Nothing here needs a compiler or a built binary (this is `pnpm test` scope;
// installer/test/ is the binary-in-the-loop half — see installer/test/README.md).

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT_DIR = path.join(REPO_ROOT, 'installer', 'web', 'script');
const INDEX_HTML = path.join(REPO_ROOT, 'installer', 'web', 'index.html');

/**
 * The web UI fragments, in ship order. 00-head.js opens the IIFE and 50-init.js
 * closes it; {@link loadWebUi} strips both wrapper lines.
 */
export const WEB_UI_FRAGMENTS = [
  '00-head.js',
  '10-ingest.js',
  '20-banners.js',
  '30-render.js',
  '40-install.js',
  '50-init.js',
];

/** A Response-like object whose body is JSON (`r.json()`). */
export function jsonResponse(body) {
  return {ok: true, status: 200, json: () => Promise.resolve(body)};
}

/** A Response-like object whose body is raw bytes (`r.arrayBuffer()`). */
export function rawResponse(text) {
  return {
    ok: true,
    status: 200,
    arrayBuffer: () => Promise.resolve(new TextEncoder().encode(text).buffer),
  };
}

function notFound() {
  const err = () => new Error('404');
  return {
    ok: false,
    status: 404,
    json: () => Promise.reject(err()),
    arrayBuffer: () => Promise.reject(err()),
  };
}

/* ========================================================================
 * Attribute + selector handling — the subset the fragments use
 * ======================================================================== */ const NAME_CHAR =
  /[-a-zA-Z0-9_:.]/;
const WS = /\s/;

/**
 * Parse an HTML attribute string into a Map (lowercased names). Hand-rolled
 * rather than regex-driven: an attribute pattern needs alternation inside an
 * optional group, which is exactly the shape eslint's security plugin (rightly)
 * refuses as a potential ReDoS.
 */
function parseAttrs(source) {
  const attrs = new Map();
  if (!source) return attrs;
  let i = 0;
  const n = source.length;
  while (i < n) {
    while (i < n && (WS.test(source[i]) || source[i] === '/')) i++;
    const nameStart = i;
    while (i < n && NAME_CHAR.test(source[i])) i++;
    if (i === nameStart) {
      i++;
      continue;
    }
    const name = source.slice(nameStart, i).toLowerCase();
    while (i < n && WS.test(source[i])) i++;
    if (source[i] !== '=') {
      attrs.set(name, '');
      continue;
    }
    i++;
    while (i < n && WS.test(source[i])) i++;
    const quote = source[i];
    if (quote === '"' || quote === "'") {
      const end = source.indexOf(quote, i + 1);
      attrs.set(name, decodeEntities(source.slice(i + 1, end === -1 ? n : end)));
      i = end === -1 ? n : end + 1;
    } else {
      const start = i;
      while (i < n && source[i] !== '>' && !WS.test(source[i])) i++;
      attrs.set(name, decodeEntities(source.slice(start, i)));
    }
  }
  return attrs;
}

const ENTITIES = {
  'amp': '&',
  'lt': '<',
  'gt': '>',
  'quot': '"',
  '#39': "'",
  'apos': "'",
  'nbsp': ' ',
};

/**
 * Minimal entity decode — enough for the em-dashes and ampersands the tab
 * emits.
 */
function decodeEntities(s) {
  return String(s).replace(/&(#\d+|#x[0-9a-fA-F]+|\w+);/g, (whole, name) => {
    if (Object.prototype.hasOwnProperty.call(ENTITIES, name)) return ENTITIES[name];
    if (name[0] === '#') {
      const code = name[1] === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return whole;
  });
}

/**
 * Split `sel` into `{tokens, scoped}`: `tokens` is `[{compound, combinator}]`
 * where `combinator` is how that step is reached from the previous one (' ' or
 * '>'; `null` for the first). A leading `:scope` is reported through `scoped`
 * rather than kept as a compound, and a leading `>` lands on the first token so
 * `:scope > .success-banner` can be anchored on the query's own element.
 */
function parseSelector(sel) {
  let s = String(sel).trim();
  let scoped = false;
  if (/^:scope\b/.test(s)) {
    scoped = true;
    s = s.replace(/^:scope\b/, '').trim();
  }
  const tokens = [];
  let pending = null;
  while (s.length) {
    let m;
    if ((m = /^\s*>\s*/.exec(s))) {
      pending = '>';
      s = s.slice(m[0].length);
    } else if ((m = /^\s+/.exec(s))) {
      pending = pending || ' ';
      s = s.slice(m[0].length);
    } else if ((m = /^[^\s>]+/.exec(s))) {
      tokens.push({compound: m[0], combinator: pending || (tokens.length ? ' ' : null)});
      pending = null;
      s = s.slice(m[0].length);
    } else {
      s = s.slice(1);
    }
  }
  return {tokens, scoped};
} /**
 * Split a compound selector (`.a.b[attr="v"]#id span`) into its parts. Also
 * hand-rolled: attribute selectors need an optional quoted value inside a
 * bracket group, the same shape the security plugin rejects as ReDoS-prone.
 */
function parseCompound(compound) {
  const parts = {tag: null, classes: [], id: null, attrs: []};
  let i = 0;
  while (i < compound.length) {
    const ch = compound[i];
    if (ch === '*') {
      i++;
    } else if (ch === '.' || ch === '#') {
      let j = i + 1;
      while (j < compound.length && /[-\w]/.test(compound[j])) j++;
      if (ch === '.') parts.classes.push(compound.slice(i + 1, j));
      else parts.id = compound.slice(i + 1, j);
      i = j;
    } else if (ch === '[') {
      const close = compound.indexOf(']', i);
      const body = compound.slice(i + 1, close === -1 ? compound.length : close);
      const eq = body.indexOf('=');
      if (eq === -1) {
        parts.attrs.push({name: body.trim(), value: null});
      } else {
        const lhs = body.slice(0, eq).trim();
        let value = body.slice(eq + 1).trim();
        const first = value[0];
        if ((first === '"' || first === "'") && value.endsWith(first)) value = value.slice(1, -1);
        parts.attrs.push({name: lhs.replace(/[~|^$*]$/, ''), value});
      }
      i = close === -1 ? compound.length : close + 1;
    } else {
      let j = i;
      while (j < compound.length && /[a-zA-Z0-9-]/.test(compound[j])) j++;
      if (j === i) {
        i++;
        continue;
      }
      parts.tag = compound.slice(i, j);
      i = j;
    }
  }
  return parts;
}

/** Match one compound selector against an element. */
function matchesCompound(el, compound) {
  if (!el || el.nodeType !== 1) return false;
  const parts = typeof compound === 'string' ? parseCompound(compound) : compound;
  if (parts.tag && el.tagName !== parts.tag.toUpperCase()) return false;
  if (parts.id !== null && el.getAttribute('id') !== parts.id) return false;
  for (const cls of parts.classes) {
    if (!el.classList.contains(cls)) return false;
  }
  for (const attr of parts.attrs) {
    const actual = el.getAttribute(attr.name);
    if (actual === null) return false;
    if (attr.value !== null && actual !== attr.value) return false;
  }
  return true;
}

/** Match a parsed selector chain against `el`, walking right to left. */
function matchesSteps(el, steps) {
  if (!steps || !steps.length || !el || el.nodeType !== 1) return false;
  if (!matchesCompound(el, steps[steps.length - 1].compound)) return false;
  let node = el;
  for (let i = steps.length - 1; i > 0; i--) {
    const combinator = steps[i].combinator;
    const compound = steps[i - 1].compound;
    let parent = node.parentNode;
    if (combinator === '>') {
      if (!parent || !matchesCompound(parent, compound)) return false;
      node = parent;
    } else {
      while (parent && !matchesCompound(parent, compound)) parent = parent.parentNode;
      if (!parent) return false;
      node = parent;
    }
  }
  return true;
}

/* ========================================================================
 * Tolerant HTML parser — for `innerHTML = '…'`, which is how the render path
 * injects badges, the progress bar and the open-folder buttons.
 * ======================================================================== */

const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
  // SVG children the icons use — self-closed in the tab's icon constants.
  'path',
  'polyline',
  'circle',
  'line',
  'rect',
]);

/**
 * Split markup into `{type: 'text'|'open'|'close'}` tokens. Hand-rolled for the
 * same reason as parseAttrs: tag scanning needs quote-aware alternation inside
 * a repeated group, which the security plugin flags as ReDoS-prone. Quote-aware
 * means an attribute value may legally contain '>'.
 */
function tokenizeMarkup(html) {
  const tokens = [];
  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      tokens.push({type: 'text', value: html.slice(i)});
      break;
    }
    if (lt > i) tokens.push({type: 'text', value: html.slice(i, lt)});
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (html[lt + 1] === '!' || html[lt + 1] === '?') {
      const end = html.indexOf('>', lt);
      i = end === -1 ? n : end + 1;
      continue;
    }
    let j = lt + 1;
    let quote = null;
    while (j < n) {
      const ch = html[j];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        break;
      }
      j++;
    }
    const inner = html.slice(lt + 1, j);
    i = j + 1;
    if (inner[0] === '/') {
      tokens.push({type: 'close', name: inner.slice(1).trim()});
      continue;
    }
    const open = /^([a-zA-Z][a-zA-Z0-9:_-]*)/.exec(inner);
    if (!open) continue;
    tokens.push({type: 'open', name: open[1], attrs: inner.slice(open[1].length)});
  }
  return tokens;
}

/**
 * Parse `html` into element stubs under a detached root. Whitespace-only text
 * between tags is dropped so `text()` reads like the rendered UI rather than
 * like the source indentation.
 */
function parseHtml(html, factory) {
  const root = factory('div');
  const stack = [root];
  const top = () => stack[stack.length - 1];
  for (const token of tokenizeMarkup(String(html))) {
    if (token.type === 'text') {
      if (token.value.trim()) top().appendChild(factory('#text', decodeEntities(token.value)));
      continue;
    }
    if (token.type === 'close') {
      // Pop to the matching open tag, tolerating unclosed children.
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tagName === token.name.toUpperCase()) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const selfClosing = /\/\s*$/.test(token.attrs) || VOID_TAGS.has(token.name.toLowerCase());
    const el = factory(token.name, parseAttrs(token.attrs));
    top().appendChild(el);
    if (!selfClosing) stack.push(el);
  }
  return root;
}

/** Serialize an element tree back to HTML (assertions and debugging). */
function serialize(node) {
  if (node.nodeType === 3) return node.data;
  const attrs = [];
  for (const [name, value] of node.attributes) {
    attrs.push(value === '' ? ` ${name}` : ` ${name}="${value}"`);
  }
  const inner = node.childNodes.map(serialize).join('');
  if (VOID_TAGS.has(node.tagName.toLowerCase()))
    return `<${node.tagName.toLowerCase()}${attrs.join('')}>`;
  return `<${node.tagName.toLowerCase()}${attrs.join('')}>${inner}</${node.tagName.toLowerCase()}>`;
}

/* ========================================================================
 * The DOM
 * ======================================================================== */

/**
 * Build the document: the shipped markup, plus a factory for new nodes.
 *
 * @param {{downloads: Array}} recorders shared with loadWebUi, so a click on an
 *   anchor created by the tab itself is recorded the same way as one on a
 *   seeded element.
 */
function createDom(recorders) {
  const byId = new Map();
  const missingIds = [];

  function makeStyle() {
    const style = {};
    Object.defineProperty(style, 'cssText', {
      get() {
        return Object.keys(style)
          .filter(k => k !== 'cssText')
          .map(k => `${k}:${style[k]}`)
          .join(';');
      },
      set(value) {
        for (const key of Object.keys(style)) {
          if (key !== 'cssText') delete style[key];
        }
        String(value || '')
          .split(';')
          .forEach(decl => {
            const idx = decl.indexOf(':');
            if (idx === -1) return;
            const prop = decl.slice(0, idx).trim();
            if (prop) style[prop] = decl.slice(idx + 1).trim();
          });
      },
      enumerable: false,
    });
    return style;
  }

  function makeClassList(el) {
    const read = () => (el.getAttribute('class') || '').split(/\s+/).filter(Boolean);
    const write = list => el.setAttribute('class', list.join(' '));
    return {
      contains: name => read().includes(name),
      add(...names) {
        const list = read();
        for (const name of names) if (!list.includes(name)) list.push(name);
        write(list);
      },
      remove(...names) {
        write(read().filter(n => !names.includes(n)));
      },
      toggle(name, force) {
        const has = read().includes(name);
        const on = force === undefined ? !has : Boolean(force);
        if (on) this.add(name);
        else this.remove(name);
        return on;
      },
      get length() {
        return read().length;
      },
      toString() {
        return el.getAttribute('class') || '';
      },
    };
  }

  function createElement(tagName, attrs) {
    const attributes = new Map();
    const handlers = new Map();
    const childNodes = [];
    const style = makeStyle();
    let downloadSet = false;

    const el = {
      nodeType: 1,
      tagName: String(tagName || 'div').toUpperCase(),
      attributes,
      style,
      childNodes,
      parentNode: null,
      childElementCount: 0,
      onclick: null,
      onchange: null,
      checked: false,
      disabled: false,
      get children() {
        return childNodes.filter(n => n.nodeType === 1);
      },
      get firstChild() {
        return childNodes[0] || null;
      },
      get lastChild() {
        return childNodes[childNodes.length - 1] || null;
      },
      get classList() {
        return makeClassList(el);
      },
      dataset: new Proxy(
        {},
        {
          get: (_t, key) =>
            el.getAttribute('data-' + String(key).replace(/[A-Z]/g, c => '-' + c.toLowerCase())),
          set: (_t, key, value) => {
            el.setAttribute(
              'data-' + String(key).replace(/[A-Z]/g, c => '-' + c.toLowerCase()),
              value
            );
            return true;
          },
          has: (_t, key) =>
            el.getAttribute('data-' + String(key).replace(/[A-Z]/g, c => '-' + c.toLowerCase())) !==
            null,
          ownKeys: () =>
            [...attributes.keys()]
              .filter(n => n.startsWith('data-'))
              .map(n => n.slice(5).replace(/-([a-z])/g, (_w, c) => c.toUpperCase())),
          getOwnPropertyDescriptor: () => ({enumerable: true, configurable: true}),
        }
      ),
    };

    // `id`, `className`, `hidden`, `title` and `href` are attributes in a real
    // DOM, and the tab both reads them as properties and back them with
    // getAttribute/removeAttribute (wireDownloadLink's dead-link guard, the
    // Restart button's tooltip). Reflect both directions.
    const reflect = (prop, attr) =>
      Object.defineProperty(el, prop, {
        get: () => el.getAttribute(attr),
        set(value) {
          el.setAttribute(attr, value);
        },
        enumerable: true,
        configurable: true,
      });

    reflect('id', 'id');
    reflect('className', 'class');
    reflect('title', 'title');
    reflect('href', 'href');
    Object.defineProperty(el, 'hidden', {
      get: () => attributes.has('hidden'),
      set(value) {
        if (value) attributes.set('hidden', 'hidden');
        else attributes.delete('hidden');
      },
      enumerable: true,
      configurable: true,
    });
    Object.defineProperty(el, 'download', {
      get: () => el.getAttribute('download'),
      set(value) {
        // Presence is what distinguishes a download click from any other.
        downloadSet = true;
        el.setAttribute('download', value);
      },
      enumerable: true,
      configurable: true,
    });

    el.setAttribute = function (name, value) {
      const key = String(name).toLowerCase();
      const str = value === true ? '' : String(value);
      attributes.set(key, str);
      if (key === 'id') {
        if (str) byId.set(str, el);
        else byId.delete('');
      }
      if (key === 'style') style.cssText = str;
      if (key === 'disabled') el.disabled = true;
      if (key === 'checked') el.checked = true;
    };
    el.getAttribute = function (name) {
      const key = String(name).toLowerCase();
      return attributes.has(key) ? attributes.get(key) : null;
    };
    el.hasAttribute = function (name) {
      return attributes.has(String(name).toLowerCase());
    };
    el.removeAttribute = function (name) {
      attributes.delete(String(name).toLowerCase());
    };

    Object.defineProperty(el, 'innerHTML', {
      get: () => childNodes.map(serialize).join(''),
      set(value) {
        childNodes.length = 0;
        const parsed = parseHtml(String(value), factory);
        for (const child of parsed.childNodes.slice()) el.appendChild(child);
      },
      enumerable: true,
      configurable: true,
    });
    Object.defineProperty(el, 'textContent', {
      get: () => {
        let out = '';
        for (const node of childNodes) {
          out += node.nodeType === 3 ? node.data : node.textContent;
        }
        return out;
      },
      set(value) {
        childNodes.length = 0;
        if (value !== '' && value !== null && value !== undefined) {
          el.appendChild(factory('#text', String(value)));
        }
      },
      enumerable: true,
      configurable: true,
    });

    el.appendChild = function (child) {
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = el;
      childNodes.push(child);
      if (child.id) byId.set(child.id, child);
      return child;
    };
    el.insertBefore = function (child, ref) {
      if (!ref) return el.appendChild(child);
      if (child.parentNode) child.parentNode.removeChild(child);
      const index = childNodes.indexOf(ref);
      if (index === -1) childNodes.push(child);
      else childNodes.splice(index, 0, child);
      child.parentNode = el;
      if (child.id) byId.set(child.id, child);
      return child;
    };
    el.removeChild = function (child) {
      const index = childNodes.indexOf(child);
      if (index !== -1) childNodes.splice(index, 1);
      child.parentNode = null;
      return child;
    };
    el.remove = function () {
      if (el.parentNode) el.parentNode.removeChild(el);
    };
    el.contains = function (node) {
      for (let n = node; n; n = n.parentNode) if (n === el) return true;
      return false;
    };
    el.matches = function (selector) {
      return matchesSteps(el, parseSelector(selector).tokens);
    };

    el.querySelectorAll = function (selector) {
      const {tokens} = parseSelector(selector);
      if (!tokens.length) return [];
      const out = [];
      // A leading '>' anchors the search on this element: `:scope > x` must
      // match a DIRECT child.  The tab uses it for the success banner
      // (40-install.js:449), which is a sibling of the cards, never nested.
      // matchesSteps never reads the first step's combinator, so dropping it
      // turns the chain into one relative to each child.
      if (tokens[0].combinator === '>') {
        const relative = tokens.map((step, i) => (i === 0 ? {...step, combinator: null} : step));
        for (const child of el.children) {
          if (matchesSteps(child, relative)) out.push(child);
        }
        return out;
      }
      const walk = node => {
        for (const child of node.childNodes) {
          if (child.nodeType !== 1) continue;
          if (matchesSteps(child, tokens)) out.push(child);
          walk(child);
        }
      };
      walk(el);
      return out;
    };
    el.querySelector = function (selector) {
      return el.querySelectorAll(selector)[0] || null;
    };
    el.closest = function (selector) {
      const {tokens} = parseSelector(selector);
      for (let node = el; node; node = node.parentNode) {
        if (node.nodeType === 1 && matchesSteps(node, tokens)) return node;
      }
      return null;
    };

    el.addEventListener = function (type, fn) {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type).push(fn);
    };
    el.removeEventListener = function (type, fn) {
      const list = handlers.get(type) || [];
      const index = list.indexOf(fn);
      if (index !== -1) list.splice(index, 1);
    };
    /** Fire this element's own listeners; delegated ones live on `document`. */
    el.dispatch = function (type, event = {}) {
      for (const fn of (handlers.get(type) || []).slice()) fn(event);
      const inline = el['on' + type];
      if (typeof inline === 'function') inline.call(el, event);
    };
    el.click = function () {
      // Two call sites set `download` on a detached anchor and click it:
      // downloadPackage() (blob URL + explicit save-name) and the self-update
      // banner (asset URL, empty save-name).  Presence is what distinguishes
      // them; the value tells them apart.
      if (downloadSet) {
        recorders.downloads.push({
          href: el.getAttribute('href'),
          download: el.getAttribute('download'),
        });
      }
      el.dispatch('click', {preventDefault() {}, target: el});
    };

    for (const [name, value] of attrs || []) {
      attributes.set(name, value);
      if (name === 'id' && value) byId.set(value, el);
      if (name === 'style') style.cssText = value;
      if (name === 'disabled') el.disabled = true;
      if (name === 'checked') el.checked = true;
    }
    // Element stubs are cyclic (parentNode/children) and carry a dataset
    // Proxy; a bare `assert.equal(el, null)` that FAILS would otherwise try to
    // serialize the whole tree and exhaust memory instead of printing a
    // mismatch.  A short tag summary keeps failure output readable.
    Object.defineProperty(el, Symbol.for('nodejs.util.inspect.custom'), {
      value: () =>
        '<' +
        el.tagName.toLowerCase() +
        (el.id ? '#' + el.id : '') +
        (el.getAttribute('class') ?
          '.' + el.getAttribute('class').trim().split(/\s+/).join('.')
        : '') +
        '>',
      enumerable: false,
    });
    return el;
  }

  function factory(tagName, attrs) {
    return tagName === '#text' ? makeText(attrs) : createElement(tagName, attrs);
  }

  function makeText(data = '') {
    return {
      nodeType: 3,
      data: String(data),
      parentNode: null,
      get textContent() {
        return this.data;
      },
      set textContent(value) {
        this.data = String(value);
      },
      get innerHTML() {
        return this.data;
      },
    };
  }

  // Parse the shipped markup into a fresh tree per document: the tab mutates
  // its DOM freely, so every load has to start from the real thing rather than
  // a copy shared between tests.  index.html is ~9 KB and parsing it costs
  // well under a millisecond, so reading it here beats caching complexity.
  const root = parseHtml(fs.readFileSync(INDEX_HTML, 'utf8'), factory);
  const documentElement = root.children.find(el => el.tagName === 'HTML') || root;
  const body = documentElement.querySelector('body') || documentElement;
  if (body && !body.parentNode) documentElement.appendChild(body);

  const documentListeners = new Map();
  const document = {
    documentElement,
    body,
    getElementById(id) {
      const el = byId.get(id);
      if (!el) missingIds.push(id);
      return el || null;
    },
    querySelector(selector) {
      return documentElement.querySelector(selector);
    },
    querySelectorAll(selector) {
      return documentElement.querySelectorAll(selector);
    },
    createElement(tagName) {
      return createElement(tagName);
    },
    createTextNode(data) {
      return makeText(data);
    },
    addEventListener(type, fn) {
      if (!documentListeners.has(type)) documentListeners.set(type, []);
      documentListeners.get(type).push(fn);
    },
    removeEventListener() {},
    setAttribute(name, value) {
      body.setAttribute(name, value);
    },
    getAttribute(name) {
      return body.getAttribute(name);
    },
  };

  return {
    document,
    body,
    byId,
    missingIds,
    factory,
    /** Fire a document-level listener (the tab's delegated click handler). */
    dispatchDocument(type, event = {}) {
      for (const fn of (documentListeners.get(type) || []).slice()) fn(event);
    },
    documentListeners,
  };
}

/* ========================================================================
 * loadWebUi
 * ======================================================================== */

/**
 * Load the web UI fragments into a vm context with the shipped DOM, stub
 * window/fetch.
 *
 * @param {object} [options]
 * @param {Record<string, Function>} [options.routes] url → handler(init) →
 *   Response-like
 * @param {string[]} [options.fragments] fragment file names, in ship order
 * @param {string} [options.search] `window.location.search` (default '' — no
 *   session token)
 * @param {string} [options.host] `location.host` (default the installer's fixed
 *   port)
 * @returns {object} the harness: `ctx` (fragment functions), `document`,
 *   `element()`, `find()`, `text()`, `html()`, `settle()`, `opened`, …
 */
export function loadWebUi(options = {}) {
  const fragments = options.fragments || WEB_UI_FRAGMENTS;
  const routes = new Map(Object.entries(options.routes || {}));
  const fetches = [];
  const unstubbed = [];
  const opened = [];
  const downloads = [];
  const objectUrls = [];
  const intervals = [];

  const dom = createDom({downloads});
  const {document, body, missingIds, factory} = dom;

  let objectUrlSeq = 0;
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    // The tab starts a 3s heartbeat; scheduling it would keep the test process
    // alive, so intervals are recorded and never run.
    setInterval(fn, ms) {
      intervals.push({fn, ms});
      return intervals.length;
    },
    clearInterval() {},
    AbortController,
    Blob,
    URL: {
      createObjectURL() {
        const url = `blob:stub-${++objectUrlSeq}`;
        objectUrls.push(url);
        return url;
      },
      revokeObjectURL(url) {
        objectUrls.push(`revoked ${url}`);
      },
    },
    document,
    location: {host: options.host || '127.0.0.1:8777', href: 'http://127.0.0.1:8777/'},
    fetch(url, init) {
      const key = String(url);
      fetches.push({url: key, method: (init && init.method) || 'GET'});
      const handler = routes.get(key);
      if (!handler) {
        unstubbed.push(key);
        return Promise.resolve(notFound());
      }
      return Promise.resolve(handler(init && init.method));
    },
  };
  sandbox.window = {
    location: {search: options.search || '', href: sandbox.location.href},
    open(url, target, features) {
      opened.push({url, target, features});
      return null;
    },
    close() {},
    addEventListener() {},
    removeEventListener() {},
  };
  sandbox.window.window = sandbox.window;
  sandbox.globalThis = sandbox;

  const ctx = vm.createContext(sandbox);
  const source =
    fragments.map(f => fs.readFileSync(path.join(SCRIPT_DIR, f), 'utf8')).join('\n') + '\n';
  // Drop the IIFE wrapper: evaluated as a plain script, top-level function
  // declarations become properties of the context, so a test can call
  // checkSelfUpdate() / renderBrowsers() directly.  00-head.js opens the IIFE
  // after its banner comment, and 50-init.js closes it, so both ends are cut
  // positionally rather than by an anchored pattern.
  const OPEN = '(function () {';
  const open = source.indexOf(OPEN);
  if (open === -1) throw new Error('webUiSandbox: no IIFE wrapper found in the fragments');
  const unwrapped = source.slice(open + OPEN.length).replace(/\}\)\(\);\s*$/, '');
  vm.runInContext(unwrapped, ctx, {filename: 'web-ui-fragments.js'});

  /** Let every pending cross-realm promise continuation run. */
  async function settle() {
    for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
  }

  /** Whitespace-collapsed visible text, the way a reader sees the card. */
  const text = node => (node ? node.textContent : '').replace(/\s+/g, ' ').trim();

  return {
    ctx,
    settle,
    fetches,
    unstubbed,
    opened,
    downloads,
    objectUrls,
    intervals,
    document,
    body,
    /**
     * Ids the tab asked for that the shipped markup does not contain. Should
     * always be empty: a non-empty list means the markup and the fragments have
     * drifted apart (the element is null in production, so any `if (!el)` guard
     * in the tab really does fire).
     */
    missingIds,
    /**
     * Fetch handlers can be added or replaced after load (init fetches in
     * stages).
     */
    route(url, handler) {
      routes.set(url, handler);
    },
    routeJSON(url, body2) {
      routes.set(url, () => jsonResponse(body2));
    },
    routeRaw(url, textBody) {
      routes.set(url, () => rawResponse(textBody));
    },
    /** Look an element up by id, or null when the markup has no such element. */
    element(id) {
      return dom.byId.get(id) || null;
    },
    /** Whether the id exists in the document (shipped markup or created). */
    has(id) {
      return dom.byId.has(id);
    },
    /** First match for a CSS selector anywhere in the document. */
    find(selector) {
      return document.querySelector(selector);
    },
    /** All matches for a CSS selector anywhere in the document. */
    findAll(selector) {
      return document.querySelectorAll(selector);
    },
    text,
    /** Serialized markup of a node (for asserting on injected HTML). */
    html(node) {
      return node ? node.innerHTML : '';
    },
    /** Start the UI exactly as the real tab does. */
    fireDOMContentLoaded() {
      dom.dispatchDocument('DOMContentLoaded', {});
    },
    /** Fire a delegated document listener (the tab's open-folder handler). */
    fireDocument(type, event) {
      dom.dispatchDocument(type, event);
    },
    /** Build an element without inserting it (for event-target stand-ins). */
    createElement: factory,
  };
}
