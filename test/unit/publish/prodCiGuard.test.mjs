// test/unit/publish/prodCiGuard.test.mjs — unit tests for prodCiGuard.mjs
// (the guard itself is pure; the process-exit behavior lives in the throw).

import {test} from 'node:test';
import assert from 'node:assert/strict';

const {runProdCiGuard} = await import('../../../tools/publish/prodCiGuard.mjs');

test('prod + real upload + not CI → aborts', () => {
  assert.throws(() => runProdCiGuard({mode: 'prod', local: false, isCi: false}), {
    message: /not a CI run/,
  });
});

test('CI prod run proceeds', () => {
  assert.deepEqual(runProdCiGuard({mode: 'prod', local: false, isCi: true}), {aborted: false});
});

test('--local prod snapshot is exempt (offline, publishes nothing)', () => {
  assert.deepEqual(runProdCiGuard({mode: 'prod', local: true, isCi: false}), {aborted: false});
});

test('dev mode is exempt (disposable test channel, ADR 0026)', () => {
  assert.deepEqual(runProdCiGuard({mode: 'dev', local: false, isCi: false}), {aborted: false});
  assert.deepEqual(runProdCiGuard({mode: 'dev', local: true, isCi: false}), {aborted: false});
});
