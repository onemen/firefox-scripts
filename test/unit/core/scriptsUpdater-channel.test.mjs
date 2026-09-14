// test/unit/core/scriptsUpdater-channel.test.mjs — publish-channel logic from
// core/chrome/utils/updater/scriptsUpdater.sys.mjs (ADR 0026):
//
// - channel derivation (stored pref → build mode; --local never channels)
// - channelValue routing (dev channel → own URLs; stable → STABLE_* with the
//   stable-build empty-key fallback; override prefs honored for the harness)
// - getAssetSuffix ('-dev' only on the dev channel / --local build)
// - fetchOwnManifestOrFallback: dead dev manifest → one stable attempt, the
//   migration recorded only when stable answers; both-dead → silent exit;
//   --local and pre-0026 configs never fall back.
//
// Technique: the real .sys.mjs is evaluated in a vm sandbox with stubbed
// Firefox services (same spirit as bootstrapLoader.test.mjs). The file uses
// only function-declaration exports, so stripping the `export ` keywords and
// running it as a classic script exposes the API on the sandbox object; each
// test builds a fresh sandbox, so the module's channel state is isolated.
// Not exercised here: the zip/DOM/IOUtils machinery (covered by the e2e legs).

import {test} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

const PREF_CHANNEL = 'extensions.firefox-scripts.activeChannel';
const PREF_CHANNEL_BUILD = 'extensions.firefox-scripts.activeChannelBuild';
const PREF_OVERRIDE_PREFIX = 'extensions.firefox-scripts.override.';

const DEV_HASHES =
  'https://cdn.jsdelivr.net/gh/onemen/firefox-scripts@dev-build-main-abc1/hashes.json';
const DEV_ZIP = 'https://cdn.jsdelivr.net/gh/onemen/firefox-scripts@dev-build-main-abc1';
const STABLE_HASHES = 'https://onemen.github.io/firefox-scripts/hashes.json';
const STABLE_ZIP = 'https://github.com/onemen/firefox-scripts/releases/download/latest';
const STABLE_UI = 'https://onemen.github.io/firefox-scripts';
const STABLE_HELPER = 'https://onemen.github.io/firefox-scripts';

/** Dev-channel generated config (STABLE_* baked in per ADR 0026). */
function devConfig(overrides = {}) {
  return {
    HASHES_URL: DEV_HASHES,
    ZIP_BASE_URL: DEV_ZIP,
    UI_BASE_URL: DEV_ZIP,
    HELPER_BASE_URL: DEV_ZIP,
    STABLE_HASHES_URL: STABLE_HASHES,
    STABLE_ZIP_BASE_URL: STABLE_ZIP,
    STABLE_UI_BASE_URL: STABLE_UI,
    STABLE_HELPER_BASE_URL: STABLE_HELPER,
    DEV_BRANCH: 'dev-build-main-abc1',
    IS_DEV: true,
    IS_LOCAL: false,
    ASSET_SUFFIX: '-dev',
    ...overrides,
  };
}

/** Stable-channel generated config (STABLE_* empty — its channel is its own). */
function stableConfig(overrides = {}) {
  return {
    HASHES_URL: STABLE_HASHES,
    ZIP_BASE_URL: STABLE_ZIP,
    UI_BASE_URL: STABLE_UI,
    HELPER_BASE_URL: STABLE_HELPER,
    STABLE_HASHES_URL: '',
    STABLE_ZIP_BASE_URL: '',
    STABLE_UI_BASE_URL: '',
    STABLE_HELPER_BASE_URL: '',
    IS_DEV: false,
    IS_LOCAL: false,
    ASSET_SUFFIX: '',
    ...overrides,
  };
}

/** A manifest whose utils hash never matches (files don't exist locally). */
const MISMATCH_MANIFEST = JSON.stringify({
  utils: {hash: 'f'.repeat(64), files: ['chrome/utils/updater.js'], date: '2026-09-12'},
});

/* ---------------- Firefox-service stubs ---------------- */

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

/**
 * Fetch stub. routes: url → {status, body} (success / HTTP error) or {error:
 * true} (transport failure). Unlisted urls fail too. Each route records its hit
 * count so tests can assert exactly who was consulted.
 */
