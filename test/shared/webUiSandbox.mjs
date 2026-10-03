// test/shared/webUiSandbox.mjs — node:vm harness for the installer's web UI
// (installer/web/script/*.js).
//
// The tab ships as ONE concatenated IIFE (installer/src/script.built.js, built
// by installer/embed.mjs — see test/unit/installer/concatGate.test.mjs): the
// fragments are IIFE bodies, so none of them is individually parseable or
// importable, and every helper they call (qs, fetchJSON, fetchRaw, postRaw,
// showDebug, …) shares one closure.  A test that wants to drive real tab code
// therefore has to evaluate the fragments inside a context it controls.
//
// This module is that context, shared so each suite does not grow its own
// slightly different DOM stub.  It provides:
//
//   * a permissive element stub — getElementById/querySelector auto-create and
//     cache, so `if (!el) return;` guards and `qs(...).style.display = …`
//     assignments both behave, and every write a test wants to assert on is
//     observable afterwards;
//   * a route registry for `fetch` — a URL maps to a handler returning a
//     Response-like object; unstubbed URLs resolve 404 (what production code
//     already handles gracefully) and are recorded in `unstubbed` so a test can
//     assert nothing important was missed;
//   * recording of the effects a test wants to assert on: window.open, anchor
//     clicks (blob downloads), object-URL create/revoke, and every fetch;
//   * `settle()` — the tab's promise chains cross realms, so a bare `await` on
//     the fragment's own promise can return before its continuations run;
//   * `fireDOMContentLoaded()` — 50-init.js starts the whole UI from a
//     DOMContentLoaded listener, which is how the manual-download links and the
//     test/dev build banner get wired in the real tab.
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

/**
 * Load the web UI fragments into a vm context with stub DOM/window/fetch.
 *
 * @param {object} [options]
 * @param {Record<string, Function>} [options.routes] url → handler(init) →
 *   Response-like
 * @param {string[]} [options.fragments] fragment file names, in ship order
 * @param {string} [options.search] `window.location.search` (default '' — no
 *   session token)
 * @param {string} [options.host] `location.host` (default the installer's fixed
 *   port)
 * @returns {object} the harness: `ctx` (fragment functions), `dom`, `fetch`,
 *   `opened`, `downloads`, `settle()`, `fireDOMContentLoaded()`, …
 */
