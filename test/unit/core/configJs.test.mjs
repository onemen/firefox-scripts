// test/unit/core/configJs.test.mjs — Unit tests for core/fx-folder/config.js.
//
// config.js is the autoconfig entry point: it runs BEFORE any of our modules,
// inside Firefox's autoconfig sandbox, and every failure in it is swallowed by
// a bare `catch (ex) {}`. That is deliberate — a browser whose autoconfig is
// broken must still start — but it also means an API drift (a renamed
// dirsvc key, a changed loadSubScript signature, a removed lockPref) degrades
// to SILENTLY not installing anything, with no console error and no E2E
// failure to attribute it to. The existing suites only load config.js as a
// side effect of the shared-scope tests, and they assert only the loadSubScript
// URIs; nothing pins the pieces the file exists for.
//
// These tests evaluate the real file in a Node vm with mocked autoconfig
// globals (same pattern as bootstrapLoader.test.mjs) and assert the observable
// autoconfig effects.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const CONFIG_SRC = fs.readFileSync(path.join(REPO_ROOT, 'core', 'fx-folder', 'config.js'), 'utf-8');

/**
 * Build a vm sandbox with the autoconfig globals config.js touches, recording
 * every effect so the tests can assert them.
 *
 * `dirsvcFailure` models a dirsvc/autoRegister regression: the real file wraps
 * this whole block in `catch (ex) {}`, so a throw here must be invisible to the
 * rest of the browser's startup — that resilience is the point of the test, not
 * an accident to paper over.
 *
 * @param {string} browserName value for Services.appinfo.name
 * @param {{dirsvcFailure?: boolean}} [opts]
 * @returns {{
 *   sandbox: object;
 *   locked: [string, unknown][];
 *   loadedURIs: string[];
 *   registered: object[];
 * }}
 */
function makeSandbox(browserName, {dirsvcFailure = false} = {}) {
  const locked = [];
  const loadedURIs = [];
  const registered = [];

  const sandbox = {
    // Autoconfig provides these as globals; config.js never imports them.
    lockPref(name, value) {
      locked.push([name, value]);
    },
    Services: {
      appinfo: {name: browserName},
      dirsvc: {
        get(key) {
          if (dirsvcFailure) throw new Error(`dirsvc.get(${key}) failed`);
          // Real nsIFile: `append` mutates in place and the caller registers the
          // resulting object, so the segments it accumulated are the contract.
          return {
            segments: [key],
            append(segment) {
              this.segments.push(segment);
            },
          };
        },
      },
      scriptloader: {
        loadSubScript(uri) {
          loadedURIs.push(uri);
        },
      },
    },
    Components: {
      manager: {
        QueryInterface() {
          return {
            autoRegister(manifestFile) {
              registered.push(manifestFile);
            },
          };
        },
      },
    },
    Ci: {nsIFile: {}, nsIComponentRegistrar: {}},
  };

  return {sandbox, locked, loadedURIs, registered};
}

/** Evaluate the real config.js in a fresh sandbox for one browser brand. */
function evaluate(browserName, opts) {
  const ctx = makeSandbox(browserName, opts);
  vm.createContext(ctx.sandbox);
  vm.runInContext(CONFIG_SRC, ctx.sandbox, {filename: 'config.js'});
  return ctx;
}

const BOOTSTRAP_LOADER_URI = 'chrome://userchromejs/content/BootstrapLoader.js';
const USER_CHROME_URI = 'chrome://userchromejs/content/userChrome.js';

// ── The lockPref pins autoconfig exists to enable ───────────────────────────

test('lockPref pins the two prefs autoconfig must set for a legacy install', () => {
  // Without these the installed legacy extension is treated as unsigned and
  // the browser refuses to install it — and, because the file cannot report
  // an error, the user just sees an extension that never appears.
  const ctx = evaluate('Firefox');
  assert.deepEqual(ctx.locked, [
    ['xpinstall.signatures.required', false],
    ['extensions.install_origins.enabled', false],
  ]);
});

// ── chrome://userchromejs registration ──────────────────────────────────────

test('autoRegister registers the shipped utils chrome.manifest under UChrm', () => {
  // This autoRegister is what makes chrome://userchromejs/content/... resolve,
  // which is in turn what the two loadSubScript calls below depend on. A drift
  // in the dirsvc key or the path segments fails SILENTLY (the file catches
  // everything), so the registered path is asserted explicitly.
  const ctx = evaluate('Firefox');
  assert.equal(ctx.registered.length, 1, 'exactly one manifest registered');
  assert.deepEqual(ctx.registered[0].segments, ['UChrm', 'utils', 'chrome.manifest']);
});

// ── Load order ──────────────────────────────────────────────────────────────

test('Firefox: BootstrapLoader.js loads before userChrome.js', () => {
  // BootstrapLoader patches the prototypes userChrome.js's createElement relies
  // on, so the order is load-bearing, not incidental.
  const ctx = evaluate('Firefox');
  assert.deepEqual(ctx.loadedURIs, [BOOTSTRAP_LOADER_URI, USER_CHROME_URI]);
});

test('Waterfox: BootstrapLoader.js is skipped, userChrome.js still loads', () => {
  // Waterfox bundles its own legacy loader; loading ours would double-register
  // it. userChrome.js must still load — Waterfox users install these
  // files for the user-scripts and the auto-updater.
  const ctx = evaluate('Waterfox');
  assert.deepEqual(ctx.loadedURIs, [USER_CHROME_URI]);
  // The utils manifest is still registered on Waterfox: skipping the loader is
  // NOT skipping the chrome://userchromejs registration userChrome.js needs.
  assert.deepEqual(ctx.registered[0].segments, ['UChrm', 'utils', 'chrome.manifest']);
});

test('Waterfox brand matching is case-insensitive', () => {
  // The file's own regex is /waterfox/i; the product name comes from
  // appinfo.name, which varies in case across rebranded builds.
  for (const name of ['Waterfox', 'waterfox', 'WATERFOX G4']) {
    assert.deepEqual(evaluate(name).loadedURIs, [USER_CHROME_URI], name);
  }
});

// ── Fail-soft resilience ────────────────────────────────────────────────────

test('a failing dirsvc/autoRegister does not stop userChrome.js from loading', () => {
  // config.js swallows every error so a broken autoconfig can never keep the
  // browser from starting. The cost is that a partial failure is silent — so
  // the guarantee worth pinning is that the two halves stay INDEPENDENT: a
  // dead registration must not cost the userChrome.js load.
  const ctx = evaluate('Firefox', {dirsvcFailure: true});
  assert.deepEqual(ctx.registered, [], 'nothing registered');
  assert.deepEqual(ctx.loadedURIs, [USER_CHROME_URI], 'userChrome.js still loaded');
});

test('top-level evaluation never throws, whatever the browser brand', () => {
  // The point of the bare catch blocks: a brand this file has never seen (and
  // therefore any autoconfig API drift) must not throw out of autoconfig.
  for (const name of ['Firefox', 'Nightly', 'floorp', 'librewolf', 'zen', '']) {
    assert.doesNotThrow(() => evaluate(name), name);
  }
});
