// test/unit/e2e/scriptsUpdater-daily-gate.test.mjs — the daily gate in
// checkForUpdates (scriptsUpdater.sys.mjs), against the REAL module in the same
// vm sandbox technique as scriptsUpdater-hash.test.mjs.
//
// Driven through the production entry initScriptsUpdater(win): gWindow is a
// lexical module binding inside the context, so a test cannot assign it from
// outside — entering the way the browser does is also what keeps the suite
// honest. The check initScriptsUpdater starts is fire-and-forget, so the
// assertions settle by polling for the observable (marker pref written / tab
// opened) against a deadline.
//
// What is pinned here (the 2026-09-26 single-pref daily gate):
//   - an up-to-date check writes lastScriptsCheckDate = today — the one daily
//     pref (ADR 0012) — so the happy path runs once per DAY, not per session;
//   - the same-day re-check is then a no-op — the manifest is NOT re-fetched;
//   - an unreachable manifest (network-failure day) writes NO pref, so the
//     next session re-checks instead of being rate-limited away for a day;
//   - a pending update opens the tab WITHOUT the scheduler writing the pref —
//     the tab itself records the shown day (updater.js engineInit, source
//     canary below), and an ignored tab simply resurfaces tomorrow.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'vm';
import {fileURLToPath} from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const MODULE_PATH = path.join(
  REPO_ROOT,
  'core',
  'chrome',
  'utils',
  'updater',
  'scriptsUpdater.sys.mjs'
);
const TAB_ENGINE_PATH = path.join(REPO_ROOT, 'tools', 'publish', 'remote-ui', 'updater.js');

const PREF_LAST_CHECK = 'extensions.firefox-scripts.lastScriptsCheckDate';
// Retired pref names — kept only for the negative asserts and the canary:
// these strings must never come back (see the ADR 0012 amendment).
const PREF_LAST_SHOWN = 'extensions.firefox-scripts.lastUpdateTabShown';
const PREF_LAST_VERIFIED = 'extensions.firefox-scripts.lastVerifiedDate';
const MANIFEST_URL = 'https://manifest.test/hashes.json';
const TODAY = new Date().toISOString().slice(0, 10);

/* ------------- harness (same shapes as scriptsUpdater-hash.test.mjs) -------- */

function makePrefs(store) {
  return {
    PREF_STRING: 64,
    getPrefType: key => (key in store ? 64 : 0),
    getStringPref: (key, d = '') => (key in store ? store[key] : d),
    getCharPref: (key, d = '') => (key in store ? store[key] : d),
    setCharPref: (key, v) => {
      store[key] = String(v);
    },
    clearUserPref: key => {
      delete store[key];
    },
  };
}

function makeIo(routes) {
  const NS_ERROR_FAILURE = 0x80004005;
  const state = {routes, fetches: 0};
  const io = {
    newURI: spec => ({spec}),
    newChannelFromURI: uri => ({
      asyncOpen(listener) {
        queueMicrotask(() => {
          const route = state.routes[uri.spec];
          if (route && !route.error) state.fetches++;
          const request = {QueryInterface: () => ({responseStatus: route ? route.status || 0 : 0})};
          if (!route || route.error) {
            listener.onStopRequest(request, NS_ERROR_FAILURE);
            return;
          }
          const bytes = Buffer.from(route.body, 'utf-8');
          listener.onStartRequest?.(request, null);
          listener.onDataAvailable(request, {_bytes: bytes}, 0, bytes.length);
          listener.onStopRequest(request, 0);
        });
      },
    }),
  };
  io._state = state;
  return io;
}

function makeNsIFile() {
  let p = '';
  return {
    initWithPath(native) {
      p = native;
    },
    clone() {
      const c = makeNsIFile();
      c.initWithPath(p);
      return c;
    },
    append(part) {
      p = p.replace(/[\\/]+$/, '') + path.sep + part;
    },
    get path() {
      return p;
    },
    exists: () => fs.existsSync(p),
    isFile() {
      try {
        return fs.statSync(p).isFile();
      } catch {
        return false;
      }
    },
  };
}

