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
import {comparePlatformVersions, resolveSandboxLazyModule} from '../../shared/sandboxServices.mjs';

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
 * makeCc call, i.e. per loadUpdater) with their delay, so a test can fire
 * exactly the one it means: selectWhenLoaded's 10 s fallback. The module's
 * other timers (withTimeout, the daily timer) must never fire, and the
 * late-restore guard creates none at all — it is event-driven.
 */
let ccTimers = [];

/** The last live timer registered with `delay` ms. */
function timerByDelay(delay) {
  return ccTimers.filter(t => t._delay === delay && t._cb).pop();
}
let makeSsCalls = [];
let lazySpecs = {};

function makeCc() {
  ccTimers = [];
  return {
    '@mozilla.org/timer;1': {
      createInstance: () => {
        const timer = {
          initWithCallback(cb, delay, type) {
            timer._cb = cb;
            timer._delay = delay;
            timer._type = type;
          },
          cancel() {
            timer._cb = null;
          },
          /** Run one tick the way the real nsITimer would. */
          fire() {
            const cb = timer._cb;
            if (typeof cb === 'function') {
              cb();
            } else {
              cb.notify();
            }
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

function loadUpdater({store = {}, routes = {}, windows = [], platformVersion = '140.0'} = {}) {
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
      // The module keeps ONE defineESModuleGetters block; every spec but the
      // instrumented Timer resolves through the shared dispatcher, so a module
      // this suite does not know about fails loudly instead of arriving
      // undefined (which is how a conditional import hides a bug).
      defineESModuleGetters: (target, getters) => {
        for (const [name, spec] of Object.entries(getters)) {
          lazySpecs[name] = String(spec);
          target[name] =
            String(spec).includes('Timer') ?
              cb => setTimeout(cb, 0)
            : resolveSandboxLazyModule(name, spec, {
                onForgetClosedTab: (win, index) => makeSsCalls.push({win, index}),
              });
        }
      },
      importESModule(spec) {
        if (spec.includes('updater-config')) {
          return {CONFIG: updaterConfig()};
        }
        if (spec.includes('SessionStore')) {
          // SessionStore is reachable ONLY through the lazy getter (its spec
          // is version-conditional) — a direct import here means the module
          // regressed to a module-scope import.
          throw new Error(
            `SessionStore must come from the lazy getter, not importESModule: ${spec}`
          );
        }
        return {};
      },
    },
    Services: {
      console: {logStringMessage: () => {}},
      prefs: makePrefs(store),
      appinfo: {
        OS: process.platform === 'win32' ? 'WINNT' : 'Linux',
        version: platformVersion,
        platformVersion,
      },
      vc: {compare: comparePlatformVersions},
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
  lazySpecs = {};
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

/** A browser already showing the updater page (a restored tab, not a fresh one). */
function restoredUpdaterBrowser() {
  const browser = makeBrowser();
  browser.currentURI = {spec: TAB_URI};
  return browser;
}

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

test('the session-restore gate is bounded at 5s (a pending promise cannot stall the attach)', () => {
  // The attach awaits SessionStore.promiseAllWindowsRestored before it claims
  // the tab set, so a promise that never settles must not wedge the attach
  // forever: the race carries an explicit bound. 5 s is ~2-3x the observed
  // restore (1-2 s) and the twin guard still catches a tab that lands after
  // it, so the bound is policy, not implementation — pin the number.
  const gate = fs.readFileSync(MODULE_PATH, 'utf-8');
  const match = gate.match(
    /withTimeout\(Promise\.resolve\(lazy\.SessionStore\.promiseAllWindowsRestored\), (\d+)\)/
  );
  assert.ok(match, 'the restore gate must race SessionStore with an explicit bound');
  assert.equal(Number(match[1]), 5000, 'the restore gate waits at most 5 s');
});

test('selection falls back after the 10s timer when no load ever fires', async () => {
  const {layout, win, opened} = await openTabOnPendingWorld();
  try {
    assert.ok(opened);
    const tab = win.openedTabs[0];
    const fallback = timerByDelay(10_000);
    assert.ok(fallback, 'the 10 s fallback timer was registered and is still live');
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
  const {sandbox, layout, win, opened} = await openTabOnPendingWorld({
    windows: [restoredWin],
  });
  try {
    // A restored twin can materialize after the attach block — the module
    // reacts to SessionStore's per-restored-tab notification instead of polling
    // for it (ESR 140, 2026-10-01), so drive that notification here, after the
    // fresh open already happened.
    sandbox.Services.obs.notify('sessionstore-one-or-no-tab-restored');
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

test('a twin materializing after the attach is forgotten on the per-tab restore notification', async () => {
  // The 2026-10-01 ESR 140 CI order: this module initialized AFTER
  // sessionstore-windows-restored had already fired (non-window startup order),
  // so that observer never ran; the restored tab then appeared next to the
  // fresh one. SessionStore's PER-TAB notification is the hook that still
  // arrives, whatever the module's startup ordering — no timer involved.
  const restoredWin = makeFakeWindow();
  const win = makeFakeWindow();
  // The enumerator must see BOTH windows, the way Services.wm does in Firefox
  // (the guard looks for the marked fresh tab session-wide).
  const windows = [restoredWin, win];
  const {sandbox} = loadUpdater({store: {}, windows});
  const layout = makeProfileLayout(sandbox);
  const routes = seedPendingWorld(layout);
  sandbox.Services.io = makeIo(routes);
  sandbox.initScriptsUpdater(win); // no notify(): the event already happened
  try {
    assert.ok(await waitFor(() => win.openedTabs.length > 0), 'the fresh tab opened');
    const lateTab = {_uri: TAB_URI, linkedBrowser: restoredUpdaterBrowser()};
    restoredWin.gBrowser.tabs.push(lateTab);
    sandbox.Services.obs.notify('sessionstore-one-or-no-tab-restored');
    assert.ok(!restoredWin.openedTabs.includes(lateTab), 'the late twin is forgotten');
    assert.ok(makeSsCalls.length >= 1, 'and purged from the recently-closed list');
    // Every notification is honoured, not just the first one.
    const secondLateTab = {_uri: TAB_URI, linkedBrowser: restoredUpdaterBrowser()};
    restoredWin.gBrowser.tabs.push(secondLateTab);
    sandbox.Services.obs.notify('sessionstore-one-or-no-tab-restored');
    assert.ok(!restoredWin.openedTabs.includes(secondLateTab), 'the next twin is forgotten too');
    // No marked tab left = no twin: an unmarked updater tab is then the ONLY
    // one (a user's own open, or the E2E driver's) and must be left alone.
    win.openedTabs.length = 0;
    const loneTab = {_uri: TAB_URI, linkedBrowser: restoredUpdaterBrowser()};
    restoredWin.gBrowser.tabs.push(loneTab);
    sandbox.Services.obs.notify('sessionstore-one-or-no-tab-restored');
    assert.ok(
      restoredWin.openedTabs.includes(loneTab),
      "only DUPLICATES of the session's own fresh tab are removed"
    );
  } finally {
    layout.cleanup();
  }
});

test("the twin guard is registered on SessionStore's per-tab notification, not on a timer", async () => {
  // The event-driven contract: the module observes the topic that fires when a
  // restored tab actually materializes, and creates no repeating sweep timer
  // for it (the old 6 × 2 s window is gone).
  const {sandbox} = loadUpdater({store: {}, windows: []});
  sandbox.initScriptsUpdater(makeFakeWindow());
  assert.ok(
    sandbox.Services.obs._observers['sessionstore-one-or-no-tab-restored']?.length === 1,
    'one observer on sessionstore-one-or-no-tab-restored'
  );
  assert.equal(
    ccTimers.filter(t => t._delay === 2000).length,
    0,
    'no repeating 2 s sweep timer is created any more'
  );
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
  // A restored tab never carries the scheduler's mark — only THIS session's
  // fresh open is marked. The forget pass therefore removes it (and, since the
  // skip-marked rule, would skip a marked one: that shape belongs to the
  // duplicate guard, not the attach block's scan).
  const restoredTab = {_uri: TAB_URI, linkedBrowser: restoredBrowser};
  win.gBrowser.tabs.push(restoredTab);
  try {
    sandbox.initScriptsUpdater(win);
    sandbox.Services.obs.notify('sessionstore-windows-restored');
    // The attach block's scan sees the seeded restored tab only if it landed
    // BEFORE init; a late-materialized one is swept by the restore-sweep
    // timer (play its tick here — same race the ESR 140 run exposed).
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

/* ------------- the version-conditional SessionStore spec (ESR 140..Nightly) ------------- */

test('SessionStore spec follows the platform version: resource:// before 156.0a1, moz-src:// from it', async () => {
  // 156.0a1 moved SessionStore to moz-src://; the resource:///modules alias is
  // gone afterwards, and moz-src:// does not exist before it. The chosen spec
  // is visible only through the module's single lazy getter block.
  const RESOURCE = 'resource:///modules/sessionstore/SessionStore.sys.mjs';
  const MOZ_SRC = 'moz-src:///browser/components/sessionstore/SessionStore.sys.mjs';

  loadUpdater({platformVersion: '140.0'});
  assert.equal(lazySpecs.SessionStore, RESOURCE, 'ESR 140 must keep resource:///modules');

  loadUpdater({platformVersion: '156.0a1'});
  assert.equal(lazySpecs.SessionStore, MOZ_SRC, 'the cutoff version itself already moved');

  loadUpdater({platformVersion: '159.0a1'});
  assert.equal(lazySpecs.SessionStore, MOZ_SRC, 'Nightly resolves moz-src://');
});

test('the purge and the restore gate both resolve SessionStore through the lazy getter', async () => {
  // One getter, one module instance: the closed-tab purge call must be visible
  // to the stub that the getter served (a direct importESModule would throw in
  // this harness, so this test also fails if the module regresses).
  const restoredWin = makeFakeWindow();
  restoredWin.gBrowser.tabs.push({linkedBrowser: {currentURI: {spec: TAB_URI}}});
  const {layout, opened} = await openTabOnPendingWorld({windows: [restoredWin]});
  try {
    assert.ok(opened);
    assert.ok(
      makeSsCalls.length >= 1,
      'forgetUpdaterTab reached lazy.SessionStore.getClosedTabDataForWindow/forgetClosedTab'
    );
  } finally {
    layout.cleanup();
  }
});
