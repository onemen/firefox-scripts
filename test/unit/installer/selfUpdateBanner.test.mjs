// test/unit/installer/selfUpdateBanner.test.mjs — the installer self-update
// banner's FALLBACK destination.
//
// The banner's normal branch downloads data.downloadUrl (an asset URL from the
// managed "download" map).  When a newer publish carries no download entry for
// THIS platform, installer/src/self_update.c still reports updateAvailable with
// an empty download_url, and the tab opens a human-facing page instead.  That
// page must be the permanently-named `latest` release: the rolling /releases
// listing can be topped by a dated component release (scripts-<date>) that
// carries no installer asset, leaving the user to hunt for the binary.
//
// The web UI ships as one concatenated IIFE (installer/src/script.built.js,
// built by embed.mjs — see concatGate.test.mjs), so the functions are not
// individually parseable or importable.  This test therefore evaluates the two
// FRAGMENTS that own the logic inside a vm context with a stub DOM and a
// scripted fetch, and drives the real checkSelfUpdate() end to end:
// /api/build-info -> /api/package-urls -> Pages payload ingest ->
// /api/self-update -> the button's onclick.
//
// Pure Node — no compiler, no built binary (this belongs to `pnpm test`, not
// `pnpm test:hash`; see installer/test/README.md for the split).

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT_DIR = path.join(REPO_ROOT, 'installer', 'web', 'script');

const LATEST_RELEASE_URL = 'https://github.com/onemen/firefox-scripts/releases/tag/latest';
const PAGES_PAYLOAD_URL = 'https://onemen.github.io/firefox-scripts/self-update.json';
const RELEASES_URL = 'https://api.github.com/repos/onemen/firefox-scripts/releases?per_page=10';

/**
 * The endpoints every self-update check walks: build info, the package-url
 * descriptor (which carries BOTH ingest surfaces — the Pages payload and the
 * release listing), and the local self-update endpoint that the tab POSTs an
 * ingest into and GETs the C-side verdict from.
 *
 * @param {object} verdict body served by GET /api/self-update
 */
function routes(verdict) {
  return {
    '/api/build-info': () =>
      jsonResponse({selfUpdateDisabled: false, buildDate: '2026-01-01', isLocal: false}),
    '/api/package-urls': () =>
      jsonResponse({selfUpdatePagesUrl: PAGES_PAYLOAD_URL, releasesUrl: RELEASES_URL}),
    [PAGES_PAYLOAD_URL]: () =>
      rawResponse(JSON.stringify({mechanismSince: '2026-01-01', installerDate: '2026-10-01'})),
    [RELEASES_URL]: () =>
      rawResponse(
        JSON.stringify({
          installerDate: '2026-10-01',
          download: {
            installer_win:
              'https://github.com/onemen/firefox-scripts/releases/download/latest/installer_win.exe',
          },
        })
      ),
    // The tab checks the POST BODY's "ok" field (postRaw returns r.json()),
    // not the HTTP status.
    '/api/self-update': method =>
      method === 'POST' ? jsonResponse({ok: true}) : jsonResponse(verdict),
  };
}

/**
 * Load the ingest + banner fragments in a vm context.
 *
 * The fragments are bodies of the shipped IIFE, so they are evaluated here with
 * their shared helpers in scope: qs/fetchJSON/fetchRaw/postRaw come from
 * 10-ingest.js, getSessionToken is stubbed (it lives in 50-init.js, which would
 * run the whole page init on load).
 *
 * @param {object} routes url (or path) -> handler returning a Response-like
 * @returns {{ctx: object; elements: Map<string, object>; opened: string[]}}
 */
