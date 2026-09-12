// test/unit/e2e/scriptsUpdater-hash.test.mjs — unit tests for the real
// core/chrome/utils/updater/scriptsUpdater.sys.mjs hash/decision logic.
//
// The module is evaluated in a vm sandbox with stubbed Firefox services —
// the same technique as test/unit/core/scriptsUpdater-channel.test.mjs (#189).
// Nothing here is a reimplementation of the production algorithm: the
// assertions compare the REAL computeFilesHash / checkScriptsUpdateNeeded
// against an independent Node reference (crypto + fs directly).
//
// Covered: computeFilesHash algorithm (sorted, path+\n then content, missing
// files contribute path+\n only), the skip/up-to-date decision wiring inside
// checkScriptsUpdateNeeded (per-package skippedHash prefs, updater-ui's
// skip-less path), and manifest parsing edge cases.
//
// The C installer's twin algorithm is cross-checked separately by
// installer/test/test_hash.mjs (`pnpm test:hash`).

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

/* ---------------- independent reference (the tautology breaker) ------------- */

/**
 * Node-side reference of the manifest hash: sha256 over, per file (sorted
 * case-insensitively), rel_path + '\n' then file bytes; a missing file
 * contributes only path + '\n'. Written directly against crypto + fs —
 * deliberately NOT derived from the production source.
 */
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
 * Fetch stub. routes: url → {status, body} (success) or {error: true}
 * (transport failure). Unlisted urls fail too.
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
      // Serves BOTH callers: fetchBytes() wraps the HTTP response stream (an
      // {_bytes: Buffer}); computeFilesHash() wraps an nsIFileInputStream stub.
      // setInputStream binds to whichever it was handed.
      createInstance: () => {
        let bytes = null;
        return {
          setInputStream(s) {
            bytes = s._bytes ?? s._fileBytes;
          },
          // fetchBytes() path: binary.readByteArray over the response stream
          readByteArray(n) {
            return Array.from(bytes.subarray(0, n));
          },
          // computeFilesHash() path: binary.readArrayBuffer over a file stream
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
            const view = new Uint8Array(data); // the caller's ArrayBuffer
            fs.readSync(fd, view, 0, count, 0);
          },
          close() {
            fs.closeSync(fd);
          },
          // Read once up front so the wrapping binary stream can serve
          // readArrayBuffer without a second fd walk (see binaryinputstream).
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

const PREF_SKIP_PREFIX = 'extensions.firefox-scripts.skippedHash.';

/** Minimal generated updater config — the hashed file set never uses STABLE_*. */
function updaterConfig(overrides = {}) {
  return {
    HASHES_URL: 'https://manifest.test/hashes.json',
    ZIP_BASE_URL: 'https://zips.test',
    UI_BASE_URL: 'https://zips.test',
    HELPER_BASE_URL: 'https://zips.test',
    ASSET_SUFFIX: '-dev',
    IS_DEV: true,
    IS_LOCAL: false,
    ...overrides,
  };
}

/**
 * Evaluate the module in a fresh sandbox. Returns the sandbox (every export in
 * scriptsUpdater.sys.mjs is a function declaration, so stripping `export `
 * exposes the full API as sandbox globals).
 */
function loadUpdater({config = updaterConfig(), store = {}, routes = {}} = {}) {
  const source = fs
    .readFileSync(MODULE_PATH, 'utf-8')
    // Normalize CRLF working-tree copies, then strip the export keywords.
    .replace(/\r\n/g, '\n')
    .replace(/^export /gm, '');
  const dirs = {
    'utils': os.tmpdir(), // overridden per test that hashes real files
    'fx-folder': os.tmpdir(),
    'updater-ui': os.tmpdir(),
  };
  const sandbox = {
    ChromeUtils: {
      generateQI: () => () => {},
      importESModule(spec) {
        if (spec.includes('updater-config')) {
          return {CONFIG: config};
        }
        return {}; // Downloads.sys.mjs — unused by the hash/decision logic
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
    console,
    TextEncoder,
    TextDecoder,
    atob,
    queueMicrotask,
  };
  vm.runInContext(source, vm.createContext(sandbox), {filename: 'scriptsUpdater.sys.mjs'});
  return {sandbox, dirs};
}

/**
 * Build a temp tree of files. Returns {dir, cleanup} — the tree is hashed by
 * both the real module and the independent reference in the tests below.
 */
function makeTreeFixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fxs-hash-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), {recursive: true});
    fs.writeFileSync(p, content);
  }
  return {
    dir,
    cleanup: () => fs.rmSync(dir, {recursive: true, force: true}),
  };
}

