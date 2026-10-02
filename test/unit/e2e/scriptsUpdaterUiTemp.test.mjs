// test/unit/e2e/scriptsUpdaterUiTemp.test.mjs — the updater's temp-dir hygiene
// (ADR 0038).
//
// ensureUpdaterUi() stages updater-ui.zip in PathUtils.tempDir and removes the
// staging dir in a `finally` — which never runs when the browser is killed
// mid-swap (a shutdown during the copy, an OS crash). Four such dirs, each
// still holding updater-ui.zip plus the extracted tree, were sitting in the
// user's Temp on 2026-10-02. Two defences are pinned here:
//
//   1. the staging dir is named per browser PROCESS, so the several checks one
//      session runs share one dir (cleared before each use) and two processes
//      never collide over it;
//   2. sweepStaleUpdaterUiTempDirs() reclaims dirs older than a day, which is
//      every stranded one and never a live session's (minutes old).
//
// The module is evaluated in a vm sandbox (same approach as
// scriptsUpdater-hash.test.mjs) so the real PathUtils/IOUtils surface can be
// backed by the real filesystem in a temp dir. Arrays it returns are sandbox
// arrays: spread them into this realm before deepEqual (the prototype differs).

import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
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

const tempRoots = [];
after(() => {
  for (const root of tempRoots) {
    try {
      fs.rmSync(root, {recursive: true, force: true});
    } catch {
      /* ignore */
    }
  }
});

/** Real-fs IOUtils over a sandbox temp dir. */
function makeIoUtils() {
  return {
    getChildren: async dir => fs.readdirSync(dir),
    stat: async p => fs.statSync(p),
    remove: async (p, {recursive = false, ignoreAbsent = false} = {}) => {
      try {
        fs.rmSync(p, {recursive, force: true});
      } catch (err) {
        if (!ignoreAbsent) throw err;
      }
    },
  };
}

/** Evaluate scriptsUpdater.sys.mjs with just enough sandbox to reach the sweep. */
function loadUpdater(tempDir) {
  const source = fs
    .readFileSync(MODULE_PATH, 'utf-8')
    .replace(/\r\n/g, '\n')
    .replace(/^export /gm, '');
  const sandbox = {
    ChromeUtils: {
      generateQI: () => () => {},
      importESModule: () => ({CONFIG: {HASHES_URL: '', ZIP_BASE_URL: '', UI_BASE_URL: ''}}),
    },
    Services: {
      prefs: {getCharPref: () => '', getStringPref: () => '', setStringPref: () => {}},
      appinfo: {OS: 'WINNT', processID: 4242},
    },
    PathUtils: {tempDir, profileDir: tempDir, join: path.join},
    IOUtils: makeIoUtils(),
    Cc: {},
    Ci: new Proxy({}, {get: () => ({})}),
    console: {log() {}, warn() {}, error() {}, debug() {}},
    TextEncoder,
    TextDecoder,
    atob,
    queueMicrotask,
  };
  vm.runInContext(source, vm.createContext(sandbox), {filename: 'scriptsUpdater.sys.mjs'});
  return sandbox;
}

/** A temp dir plus two staging dirs inside it; {root, stale, live}. */
function makeTempFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fxs-ui-temp-'));
  tempRoots.push(root);
  const stale = path.join(root, 'fxs-updater-ui-1700000000000');
  const live = path.join(root, 'fxs-updater-ui-4242');
  for (const dir of [stale, live]) {
    fs.mkdirSync(path.join(dir, 'extracted'), {recursive: true});
    fs.writeFileSync(path.join(dir, 'updater-ui.zip'), 'zip');
    fs.writeFileSync(path.join(dir, 'extracted', 'updater.html'), '<html>');
  }
  // A foreign temp entry that must never be touched.
  fs.mkdirSync(path.join(root, 'someone-elses-dir'), {recursive: true});
  return {root, stale, live};
}

/** Backdate a tree's mtime (the sweep reads mtime, not ctime). */
function backdate(dir, ms) {
  const when = new Date(Date.now() - ms);
  fs.utimesSync(dir, when, when);
}

test('sweepStaleUpdaterUiTempDirs: removes a stranded staging dir, keeps a live one', async () => {
  const {root, stale, live} = makeTempFixture();
  backdate(stale, 48 * 60 * 60 * 1000);
  const sandbox = loadUpdater(root);

  const removed = await sandbox.sweepStaleUpdaterUiTempDirs({tempDir: root});

  assert.deepEqual([...removed], ['fxs-updater-ui-1700000000000']);
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(live), true, "this session's staging dir stays");
  assert.equal(fs.existsSync(path.join(root, 'someone-elses-dir')), true);
});

test('sweepStaleUpdaterUiTempDirs: a fresh dir is never swept', async () => {
  const {root, live} = makeTempFixture();
  const sandbox = loadUpdater(root);

  assert.deepEqual([...(await sandbox.sweepStaleUpdaterUiTempDirs({tempDir: root}))], []);
  assert.equal(fs.existsSync(live), true);
});

test('sweepStaleUpdaterUiTempDirs: maxAgeMs is the only knob, and it is forgiving', async () => {
  const {root, stale} = makeTempFixture();
  backdate(stale, 30 * 60 * 1000); // 30 minutes
  const sandbox = loadUpdater(root);

  assert.deepEqual([...(await sandbox.sweepStaleUpdaterUiTempDirs({tempDir: root}))], []);
  assert.deepEqual(
    [...(await sandbox.sweepStaleUpdaterUiTempDirs({tempDir: root, maxAgeMs: 60 * 1000}))],
    ['fxs-updater-ui-1700000000000']
  );

  // A temp dir that cannot be listed must degrade to "removed nothing", never
  // to a thrown rejection (init calls this fire-and-forget).
  assert.deepEqual(
    [...(await sandbox.sweepStaleUpdaterUiTempDirs({tempDir: path.join(root, 'nope')}))],
    []
  );
});

test('the staging dir name is per process, so one session reuses one dir', () => {
  const {root} = makeTempFixture();
  const sandbox = loadUpdater(root);
  // Module-private, but stripping `export ` leaves it a sandbox global — the
  // same trick scriptsUpdater-hash.test.mjs uses.
  assert.equal(sandbox.uiTempDirName(), 'fxs-updater-ui-4242');
  assert.equal(
    sandbox.uiTempDirName(),
    sandbox.uiTempDirName(),
    'stable within a process: repeated checks reuse (and re-clear) one dir'
  );
});

test('without a process id the staging name falls back to a unique-per-check suffix', () => {
  const {root} = makeTempFixture();
  const sandbox = loadUpdater(root);
  sandbox.Services.appinfo.processID = undefined;
  const first = sandbox.uiTempDirName();
  assert.match(first, /^fxs-updater-ui-\d+$/);
  assert.notEqual(first, 'fxs-updater-ui-4242');
});
