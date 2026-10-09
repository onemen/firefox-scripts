// test/unit/core/bootstrapLoaderSweep.test.mjs — Unit test for the
// chrome.manifest startup sweep in core/chrome/utils/BootstrapLoader.js
// (covered only by the E2E leg).
//
// A killed session can leave stale temporary manifests behind in
// ProfD/browser-extension-data/<id>/: a 0-byte `chrome.manifest` (crash between
// truncate and remove) or a `chrome.manifest.<uuid>` leftover. Registrations
// are re-derived from whatever gets autoRegister'ed this session, so leftovers
// are pure litter — sweepStaleManifests() removes them at startup before the
// fresh manifest is written.
//
// Today that behavior is only asserted by test/e2e/core/manifest-lifecycle-e2e.mjs
// (a real-browser leg, three sessions, all three OSes). That is slow to iterate
// on and only runs when core/** changes, so a regression in the sweep's
// matching rules (too narrow → litter survives; too broad → the add-on's own
// files are deleted) ships with the guard in exactly one place. This suite pins
// those rules in `pnpm test` instead: pure Node, no browser, no network.
//
// The sweep is a closure inside BootstrapLoader.loadScope(), so the test drives
// the real pipeline — evaluate the actual BootstrapLoader.js in a vm, call
// loadScope() with a stub add-on, and invoke the returned scope's startup(),
// which is the only caller of createManifestTemporarily() →
// sweepStaleManifests(). Nothing here reimplements the sweep: if it changes,
// these assertions follow it.

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

// ── A minimal in-memory nsIFile tree ───────────────────────────────────────
//
// nsIFile is a mutable, cloneable path object: `append` pushes a segment onto
// the receiver, `clone` snapshots it, and `directoryEntries` is an
// nsIEnumerator. The sweep reads tempDir.directoryEntries and calls
// `entry.remove(false)`, so the stubs must model a real directory with shared,
// mutable children — a plain array of names would not catch a sweep that
// removed the wrong entry or mishandled the enumerator.

/**
 * One node of the virtual filesystem.
 *
 * @param {string[]} segments - path segments
 * @param {object} [state] - shared directory state (`children`, `removeFails`)
 * @returns {object} an nsIFile-shaped stub
 */
function makeFile(segments, state) {
  const self = {
    segments: [...segments],
    leafName: segments[segments.length - 1],
    path: segments.join('/'),
    isFile: () => true,
    exists: () => true,
    fileSize: 0,
    append(segment) {
      self.segments.push(segment);
      self.leafName = segment;
      self.path = self.segments.join('/');
    },
    clone() {
      return makeFile(self.segments, state);
    },
    QueryInterface() {
      return self;
    },
    remove(recursive) {
      if (state.removeFails.includes(self.leafName)) {
        throw new Error(`file is locked: ${self.leafName}`);
      }
      const index = state.children.indexOf(self.leafName);
      if (index !== -1) state.children.splice(index, 1);
      self.removedWith = {recursive, path: self.path};
      return true;
    },
    // nsIEnumerator, as consumed by the sweep's
    // `while (entries.hasMoreElements()) entries.getNext()` loop.
    get directoryEntries() {
      // The real guard the sweep relies on: an nsIFile whose directory does not
      // exist throws HERE (not from dirsvc.get), which is what a first-ever
      // startup looks like before browser-extension-data/ has been created.
      if (state.enumerationFails) throw new Error('directory does not exist');
      const items = state.children.map(name => makeFile([...self.segments, name], state));
      let i = 0;
      return {
        hasMoreElements: () => i < items.length,
        getNext: () => items[i++],
      };
    },
  };
  return self;
}

/**
 * Evaluate the real BootstrapLoader.js, drive one add-on startup over a
 * ProfD/browser-extension-data/<id>/ directory seeded with `entries`, and
 * report what survived.
 *
 * @param {string[]} entries - leaf names present before startup (the litter)
 * @param {{enumerationFails?: boolean; removeFails?: string[]}} [opts] - test
 *   seams
 * @returns {{
 *   remaining: string[];
 *   logged: object[];
 *   autoRegistered: string[];
 * }}
 */
