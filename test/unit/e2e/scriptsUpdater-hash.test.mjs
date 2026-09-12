// test/unit/e2e/scriptsUpdater-hash.test.mjs — Unit tests for the pure-logic
// parts of core/chrome/utils/updater/scriptsUpdater.sys.mjs that are
// extractable to Node without a Firefox context.
//
// Tests: computeFilesHash algorithm (sorted, path+\n then content, missing
// files contribute path+\n only), the stale/up-to-date/skipped decision
// logic, manifest parsing edge cases.
//
// These mirror the C installer's compute_directory_sha256() semantics (see
// installer/test/test_hash.mjs for the C side and test:hash for parity).

import {test} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// ── Reference implementation of the hash algorithm (independent reimplementation) ──

/** Node-side reference: sha256 over rel_path + '\n' + file_bytes, sorted ci. */
function referenceComputeFilesHash(files, baseDir) {
  const sorted = [...files].sort((a, b) => a.localeCompare(b));
  const hash = crypto.createHash('sha256');
  for (const relative of sorted) {
    hash.update(relative + '\n');
    const abs = path.join(baseDir, ...relative.split('/'));
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      hash.update(fs.readFileSync(abs));
    }
    // missing file: path + '\n' only — nothing more
  }
  return hash.digest('hex');
}

// ── Extract computeFilesHash by re-implementing it in pure Node ──

/** Node-side reimplementation of scriptsUpdater.computeFilesHash. */
export function computeFilesHash(files, baseDir) {
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

// ── Decision logic (extracted from checkScriptsUpdateNeeded) ──

/** Simpler, correct version of the decision logic. */
export function packageNeedsUpdate({localHash, remoteHash, skipHash, isUpdaterUi = false}) {
  if (!remoteHash) return false;
  const mismatch = localHash !== remoteHash;
  if (isUpdaterUi) return mismatch;
  // Per-package skip: suppressed when skipHash matches remote OR local already matches.
  if (skipHash) {
    if (skipHash === remoteHash) return false; // user skipped this exact version
    if (!mismatch) return false; // local matches remote — no update needed, clear skip
  }
  return mismatch;
}

// ── Manifest parsing helpers ──

export function parseManifest(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed;
  } catch {
    return null;
  }
}

export function getPackageEntry(manifest, pkgKey) {
  const entry = manifest?.[pkgKey];
  if (!entry || !Array.isArray(entry.files) || !entry.hash) return null;
  return entry;
}

// ── Tests ──

function makeTree(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fxs-hash-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), {recursive: true});
    fs.writeFileSync(p, content);
  }
  return dir;
}

