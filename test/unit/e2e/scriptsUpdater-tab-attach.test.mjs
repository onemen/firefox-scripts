// test/unit/e2e/scriptsUpdater-tab-attach.test.mjs — the tab-attach block of
// checkForUpdates (scriptsUpdater.sys.mjs), against the REAL module in the same
// vm sandbox technique as scriptsUpdater-daily-gate.test.mjs (which owns the
// harness shapes reused here).
//
// What is pinned here (the #384 fix):
//   - the fresh updater tab is selected only AFTER its browser starts loading
//     the page (load or pageshow, past the about:blank placeholder) — the
//     synchronous `selectedTab = tab` this replaced wedged the tab load at
//     about:blank in headless Nightly under startup CPU contention
//     (AsyncTabSwitcher schemeIs TypeError; the tab never rendered, the pending
//     update stayed hidden for the whole session);
//   - the twin-tab guard scans ALL browser windows (a restored session can
//     hold the updater tab in a non-active window) and tolerates a tab whose
//     browser is mid-teardown;
//   - selection falls back after 10 s if no load event ever fires, and a tab
//     whose window died before selection is not selected into a dead window.

import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'vm';
import {fileURLToPath} from 'node:url';

const tempRoots = [];
after(() => {
  for (const root of tempRoots) {
    try {
      fs.rmSync(root, {recursive: true, force: true});
    } catch (error) {
      console.warn(`temp cleanup failed for ${root}: ${error.message}`);
    }
  }
});

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const MODULE_PATH = path.join(
  REPO_ROOT,
  'core',
  'chrome',
  'utils',
  'updater',
  'scriptsUpdater.sys.mjs'
);
const MANIFEST_URL = 'https://manifest.test/hashes.json';

/* -------- harness (same shapes as scriptsUpdater-daily-gate.test.mjs) -------- */

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

/**
 * Timers registered through the sandbox's Cc are captured here (reset per
 * makeCc call, i.e. per loadUpdater). selectWhenLoaded's 10 s fallback is the
 * last one registered by the time the tab exists; a test fires it explicitly —
 * the module's other timers (withTimeout, the daily timer) must never fire.
 */
let ccTimers = [];
let makeSsCalls = [];