function startupWithLitter(entries, {enumerationFails = false, removeFails = []} = {}) {
  // ONE shared state object: every node in the tree refers to it, so a remove
  // through an enumerated child is visible to the test afterwards.
  const state = {children: [...entries], removeFails, enumerationFails};
  const logged = [];
  const autoRegistered = [];
  let writtenManifest = null;

  const dataDirSegments = ['ProfD', 'browser-extension-data', 'test@example.com'];

  // The file-output-stream stub is itself crash litter in miniature: a 0-byte
  // chrome.manifest is what a session killed between `truncate` and `remove`
  // leaves behind. Record what this startup wrote through it.
  const fileOutputStream = {
    init() {},
    write(text) {
      writtenManifest = text;
    },
    close() {},
  };

  const addon = {
    id: 'test@example.com',
    type: 'extension',
    version: '1.0',
    // A directory, not an XPI, so getURIForResourceInFile() takes the file:-URI
    // branch and the jar: path is never needed.
    file: makeFile(['extensions', 'test@example.com'], state),
  };

  const sandbox = {
    Services: {
      appinfo: {name: 'Firefox', platformVersion: '140.0'},
      io: {
        newFileURI: file => ({spec: `file:///${file.path}`}),
        newURI: spec => ({spec}),
        // startup() reads install.rdf and chrome.manifest out of the add-on
        // dir. The contents only have to parse, not be real RDF.
        newChannelFromURI: () => ({
          open: () => ({available: () => 0, close() {}}),
        }),
      },
      scriptSecurityManager: {getSystemPrincipal: () => ({})},
      dirsvc: {
        get(key) {
          if (key !== 'ProfD') return makeFile([key], state);
          // The sweep's tempDir = ProfD + browser-extension-data + <addon id>.
          return makeFile(dataDirSegments, state);
        },
      },
      scriptloader: {loadSubScript() {}},
      obs: {addObserver() {}, notifyObservers() {}},
      tm: {
        // How loadScope waits for bootstrap.js to evaluate. The compileScript
        // stub resolves on the microtask queue, which spinEventLoopUntil's
        // predicate cannot observe, so `startup` resolves through findMethod's
        // evalInSandbox fallback instead — irrelevant here, since the
        // manifest work happens before the inner startup() is called.
        spinEventLoopUntil() {
          return undefined;
        },
      },
    },
    ChromeUtils: {
      importESModule(spec) {
        if (spec.endsWith('AddonManager.sys.mjs')) {
          return {
            AddonManager: {
              isReady: false,
              AUTOUPDATE_DEFAULT: 0,
              SIGNEDSTATE_NOT_REQUIRED: 1,
              addExternalExtensionLoader() {},
              getAllAddons: () => Promise.resolve([]),
            },
            get AddonManagerPrivate() {
              return {externalExtensionLoaders: new Map()};
            },
          };
        }
        if (spec.endsWith('XPIDatabase.sys.mjs')) {
          return {XPIDatabase: {}, AddonInternal: function AddonInternal() {}};
        }
        if (spec.endsWith('XPIExports.sys.mjs')) {
          return {XPIExports: {verifyBundleSignedState: () => {}}};
        }
        if (spec.endsWith('XPIProvider.sys.mjs')) {
          return {
            XPIProvider: {
              BOOTSTRAP_REASONS: {APP_SHUTDOWN: 2, ADDON_INSTALL: 1, ADDON_UNINSTALL: 4},
            },
          };
        }
        if (spec.endsWith('Console.sys.mjs')) {
          return {
            ConsoleAPI: function ConsoleAPI() {
              return {
                warn: (...args) => logged.push({level: 'warn', args}),
                debug: () => {},
              };
            },
          };
        }
        return {};
      },
      defineESModuleGetters() {},
      defineLazyGetter(target, name, fn) {
        Object.defineProperty(target, name, {get: () => fn(), configurable: true});
      },
      compileScript: () => Promise.resolve({executeInGlobal() {}}),
    },
    NetUtil: {
      // One stubbed read serves both install.rdf and chrome.manifest: the
      // loader only parses the former for name/version and absolutizes the
      // latter's paths, neither of which affects the sweep.
      readInputStreamToString: () => 'content testext chrome/content/\n',
    },
    InstallRDF: {
      loadFromString: () => ({
        decode: () => ({id: 'test@example.com', version: '1.0', type: '2'}),
        getProps: () => ({name: 'Test Extension', version: '1.0'}),
      }),
    },
    Cc: {
      '@mozilla.org/network/file-output-stream;1': {createInstance: () => fileOutputStream},
      '@mozilla.org/chrome/chrome-registry;1': {
        getService: () => ({checkForNewChrome() {}}),
      },
    },
    Ci: {
      nsIFile: {},
      nsIComponentRegistrar: {},
      nsIFileOutputStream: {},
      nsILoadInfo: {SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL: 1},
      nsIContentPolicy: {TYPE_OTHER: 2},
      nsIScriptError: {},
      nsIXULChromeRegistry: {},
    },
    Cu: {
      // loadScope() calls `new Cu.Sandbox(...)`, so this must be a
      // constructor, not an arrow function.
      Sandbox: function Sandbox() {
        return {};
      },
      // findMethod()'s fallback: an add-on whose bootstrap.js has not (yet)
      // evaluated gets a no-op so startup() still runs the manifest work.
      evalInSandbox: () => () => {},
    },
    Components: {
      manager: {
        QueryInterface: () => ({
          autoRegister: file => autoRegistered.push(file.path),
        }),
      },
    },
    lockPref() {},
  };

  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, {filename: 'BootstrapLoader.js'});

  // BootstrapLoader is a top-level `const` in the file, so it lives in the
  // context's lexical scope — NOT on the sandbox object. Read it back out by
  // evaluating an expression in the same context.
  const loader = vm.runInContext('BootstrapLoader', sandbox);
  const scope = loader.loadScope(addon);
  scope.startup();

  return {
    remaining: [...state.children],
    logged,
    autoRegistered,
    writtenManifest: () => writtenManifest,
  };
}

