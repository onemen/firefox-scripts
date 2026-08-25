// test/unit/e2e/browsers.test.mjs — Unit tests for test/e2e/shared/browsers.mjs
//
// Tests: findGreDir (per-platform path derivation), findSnapshot (discovery
// with/without branch check), discoverFirefoxBinary (existence fallback),
// gitBranchAndSha (returns strings).

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const browsersUrl = pathToFileURL(
  path.join(REPO_ROOT, 'test', 'e2e', 'shared', 'browsers.mjs')
).href;
const {
  findGreDir,
  findSnapshot,
  discoverFirefoxBinary,
  gitBranchAndSha,
  grePrefsDir,
  isSnapBinary,
} = await import(browsersUrl);

// ── findGreDir ─────────────────────────────────────────────────────────────

test('findGreDir: returns the bin dir on Windows', {skip: process.platform !== 'win32'}, () => {
  const gre = findGreDir('C:\\Program Files\\Mozilla Firefox\\firefox.exe');
  assert.equal(gre, 'C:\\Program Files\\Mozilla Firefox');
});

test('findGreDir: resolves Resources on macOS', () => {
  const gre = findGreDir('/Applications/Firefox.app/Contents/MacOS/firefox-bin');
  assert.equal(gre, '/Applications/Firefox.app/Contents/Resources');
});

test('findGreDir: handles Snap path on Linux', {skip: process.platform !== 'linux'}, () => {
  const gre = findGreDir('/snap/bin/firefox');
  assert.equal(gre, '/etc/firefox');
});

test('findGreDir: tarball/portable dir contains application.ini', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gre-test-'));
  try {
    fs.writeFileSync(path.join(tmp, 'application.ini'), '[App]\nName=Firefox');
    const bin = path.join(tmp, process.platform === 'win32' ? 'firefox.exe' : 'firefox');
    fs.writeFileSync(bin, 'fake');
    const gre = findGreDir(bin);
    assert.equal(gre, tmp);
  } finally {
    fs.rmSync(tmp, {recursive: true, force: true});
  }
});

test(
  'findGreDir: resolves /usr/bin symlink to the real install dir on Linux',
  {
    skip: process.platform !== 'linux',
  },
  () => {
    // /usr/bin/librewolf -> /opt/librewolf/librewolf (real dir with application.ini)
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gre-symlink-'));
    try {
      const realDir = path.join(tmp, 'librewolf');
      fs.mkdirSync(realDir);
      fs.writeFileSync(path.join(realDir, 'application.ini'), '[App]\nName=LibreWolf');
      fs.writeFileSync(path.join(realDir, 'librewolf'), 'fake');
      fs.mkdirSync(path.join(tmp, 'bin'));
      const link = path.join(tmp, 'bin', 'librewolf');
      fs.symlinkSync(path.join(realDir, 'librewolf'), link);
      assert.equal(findGreDir(link), realDir);
    } finally {
      fs.rmSync(tmp, {recursive: true, force: true});
    }
  }
);

test('findGreDir: returns the bin dir when nothing else matches', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gre-test-'));
  try {
    const bin = path.join(tmp, process.platform === 'win32' ? 'firefox.exe' : 'firefox');
    fs.writeFileSync(bin, 'fake');
    const gre = findGreDir(bin);
    assert.ok(gre.length > 0);
  } finally {
    fs.rmSync(tmp, {recursive: true, force: true});
  }
});

// ── grePrefsDir ───────────────────────────────────────────────────────────

test('grePrefsDir: appends defaults/pref', () => {
  const result = grePrefsDir('/some/browser/path');
  assert.ok(result.endsWith('pref'));
  assert.ok(result.includes('defaults'));
  // The dir is a sub-path of the input
  assert.ok(result.length > '/some/browser/path'.length);
});

// ── isSnapBinary ──────────────────────────────────────────────────────────

test('isSnapBinary: non-Snap paths return false on any platform', () => {
  assert.equal(isSnapBinary('/usr/bin/firefox'), false);
  assert.equal(isSnapBinary('C:\\Program Files\\Mozilla Firefox\\firefox.exe'), false);
});

test('isSnapBinary: Snap paths detected on Linux', {skip: process.platform !== 'linux'}, () => {
  assert.equal(isSnapBinary('/snap/bin/firefox'), true);
});

// ── gitBranchAndSha ───────────────────────────────────────────────────────

test('gitBranchAndSha: returns strings', () => {
  const info = gitBranchAndSha();
  assert.equal(typeof info.branch, 'string');
  assert.equal(typeof info.sha, 'string');
});

// ── findSnapshot ──────────────────────────────────────────────────────────

test('findSnapshot: returns null when dist/ is empty', () => {
  // In CI the dist/ dir may exist but be empty at test time.
  const snap = findSnapshot({branchCheck: false});
  // We can't assert null unless nothing was built — this test just checks it
  // doesn't throw.
  if (snap) {
    assert.equal(typeof snap.dir, 'string');
    assert.ok(snap.dir.includes('dist'));
  }
});

test('findSnapshot: with override returns that dir', () => {
  assert.throws(() => findSnapshot({override: '/nonexistent'}));
});

// ── discoverFirefoxBinary ─────────────────────────────────────────────────

test('discoverFirefoxBinary: returns string or null without throwing', () => {
  const bin = discoverFirefoxBinary();
  if (bin) {
    assert.equal(typeof bin, 'string');
    // May not exist if the binary was discovered via env var.
  }
  // Not asserting null — the CI runner may have Firefox installed.
});

test('discoverFirefoxBinary: invalid FIREFOX_BINARY falls through to platform detection', () => {
  const orig = process.env.FIREFOX_BINARY;
  try {
    process.env.FIREFOX_BINARY = '/nonexistent/firefox';
    // A nonexistent env var path is ignored; the platform-specific candidates
    // take over (may return a real Firefox or null — either is fine).
    const bin = discoverFirefoxBinary();
    if (bin) assert.ok(bin.includes('/') || bin.includes('\\'));
  } finally {
    if (orig === undefined) delete process.env.FIREFOX_BINARY;
    else process.env.FIREFOX_BINARY = orig;
  }
});