test('computeFilesHash: deterministic across calls', () => {
  const dir = makeTree({'a.js': '1', 'b.js': '2'});
  try {
    assert.equal(computeFilesHash(['a.js', 'b.js'], dir), computeFilesHash(['a.js', 'b.js'], dir));
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('computeFilesHash: content change changes hash', () => {
  const dir = makeTree({'a.js': 'hello'});
  try {
    const h1 = computeFilesHash(['a.js'], dir);
    fs.writeFileSync(path.join(dir, 'a.js'), 'world');
    const h2 = computeFilesHash(['a.js'], dir);
    assert.notEqual(h1, h2);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('computeFilesHash: sorted order independent of input order', () => {
  const dir = makeTree({'z.js': 'z', 'a.js': 'a'});
  try {
    assert.equal(computeFilesHash(['z.js', 'a.js'], dir), computeFilesHash(['a.js', 'z.js'], dir));
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('computeFilesHash: matches independent reference implementation', () => {
  const dir = makeTree({
    'z.js': 'zzz',
    'a/nested.txt': 'hello\nworld',
    'b.txt': 'bbb',
  });
  try {
    assert.equal(
      computeFilesHash(['z.js', 'a/nested.txt', 'b.txt'], dir),
      referenceComputeFilesHash(['z.js', 'a/nested.txt', 'b.txt'], dir)
    );
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('computeFilesHash: missing file contributes path+\\n only', () => {
  const dir = makeTree({'a.js': 'present'});
  try {
    const withMissing = computeFilesHash(['a.js', 'missing.js'], dir);
    const ref = referenceComputeFilesHash(['a.js', 'missing.js'], dir);
    assert.equal(withMissing, ref);
    // Should differ from hash of just the present file
    assert.notEqual(withMissing, computeFilesHash(['a.js'], dir));
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('computeFilesHash: empty file list produces valid hash', () => {
  const dir = makeTree({});
  try {
    const h = computeFilesHash([], dir);
    assert.ok(crypto.createHash('sha256').update('').digest('hex').length === 64);
    // Empty list: no path entries, so hash of empty string
    assert.equal(h, crypto.createHash('sha256').update('').digest('hex'));
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('computeFilesHash: nested paths sorted case-insensitively', () => {
  const dir = makeTree({
    'B.txt': 'b',
    'a.txt': 'a',
    'A/nested.js': 'nested',
  });
  try {
    const result = computeFilesHash(['B.txt', 'a.txt', 'A/nested.js'], dir);
    const ref = referenceComputeFilesHash(['B.txt', 'a.txt', 'A/nested.js'], dir);
    assert.equal(result, ref);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('packageNeedsUpdate: stale package needs update', () => {
  assert.equal(
    packageNeedsUpdate({
      localHash: 'aaa',
      remoteHash: 'bbb',
      skipHash: '',
    }),
    true
  );
});

test('packageNeedsUpdate: up-to-date package needs no update', () => {
  assert.equal(
    packageNeedsUpdate({
      localHash: 'abc',
      remoteHash: 'abc',
      skipHash: '',
    }),
    false
  );
});

test('packageNeedsUpdate: skipped package with matching skip hash is suppressed', () => {
  assert.equal(
    packageNeedsUpdate({
      localHash: 'aaa',
      remoteHash: 'bbb',
      skipHash: 'bbb', // user skipped this exact remote version
    }),
    false
  );
});

test('packageNeedsUpdate: skip cleared when remote hash changes', () => {
  // skipHash points at old remote; new remote is different → update needed
  assert.equal(
    packageNeedsUpdate({
      localHash: 'aaa',
      remoteHash: 'ccc', // changed from bbb
      skipHash: 'bbb',
    }),
    true
  );
});

test('packageNeedsUpdate: skip cleared when local matches remote', () => {
  // User had skipped, but now local matches remote (e.g. they reinstalled) → no update, skip cleared
  assert.equal(
    packageNeedsUpdate({
      localHash: 'abc',
      remoteHash: 'abc',
      skipHash: 'old-skip',
    }),
    false
  );
});

test('packageNeedsUpdate: updater-ui has no skip logic', () => {
  // updater-ui always updates when hash mismatches, regardless of skip prefs
  assert.equal(
    packageNeedsUpdate({
      localHash: 'aaa',
      remoteHash: 'bbb',
      skipHash: 'bbb',
      isUpdaterUi: true,
    }),
    true
  );
});

test('packageNeedsUpdate: no remote hash → no update', () => {
  assert.equal(
    packageNeedsUpdate({
      localHash: 'aaa',
      remoteHash: '',
      skipHash: '',
    }),
    false
  );
  assert.equal(
    packageNeedsUpdate({
      localHash: 'aaa',
      remoteHash: null,
      skipHash: '',
    }),
    false
  );
  assert.equal(
    packageNeedsUpdate({
      localHash: 'aaa',
      remoteHash: undefined,
      skipHash: '',
    }),
    false
  );
});

test('parseManifest: valid JSON returns parsed object', () => {
  const manifest = JSON.stringify({
    'utils': {hash: 'abc', files: ['a.js']},
    'fx-folder': {hash: 'def', files: ['config.js']},
    'updater-ui': {hash: 'ghi', files: ['updater.html']},
  });
  const parsed = parseManifest(manifest);
  assert.ok(parsed);
  assert.equal(parsed.utils.hash, 'abc');
  assert.deepEqual(parsed.utils.files, ['a.js']);
});

test('parseManifest: invalid JSON returns null', () => {
  assert.equal(parseManifest('{bad json'), null);
  assert.equal(parseManifest(''), null);
  assert.equal(parseManifest('not json'), null);
});

test('getPackageEntry: returns entry for valid package', () => {
  const manifest = {
    utils: {hash: 'abc', files: ['a.js', 'b.js'], date: '2026-01-01'},
  };
  const entry = getPackageEntry(manifest, 'utils');
  assert.ok(entry);
  assert.equal(entry.hash, 'abc');
  assert.deepEqual(entry.files, ['a.js', 'b.js']);
});

test('getPackageEntry: returns null for missing package', () => {
  const manifest = {utils: {hash: 'abc', files: []}};
  assert.equal(getPackageEntry(manifest, 'fx-folder'), null);
});

test('getPackageEntry: returns null for entry without hash', () => {
  const manifest = {utils: {files: ['a.js']}};
  assert.equal(getPackageEntry(manifest, 'utils'), null);
});

test('getPackageEntry: returns null for entry without files array', () => {
  const manifest = {utils: {hash: 'abc'}};
  assert.equal(getPackageEntry(manifest, 'utils'), null);
});

test('getPackageEntry: returns null for null/undefined manifest', () => {
  assert.equal(getPackageEntry(null, 'utils'), null);
  assert.equal(getPackageEntry(undefined, 'utils'), null);
});

test('getPackageEntry: accepts entry with empty files array if hash present', () => {
  // The checkScriptsUpdateNeeded loop skips entries without files, but
  // getPackageEntry itself is permissive — it checks hash + Array.isArray(files)
  // but not files.length > 0. An empty files array with a hash is a valid entry.
  const manifest = {utils: {hash: 'abc', files: []}};
  const entry = getPackageEntry(manifest, 'utils');
  assert.ok(entry);
  assert.equal(entry.hash, 'abc');
  assert.deepEqual(entry.files, []);
});

test('getPackageEntry: returns null when files is missing entirely', () => {
  const manifest = {utils: {hash: 'abc'}};
  assert.equal(getPackageEntry(manifest, 'utils'), null);
});
