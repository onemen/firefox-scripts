// test/unit/core/bootstrapLoader.test.mjs — Unit tests for the bundled-loader
// guard in core/chrome/utils/BootstrapLoader.js (issue #38 pre-1.0 scope).
//
// config.js skips loading BootstrapLoader.js on Waterfox because Waterfox
// bundles its own legacy-extension loader. But a user-modified config.js that
// loads it unconditionally would run every top-level side effect a second time
// (double observers, double prototype patches, second external loader
// registration). The file therefore keeps all top-level side effects inside
// one initBootstrapLoader() function, guarded by bootstrapLoaderBundled():
//
//   - brand regex (primary, deterministic — autoconfig runs before AddonManager
//     startup, so the registry may not be populated yet on Waterfox itself),
//   - the AddonManager.externalExtensionLoaders registry (public Map getter,
//     keyed by loader.name) — catches rebranded forks whose bundled loader is
//     already registered, and makes a second evaluation of this file in a
//     fresh scope inert (our own 'bootstrap' registration is then visible).
//
// These tests evaluate the *full* file in a Node vm with mocked Firefox
// globals (same pattern as userChrome.test.mjs) and assert the observable
// side effects. The shared-scope test also evaluates config.js and
// BootstrapLoader.js into one context: loadSubScript evaluates into the
// caller's global lexical environment, so a name collision with config.js's
// `isWaterfox` would throw SyntaxError on every browser.

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
 * let tests assert the exact side effects. `externalExtensionLoaders` mirrors
 * the real AddonManager registry (Map keyed by loader.name).
 */
function makeSandbox(browserName, shared = {}) {
  const observers = [];
  const loadedURIs = [];
  // `shared` lets a test model one browser session across several evaluations
  // (same AddonManager/XPIDatabase/XPIExports singletons) — the closures below
  // capture these locals, so sharing must happen at creation time.
  const addonManager = shared.addonManager ?? {
    isReady: false,
    registered: [],
    externalExtensionLoaders: new Map(),
    addExternalExtensionLoader(loader) {
      this.registered.push(loader);
      this.externalExtensionLoaders.set(loader.name, loader);
    },
    getAllAddons: () => Promise.resolve([]),
  };
  const xpidb = shared.xpidb ?? {};
  const origVerifyBundleSignedState = function origVerifyBundleSignedState() {};
  const xpiExports = shared.xpiExports ?? {verifyBundleSignedState: origVerifyBundleSignedState};

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
function evaluate(browserName, overrides = {}) {
  const ctx = makeSandbox(browserName);
  Object.assign(ctx.addonManager, overrides);
  vm.createContext(ctx.sandbox);
  vm.runInContext(SRC, ctx.sandbox, {filename: 'BootstrapLoader.js'});
  return ctx;
}

/** Assertions for "the file stayed fully inert". */
function assertInert(ctx, label) {
  assert.deepEqual(ctx.observers, [], `${label}: no chrome-document-loaded observers`);
  assert.deepEqual(ctx.addonManager.registered, [], `${label}: no external loader registered`);
  assert.equal('isDisabledLegacy' in ctx.xpidb, false, `${label}: XPIDatabase untouched`);
  assert.equal(
    ctx.xpiExports.verifyBundleSignedState,
    ctx.origVerifyBundleSignedState,
    `${label}: XPIExports.verifyBundleSignedState not wrapped`
  );
}

// ── Waterfox: the whole file must be a no-op ────────────────────────────────

test('Waterfox: no observers, no loader registration, no XPIDatabase/XPIExports patches', () => {
  assertInert(evaluate('Waterfox'), 'Waterfox');
});

test('Waterfox name variants are all detected', () => {
  for (const name of ['Waterfox', 'waterfox', 'Waterfox Current', 'Waterfox G6']) {
    assertInert(evaluate(name), name);
  }
});

// ── Registry signal (AddonManager.externalExtensionLoaders) ─────────────────

test('rebranded fork with a bundled loader already registered is detected via the registry', () => {
  // Waterfox build that renamed itself: brand regex misses, registry catches.
  const ctx = evaluate('MyRebrand', {
    externalExtensionLoaders: new Map([
      ['bootstrap', {name: 'bootstrap', manifestFile: 'install.rdf'}],
    ]),
  });
  assertInert(ctx, 'rebranded fork');
});

test('second evaluation of this file in a fresh scope is inert (own registration visible)', () => {
  // One browser session: config.js loads the file once (registers 'bootstrap');
  // a second loadSubScript into a different scope sees the registration and
  // stays inert instead of double-patching.
  const first = makeSandbox('Firefox');
  vm.createContext(first.sandbox);
  vm.runInContext(SRC, first.sandbox, {filename: 'BootstrapLoader.js'});

  const second = makeSandbox('Firefox', {
    addonManager: first.addonManager,
    xpidb: first.xpidb,
    xpiExports: first.xpiExports,
  });
  vm.createContext(second.sandbox);
  vm.runInContext(SRC, second.sandbox, {filename: 'BootstrapLoader.js'});

  assert.equal(first.observers.length, 2);
  assert.equal(second.observers.length, 0, 'no observers from the second evaluation');
  assert.equal(first.addonManager.registered.length, 1, 'loader registered exactly once');
  assert.equal(
    second.xpiExports.verifyBundleSignedState,
    first.xpiExports.verifyBundleSignedState,
    "single wrapper (the first evaluation's)"
  );
});

test('empty registry on a non-Waterfox browser does not block initialization', () => {
  const ctx = evaluate('Firefox');
  assert.equal(ctx.observers.length, 2, 'updater-init + about:addons observers');
  assert.equal(ctx.addonManager.registered.length, 1, 'external loader registered once');
});

// ── Firefox: everything runs as before ──────────────────────────────────────

test('Firefox: both observers registered, loader registered, patches applied', () => {
  const ctx = evaluate('Firefox');
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
  // browser.
  const ctx = makeSandbox('Waterfox');
  vm.createContext(ctx.sandbox);
  // Real config.js on stock Waterfox records the BootstrapLoader.js load but
  // skips it (its own isWaterfox check). Then simulate the user-modified
  // config.js case by loading BootstrapLoader.js unconditionally.
  vm.runInContext(CONFIG_SRC, ctx.sandbox, {filename: 'config.js'});
  assert.deepEqual(ctx.loadedURIs, ['chrome://userchromejs/content/userChrome.js']);
  vm.runInContext(SRC, ctx.sandbox, {filename: 'BootstrapLoader.js'});
  assertInert(ctx, 'shared scope on Waterfox');
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