function makeIo(routes) {
  const NS_ERROR_FAILURE = 0x80004005;
  for (const route of Object.values(routes)) {
    route.hits = 0;
  }
  return {
    newURI: spec => ({spec}),
    newChannelFromURI: uri => ({
      asyncOpen(listener) {
        queueMicrotask(() => {
          const route = routes[uri.spec];
          if (route) {
            route.hits = (route.hits || 0) + 1;
          }
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

/** Real SHA-256 behind the nsICryptoHash surface (hex in → base64 out). */
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
      // Never fires: withTimeout resolves through the wrapped promise.
      createInstance: () => ({initWithCallback() {}, cancel() {}}),
    },
    '@mozilla.org/binaryinputstream;1': {
      createInstance: () => {
        let bytes = null;
        return {
          setInputStream(s) {
            bytes = s._bytes;
          },
          readByteArray(n) {
            return Array.from(bytes.subarray(0, n));
          },
        };
      },
    },
    '@mozilla.org/file/local;1': {createInstance: () => makeNsIFile()},
    '@mozilla.org/security/hash;1': {createInstance: () => makeCryptoHash()},
  };
}

/**
 * Evaluate the module in a fresh sandbox. Returns the sandbox (the exported
 * functions become its properties).
 */
function loadUpdater({config, store = {}, routes = {}} = {}) {
  const source = fs
    .readFileSync(MODULE_PATH, 'utf-8')
    // Strip normalize newlines for CRLF working trees, then the export
    // keywords: every export in this module is a function declaration, so the
    // classic-script evaluation exposes the full API as sandbox globals.
    .replace(/\r\n/g, '\n')
    .replace(/^export /gm, '');
  const sandbox = {
    ChromeUtils: {
      generateQI: () => () => {},
      importESModule(spec) {
        if (spec.includes('updater-config')) {
          return {CONFIG: config};
        }
        return {}; // Downloads.sys.mjs — unused by the channel logic
      },
    },
    Services: {
      prefs: makePrefs(store),
      appinfo: {OS: process.platform === 'win32' ? 'WINNT' : 'Linux', version: '140.0'},
      dirsvc: {get: () => ({path: os.tmpdir()})},
      io: makeIo(routes),
      scriptSecurityManager: {getSystemPrincipal: () => ({})},
    },
    Cc: makeCc(),
    Ci: new Proxy({}, {get: () => ({})}),
    console,
    TextEncoder,
    TextDecoder,
    atob,
    queueMicrotask,
  };
  vm.runInContext(source, vm.createContext(sandbox), {filename: 'scriptsUpdater.sys.mjs'});
  return sandbox;
}

/* ---------------- channel derivation ---------------- */

/**
 * getChannelState returns a sandbox-realm object, so deepStrictEqual's
 * prototype check would fail against test-realm literals — compare fields.
 */
function assertChannel(u, channel, migratedFromDev) {
  const s = u.getChannelState();
  assert.equal(s.channel, channel, 'channel');
  assert.equal(s.migratedFromDev, migratedFromDev, 'migratedFromDev');
}

test('stable build: own URLs, no suffix, failed check stays on stable silently', async () => {
  const u = loadUpdater({
    config: stableConfig(),
    routes: {[STABLE_HASHES]: {error: true}},
  });
  assert.equal(u.getHashesUrl(), STABLE_HASHES);
  assert.equal(u.getAssetSuffix(), '');
  const result = await u.checkScriptsUpdateNeeded();
  assert.equal(result.utils.updateNeeded, false);
  assertChannel(u, 'stable', false);
});

test('dev build on its own channel: dev URLs, -dev suffix, manifest compared', async () => {
  const u = loadUpdater({
    config: devConfig(),
    routes: {[DEV_HASHES]: {status: 200, body: MISMATCH_MANIFEST}},
  });
  assert.equal(u.getHashesUrl(), DEV_HASHES);
  assert.equal(u.getAssetSuffix(), '-dev');
  const result = await u.checkScriptsUpdateNeeded();
  assert.equal(result.utils.updateNeeded, true);
  assert.equal(result.utils.date, '2026-09-12');
  assertChannel(u, 'dev', false);
});

test('stored channel pref wins over the build mode (persisted migration)', () => {
  const u = loadUpdater({
    config: devConfig(), // IS_DEV true, but this build previously migrated
    store: {
      [PREF_CHANNEL]: 'stable',
      [PREF_CHANNEL_BUILD]: 'dev-build-main-abc1', // ...and the pref names it
    },
  });
  assert.equal(u.getHashesUrl(), STABLE_HASHES);
  assert.equal(u.getAssetSuffix(), '');
  assertChannel(u, 'stable', false);
});

test('a different dev build does not inherit a previous migration', async () => {
  // Build A migrated to stable and its branch died; the profile then installs
  // a fresh dev build B — B must evaluate its own dev channel (its manifest
  // may still be alive), not ride A's migration.
  const BUILD_B_HASHES =
    'https://cdn.jsdelivr.net/gh/onemen/firefox-scripts@dev-build-main-abc2/hashes.json';
  const u = loadUpdater({
    config: devConfig({
      HASHES_URL: BUILD_B_HASHES,
      DEV_BRANCH: 'dev-build-main-abc2',
    }),
    store: {
      [PREF_CHANNEL]: 'stable',
      [PREF_CHANNEL_BUILD]: 'dev-build-main-abc1', // belongs to build A
    },
    routes: {[BUILD_B_HASHES]: {status: 200, body: MISMATCH_MANIFEST}},
  });
  assert.equal(u.getHashesUrl(), BUILD_B_HASHES); // own dev URLs
  assert.equal(u.getAssetSuffix(), '-dev');
  const result = await u.checkScriptsUpdateNeeded();
  assert.equal(result.utils.updateNeeded, true);
  assertChannel(u, 'dev', false);
});

test('--local snapshot: never channels, keeps the build-mode suffix', () => {
  const u = loadUpdater({
    config: devConfig({IS_LOCAL: true, HASHES_URL: 'http://127.0.0.1:8777/hashes.json'}),
    // A reused harness profile must not inherit a real install's channel.
    store: {[PREF_CHANNEL]: 'stable'},
  });
  assert.equal(u.getHashesUrl(), 'http://127.0.0.1:8777/hashes.json');
  assert.equal(u.getAssetSuffix(), '-dev');
  assertChannel(u, 'local', false);
});

test('override prefs still steer the own-channel URLs (harness mechanism)', () => {
  const u = loadUpdater({
    config: devConfig(),
    store: {[`${PREF_OVERRIDE_PREFIX}HASHES_URL`]: 'http://127.0.0.1:8999/hashes.json'},
  });
  assert.equal(u.getHashesUrl(), 'http://127.0.0.1:8999/hashes.json');
});

test('stable build with a stored stable channel pref stays stable (no build pref)', () => {
  const u = loadUpdater({
    config: stableConfig(),
    store: {[PREF_CHANNEL]: 'stable'}, // no activeChannelBuild — a stable
    // build's stored channel is its own regardless.
  });
  assert.equal(u.getHashesUrl(), STABLE_HASHES);
  assertChannel(u, 'stable', false);
});

test('getUiBaseUrl keeps the pre-#102 zip-base fallback for dev configs', () => {
  const u = loadUpdater({config: devConfig({UI_BASE_URL: ''})});
  assert.equal(u.getUiBaseUrl(), DEV_ZIP);
});

/* ---------------- dead-test-channel fallback (ADR 0026 §3) ---------------- */

test('dead dev manifest: falls back to stable, migrates, resolves stable URLs', async () => {
  const routes = {
    [DEV_HASHES]: {error: true},
    [STABLE_HASHES]: {status: 200, body: MISMATCH_MANIFEST},
  };
  const store = {};
  const u = loadUpdater({config: devConfig(), store, routes});
  const result = await u.checkScriptsUpdateNeeded();

  // The stable manifest's content drove the comparison...
  assert.equal(result.utils.updateNeeded, true);
  assert.equal(result.utils.date, '2026-09-12');
  // ...the migration is recorded (session flag + persisted pref)...
  assertChannel(u, 'stable', true);
  assert.equal(store[PREF_CHANNEL], 'stable');
  assert.equal(store[PREF_CHANNEL_BUILD], 'dev-build-main-abc1');
  // ...each manifest was consulted exactly once...
  assert.equal(routes[DEV_HASHES].hits, 1);
  assert.equal(routes[STABLE_HASHES].hits, 1);
  // ...and the URL getters now resolve the stable channel.
  assert.equal(u.getZipBaseUrl(), STABLE_ZIP);
  assert.equal(u.getUiBaseUrl(), STABLE_UI);
  assert.equal(u.getHelperBaseUrl(), STABLE_HELPER);
  assert.equal(u.getAssetSuffix(), '');
});

test('dead dev manifest, stable also dead: silent exit, stays on dev', async () => {
  const routes = {
    [DEV_HASHES]: {error: true},
    [STABLE_HASHES]: {error: true},
  };
  const u = loadUpdater({config: devConfig(), routes});
  const result = await u.checkScriptsUpdateNeeded();
  assert.equal(result.utils.updateNeeded, false);
  assertChannel(u, 'dev', false);
  assert.equal(routes[STABLE_HASHES].hits, 1); // attempted, then gave up
});

test('pre-0026 dev build (no STABLE_HASHES_URL): silent exit, no stable attempt', async () => {
  const routes = {
    [DEV_HASHES]: {error: true},
    [STABLE_HASHES]: {status: 200, body: MISMATCH_MANIFEST},
  };
  const u = loadUpdater({config: devConfig({STABLE_HASHES_URL: ''}), routes});
  const result = await u.checkScriptsUpdateNeeded();
  assert.equal(result.utils.updateNeeded, false);
  assertChannel(u, 'dev', false);
  assert.equal(routes[STABLE_HASHES].hits, 0); // never consulted
});

test('fallback fetch honors the STABLE_HASHES_URL override pref (harness mechanism)', async () => {
  const LOCAL_STABLE = 'http://127.0.0.1:8999/hashes.json';
  const routes = {
    [DEV_HASHES]: {error: true},
    [LOCAL_STABLE]: {status: 200, body: MISMATCH_MANIFEST},
    [STABLE_HASHES]: {status: 200, body: MISMATCH_MANIFEST},
  };
  const u = loadUpdater({
    config: devConfig(),
    store: {[`${PREF_OVERRIDE_PREFIX}STABLE_HASHES_URL`]: LOCAL_STABLE},
    routes,
  });
  const result = await u.checkScriptsUpdateNeeded();
  assert.equal(result.utils.updateNeeded, true); // the override served the manifest
  assertChannel(u, 'stable', true);
  assert.equal(routes[LOCAL_STABLE].hits, 1);
  assert.equal(routes[STABLE_HASHES].hits, 0); // the baked URL was never hit
});

test('--local snapshot: own manifest failure never falls back', async () => {
  const routes = {
    'http://127.0.0.1:8777/hashes.json': {error: true},
    [STABLE_HASHES]: {status: 200, body: MISMATCH_MANIFEST},
  };
  const u = loadUpdater({
    config: devConfig({IS_LOCAL: true, HASHES_URL: 'http://127.0.0.1:8777/hashes.json'}),
    routes,
  });
  const result = await u.checkScriptsUpdateNeeded();
  assert.equal(result.utils.updateNeeded, false);
  assertChannel(u, 'local', false);
  assert.equal(routes[STABLE_HASHES].hits, 0);
});

test('live own manifest: fallback never consulted even when stable is reachable', async () => {
  const routes = {
    [DEV_HASHES]: {status: 200, body: MISMATCH_MANIFEST},
    [STABLE_HASHES]: {status: 200, body: MISMATCH_MANIFEST},
  };
  const u = loadUpdater({config: devConfig(), routes});
  await u.checkScriptsUpdateNeeded();
  assert.equal(routes[DEV_HASHES].hits, 1);
  assert.equal(routes[STABLE_HASHES].hits, 0);
});