function makeCryptoHash() {
  const h = crypto.createHash('sha256');
  return {
    init() {},
    update(bytes, len) {
      h.update(bytes.subarray(0, len ?? bytes.length));
    },
    finish(b64) {
      const d = h.digest();
      return b64 ? d.toString('base64') : d.toString('hex');
    },
  };
}

function makeCc() {
  return {
    '@mozilla.org/timer;1': {
      // The daily timer must never fire inside a test; withTimeout resolves
      // through the wrapped promise.
      createInstance: () => ({initWithCallback() {}, cancel() {}}),
    },
    '@mozilla.org/binaryinputstream;1': {
      createInstance: () => {
        let bytes = null;
        return {
          setInputStream(s) {
            bytes = s._bytes ?? s._fileBytes;
          },
          readByteArray(n) {
            return Array.from(bytes.subarray(0, n));
          },
          readArrayBuffer(count, data) {
            const view = new Uint8Array(data);
            view.set(bytes.subarray(0, Math.min(count, bytes.length)), 0);
          },
        };
      },
    },
    '@mozilla.org/file/local;1': {createInstance: () => makeNsIFile()},
    '@mozilla.org/network/file-input-stream;1': {
      createInstance: () => {
        let fd = null;
        return {
          init(file) {
            fd = fs.openSync(file.path, 'r');
          },
          available() {
            return fs.fstatSync(fd).size;
          },
          readArrayBuffer(count, data) {
            const view = new Uint8Array(data);
            fs.readSync(fd, view, 0, count, 0);
          },
          close() {
            fs.closeSync(fd);
          },
          get _fileBytes() {
            const buf = Buffer.alloc(fs.fstatSync(fd).size);
            fs.readSync(fd, buf, 0, buf.length, 0);
            return buf;
          },
        };
      },
    },
    '@mozilla.org/security/hash;1': {createInstance: () => makeCryptoHash()},
  };
}

const updaterConfig = () => ({
  HASHES_URL: MANIFEST_URL,
  ZIP_BASE_URL: 'https://zips.test',
  UI_BASE_URL: 'https://zips.test',
  HELPER_BASE_URL: 'https://zips.test',
  ASSET_SUFFIX: '-dev',
  IS_DEV: true,
  IS_LOCAL: false,
});

function loadUpdater({store = {}, routes = {}} = {}) {
  const source = fs
    .readFileSync(MODULE_PATH, 'utf-8')
    .replace(/\r\n/g, '\n')
    .replace(/^export /gm, '');
  const dirs = {
    'utils': os.tmpdir(),
    'fx-folder': os.tmpdir(),
    'updater-ui': os.tmpdir(),
  };
  const sandbox = {
    ChromeUtils: {
      generateQI: () => () => {},
      importESModule(spec) {
        if (spec.includes('updater-config')) {
          return {CONFIG: updaterConfig()};
        }
        return {};
      },
    },
    Services: {
      prefs: makePrefs(store),
      appinfo: {OS: process.platform === 'win32' ? 'WINNT' : 'Linux', version: '140.0'},
      dirsvc: {get: () => ({path: dirs['fx-folder']})},
      io: makeIo(routes),
      scriptSecurityManager: {getSystemPrincipal: () => ({})},
    },
    Cc: makeCc(),
    Ci: new Proxy({}, {get: () => ({})}),
    // ensureUpdaterUi builds its paths through PathUtils (profile/temp dirs)
    // and probes/copies through IOUtils — both are backed by the real fs here.
    PathUtils: {
      profileDir: fs.mkdtempSync(path.join(os.tmpdir(), 'fxs-gate-pathutils-')),
      tempDir: os.tmpdir(),
      join: (...parts) => path.join(...parts),
      exists: async p => fs.existsSync(p),
    },
    IOUtils: {
      exists: async p => fs.existsSync(p),
      copy: async (from, to) => fs.copyFileSync(from, to),
      remove: async (p, opts) => fs.rmSync(p, {recursive: true, force: Boolean(opts?.recursive)}),
      makeDirectory: async (p, opts) =>
        fs.mkdirSync(p, {recursive: Boolean(opts?.ignoreExisting ?? opts?.recursive)}),
    },
    console,
    TextEncoder,
    TextDecoder,
    atob,
    queueMicrotask,
  };
  vm.runInContext(source, vm.createContext(sandbox), {filename: 'scriptsUpdater.sys.mjs'});
  return {sandbox};
}