function loadBanner(routes) {
  const elements = new Map();
  const opened = [];

  const sandbox = {
    console,
    JSON,
    setTimeout,
    clearTimeout,
    AbortController,
    Promise,
    Date,
    RegExp,
    window: {
      open(url, target, features) {
        opened.push({url, target, features});
        return null;
      },
    },
    document: {
      getElementById(id) {
        if (!elements.has(id)) {
          elements.set(id, {id, style: {}, textContent: '', onclick: null});
        }
        return elements.get(id);
      },
      createElement() {
        return {
          style: {},
          set href(v) {
            this._href = v;
          },
          get href() {
            return this._href;
          },
          click() {
            opened.push({url: this._href, download: true});
          },
          remove() {},
        };
      },
      body: {appendChild() {}, removeChild() {}},
    },
    fetch(url, init) {
      const key = typeof url === 'string' ? url : String(url);
      const handler = routes[key];
      if (!handler) throw new Error('unexpected fetch: ' + key);
      return Promise.resolve(handler(init && init.method));
    },
  };
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);

  const prelude = 'function getSessionToken() { return ""; }';
  const fragments = ['10-ingest.js', '20-banners.js']
    .map(f => fs.readFileSync(path.join(SCRIPT_DIR, f), 'utf8'))
    .join('\n');
  vm.runInContext(prelude + '\n' + fragments, ctx, {filename: 'script-fragments.js'});

  return {ctx, elements, opened};
}

/** Drive the real checkSelfUpdate() and let its promise chain settle. */
async function checkSelfUpdate(ctx) {
  await ctx.checkSelfUpdate();
  // The fragment's chain spans several cross-realm promise hops (the vm
  // context has its own globals); flush the microtask queue so every
  // continuation has run before the assertions look at the DOM.
  await new Promise(resolve => setImmediate(resolve));
}

function jsonResponse(body) {
  return {ok: true, status: 200, json: () => Promise.resolve(body)};
}

function rawResponse(text) {
  return {
    ok: true,
    status: 200,
    arrayBuffer: () => Promise.resolve(new TextEncoder().encode(text).buffer),
  };
}

/** The self-update verdict the C side reports for "newer build, no URL for us". */
const NO_URL_UPDATE_AVAILABLE = {
  updateAvailable: true,
  downloadUrl: '',
  buildDate: '2026-01-01',
  latestDate: '2026-10-01',
};

test('self-update banner falls back to the latest release tag, not /releases', async () => {
  const {ctx, elements, opened} = loadBanner(routes({...NO_URL_UPDATE_AVAILABLE}));

  await checkSelfUpdate(ctx);

  const banner = elements.get('update-banner');
  assert.ok(banner, 'update-banner element was resolved');
  assert.equal(banner.style.display, 'flex', 'banner shown for an available update');

  const button = elements.get('btn-self-update');
  assert.ok(button && typeof button.onclick === 'function', 'update button wired up');

  button.onclick();

  assert.equal(opened.length, 1, 'exactly one page opened');
  assert.equal(opened[0].url, LATEST_RELEASE_URL);
  assert.equal(opened[0].target, '_blank');
  assert.equal(opened[0].features, 'noopener');
});

test('self-update banner still downloads the asset when a download URL is present', async () => {
  const assetUrl =
    'https://github.com/onemen/firefox-scripts/releases/download/latest/installer_win.exe';
  const {ctx, elements, opened} = loadBanner(
    routes({...NO_URL_UPDATE_AVAILABLE, downloadUrl: assetUrl})
  );

  await checkSelfUpdate(ctx);
  elements.get('btn-self-update').onclick();

  assert.deepEqual(opened, [{url: assetUrl, download: true}]);
  assert.ok(
    !opened.some(o => o.url && o.url.includes('/releases/tag/')),
    'the normal branch never opens a release page'
  );
});

test('self-update banner stays hidden when self-update is disabled', async () => {
  const {ctx, elements, opened} = loadBanner({
    '/api/build-info': () => jsonResponse({selfUpdateDisabled: true, isLocal: true}),
  });

  await checkSelfUpdate(ctx);

  assert.ok(!elements.has('btn-self-update'), 'no button handler installed');
  assert.deepEqual(opened, [], 'nothing opened');
});
