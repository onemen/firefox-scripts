// test/unit/publish/prodCiGuard.test.mjs — unit tests for prodCiGuard.mjs
// (the guard itself is pure; the process-exit behavior lives in the throw).

import {test} from 'node:test';
import assert from 'node:assert/strict';

const {isWorkflowRun, runProdCiGuard} = await import('../../../tools/publish/prodCiGuard.mjs');

test('prod + real upload + not a workflow run → aborts', () => {
  assert.throws(() => runProdCiGuard({mode: 'prod', local: false, isCi: false}), {
    message: /not a CI run/,
  });
});

test('workflow prod run proceeds', () => {
  assert.deepEqual(runProdCiGuard({mode: 'prod', local: false, isCi: true}), {aborted: false});
});

test('--local prod snapshot is exempt (offline, publishes nothing)', () => {
  assert.deepEqual(runProdCiGuard({mode: 'prod', local: true, isCi: false}), {aborted: false});
});

test('dev mode is exempt (disposable test channel, ADR 0026)', () => {
  assert.deepEqual(runProdCiGuard({mode: 'dev', local: false, isCi: false}), {aborted: false});
  assert.deepEqual(runProdCiGuard({mode: 'dev', local: true, isCi: false}), {aborted: false});
});

test('isWorkflowRun: true only for the workflow marker, never for ambient CI env', () => {
  assert.equal(isWorkflowRun({FXS_INTERNAL_CI: '1'}), true);
  assert.equal(isWorkflowRun({CI: 'true', GITHUB_ACTIONS: 'true'}), false);
  assert.equal(isWorkflowRun({}), false);
  assert.equal(isWorkflowRun({FXS_INTERNAL_CI: '0'}), false);
});