export function loadWebUi(options = {}) {
  const fragments = options.fragments || WEB_UI_FRAGMENTS;
  const routes = new Map(Object.entries(options.routes || {}));
  const byId = new Map();
  const bySelector = new Map();
  const listeners = [];
  const fetches = [];
  const unstubbed = [];
  const opened = [];
  const downloads = [];
  const objectUrls = [];
  const intervals = [];

  function makeElement(id) {
    const attrs = new Map();
    const handlers = new Map();
    const el = {
      id: id || '',
      tagName: 'DIV',
      style: {},
      className: '',
      // index.html ships the banner elements with `hidden`; defaulting to true
      // means "never revealed" is distinguishable from "revealed".
      hidden: true,
      disabled: false,
      onclick: null,
      textContent: '',
      innerHTML: '',
      children: [],
      parentNode: null,
      dataset: {},
      classList: {
        add() {},
        remove() {},
        toggle() {},
        contains() {
          return false;
        },
      },
      setAttribute(name, value) {
        attrs.set(name, String(value));
      },
      getAttribute(name) {
        return attrs.has(name) ? attrs.get(name) : null;
      },
      removeAttribute(name) {
        attrs.delete(name);
      },
      appendChild(child) {
        el.children.push(child);
        child.parentNode = el;
        return child;
      },
      insertBefore(child) {
        el.children.unshift(child);
        child.parentNode = el;
        return child;
      },
      removeChild(child) {
        el.children = el.children.filter(c => c !== child);
        child.parentNode = null;
        return child;
      },
      contains() {
        return true;
      },
      addEventListener(type, fn) {
        if (!handlers.has(type)) handlers.set(type, []);
        handlers.get(type).push(fn);
      },
      removeEventListener() {},
      /**
       * Fire this element's own listeners (the delegated ones live on
       * `document`).
       */
      dispatch(type, event = {}) {
        for (const fn of handlers.get(type) || []) fn(event);
      },
      querySelector() {
        return undefined;
      },
      querySelectorAll() {
        return [];
      },
      closest() {
        return null;
      },
      // In a real DOM `link.href = url` reflects into the href ATTRIBUTE, and
      // the tab reads it back with getAttribute (wireDownloadLink's dead-link
      // guard).  Mirror both directions so that guard is exercised for real.
      _href: undefined,
      click() {
        // Two call sites set `download` on a detached anchor and click it:
        // downloadPackage() (blob URL + explicit save-name) and the
        // self-update banner (asset URL, empty save-name).  Recording on the
        // property's presence captures both, and the value tells them apart.
        if ('download' in el) downloads.push({href: el.href, download: el.download});
        el.dispatch('click', {preventDefault() {}, target: el});
      },
    };
    Object.defineProperty(el, 'href', {
      get() {
        return el._href;
      },
      set(value) {
        el._href = String(value);
        attrs.set('href', String(value));
      },
    });
    return el;
  }

  const body = makeElement('body');
  /** Auto-created nodes are attached to <body>: init does `list.parentNode.…`. */
  const attach = el => {
    el.parentNode = body;
    return el;
  };

  // Seed the ids index.html ships, honouring each element's `hidden`
  // attribute: an element that starts hidden in the markup must still read as
  // hidden when the tab does nothing, so a test can assert the user-visible
  // outcome ("the banner stays hidden") instead of an artefact of which
  // getElementById calls happened.
  for (const tag of fs
    .readFileSync(path.join(REPO_ROOT, 'installer', 'web', 'index.html'), 'utf8')
    .match(/<[a-zA-Z][^>]*>/g) || []) {
    const id = /\bid="([^"]+)"/.exec(tag);
    if (!id) continue;
    const el = attach(makeElement(id[1]));
    el.hidden = /(?:^|\s)hidden(?:=|\s|$)/.test(tag);
    byId.set(id[1], el);
  }

  const document = {
    body,
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, attach(makeElement(id)));
      return byId.get(id);
    },
    querySelector(selector) {
      if (!bySelector.has(selector)) bySelector.set(selector, attach(makeElement(selector)));
      return bySelector.get(selector);
    },
    querySelectorAll() {
      return [];
    },
    createElement(tag) {
      const el = makeElement('');
      el.tagName = String(tag || 'div').toUpperCase();
      return el;
    },
    addEventListener(type, fn) {
      listeners.push({type, fn});
    },
    removeEventListener() {},
    setAttribute(name, value) {
      body.setAttribute(name, value);
    },
    getAttribute(name) {
      return body.getAttribute(name);
    },
  };

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
  // checkSelfUpdate() / showBuildBanner() directly.  00-head.js opens the IIFE
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

  return {
    ctx,
    settle,
    fetches,
    unstubbed,
    opened,
    downloads,
    objectUrls,
    intervals,
    /**
     * Fetch handlers can be added or replaced after load (init fetches in
     * stages).
     */
    route(url, handler) {
      routes.set(url, handler);
    },
    routeJSON(url, body) {
      routes.set(url, () => jsonResponse(body));
    },
    routeRaw(url, text) {
      routes.set(url, () => rawResponse(text));
    },
    element(id) {
      return byId.get(id);
    },
    /** Whether the tab ever looked this id up (never-touched = never revealed). */
    has(id) {
      return byId.has(id);
    },
    /** Start the UI exactly as the real tab does. */
    fireDOMContentLoaded() {
      for (const {type, fn} of listeners) if (type === 'DOMContentLoaded') fn({});
    },
  };
}