function makeProfileLayout(sandbox) {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fxs-gate-prof-'));
  const greDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fxs-gate-gre-'));
  sandbox.Services.dirsvc.get = name => {
    if (name === 'ProfD') return {path: profileDir};
    if (name === 'GreD' || name === 'XREExeF') return {path: greDir};
    return {path: os.tmpdir()};
  };
  return {
    utilsDir: path.join(profileDir, 'chrome', 'utils'),
    greDir,
    cleanup: () => {
      fs.rmSync(profileDir, {recursive: true, force: true});
      fs.rmSync(greDir, {recursive: true, force: true});
    },
  };
}

function referenceFilesHash(files, baseDir) {
  const sorted = [...files].sort((a, b) => a.localeCompare(b));
  const hash = crypto.createHash('sha256');
  for (const relative of sorted) {
    hash.update(relative + '\n');
    const abs = path.join(baseDir, ...relative.split('/'));
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      hash.update(fs.readFileSync(abs));
    }
  }
  return hash.digest('hex');
}

/** Fake browser window: the tab-open path records the URI. */
function makeFakeWindow() {
  const win = {closed: false, openedTabs: [], gBrowser: null};
  const gBrowser = {
    // checkForUpdates walks b.tabs to keep a single updater-tab instance.
    tabs: win.openedTabs,
    addTrustedTab: uri => {
      win.openedTabs.push(uri);
      return {linkedBrowser: {currentURI: {spec: uri}}};
    },
  };
  win.gBrowser = gBrowser;
  return win;
}

/** Poll until cond() or deadline — settles the fire-and-forget init check. */
async function waitFor(cond, ms = 2000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) return false;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return true;
}

/**
 * utils + fx-folder trees matching their manifest (the COMPLETED up-to-date
 * world).
 */
function writeUpToDateWorld(io, layout) {
  fs.mkdirSync(layout.utilsDir, {recursive: true});
  fs.writeFileSync(path.join(layout.utilsDir, 'updater.js'), 'real code');
  fs.mkdirSync(layout.greDir, {recursive: true});
  fs.writeFileSync(path.join(layout.greDir, 'config.js'), '// config\n');
  const manifest = {
    'utils': {
      hash: referenceFilesHash(['updater.js'], layout.utilsDir),
      files: ['updater.js'],
      date: '2026-09-26',
    },
    'fx-folder': {
      hash: referenceFilesHash(['config.js'], layout.greDir),
      files: ['config.js'],
      date: '2026-09-26',
    },
  };
  Object.assign(io._state.routes, {[MANIFEST_URL]: {status: 200, body: JSON.stringify(manifest)}});
}

/* ---------------- the daily gate ---------------- */

test('up-to-date check records the day, so new sessions do not re-run it', async () => {
  const store = {};
  const {sandbox} = loadUpdater({store});
  const layout = makeProfileLayout(sandbox);
  writeUpToDateWorld(sandbox.Services.io, layout);
  try {
    sandbox.initScriptsUpdater(makeFakeWindow());
    const settled = await waitFor(() => store[PREF_LAST_CHECK] === TODAY);
    assert.ok(settled, 'the daily pref was not written on the up-to-date path');
    assert.equal(store[PREF_LAST_SHOWN], undefined, 'the retired shown pref stays dead');
    assert.equal(store[PREF_LAST_VERIFIED], undefined, 'the retired verified pref stays dead');
  } finally {
    layout.cleanup();
  }
});

