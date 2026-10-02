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
const {pollUntil, withLockRetrySync, readFileSyncWithRetry, writeFileSyncWithRetry} = await import(
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