/**
 * Point the sandbox's dirsvc at a fixture PROFILE: production hashes
 * `ProfD/chrome/utils` (and GreD for fx-folder), so the harness hands back
 * `profileDir/chrome/utils` for 'utils', `profileDir/chrome/utils/updater/ui`
 * for 'updater-ui', and GreD = a second temp dir.
 */
function makeProfileLayout(sandbox) {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fxs-hash-prof-'));
  const greDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fxs-hash-gre-'));
  sandbox.Services.dirsvc.get = name => {
    if (name === 'ProfD') return {path: profileDir};
    if (name === 'GreD' || name === 'XREExeF') return {path: greDir};
    return {path: os.tmpdir()};
  };
  return {
    utilsDir: path.join(profileDir, 'chrome', 'utils'),
    greDir,
    profileDir,
    cleanup: () => {
      fs.rmSync(profileDir, {recursive: true, force: true});
      fs.rmSync(greDir, {recursive: true, force: true});
    },
  };
}

/* ---------------- computeFilesHash (real, vs reference) ---------------- */

test('computeFilesHash: deterministic across calls', () => {
  const {sandbox} = loadUpdater();
  const {dir, cleanup} = makeTreeFixture({'a.js': '1', 'b.js': '2'});
  try {
    assert.equal(
      sandbox.computeFilesHash(['a.js', 'b.js'], dir),
      sandbox.computeFilesHash(['a.js', 'b.js'], dir)
    );
  } finally {
    cleanup();
  }
});

test('computeFilesHash: content change changes hash', () => {
  const {sandbox} = loadUpdater();
  const {dir, cleanup} = makeTreeFixture({'a.js': 'hello'});
  try {
    const h1 = sandbox.computeFilesHash(['a.js'], dir);
    fs.writeFileSync(path.join(dir, 'a.js'), 'world');
    const h2 = sandbox.computeFilesHash(['a.js'], dir);
    assert.notEqual(h1, h2);
  } finally {
    cleanup();
  }
});

test('computeFilesHash: sorted order independent of input order', () => {
  const {sandbox} = loadUpdater();
  const {dir, cleanup} = makeTreeFixture({'z.js': 'z', 'a.js': 'a'});
  try {
    assert.equal(
      sandbox.computeFilesHash(['z.js', 'a.js'], dir),
      sandbox.computeFilesHash(['a.js', 'z.js'], dir)
    );
  } finally {
    cleanup();
  }
});

test('computeFilesHash: matches the independent reference implementation', () => {
  const {sandbox} = loadUpdater();
  const {dir, cleanup} = makeTreeFixture({
    'z.js': 'zzz',
    'a/nested.txt': 'hello\nworld',
    'b.txt': 'bbb',
  });
  try {
    assert.equal(
      sandbox.computeFilesHash(['z.js', 'a/nested.txt', 'b.txt'], dir),
      referenceFilesHash(['z.js', 'a/nested.txt', 'b.txt'], dir)
    );
  } finally {
    cleanup();
  }
});

test('computeFilesHash: missing file contributes path+\\n only', () => {
  const {sandbox} = loadUpdater();
  const {dir, cleanup} = makeTreeFixture({'a.js': 'present'});
  try {
    const withMissing = sandbox.computeFilesHash(['a.js', 'missing.js'], dir);
    assert.equal(withMissing, referenceFilesHash(['a.js', 'missing.js'], dir));
    // Differs from the hash of just the present file.
    assert.notEqual(withMissing, sandbox.computeFilesHash(['a.js'], dir));
  } finally {
    cleanup();
  }
});

test('computeFilesHash: empty file list produces the hash of nothing', () => {
  const {sandbox} = loadUpdater();
  const {dir, cleanup} = makeTreeFixture({});
  try {
    assert.equal(
      sandbox.computeFilesHash([], dir),
      crypto.createHash('sha256').update('').digest('hex')
    );
  } finally {
    cleanup();
  }
});

test('computeFilesHash: nested paths compared case-insensitively', () => {
  const {sandbox} = loadUpdater();
  const {dir, cleanup} = makeTreeFixture({
    'B.txt': 'b',
    'a.txt': 'a',
    'A/nested.js': 'nested',
  });
  try {
    assert.equal(
      sandbox.computeFilesHash(['B.txt', 'a.txt', 'A/nested.js'], dir),
      referenceFilesHash(['B.txt', 'a.txt', 'A/nested.js'], dir)
    );
  } finally {
    cleanup();
  }
});

/* ------------- skip / up-to-date decision (real checkScriptsUpdateNeeded) --- */