test('same-day re-check after a recorded day is a no-op (manifest not refetched)', async () => {
  const store = {};
  const {sandbox} = loadUpdater({store});
  const layout = makeProfileLayout(sandbox);
  writeUpToDateWorld(sandbox.Services.io, layout);
  try {
    sandbox.initScriptsUpdater(makeFakeWindow());
    assert.ok(await waitFor(() => store[PREF_LAST_CHECK] === TODAY));
    const fetchesAfterFirst = sandbox.Services.io._state.fetches;
    assert.ok(fetchesAfterFirst >= 1, 'the first check fetched the manifest');

    // A "new session": init runs again the same day. The gate must exit BEFORE
    // the fetch — zero additional manifest fetches, nothing else observable.
    sandbox.initScriptsUpdater(makeFakeWindow());
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(
      sandbox.Services.io._state.fetches,
      fetchesAfterFirst,
      'the same-day re-check must not fetch the manifest again'
    );
  } finally {
    layout.cleanup();
  }
});

test('the daily pref from earlier today skips the check entirely', async () => {
  const store = {[PREF_LAST_CHECK]: TODAY};
  const {sandbox} = loadUpdater({store});
  const layout = makeProfileLayout(sandbox);
  writeUpToDateWorld(sandbox.Services.io, layout);
  try {
    sandbox.initScriptsUpdater(makeFakeWindow());
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(sandbox.Services.io._state.fetches, 0, 'no manifest fetch');
  } finally {
    layout.cleanup();
  }
});

test('unreachable manifest: NO pref written — the next session re-checks', async () => {
  const store = {};
  const {sandbox} = loadUpdater({
    store,
    routes: {[MANIFEST_URL]: {status: 0, error: true}},
  });
  const layout = makeProfileLayout(sandbox);
  fs.mkdirSync(layout.utilsDir, {recursive: true});
  fs.writeFileSync(path.join(layout.utilsDir, 'updater.js'), 'real code');
  try {
    sandbox.initScriptsUpdater(makeFakeWindow());
    // Give the failing check ample time to settle, then assert the negative.
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(
      store[PREF_LAST_CHECK],
      undefined,
      'a network-failure day must not rate-limit away the next day of checks'
    );
  } finally {
    layout.cleanup();
  }
});

test('malformed manifest: NO pref written — a broken publish must not consume the day', async () => {
  const store = {};
  const {sandbox} = loadUpdater({
    store,
    routes: {[MANIFEST_URL]: {status: 200, body: '{not json at all'}},
  });
  const layout = makeProfileLayout(sandbox);
  fs.mkdirSync(layout.utilsDir, {recursive: true});
  fs.writeFileSync(path.join(layout.utilsDir, 'updater.js'), 'real code');
  try {
    sandbox.initScriptsUpdater(makeFakeWindow());
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(
      store[PREF_LAST_CHECK],
      undefined,
      'a malformed-manifest day must not rate-limit away the next day of checks'
    );
  } finally {
    layout.cleanup();
  }
});

