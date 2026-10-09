// test/unit/e2e/helpers.test.mjs — Unit tests for test/e2e/shared/helpers.mjs
//
// pollUntil's contract is what the E2E scenarios lean on: it returns the first
// truthy value, and null (never a throw) when its budget runs out, so a caller
// can assert on the outcome rather than hang. The daily-recheck-timer scenario
// waits on exactly that for the timer's third manifest fetch, so the
// primitive's timeout behaviour is pinned here.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const helpersUrl = pathToFileURL(path.join(REPO_ROOT, 'test', 'e2e', 'shared', 'helpers.mjs')).href;
const {
  pollUntil,
  tempDir,
  rmDir,
  sweepLiveTempRoots,
  pruneStaleTempRoots,
  withLockRetrySync,
  readFileSyncWithRetry,
  writeFileSyncWithRetry,
} = await import(helpersUrl);

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

// ── withLockRetrySync (Windows file-lock race) ────────────────────────────
// The updater E2E reads and writes files a running browser holds; a bare
// readFileSync then throws EBUSY and reds a leg whose install already succeeded
// (floorp portable leg, 2026-10-02). The wrappers must ride out a TRANSIENT
// lock, must not swallow any other error, and must not retry forever.

/** A readFileSync-shaped EBUSY: code + single-line message, no stderr. */
function lockError() {
  return Object.assign(new Error("EBUSY: resource busy or locked, open 'x'"), {code: 'EBUSY'});
}

test('withLockRetrySync: rides out a transient lock then returns the value', () => {
  const sleeps = [];
  let calls = 0;
  const out = withLockRetrySync(
    () => {
      calls += 1;
      if (calls < 3) throw lockError();
      return 'settled';
    },
    {platform: 'win32', sleep: ms => sleeps.push(ms)}
  );
  assert.equal(out, 'settled');
  assert.equal(calls, 3, 'two failed attempts then the success');
  assert.deepEqual(sleeps, [300, 600], 'exponential backoff, not a fixed wait');
});

test('withLockRetrySync: a non-lock error is not retried', () => {
  let calls = 0;
  assert.throws(
    () =>
      withLockRetrySync(
        () => {
          calls += 1;
          throw Object.assign(new Error('ENOENT: no such file'), {code: 'ENOENT'});
        },
        {platform: 'win32', sleep: () => assert.fail('must not sleep')}
      ),
    /ENOENT/
  );
  assert.equal(calls, 1);
});

test('withLockRetrySync: a persistent lock rethrows after the last attempt', () => {
  let calls = 0;
  const sleeps = [];
  assert.throws(
    () =>
      withLockRetrySync(
        () => {
          calls += 1;
          throw lockError();
        },
        {platform: 'win32', attempts: 3, sleep: ms => sleeps.push(ms)}
      ),
    /EBUSY/
  );
  assert.equal(calls, 3, 'attempts honoured');
  assert.deepEqual(sleeps, [300, 600], 'no sleep after the final attempt');
});

test('withLockRetrySync: a lock is not retried off Windows', () => {
  let calls = 0;
  assert.throws(
    () =>
      withLockRetrySync(
        () => {
          calls += 1;
          throw lockError();
        },
        {platform: 'linux', sleep: () => assert.fail('must not sleep')}
      ),
    /EBUSY/
  );
  assert.equal(calls, 1, 'POSIX does not lock a file against reads');
});

test('read/writeFileSyncWithRetry: round-trip the real fs (unlocked path)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fxs-lockretry-'));
  try {
    const file = path.join(dir, 'cfg.js');
    writeFileSyncWithRetry(file, '// probe\n');
    assert.equal(readFileSyncWithRetry(file, 'utf-8'), '// probe\n');
    // The Buffer (no-encoding) form the hash path uses must round-trip too.
    assert.equal(readFileSyncWithRetry(file).toString('utf-8'), '// probe\n');
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

// ── Temp-root hygiene ───────────────────────────────────────────
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

test('rmDir: an unremovable tree the harness does not own is not logged as leaked', () => {
  // rmDir is also called on trees this harness never created (a caller's own
  // scratch dir). Reporting those in dist/e2e-leaked-temp.txt would name
  // foreign litter as ours. Force a failure the only portable way: make the
  // parent read-only so the remove cannot succeed (skipped as root/Windows
  // where that does not apply).
  if (
    process.platform === 'win32' ||
    (typeof process.getuid === 'function' && process.getuid() === 0)
  ) {
    return;
  }
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'fxs-hyg-foreign-'));
  const foreign = path.join(parent, 'not-ours');
  fs.mkdirSync(foreign);
  fs.writeFileSync(path.join(foreign, 'payload'), 'x');
  const breadcrumb = path.join(REPO_ROOT, 'dist', 'e2e-leaked-temp.txt');
  const before = fs.existsSync(breadcrumb) ? fs.readFileSync(breadcrumb, 'utf-8') : null;
  try {
    fs.chmodSync(parent, 0o500); // r-x: cannot unlink its children
    rmDir(foreign);
    if (fs.existsSync(foreign)) {
      const after = fs.existsSync(breadcrumb) ? fs.readFileSync(breadcrumb, 'utf-8') : null;
      assert.equal(
        after,
        before,
        'a foreign tree that fails to remove must not be recorded as leaked'
      );
    }
  } finally {
    fs.chmodSync(parent, 0o700);
    fs.rmSync(parent, {recursive: true, force: true});
  }
});