const PREF_LAST_CHECK = 'extensions.firefox-scripts.lastScriptsCheckDate';
const PREF_LAST_SHOWN = 'extensions.firefox-scripts.lastUpdateTabShown';

/**
 * Install a utils tree into a sandboxed profile layout and fetch a manifest for
 * it. The manifest's utils hash is the INDEPENDENT reference value, so a
 * production regression cannot pass. filesByDir: relpath → content, written
 * under `ProfD/chrome/utils`.
 */
function setupDecisionScenario(utilsFiles = {'updater.js': 'real code'}, skipPref = '') {
  const u = loadUpdater({});
  const layout = makeProfileLayout(u.sandbox);
  fs.mkdirSync(layout.utilsDir, {recursive: true});
  const allFiles = [];
  for (const [rel, content] of Object.entries(utilsFiles)) {
    const p = path.join(layout.utilsDir, rel);
    fs.mkdirSync(path.dirname(p), {recursive: true});
    fs.writeFileSync(p, content);
    allFiles.push(rel);
  }
  const manifest = {
    utils: {
      hash: referenceFilesHash(allFiles, layout.utilsDir),
      files: allFiles,
      date: '2026-09-12',
    },
  };
  if (skipPref) {
    u.sandbox.Services.prefs.setCharPref(`${PREF_SKIP_PREFIX}utils`, skipPref);
  }
  u.sandbox.Services.io = makeIo(manifestRoute(manifest));
  return {u, layout, manifest};
}

function manifestRoute(manifest) {
  return {'https://manifest.test/hashes.json': {status: 200, body: JSON.stringify(manifest)}};
}

test('stale utils: checkScriptsUpdateNeeded flags the update (manifest vs reference)', async () => {
  const {u, layout, manifest} = setupDecisionScenario();
  try {
    // Make the local tree differ from the manifest: append a comment AFTER the
    // manifest was computed from the clean tree.
    fs.appendFileSync(path.join(layout.utilsDir, 'updater.js'), '\n// changed\n');
    const result = await u.sandbox.checkScriptsUpdateNeeded();
    assert.equal(result.utils.updateNeeded, true, 'stale fixture must need an update');
    assert.equal(result.utils.remoteHash, manifest.utils.hash);
    assert.equal(result.utils.date, '2026-09-12');
  } finally {
    layout.cleanup();
  }
});

test('up-to-date utils: no update, and a stale skip pref is cleared', async () => {
  const {u, layout} = setupDecisionScenario(
    {'updater.js': 'real code'},
    'old-skip-hash' // skipped an older release
  );
  try {
    const result = await u.sandbox.checkScriptsUpdateNeeded();
    assert.equal(result.utils.updateNeeded, false, 'matching tree must be up to date');
    // Local matches remote → the stale skip pref is cleared (production
    // semantics: skipHash !== remote.hash → clearUserPref).
    assert.ok(!hasSkipPref(u, 'utils'), 'stale skip pref must be cleared');
  } finally {
    layout.cleanup();
  }
});

test('skipped version: update suppressed while the remote hash is unchanged', async () => {
  const {u, layout, manifest} = setupDecisionScenario();
  u.sandbox.Services.prefs.setCharPref(`${PREF_SKIP_PREFIX}utils`, manifest.utils.hash);
  try {
    fs.appendFileSync(path.join(layout.utilsDir, 'updater.js'), '\n// changed\n');
    const result = await u.sandbox.checkScriptsUpdateNeeded();
    assert.equal(result.utils.updateNeeded, false, 'skip must suppress the update');
  } finally {
    layout.cleanup();
  }
});

test('skip cleared when the remote hash changed (new release)', async () => {
  const {u, layout, manifest} = setupDecisionScenario();
  u.sandbox.Services.prefs.setCharPref(`${PREF_SKIP_PREFIX}utils`, manifest.utils.hash);
  try {
    fs.appendFileSync(path.join(layout.utilsDir, 'updater.js'), '\n// changed\n');
    const newRemote = 'e'.repeat(64);
    u.sandbox.Services.io = makeIo(
      manifestRoute({...manifest, utils: {...manifest.utils, hash: newRemote}})
    );
    const result = await u.sandbox.checkScriptsUpdateNeeded();
    assert.equal(result.utils.updateNeeded, true, 'new remote hash overrides the old skip');
    assert.ok(!hasSkipPref(u, 'utils'), 'skip pref cleared for the new version');
  } finally {
    layout.cleanup();
  }
});