test('incomplete manifest (fx-folder entry missing): NO pref written — skipped entries are not comparisons', async () => {
  const store = {};
  const {sandbox} = loadUpdater({store});
  const layout = makeProfileLayout(sandbox);
  // utils matches its (present) entry, but the manifest lacks the fx-folder
  // entry entirely: the user-facing package set is not fully compared, so the
  // up-to-date path must not record the day (CodeRabbit retained concern on
  // #333 — a truncated publish must not rate-limit the next day's checks).
  fs.mkdirSync(layout.utilsDir, {recursive: true});
  fs.writeFileSync(path.join(layout.utilsDir, 'updater.js'), 'real code');
  const manifest = {
    utils: {
      hash: referenceFilesHash(['updater.js'], layout.utilsDir),
      files: ['updater.js'],
      date: '2026-09-26',
    },
  };
  sandbox.Services.io = makeIo({
    [MANIFEST_URL]: {status: 200, body: JSON.stringify(manifest)},
  });
  try {
    sandbox.initScriptsUpdater(makeFakeWindow());
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(
      store[PREF_LAST_CHECK],
      undefined,
      'a manifest missing a user-facing package must not consume the day'
    );
  } finally {
    layout.cleanup();
  }
});

test('pending update: the scheduler writes NO pref, the tab opens (the tab records the day)', async () => {
  const store = {};
  const {sandbox} = loadUpdater({store});
  const layout = makeProfileLayout(sandbox);
  fs.mkdirSync(layout.utilsDir, {recursive: true});
  fs.writeFileSync(path.join(layout.utilsDir, 'updater.js'), 'real code');
  // Manifest hash ≠ local tree → update pending. ensureUpdaterUi will fetch a
  // UI zip that does not exist here; the tab-open fails silently AFTER the
  // gate-relevant decisions — the scheduler must stay pref-silent either way.
  const manifest = {
    utils: {
      hash: referenceFilesHash(['updater.js'], layout.utilsDir) + 'stale',
      files: ['updater.js'],
      date: '2026-09-26',
    },
  };
  sandbox.Services.io = makeIo({
    [MANIFEST_URL]: {status: 200, body: JSON.stringify(manifest)},
  });
  // A current updater UI is installed: ensureUpdaterUi keeps it (no zip fetch)
  // and the tab-open path proceeds — what this test wants to observe.
  const uiDir = path.join(sandbox.PathUtils.profileDir, 'chrome', 'utils', 'updater', 'ui');
  fs.mkdirSync(uiDir, {recursive: true});
  fs.writeFileSync(path.join(uiDir, 'updater.html'), '<html></html>');
  const win = makeFakeWindow();
  try {
    sandbox.initScriptsUpdater(win);
    assert.ok(
      await waitFor(() => win.openedTabs.length > 0, 3000),
      'the update tab path should have been reached'
    );
    assert.equal(
      store[PREF_LAST_CHECK],
      undefined,
      'the shown day belongs to the TAB (updater.js engineInit), not the scheduler'
    );
  } finally {
    layout.cleanup();
  }
});

test('pref-name canary: exactly one daily pref, written by the module AND the tab engine', () => {
  const moduleSrc = fs.readFileSync(MODULE_PATH, 'utf-8');
  assert.ok(moduleSrc.includes(`'${PREF_LAST_CHECK}'`), 'the daily pref is missing');
  assert.ok(
    !moduleSrc.includes('lastUpdateTabShown') && !moduleSrc.includes('lastVerifiedDate'),
    'a retired daily pref name reappeared in the module'
  );
  // The tab-side half of the contract (updater.js is window-context JS, not
  // vm-loadable here): the engine must write the shown day itself, and only
  // after its own re-check COMPLETED (CodeRabbit retained concern on #333 — a
  // failed tab re-check must not consume the day on the scheduler's behalf).
  const tabSrc = fs.readFileSync(TAB_ENGINE_PATH, 'utf-8');
  assert.ok(
    tabSrc.includes(`'${PREF_LAST_CHECK}'`),
    'updater.js no longer writes the daily pref — the shown tab would re-open daily'
  );
  assert.match(
    tabSrc,
    /checkCompleted\s*=[\s\S]*?fxFolder\?\.remoteHash[\s\S]*?utils\?\.remoteHash/,
    'the tab write must be gated on a completed re-check (both packages compared)'
  );
  assert.ok(tabSrc.includes('if (checkCompleted) {'), 'the pref write must sit behind the gate');
});