// ── Crash litter is swept ──────────────────────────────────────────────────

test('sweep removes the uuid-named leftover manifests from a killed session', () => {
  // The #245 shape: chrome.manifest.<uuid> from a uuid-named temp-manifest
  // loader variant. The sweep matches the `chrome.manifest` PREFIX.
  const ctx = startupWithLitter(['chrome.manifest.abc-123', 'chrome.manifest.def-456']);
  assert.deepEqual(ctx.remaining, [], 'every uuid manifest variant was removed');
});

test('sweep removes the 0-byte chrome.manifest a crash between truncate and remove leaves', () => {
  // The other documented litter shape, and the one a `chrome.manifest.` (with
  // a trailing dot) prefix match would silently MISS.
  const ctx = startupWithLitter(['chrome.manifest']);
  assert.deepEqual(ctx.remaining, []);
});

test('sweep removes every litter shape at once, in one startup', () => {
  // The combination the E2E seeds — the mixed case is the realistic one.
  const ctx = startupWithLitter([
    'chrome.manifest.abc-123',
    'chrome.manifest',
    'chrome.manifest.def-456',
  ]);
  assert.deepEqual(ctx.remaining, []);
});

test("sweep leaves the add-on's own files alone", () => {
  // browser-extension-data/<id>/ belongs to the add-on, not to the loader. A
  // sweep that cleared the directory instead of matching manifest leaves would
  // delete these — the failure mode a prefix match has to avoid.
  const ctx = startupWithLitter([
    'chrome.manifest.abc-123',
    'storage.js',
    'data.json',
    'manifest.json', // close, but NOT chrome.manifest-prefixed
  ]);
  assert.deepEqual(ctx.remaining, ['storage.js', 'data.json', 'manifest.json']);
});

test('the fresh manifest is written AFTER the sweep, over the same name', () => {
  // Ordering is load-bearing: sweeping after writing would delete the manifest
  // this startup just registered. The write goes to the plain name the sweep
  // also targets, so the two must not race.
  const ctx = startupWithLitter(['chrome.manifest.abc-123', 'chrome.manifest']);
  assert.equal(typeof ctx.writtenManifest(), 'string', 'a manifest was written');
  assert.equal(ctx.autoRegistered.length, 1, 'the fresh manifest was autoRegistered exactly once');
});

// ── Failure modes degrade, never crash ──────────────────────────────────────

test('a missing extension-data directory is not an error', () => {
  // A first-ever startup has no browser-extension-data dir yet. The sweep
  // guards its enumeration itself; a regression would throw during add-on
  // startup and break the legacy extension.
  const ctx = startupWithLitter([], {enumerationFails: true});
  assert.deepEqual(ctx.remaining, []);
});

test('a locked leftover is logged and the rest are still swept', () => {
  // One file held by another process must not strand the others: the removal
  // loop is per-entry, and a failure is a warn rather than an abort.
  const ctx = startupWithLitter(['chrome.manifest.locked', 'chrome.manifest.free'], {
    removeFails: ['chrome.manifest.locked'],
  });
  assert.deepEqual(ctx.remaining, ['chrome.manifest.locked'], 'only the locked file survived');
  assert.equal(
    ctx.logged.some(entry => entry.level === 'warn'),
    true,
    'the failure was logged rather than swallowed silently'
  );
});