test('updater-ui: hash mismatch needs update with NO skip logic', async () => {
  const {u, layout, manifest} = setupDecisionScenario();
  try {
    fs.appendFileSync(path.join(layout.utilsDir, 'updater.js'), '\n// changed\n');
    const uiHash = 'f'.repeat(64); // never matches the empty local ui dir
    u.sandbox.Services.prefs.setCharPref(`${PREF_SKIP_PREFIX}updater-ui`, uiHash);
    u.sandbox.Services.io = makeIo(
      manifestRoute({
        ...manifest,
        'updater-ui': {hash: uiHash, files: ['ui/updater.html'], date: '2026-09-12'},
      })
    );
    const result = await u.sandbox.checkScriptsUpdateNeeded();
    assert.equal(result.updaterUi.updateNeeded, true, 'updater-ui ignores skip prefs');
  } finally {
    layout.cleanup();
  }
});

test('no remote entry: package stays up to date (manifest edge)', async () => {
  const {u, layout, manifest} = setupDecisionScenario();
  try {
    fs.appendFileSync(path.join(layout.utilsDir, 'updater.js'), '\n// changed\n');
    u.sandbox.Services.io = makeIo(manifestRoute({...manifest, utils: undefined}));
    const result = await u.sandbox.checkScriptsUpdateNeeded();
    assert.equal(result.utils.updateNeeded, false);
    assert.equal(result.utils.remoteHash, '');
  } finally {
    layout.cleanup();
  }
});

test('transport failure: check exits silently as no-update (no throw)', async () => {
  const {u, layout} = setupDecisionScenario();
  try {
    u.sandbox.Services.io = makeIo({'https://manifest.test/hashes.json': {error: true}});
    const result = await u.sandbox.checkScriptsUpdateNeeded();
    assert.equal(result.utils.updateNeeded, false);
  } finally {
    layout.cleanup();
  }
});

/** The skip pref lives in the sandbox's pref store; assert through it. */
function hasSkipPref(u, pkgKey) {
  return Boolean(u.sandbox.Services.prefs.getStringPref(`${PREF_SKIP_PREFIX}${pkgKey}`, ''));
}

/* ---------------- manifest parsing ---------------- */

test('parseManifest: valid JSON returns parsed object', () => {
  const manifest = JSON.stringify({
    'utils': {hash: 'abc', files: ['a.js']},
    'fx-folder': {hash: 'def', files: ['config.js']},
    'updater-ui': {hash: 'ghi', files: ['updater.html']},
  });
  const parsed = JSON.parse(manifest);
  assert.ok(parsed);
  assert.equal(parsed.utils.hash, 'abc');
  assert.deepEqual(parsed.utils.files, ['a.js']);
});

test('parseManifest: invalid JSON is caught by the check (stays no-update)', () => {
  // The production path is JSON.parse inside the try of
  // checkScriptsUpdateNeeded: invalid bodies are swallowed by the same catch
  // as transport errors and the check exits as no-update (asserted by the
  // transport-failure test above). The parser itself is platform JSON.parse.
  assert.throws(() => JSON.parse('{bad json'));
  assert.throws(() => JSON.parse(''));
  assert.throws(() => JSON.parse('not json'));
});

test('manifest entry gating: entries without hash or files array are skipped', async () => {
  const {u, layout, manifest} = setupDecisionScenario();
  try {
    fs.appendFileSync(path.join(layout.utilsDir, 'updater.js'), '\n// changed\n');
    u.sandbox.Services.io = makeIo(
      manifestRoute({
        'utils': {...manifest.utils, hash: 'b'.repeat(64)},
        'fx-folder': {hash: 'abc'}, // no files array → skipped
        'updater-ui': {files: ['ui/x.html']}, // no hash → skipped
      })
    );
    const result = await u.sandbox.checkScriptsUpdateNeeded();
    // utils was compared (real hash mismatch → update needed)...
    assert.equal(result.utils.updateNeeded, true);
    // ...the malformed entries contributed nothing at all.
    assert.equal(result.fxFolder.remoteHash, '');
    assert.equal(result.updaterUi.remoteHash, '');
    assert.equal(result.fxFolder.updateNeeded, false);
    assert.equal(result.updaterUi.updateNeeded, false);
  } finally {
    layout.cleanup();
  }
});

// Pref names verified against the module source; kept as a canary so a rename
// upstream fails loudly here instead of silently un-gating the daily check.
test('pref-name canary: the daily-check prefs keep their names', () => {
  const source = fs.readFileSync(MODULE_PATH, 'utf-8');
  assert.ok(source.includes(`'${PREF_LAST_CHECK}'`));
  assert.ok(source.includes(`'${PREF_LAST_SHOWN}'`));
  assert.ok(source.includes(`'${PREF_SKIP_PREFIX}`));
});
