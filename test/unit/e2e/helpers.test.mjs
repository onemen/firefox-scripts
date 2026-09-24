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
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const helpersUrl = pathToFileURL(path.join(REPO_ROOT, 'test', 'e2e', 'shared', 'helpers.mjs')).href;
const {pollUntil} = await import(helpersUrl);

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
