// test/unit/e2e/helpers.test.mjs — Unit tests for test/e2e/shared/helpers.mjs
//
// pollUntil's contract is what the E2E scenarios lean on: it returns the first
// truthy value, and null (never a throw) when its budget runs out, so a caller
// can assert on the outcome rather than hang. The daily-recheck-timer scenario
// waits on exactly that for the timer's third manifest fetch — a regression
// there used to surface as the scenario's own failure (see updater-e2e.mjs), so
// the primitive's timeout behaviour is worth pinning.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const helpersUrl = pathToFileURL(path.join(REPO_ROOT, 'test', 'e2e', 'shared', 'helpers.mjs')).href;
const {pollUntil, tempDir, rmDir, sweepLiveTempRoots, pruneStaleTempRoots} = await import(
  helpersUrl
);

test('pollUntil: returns the first truthy value', async () => {
  let calls = 0;
  const result = await pollUntil(
    () => {
      calls += 1;
      return calls === 3 ? 'ready' : null;
    },
    1000,
    1
  );
  assert.equal(result, 'ready');
  assert.equal(calls, 3);
});

test('pollUntil: stops as soon as the callback is truthy', async () => {
  let calls = 0;
  await pollUntil(
    () => {
      calls += 1;
      return calls >= 2;
    },
    1000,
    1
  );
  assert.equal(calls, 2, 'no extra attempts after the first truthy value');
});

test('pollUntil: null when the budget runs out, after waiting for it', async () => {
  const started = Date.now();
  const result = await pollUntil(() => false, 150, 10);
  const elapsed = Date.now() - started;
  assert.equal(result, null);
  assert.ok(elapsed >= 100, `should have used the budget, not returned early (${elapsed}ms)`);
});

test('pollUntil: a throwing callback surfaces as null, not an exception', async () => {
  // The first attempt is logged as a warning; that is deliberate (a server that
  // never comes up should say why) and must not change the return contract.
  const result = await pollUntil(
    () => {
      throw new Error('server not up');
    },
    120,
    10
  );
  assert.equal(result, null);
});

test('pollUntil: a hanging callback cannot extend the budget', async () => {
  const started = Date.now();
  const result = await pollUntil(
    () =>
      new Promise(() => {
        /* never settles */
      }),
    150,
    10
  );
  assert.equal(result, null);
  assert.ok(Date.now() - started < 5000, 'the deadline must cap a hanging attempt');
});

// ── Temp-root hygiene (ADR 0038) ───────────────────────────────────────────
// The E2E mkdtemps a ~50 MB profile per scenario into the OS temp dir and the
// per-scenario `finally` only covers the success path — a Ctrl-C or a hard kill
// stranded 11 of them (412 MB) in the user's Temp on 2026-10-02. Two layers
// reclaim them: the live-root registry swept on every way out of the process,
// and an age-based prune at the start of the next run.

const HOUR = 60 * 60 * 1000;

/** A sandbox temp dir holding the given dir names (each with one file). */
function makeSandbox(names) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fxs-hyg-sandbox-'));
  for (const name of names) {
    fs.mkdirSync(path.join(root, name), {recursive: true});
    fs.writeFileSync(path.join(root, name, 'marker'), 'x');
  }
  return root;
}

test('tempDir registers its root and sweepLiveTempRoots reclaims it', () => {
  const dir = tempDir('fxs-hyg-sweep');
  fs.writeFileSync(path.join(dir, 'payload'), 'x');
  assert.ok(fs.existsSync(dir));
  const removed = sweepLiveTempRoots();
  assert.ok(removed >= 1, 'the registered root is swept');
  assert.equal(fs.existsSync(dir), false);
});

test('rmDir removes the tree and clears the registration', () => {
  const dir = tempDir('fxs-hyg-rmdir');
  fs.writeFileSync(path.join(dir, 'payload'), 'x');
  rmDir(dir);
  assert.equal(fs.existsSync(dir), false);
  // A removed root is not swept again (it is already gone).
  const before = sweepLiveTempRoots();
  assert.equal(fs.existsSync(dir), false);
  assert.equal(typeof before, 'number');
});

test('pruneStaleTempRoots removes aged harness roots, keeps everything else', () => {
  const prefix = 'fxs-hyg-prune-';
  const sandbox = makeSandbox([
    `${prefix}old1`,
    `${prefix}old2`,
    'fxs-hyg-other-dir',
    'unrelated-tool-dir',
  ]);
  try {
    // Pretend the tree is 10h old: the two harness roots age out, the 24h-old
    // junk would too but is not ours, and the foreign dir is never touched.
    const {removed, kept} = pruneStaleTempRoots({
      minAgeMs: 6 * HOUR,
      prefixes: [prefix],
      tmp: sandbox,
      now: Date.now() + 10 * HOUR,
      log: () => {},
    });
    assert.deepEqual(removed.map(d => path.basename(d)).sort(), [`${prefix}old1`, `${prefix}old2`]);
    // `kept` lists harness roots that were considered but kept; entries the
    // prefix list does not claim are never even looked at.
    assert.deepEqual(kept, []);
    assert.equal(fs.existsSync(path.join(sandbox, `${prefix}old1`)), false);
    assert.equal(fs.existsSync(path.join(sandbox, 'unrelated-tool-dir')), true);
  } finally {
    fs.rmSync(sandbox, {recursive: true, force: true});
  }
});

test('pruneStaleTempRoots keeps a fresh root (a run in flight)', () => {
  const prefix = 'fxs-hyg-fresh-';
  const sandbox = makeSandbox([`${prefix}live`]);
  try {
    const {removed, kept} = pruneStaleTempRoots({
      minAgeMs: 6 * HOUR,
      prefixes: [prefix],
      tmp: sandbox,
      log: () => {},
    });
    assert.deepEqual(removed, []);
    assert.deepEqual(
      kept.map(d => path.basename(d)),
      [`${prefix}live`]
    );
  } finally {
    fs.rmSync(sandbox, {recursive: true, force: true});
  }
});

test('pruneStaleTempRoots never removes a root this process still holds', () => {
  const prefix = 'fxs-hyg-owned-';
  const dir = tempDir(prefix.slice(0, -1)); // mkdtemp appends its own suffix
  try {
    assert.ok(path.basename(dir).startsWith(prefix), dir);
    const {removed, kept} = pruneStaleTempRoots({
      minAgeMs: 0, // everything looks aged out
      prefixes: [prefix],
      now: Date.now() + 10 * HOUR,
      log: () => {},
    });
    assert.deepEqual(removed, []);
    assert.deepEqual(kept, [dir]);
    assert.equal(fs.existsSync(dir), true);
  } finally {
    rmDir(dir);
  }
});

test('pruneStaleTempRoots tolerates a missing temp dir', () => {
  assert.deepEqual(
    pruneStaleTempRoots({tmp: path.join(os.tmpdir(), 'fxs-hyg-does-not-exist'), log: () => {}}),
    {removed: [], kept: []}
  );
});