function makeCc() {
  ccTimers = [];
  return {
    '@mozilla.org/timer;1': {
      createInstance: () => {
        const timer = {
          initWithCallback(cb) {
            timer._cb = cb;
          },
          cancel() {
            timer._cb = null;
          },
        };
        ccTimers.push(timer);
        return timer;
      },
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

function loadUpdater({store = {}, routes = {}, windows = []} = {}) {
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
      defineESModuleGetters: (target, getters) => {
        for (const [name, spec] of Object.entries(getters)) {
          if (String(spec).includes('Timer')) {
            target[name] = cb => setTimeout(cb, 0);
          }
        }
      },
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
      ss: {
        getClosedTabDataForWindow: () =>
          JSON.stringify({
            windows: [
              {tabs: [{entries: [{url: 'chrome://firefox-scripts/content/ui/updater.html'}]}]},
            ],
          }),
        forgetClosedTab: (win, index) => {
          makeSsCalls.push({win, index});
        },
      },
      obs: {
        _observers: {},
        addObserver(cb, topic) {
          this._observers[topic] = this._observers[topic] || [];
          this._observers[topic].push(cb);
        },
        removeObserver(cb, topic) {
          this._observers[topic] = (this._observers[topic] || []).filter(o => o !== cb);
        },
        /** Test seam: fire a topic exactly like Services.obs.notifyObservers. */
        notify(topic) {
          for (const cb of this._observers[topic] || []) cb(null, topic);
        },
      },
      wm: {
        getEnumerator: () => {
          let i = 0;
          return {
            hasMoreElements: () => i < windows.length,
            getNext: () => windows[i++],
          };
        },
      },
    },
    Cc: makeCc(),
    Ci: new Proxy({}, {get: () => ({})}),
    PathUtils: {
      profileDir: (() => {
        const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fxs-tab-pathutils-'));
        tempRoots.push(profileDir);
        return profileDir;
      })(),
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
    setTimeout,
    console,
    TextEncoder,
    TextDecoder,
    atob,
    queueMicrotask,
  };
  makeSsCalls = [];
  vm.runInContext(source, vm.createContext(sandbox), {filename: 'scriptsUpdater.sys.mjs'});
  return {sandbox};
}

function makeProfileLayout(sandbox) {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fxs-tab-prof-'));
  const greDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fxs-tab-gre-'));
  sandbox.Services.dirsvc.get = name => {
    if (name === 'ProfD') return {path: profileDir};
    if (name === 'GreD' || name === 'XREExeF') return {path: greDir};
    return {path: os.tmpdir()};
  };
  return {
    utilsDir: path.join(profileDir, 'chrome', 'utils'),
    // ensureUpdaterUi probes/copies under PathUtils.profileDir (NOT the dirsvc
    // ProfD the hasher uses) — the daily-gate suite hits the same split.
    uiDir: path.join(sandbox.PathUtils.profileDir, 'chrome', 'utils', 'updater', 'ui'),
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

/** Poll until cond() or deadline. */
async function waitFor(cond, ms = 3000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) return false;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return true;
}

/**
 * Pending-update world (same shapes as the daily-gate suite): utils tree at
 * chrome/utils (its manifest entry stale), an installed updater UI at
 * chrome/utils/updater/ui so ensureUpdaterUi keeps it (no zip fetch), a
 * matching fx-folder.
 */
function seedPendingWorld(layout) {
  fs.mkdirSync(layout.utilsDir, {recursive: true});
  fs.writeFileSync(path.join(layout.utilsDir, 'updater.html'), '<html></html>');
  fs.mkdirSync(layout.uiDir, {recursive: true});
  fs.writeFileSync(path.join(layout.uiDir, 'updater.html'), '<html></html>');
  fs.mkdirSync(layout.greDir, {recursive: true});
  fs.writeFileSync(path.join(layout.greDir, 'config.js'), '// config\n');
  const manifest = {
    'utils': {
      hash: referenceFilesHash(['updater.html'], layout.utilsDir) + 'stale',
      files: ['updater.html'],
      date: '2026-09-26',
    },
    'fx-folder': {
      hash: referenceFilesHash(['config.js'], layout.greDir),
      files: ['config.js'],
      date: '2026-09-26',
    },
  };
  return {[MANIFEST_URL]: {status: 200, body: JSON.stringify(manifest)}};
}

/**
 * Fake browser window with scriptable tabs. The tab's linkedBrowser is a
 * controllable event target: `commit()` plays what tabbrowser does after the
 * about:blank placeholder — currentURI flips to the target, load + pageshow
 * fire. `fireAboutBlankLoad()` plays a placeholder-only load.
 */
function makeBrowser() {
  const browser = {
    currentURI: {spec: 'about:blank'},
    _listeners: {load: [], pageshow: []},
    addEventListener(type, cb) {
      this._listeners[type].push(cb);
    },
    removeEventListener(type, cb) {
      this._listeners[type] = this._listeners[type].filter(l => l !== cb);
    },
    commit(spec) {
      this.currentURI = {spec};
      for (const cb of [...this._listeners.load]) cb();
      for (const cb of [...this._listeners.pageshow]) cb();
    },
    fireAboutBlankLoad() {
      for (const cb of [...this._listeners.load]) cb();
    },
  };
  return browser;
}

function makeFakeWindow() {
  const win = {closed: false, openedTabs: [], _selected: null};
  const gBrowser = {
    tabs: win.openedTabs,
    tabContainer: {
      contains: tab => win.openedTabs.includes(tab),
    },
    addTrustedTab: uri => {
      const tab = {_uri: uri, linkedBrowser: makeBrowser()};
      win.openedTabs.push(tab);
      return tab;
    },
    removeTab: tab => {
      const i = win.openedTabs.indexOf(tab);
      if (i >= 0) win.openedTabs.splice(i, 1);
    },
  };
  Object.defineProperty(gBrowser, 'selectedTab', {
    get: () => win._selected,
    set: tab => {
      win._selected = tab;
    },
  });
  win.gBrowser = gBrowser;
  return win;
}

const TAB_URI = 'chrome://firefox-scripts/content/ui/updater.html';

/** Run initScriptsUpdater against a seeded pending-update world. */
async function openTabOnPendingWorld({windows = []} = {}) {
  const store = {};
  const {sandbox} = loadUpdater({store, windows});
  const layout = makeProfileLayout(sandbox);
  const routes = seedPendingWorld(layout);
  sandbox.Services.io = makeIo(routes);
  const win = makeFakeWindow();
  sandbox.initScriptsUpdater(win);
  sandbox.Services.obs.notify('sessionstore-windows-restored');
  // The tests attach immediately: fire the restore event the way Firefox does.
  sandbox.Services.obs.notify('sessionstore-windows-restored');
  const opened = await waitFor(() => win.openedTabs.length > 0);
  return {store, sandbox, layout, win, opened};
}

/* ---------------- the tab-attach block (#384) ---------------- */

test('fresh tab is selected only after its browser commits the updater URI', async () => {
  const {layout, win, opened} = await openTabOnPendingWorld();
  try {
    assert.ok(opened, 'the updater tab was opened');
    const tab = win.openedTabs[0];
    assert.equal(
      win._selected,
      null,
      'selection must not happen synchronously after addTrustedTab (the #384 wedge)'
    );
    tab.linkedBrowser.commit(TAB_URI);
    assert.equal(win._selected, tab, 'selection follows the browser load');
  } finally {
    layout.cleanup();
  }
});

test('a load event while the browser is still at about:blank does not select', async () => {
  const {layout, win, opened} = await openTabOnPendingWorld();
  try {
    assert.ok(opened);
    const tab = win.openedTabs[0];
    tab.linkedBrowser.fireAboutBlankLoad();
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(win._selected, null, 'about:blank placeholders must not win selection');
    tab.linkedBrowser.commit(TAB_URI);
    assert.equal(win._selected, tab);
  } finally {
    layout.cleanup();
  }
});

test('selection falls back after the 10s timer when no load ever fires', async () => {
  const {layout, win, opened} = await openTabOnPendingWorld();
  try {
    assert.ok(opened);
    const tab = win.openedTabs[0];
    assert.ok(ccTimers.length >= 1, 'the fallback timer was registered');
    const fallback = ccTimers[ccTimers.length - 1];
    assert.ok(fallback._cb, 'the fallback timer was not cancelled');
    fallback._cb();
    assert.equal(win._selected, tab, 'the fallback selects the tab anyway');
    // Idempotent: the load arriving later must not re-select or throw.
    tab.linkedBrowser.commit(TAB_URI);
    assert.equal(win._selected, tab);
  } finally {
    layout.cleanup();
  }
});

test('twin-tab guard: a restored tab (other window) is forgotten and replaced by a fresh tab in the current window', async () => {
  // The user reported the updater tab restoring into a window they were not
  // looking at. The guard normalizes: the restored tab is closed AND purged
  // from the recently-closed list, then a fresh tab opens in the active window.
  const restoredWin = makeFakeWindow();
  restoredWin.gBrowser.tabs.push({linkedBrowser: {currentURI: {spec: TAB_URI}}});
  const {layout, win, opened} = await openTabOnPendingWorld({windows: [restoredWin]});
  try {
    assert.ok(opened, 'a fresh updater tab opens in the current window');
    assert.equal(
      restoredWin.openedTabs.length,
      0,
      'the restored tab was removed from the other window'
    );
    assert.ok(
      makeSsCalls.length >= 1,
      'the restored tab was purged from the recently-closed list (forgetClosedTab)'
    );
    assert.equal(
      win.openedTabs.filter(x => x._uri === TAB_URI).length,
      1,
      'exactly one live updater tab across the session'
    );
  } finally {
    layout.cleanup();
  }
});

test('twin-tab guard: a restored tab in the SAME window is forgotten too — exactly one fresh tab', async () => {
  // Always-fresh (#384 follow-up): even in the current window a restored tab
  // is removed + purged, then ONE fresh tab is opened. A restored chrome page
  // may never run its engine (lazily restored page); the fresh tab is the
  // proven-good path.
  const windows = [];
  const {sandbox} = loadUpdater({store: {}, windows});
  const layout = makeProfileLayout(sandbox);
  const routes = seedPendingWorld(layout);
  sandbox.Services.io = makeIo(routes);
  const win = makeFakeWindow();
  windows.push(win);
  sandbox.Services.obs.notify('sessionstore-windows-restored');
  const restoredBrowser = makeBrowser();
  restoredBrowser.currentURI = {spec: TAB_URI}; // already restored/loaded
  const restoredTab = {_uri: TAB_URI, linkedBrowser: restoredBrowser, _scriptsUpdateTab: true};
  win.gBrowser.tabs.push(restoredTab);
  try {
    sandbox.initScriptsUpdater(win);
    sandbox.Services.obs.notify('sessionstore-windows-restored');
    assert.ok(
      await waitFor(() => win.openedTabs.some(x => x._uri === TAB_URI && x !== restoredTab)),
      'a fresh tab was opened'
    );
    assert.ok(!win.openedTabs.includes(restoredTab), 'the restored tab was removed');
    assert.ok(makeSsCalls.length >= 1, 'the restored tab was purged from the recently-closed list');
    assert.equal(
      win.openedTabs.filter(x => x._uri === TAB_URI).length,
      1,
      'exactly one updater tab'
    );
  } finally {
    layout.cleanup();
  }
});

test('twin-tab guard tolerates a tab whose browser is mid-teardown', async () => {
  const restoredWin = makeFakeWindow();
  restoredWin.gBrowser.tabs.push({
    get linkedBrowser() {
      throw new Error('tab mid-teardown');
    },
  });
  const {layout, opened} = await openTabOnPendingWorld({windows: [restoredWin]});
  try {
    assert.ok(opened, 'the teardown tab is skipped; the check still opens the tab');
  } finally {
    layout.cleanup();
  }
});

test('selection into a closed window is a no-op, not a crash', async () => {
  const {layout, win, opened} = await openTabOnPendingWorld();
  try {
    assert.ok(opened);
    const tab = win.openedTabs[0];
    win.closed = true;
    tab.linkedBrowser.commit(TAB_URI);
    assert.equal(win._selected, null, 'no selection into a dead window');
  } finally {
    layout.cleanup();
  }
});

test('healthy-path tab shape is unchanged (uri, flags, no scheduler pref write)', async () => {
  const {store, layout, win, opened} = await openTabOnPendingWorld();
  try {
    assert.ok(opened);
    const tab = win.openedTabs[0];
    assert.equal(tab._uri, TAB_URI, 'the tab targets the updater page');
    assert.equal(tab._scriptsUpdateTab, true, 'the scheduler flag is still set');
    assert.equal(tab.loadOnStartup, true, 'loadOnStartup is still set');
    assert.equal(
      store['extensions.firefox-scripts.lastScriptsCheckDate'],
      undefined,
      'the shown day belongs to the tab, not the scheduler'
    );
  } finally {
    layout.cleanup();
  }
});
