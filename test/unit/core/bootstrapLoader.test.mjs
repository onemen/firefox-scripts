// test/unit/core/bootstrapLoader.test.mjs — Unit tests for the Waterfox guard
// in core/chrome/utils/BootstrapLoader.js (issue #38 pre-1.0 scope).
//
// config.js skips loading BootstrapLoader.js on Waterfox because Waterfox
// bundles its own legacy-extension loader. But a user-modified config.js that
// loads it unconditionally would run every top-level patch a second time
// (double observers, double prototype patches, second external loader
// registration). The file therefore guards all top-level side effects with a
// `waterfoxBrand` flag; these tests evaluate the *full* file in a Node vm with
// mocked Firefox globals (same pattern as userChrome.test.mjs) and assert the
// observable side effects:
//
//   - Waterfox (any name variant): zero observers, zero loader registrations,
//     XPIDatabase/XPIExports untouched.
//   - Firefox: both observers registered, loader registered, patches applied.
//   - The `waterfoxBrand` name must not collide with config.js's `isWaterfox`:
//     loadSubScript evaluates into the caller's global lexical environment, so
//     a redeclaration would throw on every browser. The shared-scope test
//     evaluates config.js and BootstrapLoader.js into one context to lock this.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const SRC = fs.readFileSync(
  path.join(REPO_ROOT, 'core', 'chrome', 'utils', 'BootstrapLoader.js'),
  'utf-8'
);
const CONFIG_SRC = fs.readFileSync(path.join(REPO_ROOT, 'core', 'fx-folder', 'config.js'), 'utf-8');

/**
 * Build a vm sandbox with the Firefox globals BootstrapLoader.js (and, for the
 * shared-scope test, config.js) touch during top-level evaluation. Recorders
 * let tests assert the exact side effects.
 */
function makeSandbox(browserName) {
  const observers = [];
  const loadedURIs = [];
  const addonManager = {
    isReady: false,
    registered: [],
    addExternalExtensionLoader(loader) {
      this.registered.push(loader);
    },
    getAllAddons: () => Promise.resolve([]),
  };
  const xpidb = {};
  const origVerifyBundleSignedState = function origVerifyBundleSignedState() {};
  const xpiExports = {verifyBundleSignedState: origVerifyBundleSignedState};

  const sandbox = {
    Services: {
      appinfo: {name: browserName, platformVersion: '140.0'},
      obs: {
        addObserver(observer) {
          observers.push(observer);
        },
      },
      scriptloader: {
        loadSubScript(uri) {
          loadedURIs.push(uri);
        },
      },
      dirsvc: {
        get() {
          return {append() {}};
        },
      },
    },
    ChromeUtils: {
      defineESModuleGetters(target, map) {
        for (const key of Object.keys(map)) {
          if (!(key in target)) {
            Object.defineProperty(target, key, {value: {}, configurable: true});
          }
        }
      },
      importESModule(spec) {
        if (spec.endsWith('AddonManager.sys.mjs')) return {AddonManager: addonManager};
        if (spec.endsWith('XPIDatabase.sys.mjs')) {
          return {XPIDatabase: xpidb, AddonInternal: function AddonInternal() {}};
        }
        if (spec.endsWith('XPIExports.sys.mjs')) return {XPIExports: xpiExports};
        if (spec.endsWith('Console.sys.mjs')) {
          return {
            ConsoleAPI: function ConsoleAPI() {
              return {warn() {}, debug() {}};
            },
          };
        }
        return {};
      },
      defineLazyGetter(target, name, fn) {
        Object.defineProperty(target, name, {get: () => fn(), configurable: true});
      },
    },
    // config.js surface (shared-scope test)
    lockPref() {},
    Components: {
      manager: {
        QueryInterface() {
          return {autoRegister() {}};
        },
      },
    },
    Cc: {},
    Ci: {nsIFile: {}, nsIComponentRegistrar: {}},
    Cu: {
      Sandbox() {
        return {};
      },
      evalInSandbox() {
        return undefined;
      },
    },
  };
  return {
    sandbox,
    observers,
    loadedURIs,
    addonManager,
    xpidb,
    xpiExports,
    origVerifyBundleSignedState,
  };
}

/** Evaluate BootstrapLoader.js alone for the given browser brand name. */
function evaluate(browserName) {
  const ctx = makeSandbox(browserName);
  vm.createContext(ctx.sandbox);
  vm.runInContext(SRC, ctx.sandbox, {filename: 'BootstrapLoader.js'});
  return ctx;
}

// ── Waterfox: the whole file must be a no-op ────────────────────────────────

