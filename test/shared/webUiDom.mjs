// test/shared/webUiDom.mjs — the element tree the installer's web-UI tests run
// against, built from the SHIPPED installer/web/index.html.
//
// This is the point of the harness: an unmatched selector returns null and an
// unknown id is recorded, so a query that matches nothing in the tab fails a
// test instead of quietly returning a blank stub. (The previous version
// auto-created an element per selector, which let the fragment write its state
// to one stub while 40-install.js read it back from another, and a
// `:scope > .success-banner` that matched nothing still "passed".)
//
// Only the DOM surface the installer fragments actually touch is modelled, so a
// property the tab starts using shows up as a clear "not a function" rather
// than a plausible wrong answer.

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {parseHtml, serialize} from './webUiMarkup.mjs';
import {matchesSteps, parseSelector} from './webUiSelector.mjs';

const INDEX_HTML = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'installer',
  'web',
  'index.html'
);

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
export function createDom(recorders) {
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
        // A fresh object per access keeps the class ATTRIBUTE the single source
        // of truth (className writes it, setAttribute writes it), so the two
        // can never drift.  Nothing in the tab holds on to the list across a
        // mutation, and it costs a microsecond.
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
      // Re-keying an id must not leave the old one resolving: the tab assigns
      // ids after createElement (`badge-utils-<n>`), so a later overwrite has
      // to drop the stale entry or getElementById would answer for a node that
      // no longer carries that id.
      if (key === 'id') {
        const previous = attributes.get('id');
        if (previous && byId.get(previous) === el) byId.delete(previous);
        if (str) byId.set(str, el);
      }
      attributes.set(key, str);
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
      const key = String(name).toLowerCase();
      if (key === 'id') {
        const previous = attributes.get('id');
        if (previous && byId.get(previous) === el) byId.delete(previous);
      }
      attributes.delete(key);
    };

    // Detach a subtree the way the real DOM does: every descendant leaves the
    // id index and every node's parentNode is cleared.  Without this, replacing
    // a node's contents left the old nodes registered — getElementById would
    // answer for nodes no longer in the document, and `contains` would still
    // report the orphan as a descendant because it kept pointing at its old
    // parent.  Both matter here: setUtilsStatus() re-renders its checkbox
    // through innerHTML on every status refresh, so a stale chk-utils-<n>
    // would otherwise shadow the live one that startGroupInstall reads.
    const detach = node => {
      if (node.nodeType === 1) {
        for (const child of node.childNodes.slice()) detach(child);
        const id = node.getAttribute('id');
        if (id && byId.get(id) === node) byId.delete(id);
      }
      node.parentNode = null;
    };
    // Symmetric half: a subtree that MOVES must re-register its whole set of
    // ids, not just its root's.  appendChild detaches from the old parent
    // first, and detaching clears descendants too — so registering only the
    // top node silently dropped every nested id (a parsed <b id><i id></b>
    // lost the inner one on the way out of the parse buffer).
    const registerSubtree = node => {
      if (node.nodeType === 1) {
        for (const child of node.childNodes) registerSubtree(child);
        const id = node.getAttribute('id');
        if (id) byId.set(id, node);
      }
    };
    const detachAll = () => {
      for (const child of childNodes.slice()) detach(child);
      childNodes.length = 0;
    };

    Object.defineProperty(el, 'innerHTML', {
      get: () => childNodes.map(serialize).join(''),
      set(value) {
        detachAll();
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
        detachAll();
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
      registerSubtree(child);
      return child;
    };
    el.insertBefore = function (child, ref) {
      if (!ref) return el.appendChild(child);
      if (child.parentNode) child.parentNode.removeChild(child);
      const index = childNodes.indexOf(ref);
      if (index === -1) childNodes.push(child);
      else childNodes.splice(index, 0, child);
      child.parentNode = el;
      registerSubtree(child);
      return child;
    };
    el.removeChild = function (child) {
      const index = childNodes.indexOf(child);
      if (index !== -1) childNodes.splice(index, 1);
      // A real removal takes the whole subtree out of the document, so its ids
      // stop resolving too — see detach() above.
      detach(child);
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
