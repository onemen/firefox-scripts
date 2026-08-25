// tools/test/unit/userChrome.test.mjs — Unit tests for
// core/chrome/utils/userChrome.js, evaluating the *full* file in a Node vm with
// mocked Firefox globals (Services, ChromeUtils, XPCOM Cc/Ci/Cu, AppConstants,
// xPref, Management). No real Firefox needed.
//
// This is the general pattern for testing userChrome.js internals: add any new
// mock a future test needs to `makeSandbox()`, evaluate the file once, then
// reach into the sandbox for the function under test.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const SRC = fs.readFileSync(
  path.join(REPO_ROOT, 'core', 'chrome', 'utils', 'userChrome.js'),
  'utf-8'
);

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
    addEventListener() {},
  };
}

/**
 * Build a vm sandbox with just enough Firefox global surface for userChrome.js
 * to evaluate top-to-bottom. `inSafeMode: true` skips the filesystem/window
 * enumeration at the bottom of the file; everything else is a no-op stub.
 */
function makeSandbox(platformVersion) {
  const sandbox = {
    Services: {
      appinfo: {platformVersion, inSafeMode: true},
      scriptloader: {loadSubScript() {}},
      dirsvc: {
        get() {
          return {
            append() {},
            directoryEntries: {
              QueryInterface() {
                return {hasMoreElements: () => false, getNext() {}};
              },
            },
          };
        },
      },
      wm: {
        getEnumerator() {
          return {hasMoreElements: () => false, getNext() {}};
        },
      },
      obs: {addObserver() {}, notifyObservers() {}},
      scriptSecurityManager: {getSystemPrincipal() {}},
    },
    ChromeUtils: {
      defineESModuleGetters(target, map) {
        for (const key of Object.keys(map)) {
          if (!(key in target)) target[key] = {};
        }
      },
      importESModule() {
        return {};
      },
    },
    AppConstants: {MOZ_APP_NAME: 'firefox'},
    xPref: {get() {}, set() {}},
    Management: {on() {}},
    Cc: {
      '@mozilla.org/content/style-sheet-service;1': {getService() {}},
    },
    Ci: {
      nsIStyleSheetService: {},
      nsIFile: {},
      nsISimpleEnumerator: {},
      nsIFileInputStream: {},
      nsIConverterInputStream: {DEFAULT_REPLACEMENT_CHARACTER: 0},
      nsIDocShellTreeItem: {typeAll: 0},
      nsIDocShell: {ENUMERATE_FORWARDS: 0},
    },
    Cu: {
      reportError() {},
      Sandbox() {
        return {};
      },
      getGlobalForObject() {
        return {addEventListener() {}};
      },
      evalInSandbox() {
        return () => {};
      },
      nukeSandbox() {},
    },
  };
  return sandbox;
}

/**
 * Evaluate userChrome.js once for the given Gecko version.
 *
 * Top-level `function` declarations attach to the vm's global object, but
 * `const`/`let` bindings (FF149, _uc, UC, …) do not — so expose them via an
 * explicit `globalThis` assignment appended to the evaluated source.
 *
 * @returns {{
 *   FF149: boolean;
 *   _uc: object;
 *   isFirefox149Plus: Function;
 *   applyAttribute: Function;
 * }}
 */
function evaluate(platformVersion) {
  const sandbox = makeSandbox(platformVersion);
  vm.createContext(sandbox);
  vm.runInContext(
    SRC + '\nglobalThis.__userChrome = { FF149, _uc, isFirefox149Plus, applyAttribute };',
    sandbox
  );
  return sandbox.__userChrome;
}

test('isFirefox149Plus: reads the Gecko (platform) version', () => {
  const {isFirefox149Plus} = evaluate('153.0');
  assert.equal(isFirefox149Plus({platformVersion: '149.0'}), true);
  assert.equal(isFirefox149Plus({platformVersion: '153.0'}), true);
  assert.equal(isFirefox149Plus({platformVersion: '159.0a1'}), true);
  assert.equal(isFirefox149Plus({platformVersion: '148.0'}), false);
  assert.equal(isFirefox149Plus({platformVersion: '140.5.0esr'}), false);
});

