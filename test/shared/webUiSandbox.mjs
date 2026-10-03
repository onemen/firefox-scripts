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
// This module is that context, and the entry point every suite imports. The
// pieces live beside it so each stays small enough to review on its own:
//
//   webUiMarkup.mjs   tolerant HTML: attributes, tokenizer, parse, serialize
//   webUiSelector.mjs the selector subset the fragments use
//   webUiDom.mjs      the element tree, built from the shipped index.html
//   webUiSandbox.mjs  this file — vm context, fetch routes, effect recorders
//
// It provides the DOM (webUiDom), a route registry for `fetch` (unstubbed URLs
// resolve 404 and are recorded in `unstubbed`), recording of the effects a test
// asserts on (window.open, anchor clicks, object URLs, every fetch, every id the
// tab looked up that the markup lacks), `settle()` — the tab's promise chains
// cross realms — and `fireDOMContentLoaded()`.
//
// Only the DOM surface the fragments actually touch is modelled, so a property
// the tab starts using shows up as a clear "not a function" rather than a
// plausible wrong answer.
//
// Nothing here needs a compiler or a built binary (this is `pnpm test` scope;
// installer/test/ is the binary-in-the-loop half — see installer/test/README.md).

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';

import {createDom} from './webUiDom.mjs';

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
    // Real globals in both the tab and Node. TextDecoder is what the self-update
    // ingest uses to turn fetchRaw's ArrayBuffer into text for the
    // mechanismSince gate (issue #401) — without it here, that path throws
    // "TextDecoder is not defined" instead of exercising the decode.
    TextDecoder,
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
