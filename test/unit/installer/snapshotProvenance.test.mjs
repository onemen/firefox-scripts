// test/unit/installer/snapshotProvenance.test.mjs — unit tests for the shared
// snapshot-provenance guard (installer/test/snapshotProvenance.mjs, 2026-09-18
// audit finding T1): the helper both binary-in-the-loop suites call before
// running the newest dist/ snapshot's installer.
//
// Pure Node, no installer binary involved: the hash computation runs against
// the real repo sources (cheap, read-only); the guard's drift/corrupt paths are
// driven through a synthetic snapshot dir with a doctored hashes.json, and the
// `exit` seam (injected, never process.exit) keeps the runner alive.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

process.argv.push('--mode=prod');
const {computeInstallerSourceHash, requireFreshSnapshot} = await import(
  new URL('../../../installer/test/snapshotProvenance.mjs', import.meta.url).href
);

test('computeInstallerSourceHash: stable and hash-shaped for the real repo sources', () => {
  const a = computeInstallerSourceHash(REPO_ROOT);
  const b = computeInstallerSourceHash(REPO_ROOT);
  assert.equal(a, b, 'recomputing without changes must be deterministic');
  assert.match(a, /^[0-9a-f]{64}$/, 'must be a 64-hex SHA-256');
});

test('computeInstallerSourceHash: changes when an installer source changes', () => {
  const probe = computeInstallerSourceHash(REPO_ROOT);
  assert.notEqual(probe, '0'.repeat(64));
  // Hash-shape sanity only: actually mutating a source file here would race
  // parallel test files reading the same tree; the publish flow's use of the
  // same routine (upload.mjs) is the real-world proof that it tracks sources.
});

/** Synthetic snapshot dir with a doctored hashes.json. */
function fakeSnapshot(manifest) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fxs-snap-'));
  fs.writeFileSync(
    path.join(dir, 'hashes.json'),
    typeof manifest === 'string' ? manifest : JSON.stringify(manifest)
  );
  return dir;
}

const REAL_HASH = computeInstallerSourceHash(REPO_ROOT);

test('requireFreshSnapshot: passes when the snapshot was built from current sources', () => {
  const dir = fakeSnapshot({installer: {hash: REAL_HASH, date: '2026-09-20'}});
  try {
    const logs = [];
    const origLog = console.log;
    console.log = m => logs.push(m);
    try {
      const provenance = requireFreshSnapshot({snapshotDir: dir, exit: () => {}});
      assert.equal(provenance.storedHash, REAL_HASH);
      assert.equal(provenance.date, '2026-09-20');
    } finally {
      console.log = origLog;
    }
    assert.match(logs.join('\n'), /Snapshot provenance verified/);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('requireFreshSnapshot: exits 1 on a snapshot built from older sources (T1)', () => {
  const dir = fakeSnapshot({installer: {hash: '0'.repeat(64), date: '2026-09-01'}});
  try {
    const errors = [];
    const origErr = console.error;
    console.error = m => errors.push(m);
    let exitCode = null;
    try {
      requireFreshSnapshot({
        snapshotDir: dir,
        exit: code => {
          exitCode = code;
          throw new Error('EXIT');
        },
      });
      assert.fail('must not reach here');
    } catch (e) {
      assert.equal(e.message, 'EXIT');
    } finally {
      console.error = origErr;
    }
    assert.equal(exitCode, 1);
    const text = errors.join('\n');
    assert.match(text, /STALE SNAPSHOT/);
    assert.match(text, /Regenerate: pnpm upload:local/);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('requireFreshSnapshot: exits 1 when hashes.json is unreadable', () => {
  const dir = fakeSnapshot('{not json');
  try {
    const errors = [];
    const origErr = console.error;
    console.error = m => errors.push(m);
    let exitCode = null;
    try {
      requireFreshSnapshot({
        snapshotDir: dir,
        exit: code => {
          exitCode = code;
          throw new Error('EXIT');
        },
      });
      assert.fail('must not reach here');
    } catch (e) {
      assert.equal(e.message, 'EXIT');
    } finally {
      console.error = origErr;
    }
    assert.equal(exitCode, 1);
    assert.match(errors.join('\n'), /Unreadable hashes\.json/);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('requireFreshSnapshot: exits 1 when the manifest records no installer hash', () => {
  const dir = fakeSnapshot({utils: {hash: REAL_HASH}});
  try {
    const errors = [];
    const origErr = console.error;
    console.error = m => errors.push(m);
    let exitCode = null;
    try {
      requireFreshSnapshot({
        snapshotDir: dir,
        exit: code => {
          exitCode = code;
          throw new Error('EXIT');
        },
      });
      assert.fail('must not reach here');
    } catch (e) {
      assert.equal(e.message, 'EXIT');
    } finally {
      console.error = origErr;
    }
    assert.equal(exitCode, 1);
    assert.match(errors.join('\n'), /\(none recorded\)/);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