test('isFirefox149Plus: fork brand versions do not matter, only Gecko does', () => {
  const {isFirefox149Plus} = evaluate('153.0');
  // Waterfox-style fork: its own release number in `version`, Gecko 153.
  assert.equal(isFirefox149Plus({version: '10.0', platformVersion: '153.0'}), true);
  // ESR-based fork (e.g. LibreWolf): Gecko 115 — bug 2008041 not present.
  assert.equal(isFirefox149Plus({version: '128.0esr', platformVersion: '115.0'}), false);
});

test('isFirefox149Plus: missing/garbage version falls back to pre-149 behavior', () => {
  const {isFirefox149Plus} = evaluate('153.0');
  assert.equal(isFirefox149Plus({}), false);
  assert.equal(isFirefox149Plus({platformVersion: 'garbage'}), false);
  assert.equal(isFirefox149Plus(null), false);
});

test('FF149: derived from Services.appinfo.platformVersion at load time', () => {
  assert.equal(evaluate('153.0').FF149, true);
  assert.equal(evaluate('148.0').FF149, false);
  // Garbage / missing → pre-149 fallback.
  assert.equal(evaluate('garbage').FF149, false);
});

test('applyAttribute: pre-149 keeps the legacy value-based setAttribute for every value', () => {
  const {applyAttribute} = evaluate('153.0');
  for (const value of [true, false, 'true', 'false', 'checked', '', 0, 'foo']) {
    const el = mockElement();
    applyAttribute(el, 'checked', value, false);
    assert.deepEqual(el.calls, [['set', 'checked', value]], `value=${JSON.stringify(value)}`);
  }
});

test('applyAttribute: 149+ maps boolean-ish values to presence-based toggleAttribute', () => {
  const {applyAttribute} = evaluate('153.0');
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
  const {applyAttribute} = evaluate('153.0');
  for (const value of ['checked', '', 0, 'foo', null, undefined]) {
    const el = mockElement();
    applyAttribute(el, 'class', value, true);
    assert.deepEqual(el.calls, [['set', 'class', value]], `value=${JSON.stringify(value)}`);
  }
});

test('createElement: boolean attrs toggle on FF149+, others setAttribute', () => {
  const {_uc, FF149} = evaluate('153.0');
  assert.equal(FF149, true);
  const el = mockElement();
  const doc = {createXULElement: () => el, createElement: () => el};
  const result = _uc.createElement(doc, 'toolbarbutton', {checked: true, class: 'foo'}, true);
  assert.equal(result, el);
  assert.deepEqual(el.calls, [
    ['toggle', 'checked', true],
    ['set', 'class', 'foo'],
  ]);
});

test('createElement: pre-149 uses setAttribute for boolean attrs', () => {
  const {_uc, FF149} = evaluate('148.0');
  assert.equal(FF149, false);
  const el = mockElement();
  const doc = {createXULElement: () => el, createElement: () => el};
  _uc.createElement(doc, 'toolbarbutton', {checked: true}, true);
  assert.deepEqual(el.calls, [['set', 'checked', true]]);
});

test('createElement: XUL=false uses document.createElement', () => {
  const {_uc} = evaluate('153.0');
  let usedCreateElement = false;
  let usedCreateXULElement = false;
  const el = mockElement();
  const doc = {
    createXULElement: () => {
      usedCreateXULElement = true;
      return el;
    },
    createElement: () => {
      usedCreateElement = true;
      return el;
    },
  };
  _uc.createElement(doc, 'div', {id: 'x'}, false);
  assert.equal(usedCreateElement, true);
  assert.equal(usedCreateXULElement, false);
});
