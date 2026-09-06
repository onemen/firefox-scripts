import test from 'node:test';
import assert from 'node:assert/strict';

import {vtFailThreshold, vtVerdict} from '../../../tools/scan-vt.mjs';

test('vtVerdict: clean when no malicious engines', () => {
  assert.equal(vtVerdict({malicious: 0, suspicious: 2, harmless: 60}, 3), 'clean');
  assert.equal(vtVerdict({}, 3), 'clean');
  assert.equal(vtVerdict(undefined, 3), 'clean');
});

test('vtVerdict: warn on a few malicious engines (below threshold)', () => {
  assert.equal(vtVerdict({malicious: 1}, 3), 'warn');
  assert.equal(vtVerdict({malicious: 2}, 3), 'warn');
});

test('vtVerdict: fail at/above the threshold', () => {
  assert.equal(vtVerdict({malicious: 3}, 3), 'fail');
  assert.equal(vtVerdict({malicious: 9}, 3), 'fail');
});

test('vtVerdict: threshold is per-call and not global', () => {
  assert.equal(vtVerdict({malicious: 1}, 1), 'fail');
  assert.equal(vtVerdict({malicious: 1}, 5), 'warn');
});

test('vtFailThreshold: defaults to 3, honors VT_FAIL_THRESHOLD', () => {
  const before = process.env.VT_FAIL_THRESHOLD;
  try {
    delete process.env.VT_FAIL_THRESHOLD;
    assert.equal(vtFailThreshold(), 3);
    process.env.VT_FAIL_THRESHOLD = '1';
    assert.equal(vtFailThreshold(), 1);
    process.env.VT_FAIL_THRESHOLD = '0'; // invalid ⇒ default
    assert.equal(vtFailThreshold(), 3);
    process.env.VT_FAIL_THRESHOLD = 'bogus'; // invalid ⇒ default
    assert.equal(vtFailThreshold(), 3);
  } finally {
    if (before === undefined) delete process.env.VT_FAIL_THRESHOLD;
    else process.env.VT_FAIL_THRESHOLD = before;
  }
});