test('Waterfox: no observers, no loader registration, no XPIDatabase/XPIExports patches', () => {
  const ctx = evaluate('Waterfox');
  assert.deepEqual(ctx.observers, [], 'no chrome-document-loaded observers');
  assert.deepEqual(ctx.addonManager.registered, [], 'no external loader registered');
  assert.equal('isDisabledLegacy' in ctx.xpidb, false, 'XPIDatabase untouched');
  assert.equal(
    ctx.xpiExports.verifyBundleSignedState,
    ctx.origVerifyBundleSignedState,
    'XPIExports.verifyBundleSignedState not wrapped'
  );
});

test('Waterfox name variants are all detected', () => {
  for (const name of ['Waterfox', 'waterfox', 'Waterfox Current', 'Waterfox G6']) {
    const ctx = evaluate(name);
    assert.deepEqual(ctx.observers, [], `${name}: no observers`);
    assert.deepEqual(ctx.addonManager.registered, [], `${name}: no loader registration`);
  }
});

// ── Firefox: everything runs as before ──────────────────────────────────────

test('Firefox: both observers registered, loader registered, patches applied', () => {
  const ctx = evaluate('Firefox');
  assert.equal(ctx.observers.length, 2, 'updater-init + about:addons observers');
  assert.equal(ctx.addonManager.registered.length, 1, 'external loader registered once');
  assert.equal(ctx.addonManager.registered[0].name, 'bootstrap', 'the BootstrapLoader object');
  assert.equal(typeof ctx.xpidb.isDisabledLegacy, 'function', 'isDisabledLegacy patched');
  assert.notEqual(
    ctx.xpiExports.verifyBundleSignedState,
    ctx.origVerifyBundleSignedState,
    'verifyBundleSignedState wrapped'
  );
});

test('Firefox + AddonManager ready: reloads enabled non-WebExtension add-ons only', async () => {
  const ctx = makeSandbox('Firefox');
  const legacy = {
    type: 'extension',
    isWebExtension: false,
    userDisabled: false,
    reload() {
      ctx.reloaded.push('legacy');
    },
  };
  const webext = {
    type: 'extension',
    isWebExtension: true,
    userDisabled: false,
    reload() {
      ctx.reloaded.push('webext');
    },
  };
  const disabled = {
    type: 'extension',
    isWebExtension: false,
    userDisabled: true,
    reload() {
      ctx.reloaded.push('disabled');
    },
  };
  ctx.reloaded = [];
  ctx.addonManager.isReady = true;
  ctx.addonManager.getAllAddons = () => Promise.resolve([legacy, webext, disabled]);

  vm.createContext(ctx.sandbox);
  vm.runInContext(SRC, ctx.sandbox, {filename: 'BootstrapLoader.js'});
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(ctx.reloaded, ['legacy']);
});

// ── Shared scope with config.js (the #38 double-load scenario) ──────────────

test('config.js + unconditionally loaded BootstrapLoader.js share one scope without a redeclaration crash', () => {
  // loadSubScript evaluates into the caller's global lexical environment.
  // config.js declares `const isWaterfox`; if BootstrapLoader.js declared the
  // same name, evaluating both in one context would throw SyntaxError on every
  // browser. The guard uses the distinct `waterfoxBrand` name.
  const ctx = makeSandbox('Waterfox');
  vm.createContext(ctx.sandbox);
  // Real config.js on stock Waterfox records the BootstrapLoader.js load but
  // skips it (its own isWaterfox check). Then simulate the user-modified
  // config.js case by loading BootstrapLoader.js unconditionally.
  vm.runInContext(CONFIG_SRC, ctx.sandbox, {filename: 'config.js'});
  assert.deepEqual(ctx.loadedURIs, ['chrome://userchromejs/content/userChrome.js']);
  vm.runInContext(SRC, ctx.sandbox, {filename: 'BootstrapLoader.js'});
  assert.deepEqual(ctx.observers, [], 'still a no-op on Waterfox');
  assert.deepEqual(ctx.addonManager.registered, [], 'still no double registration');
});

test('config.js + BootstrapLoader.js in one scope also works on Firefox', () => {
  const ctx = makeSandbox('Firefox');
  vm.createContext(ctx.sandbox);
  vm.runInContext(CONFIG_SRC, ctx.sandbox, {filename: 'config.js'});
  assert.deepEqual(ctx.loadedURIs, [
    'chrome://userchromejs/content/BootstrapLoader.js',
    'chrome://userchromejs/content/userChrome.js',
  ]);
  // The real loadSubScript executed BootstrapLoader.js inside the context —
  // here we evaluate it directly to prove the shared scope accepts it.
  vm.runInContext(SRC, ctx.sandbox, {filename: 'BootstrapLoader.js'});
  assert.equal(ctx.observers.length, 2);
  assert.equal(ctx.addonManager.registered.length, 1);
});
