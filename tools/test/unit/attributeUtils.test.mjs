// tools/test/unit/attributeUtils.test.mjs — Unit tests for
// core/chrome/utils/attributeUtils.js (the createElement boolean-attribute
// semantics behind bug 2008041 / Firefox 149+).
//
// The file under test is a plain, dependency-free subscript (no imports, no
// Services) so it can be evaluated here with a mock DOM and a mocked appinfo
// — no real Firefox needed.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const src = fs.readFileSync(
  path.join(REPO_ROOT, 'core', 'chrome', 'utils', 'attributeUtils.js'),
  'utf-8'
);
const ctx = {};
vm.createContext(ctx);
vm.runInContext(src, ctx);
const {isFirefox149Plus, applyAttribute} = ctx;

/** Mock DOM element that records every attribute call. */
function mockElement() {
  const calls = [];
  return {
    calls,
    setAttribute(name, value) {
      calls.push(['set', name, value]);
    },
    toggleAttribute(name, force) {
      calls.push(['toggle', name, force]);
    },
  };
}

test('isFirefox149Plus: reads the Gecko (platform) version', () => {
  assert.equal(isFirefox149Plus({platformVersion: '149.0'}), true);
  assert.equal(isFirefox149Plus({platformVersion: '153.0'}), true);
  assert.equal(isFirefox149Plus({platformVersion: '159.0a1'}), true);
  assert.equal(isFirefox149Plus({platformVersion: '148.0'}), false);
  assert.equal(isFirefox149Plus({platformVersion: '140.5.0esr'}), false);
});

test('isFirefox149Plus: fork brand versions do not matter, only Gecko does', () => {
  // Waterfox-style fork: its own release number in `version`, Gecko 153.
  assert.equal(isFirefox149Plus({version: '10.0', platformVersion: '153.0'}), true);
  // ESR-based fork (e.g. LibreWolf): Gecko 115 — bug 2008041 not present.
  assert.equal(isFirefox149Plus({version: '128.0esr', platformVersion: '115.0'}), false);
});

test('isFirefox149Plus: missing/garbage version falls back to pre-149 behavior', () => {
  assert.equal(isFirefox149Plus({}), false);
  assert.equal(isFirefox149Plus({platformVersion: 'garbage'}), false);
  assert.equal(isFirefox149Plus(null), false);
});

test('applyAttribute: pre-149 keeps the legacy value-based setAttribute for every value', () => {
  for (const value of [true, false, 'true', 'false', 'checked', '', 0, 'foo']) {
    const el = mockElement();
    applyAttribute(el, 'checked', value, false);
    assert.deepEqual(el.calls, [['set', 'checked', value]], `value=${JSON.stringify(value)}`);
  }
});

test('applyAttribute: 149+ maps boolean-ish values to presence-based toggleAttribute', () => {
  const cases = [
    [true, ['toggle', 'checked', true]],
    [false, ['toggle', 'checked', false]],
    ['true', ['toggle', 'checked', true]],
    ['false', ['toggle', 'checked', false]],
  ];
  for (const [value, expected] of cases) {
    const el = mockElement();
    applyAttribute(el, 'checked', value, true);
    assert.deepEqual(el.calls, [expected], `value=${JSON.stringify(value)}`);
  }
});

test('applyAttribute: 149+ non-boolean values still go through setAttribute', () => {
  for (const value of ['checked', '', 0, 'foo', null, undefined]) {
    const el = mockElement();
    applyAttribute(el, 'class', value, true);
    assert.deepEqual(el.calls, [['set', 'class', value]], `value=${JSON.stringify(value)}`);
  }
});
