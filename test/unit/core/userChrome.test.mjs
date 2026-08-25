// test/unit/core/userChrome.test.mjs — Unit tests for
// core/chrome/utils/userChrome.js, evaluating the *full* file in a Node vm with
// mocked Firefox globals (Services, ChromeUtils, XPCOM Cc/Ci/Cu, AppConstants,
// xPref, Management). No real Firefox needed.
//
// Pattern: add any new mock a future test needs to `makeSandbox()`, evaluate
// the file once, then reach into the sandbox for the value/function under test.

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

/**
 * Mock DOM element that records setAttribute, toggleAttribute, and
 * addEventListener calls so tests can assert the exact arguments.
 */
function mockElement() {
  const calls = [];
  const listeners = [];
  return {
    calls,
    listeners,
    setAttribute(name, value) {
      calls.push(['set', name, value]);
    },
    toggleAttribute(name, force) {
      calls.push(['toggle', name, force]);
    },
    addEventListener(type, handler) {
      listeners.push({type, handler});
    },
  };
}

/**
 * Build a vm sandbox with just enough Firefox global surface for userChrome.js
 * to evaluate top-to-bottom. `inSafeMode: true` skips the filesystem/window
 * enumeration at the bottom of the file.
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
 * Evaluate userChrome.js once for the given Gecko platformVersion.
 *
 * Top-level `function` declarations attach to the vm's global object, but
 * `const`/`let` bindings do not — expose them via a `globalThis` assignment
 * appended to the evaluated source.
 */
function evaluate(platformVersion) {
  const sandbox = makeSandbox(platformVersion);
  vm.createContext(sandbox);
  vm.runInContext(SRC + '\nglobalThis.__userChrome = { FF149, _uc, isFirefox149Plus };', sandbox);
  return sandbox.__userChrome;
}

// ── isFirefox149Plus ────────────────────────────────────────────────────────

test('isFirefox149Plus: reads Gecko (platform) version, not brand version', () => {
  const {isFirefox149Plus} = evaluate('153.0');
  assert.equal(isFirefox149Plus({platformVersion: '149.0'}), true);
  assert.equal(isFirefox149Plus({platformVersion: '153.0'}), true);
  assert.equal(isFirefox149Plus({platformVersion: '159.0a1'}), true);
  assert.equal(isFirefox149Plus({platformVersion: '148.0'}), false);
  assert.equal(isFirefox149Plus({platformVersion: '140.5.0esr'}), false);
});

test('isFirefox149Plus: fork brand versions do not matter', () => {
  const {isFirefox149Plus} = evaluate('153.0');
  // Waterfox: its own release number in version, Gecko 153.
  assert.equal(isFirefox149Plus({version: '10.0', platformVersion: '153.0'}), true);
  // LibreWolf ESR-based fork: Gecko 115 → bug 2008041 not present.
  assert.equal(isFirefox149Plus({version: '128.0esr', platformVersion: '115.0'}), false);
});

test('isFirefox149Plus: missing/garbage version falls back to false', () => {
  const {isFirefox149Plus} = evaluate('153.0');
  assert.equal(isFirefox149Plus({}), false);
  assert.equal(isFirefox149Plus({platformVersion: 'garbage'}), false);
  assert.equal(isFirefox149Plus(null), false);
});

// ── FF149 ───────────────────────────────────────────────────────────────────

test('FF149: derived from Services.appinfo.platformVersion at load time', () => {
  assert.equal(evaluate('153.0').FF149, true);
  assert.equal(evaluate('148.0').FF149, false);
  assert.equal(evaluate('garbage').FF149, false);
});

// ── _uc.createElement ───────────────────────────────────────────────────────

test('createElement: boolean attrs toggle on FF149+', () => {
  const {_uc} = evaluate('153.0');
  const el = mockElement();
  const doc = {createXULElement: () => el, createElement: () => el};
  _uc.createElement(doc, 'toolbarbutton', {checked: true, disabled: false}, true);
  assert.deepEqual(el.calls, [
    ['toggle', 'checked', true],
    ['toggle', 'disabled', false],
  ]);
});

test('createElement: "true"/"false" strings toggle on FF149+', () => {
  const {_uc} = evaluate('153.0');
  const el = mockElement();
  const doc = {createXULElement: () => el, createElement: () => el};
  _uc.createElement(doc, 'checkbox', {checked: 'true', disabled: 'false'}, true);
  assert.deepEqual(el.calls, [
    ['toggle', 'checked', true],
    ['toggle', 'disabled', false],
  ]);
});

test('createElement: non-boolean values always setAttribute on FF149+', () => {
  const {_uc} = evaluate('153.0');
  for (const value of ['foo', '', 0, 42, null, undefined, 'checked']) {
    const el = mockElement();
    const doc = {createXULElement: () => el, createElement: () => el};
    _uc.createElement(doc, 'elem', {class: value}, true);
    assert.deepEqual(el.calls, [['set', 'class', value]], `value=${JSON.stringify(value)}`);
  }
});

test('createElement: pre-149 uses setAttribute for boolean attrs', () => {
  const {_uc} = evaluate('148.0');
  const el = mockElement();
  const doc = {createXULElement: () => el, createElement: () => el};
  _uc.createElement(doc, 'toolbarbutton', {checked: true, disabled: false}, true);
  assert.deepEqual(el.calls, [
    ['set', 'checked', true],
    ['set', 'disabled', false],
  ]);
});

test('createElement: mixed boolean + non-boolean attrs in one call', () => {
  const {_uc} = evaluate('153.0');
  const el = mockElement();
  const doc = {createXULElement: () => el, createElement: () => el};
  _uc.createElement(
    doc,
    'toolbarbutton',
    {
      checked: true,
      label: 'Go',
      class: 'primary',
    },
    true
  );
  assert.deepEqual(el.calls, [
    ['toggle', 'checked', true],
    ['set', 'label', 'Go'],
    ['set', 'class', 'primary'],
  ]);
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

test('createElement: XUL=true (default) uses document.createXULElement', () => {
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
  _uc.createElement(doc, 'toolbarbutton', {});
  assert.equal(usedCreateXULElement, true);
  assert.equal(usedCreateElement, false);
});

test('createElement: returns the created element', () => {
  const {_uc} = evaluate('153.0');
  const el = mockElement();
  const doc = {createXULElement: () => el, createElement: () => el};
  const result = _uc.createElement(doc, 'toolbarbutton', {checked: true}, true);
  assert.equal(result, el);
});

test('createElement: empty attrs object — no attribute calls', () => {
  const {_uc} = evaluate('153.0');
  const el = mockElement();
  const doc = {createXULElement: () => el, createElement: () => el};
  _uc.createElement(doc, 'toolbarbutton', {}, true);
  assert.deepEqual(el.calls, []);
});

// ── on* event handlers ──────────────────────────────────────────────────────

test('createElement: on-click with function calls addEventListener', () => {
  const {_uc} = evaluate('153.0');
  const el = mockElement();
  const doc = {createXULElement: () => el, createElement: () => el};
  const handler = () => {};
  _uc.createElement(doc, 'button', {onclick: handler}, true);
  assert.equal(el.listeners.length, 1);
  assert.equal(el.listeners[0].type, 'click');
  assert.equal(el.listeners[0].handler, handler);
});

test('createElement: on-mousedown strips "on" prefix', () => {
  const {_uc} = evaluate('153.0');
  const el = mockElement();
  const doc = {createXULElement: () => el, createElement: () => el};
  const handler = () => {};
  _uc.createElement(doc, 'button', {onmousedown: handler}, true);
  assert.equal(el.listeners.length, 1);
  assert.equal(el.listeners[0].type, 'mousedown');
  assert.equal(el.listeners[0].handler, handler);
});

test('createElement: on-command string handler goes through evalInSandbox', () => {
  const {_uc} = evaluate('153.0');
  const el = mockElement();
  // String handlers go through Cu.evalInSandbox → the result is a function.
  const doc = {createXULElement: () => el, createElement: () => el};
  _uc.createElement(doc, 'button', {oncommand: 'console.log(1)'}, true);
  assert.equal(el.listeners.length, 1);
  assert.equal(el.listeners[0].type, 'command');
  assert.equal(typeof el.listeners[0].handler, 'function');
});

test('createElement: multiple on* handlers in one call', () => {
  const {_uc} = evaluate('153.0');
  const el = mockElement();
  const doc = {createXULElement: () => el, createElement: () => el};
  const clickHandler = () => {};
  const keyHandler = () => {};
  _uc.createElement(
    doc,
    'button',
    {
      onclick: clickHandler,
      onkeydown: keyHandler,
    },
    true
  );
  assert.equal(el.listeners.length, 2);
  assert.equal(el.listeners[0].type, 'click');
  assert.equal(el.listeners[0].handler, clickHandler);
  assert.equal(el.listeners[1].type, 'keydown');
  assert.equal(el.listeners[1].handler, keyHandler);
});

test('createElement: on* handler mixed with regular attrs', () => {
  const {_uc} = evaluate('153.0');
  const el = mockElement();
  const doc = {createXULElement: () => el, createElement: () => el};
  const handler = () => {};
  _uc.createElement(
    doc,
    'toolbarbutton',
    {
      checked: true,
      label: 'OK',
      oncommand: handler,
    },
    true
  );
  // attrs first (for-in order), then on* handlers
  assert.deepEqual(el.calls.slice(0, 2), [
    ['toggle', 'checked', true],
    ['set', 'label', 'OK'],
  ]);
  assert.equal(el.listeners.length, 1);
  assert.equal(el.listeners[0].type, 'command');
  assert.equal(el.listeners[0].handler, handler);
});
