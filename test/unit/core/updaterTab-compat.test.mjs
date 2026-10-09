// test/unit/core/updaterTab-compat.test.mjs — the updater tab's
// backward-compatibility seam.
//
// The deadlock this pins: updater-ui.zip is installed BY
// scriptsUpdater.sys.mjs, and the module can only be replaced BY the tab. A tab
// that hard-requires an export the installed module lacks therefore deadlocks
// the user — the tab throws before its first state push, so the card stays
// empty and nothing can install the module that would fix it. On 2026-09-06
// (`fxFolderDir`, #142) and 2026-09-12 (`getAssetSuffix`, `getChannelState`,
// #189) each export landed in the module and its first tab-side consumer in
// the same commit, stranding every install older than those dates on a module
// that cannot run the tab that would rescue it.
//
// These tests evaluate the real tab engine (tools/publish/remote-ui/updater.js)
// in a Node vm with stubbed Firefox globals (same technique as
// scriptsUpdater-channel.test.mjs / bootstrapLoader.test.mjs) against:
//   - the LEGACY export set — the exact export list of the reporter's
//     attached utils.zip, built at c266468 (2026-09-05), the last commit before
//     the first breaking export. The list is vendored as a literal so the
//     fixture can never drift into "whatever main exports today";
//   - the current module, asserting the real resolvers still win (no
//     regression of #282's suffix drop or ADR 0026's dead-channel fallback);
//   - a static check of the tab's import surface, so a future unguarded export
//     fails here rather than in a user's browser;
//   - the config install's hold-vs-escalation decision (see that section), the
//     one piece of install machinery a vm CAN reach: it needs no real browser.
// Not exercised here: the zip/DOM install machinery around it (the E2E legs).

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {comparePlatformVersions, resolveSandboxLazyModule} from '../../shared/sandboxServices.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const TAB_PATH = path.join(REPO_ROOT, 'tools', 'publish', 'remote-ui', 'updater.js');
const UI_PATH = path.join(REPO_ROOT, 'tools', 'publish', 'remote-ui', 'updater-ui.js');
const MODULE_PATH = path.join(
  REPO_ROOT,
  'core',
  'chrome',
  'utils',
  'updater',
  'scriptsUpdater.sys.mjs'
);

const TAB_SRC = fs.readFileSync(TAB_PATH, 'utf-8').replace(/\r\n/g, '\n');
const UI_SRC = fs.readFileSync(UI_PATH, 'utf-8').replace(/\r\n/g, '\n');

/**
 * The complete export list of scriptsUpdater.sys.mjs at c266468 (2026-09-05),
 * as attached to issue #383. Three names the tab uses today are absent from it
 * (fxFolderDir, getAssetSuffix, getChannelState) and must stay feature-
 * detected in the tab.
 */
const LEGACY_EXPORTS = [
  'getHashesUrl',
  'getZipBaseUrl',
  'getUiBaseUrl',
  'getHelperBaseUrl',
  'initScriptsUpdater',
  'checkScriptsUpdateNeeded',
  'ensureUpdaterUi',
  'fetchBytes',
  'fetchText',
  'computeFilesHash',
  'computeZipFilesHash',
  'readZipEntry',
  'extractZipFlatten',
  'copyFileList',
];

/** Exports the tab consumes that postdate the legacy floor: guarded by the seam. */
const GUARDED = ['getAssetSuffix', 'getChannelState', 'fxFolderDir', 'withFileHoldRetry'];

/** The reporter's generated config (stable channel, no STABLE_* keys: pre-0026). */
const LEGACY_CONFIG = {
  HASHES_URL: 'https://onemen.github.io/firefox-scripts/hashes.json',
  ZIP_BASE_URL: 'https://github.com/onemen/firefox-scripts/releases/download/latest',
  UI_BASE_URL: 'https://onemen.github.io/firefox-scripts',
  HELPER_BASE_URL: 'https://onemen.github.io/firefox-scripts',
  ASSET_SUFFIX: '',
  IS_DEV: false,
  IS_LOCAL: false,
  DEV_BRANCH: 'dev-build-main-c266468',
};

/* ---------------- Firefox-service stubs ---------------- */

function makePrefs(store) {
  return {
    getCharPref: (key, d = '') => (key in store ? store[key] : d),
    setCharPref: (key, v) => {
      store[key] = String(v);
    },
    clearUserPref: key => {
      delete store[key];
    },
  };
}

/** Minimal nsIFile stand-in: `exists()` false keeps readAppDisplayName inert. */
function makeNsIFile(nativePath) {
  let p = nativePath;
  return {
    get path() {
      return p;
    },
    initWithPath(next) {
      p = next;
    },
    clone() {
      return makeNsIFile(p);
    },
    append(part) {
      p = p.replace(/[\\/]+$/, '') + '/' + part;
    },
    exists: () => false,
    reveal() {},
  };
}

function makeIoFiles({exePath, grePath, profPath}) {
  const dirs = {XREExeF: exePath, GreD: grePath, ProfD: profPath};
  return {
    get: key => makeNsIFile(dirs[key] ?? grePath),
  };
}

/**
 * A scriptsUpdater namespace exposing exactly LEGACY_EXPORTS (the tab's seven
 * unconditional names implemented; the rest are inert stubs), so the test
 * cannot pass by accident on an export the reporter's module never had.
 */
function legacyNamespace(config, {utilsUpdateNeeded = true} = {}) {
  const names = {
    getHashesUrl: () => config.HASHES_URL,
    getZipBaseUrl: () => config.ZIP_BASE_URL,
    getUiBaseUrl: () => config.UI_BASE_URL,
    getHelperBaseUrl: () => config.HELPER_BASE_URL,
    initScriptsUpdater: () => {},
    checkScriptsUpdateNeeded: async () => ({
      fxFolder: {updateNeeded: false, date: '2026-08-21', remoteHash: 'a'.repeat(64), files: []},
      utils: {
        updateNeeded: utilsUpdateNeeded,
        date: '2026-09-26',
        remoteHash: 'b'.repeat(64),
        files: ['updater/scriptsUpdater.sys.mjs'],
      },
      updaterUi: {updateNeeded: false, date: '', remoteHash: '', files: []},
    }),
    ensureUpdaterUi: async () => true,
    fetchBytes: async () => new Uint8Array(),
    fetchText: async () => '',
    computeFilesHash: () => 'a'.repeat(64),
    computeZipFilesHash: async () => 'a'.repeat(64),
    readZipEntry: () => null,
    extractZipFlatten: async () => '',
    copyFileList: async () => {},
  };
  assert.deepEqual(
    Object.keys(names).sort(),
    [...LEGACY_EXPORTS].sort(),
    'the stub namespace must mirror the legacy export set exactly'
  );
  return names;
}

/**
 * Evaluate the tab engine against `moduleExports` + `config`, run its real
 * init() and resolve with the state snapshot it pushed.
 *
 * `ioUtils` overrides individual IOUtils methods (the install tests inject a
 * copy that fails); `subprocessExitCode` is what the elevated-copy helper
 * "returns", and every spawn is recorded in `subprocessCalls` so a test can
 * assert the tab did — or did not — ask the user for admin rights.
 */
async function runTab({
  moduleExports,
  config,
  exePath = 'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
  grePath = 'C:\\Program Files\\Mozilla Firefox',
  profPath = 'C:\\Users\\test\\AppData\\Roaming\\Mozilla\\Firefox\\Profiles\\p1',
  platform = 'win',
  xpcomabi = 'x86_64',
  ioUtils = {},
  subprocessExitCode = 0,
} = {}) {
  const prefs = {};
  const windowStub = {};
  const subprocessCalls = [];
  const sandbox = {
    window: windowStub,
    ChromeUtils: {
      importESModule(spec) {
        if (spec.includes('Downloads')) return {Downloads: {fetch: async () => {}}};
        if (spec.includes('Subprocess')) {
          return {
            Subprocess: {
              call: async cmd => {
                subprocessCalls.push(cmd);
                return {wait: async () => ({exitCode: subprocessExitCode})};
              },
            },
          };
        }
        if (spec.includes('AppConstants')) {
          return {AppConstants: {platform, MOZ_APP_VERSION_DISPLAY: '140.0'}};
        }
        if (spec.includes('updater-config')) return {CONFIG: config};
        if (spec.includes('scriptsUpdater')) return moduleExports;
        throw new Error(`unexpected importESModule(${spec})`);
      },
    },
    Services: {
      prefs: makePrefs(prefs),
      dirsvc: makeIoFiles({exePath, grePath, profPath}),
      appinfo: {version: '140.0', XPCOMABI: xpcomabi, oscpu: 'Windows NT'},
      console: {logStringMessage() {}},
      startup: {quit() {}},
      obs: {notifyObservers() {}},
    },
    Cc: {},
    Ci: new Proxy({}, {get: () => ({})}),
    PathUtils: {
      profileDir: profPath,
      tempDir: os.tmpdir(),
      join: (...parts) => parts.join('/'),
      parent: p => p,
    },
    IOUtils: {
      // The helper's magic-number check reads 4 bytes; 'MZ' is the PE header,
      // so a stubbed download passes it and the test reaches the spawn.
      read: async () => new Uint8Array([0x4d, 0x5a, 0x90, 0x00]),
      makeDirectory: async () => {},
      copy: async () => {},
      remove: async () => {},
      ...ioUtils,
    },
    console,
    Blob,
    URL: {createObjectURL: () => 'blob:x', revokeObjectURL() {}},
    document: {createElement: () => ({click() {}}), body: {appendChild() {}, removeChild() {}}},
  };
  vm.runInContext(TAB_SRC, vm.createContext(sandbox), {filename: 'updater.js'});

  const engine = windowStub.UpdaterEngine;
  assert.ok(engine, 'the tab engine must expose window.UpdaterEngine');
  let state = null;
  engine.onState = snapshot => {
    state = snapshot;
  };
  engine.onProgress = () => {};
  await engine.init();
  assert.ok(state, 'engineInit() must push a state snapshot');
  return {state, prefs, engine, subprocessCalls};
}

/* ---------------- the reporter's scenario (legacy module) ---------------- */

test('legacy module: the tab renders and offers the very update that unblocks it', async () => {
  const config = {...LEGACY_CONFIG};
  const {state, prefs} = await runTab({moduleExports: legacyNamespace(config), config});

  // Plain, unsuffixed asset names from the legacy config's own URLs.
  assert.equal(state.fxFolderUrl, `${config.ZIP_BASE_URL}/fx-folder.zip`);
  assert.equal(state.utilsUrl, `${config.ZIP_BASE_URL}/utils.zip`);
  assert.equal(state.installerUrl, `${config.ZIP_BASE_URL}/installer_win.exe`);
  // Config install dir: GreD for an ordinary install.
  assert.equal(state.configDir, 'C:\\Program Files\\Mozilla Firefox');
  assert.equal(state.packages.config.manualInstall, false);
  // The user sees utils "Update available" and can act on it right now.
  assert.equal(state.packages.utils.updateNeeded, true);
  assert.equal(state.packages.config.updateNeeded, false);
  // A completed check records the shown day (ADR 0012).
  assert.equal(prefs['extensions.firefox-scripts.lastScriptsCheckDate'] !== undefined, true);
});

test('legacy module: no migration banner state (channel reports dev)', async () => {
  const config = {...LEGACY_CONFIG};
  const {state} = await runTab({moduleExports: legacyNamespace(config), config});
  // A pre-ADR-0026 module has no channels and never migrated; showMigrationBanner
  // only reveals itself for channel === 'stable', so it must stay off.
  assert.equal(state.channel, 'dev');
  assert.equal(state.migratedFromDev, false);
});

test('legacy module with a -dev config keeps fetching namespaced assets', async () => {
  const config = {...LEGACY_CONFIG, ASSET_SUFFIX: '-dev', IS_DEV: true};
  const {state} = await runTab({moduleExports: legacyNamespace(config), config});
  assert.equal(state.utilsUrl, `${config.ZIP_BASE_URL}/utils-dev.zip`);
  assert.equal(state.fxFolderUrl, `${config.ZIP_BASE_URL}/fx-folder-dev.zip`);
  assert.equal(state.installerUrl, `${config.ZIP_BASE_URL}/installer_win-dev.exe`);
});

test('legacy module on Snap maps the config dir to /etc/firefox', async () => {
  const config = {...LEGACY_CONFIG};
  const {state} = await runTab({
    moduleExports: legacyNamespace(config),
    config,
    exePath: '/snap/firefox/1234/usr/lib/firefox/firefox',
    grePath: '/snap/firefox/1234/usr/lib/firefox',
    platform: 'linux',
    xpcomabi: 'x86_64',
  });
  assert.equal(state.configDir, '/etc/firefox');
  assert.equal(state.packages.config.manualInstall, true);
});

/* ---------------- the current module (no regression) ---------------- */

test('current module: its own resolvers win over the fallbacks', async () => {
  const config = {...LEGACY_CONFIG, ASSET_SUFFIX: '-dev', IS_DEV: true};
  // Sentinel values: if the seam ever prefers its fallback over a present
  // module resolver, these assertions fail.
  const moduleExports = {
    ...legacyNamespace(config),
    getAssetSuffix: () => '-MODULE',
    getChannelState: () => ({channel: 'stable', migratedFromDev: true}),
    fxFolderDir: () => '/module/fx-folder',
  };
  const {state} = await runTab({moduleExports, config});
  assert.equal(state.utilsUrl, `${config.ZIP_BASE_URL}/utils-MODULE.zip`);
  assert.equal(state.installerUrl, `${config.ZIP_BASE_URL}/installer_win-MODULE.exe`);
  assert.equal(state.configDir, '/module/fx-folder');
  assert.equal(state.channel, 'stable');
  assert.equal(state.migratedFromDev, true);
});

/* ---------------- static guards ---------------- */

/** Names the tab destructures off the module namespace. */
function importedNames() {
  const match = TAB_SRC.match(
    /const scriptsUpdater = ChromeUtils\.importESModule\([\s\S]*?\nconst \{([\s\S]*?)\} = scriptsUpdater;/
  );
  assert.ok(match, 'the tab must import the module as a namespace');
  return match[1]
    .split(',')
    .map(line => line.trim())
    .filter(Boolean);
}

test('the tab imports only legacy-safe or feature-detected module exports', () => {
  const allowed = new Set([...LEGACY_EXPORTS, ...GUARDED]);
  const unexpected = importedNames().filter(name => !allowed.has(name));
  assert.deepEqual(unexpected, [], 'unguarded module exports in the tab break old installs');
});

test('every guarded export is feature-detected with a fallback', () => {
  for (const name of GUARDED) {
    assert.ok(
      TAB_SRC.includes(`typeof scriptsUpdater.${name} === 'function'`),
      `${name} must be feature-detected at the seam`
    );
  }
});

test('the UI client needs no guards: it imports nothing from the module', () => {
  assert.equal(/scriptsUpdater\.sys\.mjs/.test(UI_SRC), false);
  assert.equal(/importESModule/.test(UI_SRC), false);
});

test('the legacy fixture stays a subset of the current module (exports are never removed)', () => {
  const moduleSrc = fs.readFileSync(MODULE_PATH, 'utf-8').replace(/\r\n/g, '\n');
  const current = new Set(
    [...moduleSrc.matchAll(/^export (?:async )?(?:function|const|let|class) (\w+)/gm)].map(
      m => m[1]
    )
  );
  const lost = LEGACY_EXPORTS.filter(name => !current.has(name));
  assert.deepEqual(lost, [], 'dropping an export the legacy floor had would break the fixture');
});

/* ---------------- the Snap rule is one rule ---------------- */
// The fallback duplicates the module's Snap rule (`XREExeF` under /snap/ →
// /etc/firefox, else GreD). Nothing above ties the two together: an install
// stranded on an older module would get whichever rule the TAB spells,
// while every newer install gets whichever rule the MODULE spells — a silent
// split the static subset test cannot see. These two tests pin them to agree by
// running BOTH against the same dirsvc values and comparing the answers.

/**
 * Evaluate the real module in a vm and return its sandbox, so a test can drive
 * the module's own function rather than a hand-written stand-in. Same technique
 * as the channel tests: only the lazy getters the module resolves at load time
 * are stubbed (SessionStore, Downloads, Timer — Timer's setTimeout fires
 * immediately, so the retry backoff costs the test nothing).
 *
 * @param {string} exePath - Services XREExeF (the Snap marker lives here)
 * @param {string} grePath - Services GreD
 * @returns {object} the sandbox, carrying every export as a property
 */
function evaluateRealModule(exePath, grePath) {
  const source = fs
    .readFileSync(MODULE_PATH, 'utf-8')
    .replace(/\r\n/g, '\n')
    // Every export is a function declaration, so stripping `export ` exposes
    // the API on the sandbox object.
    .replace(/^export /gm, '');
  const sandbox = {
    ChromeUtils: {
      generateQI: () => () => {},
      importESModule(spec) {
        if (spec.includes('updater-config')) return {CONFIG: {...LEGACY_CONFIG}};
        throw new Error(`unexpected importESModule(${spec})`);
      },
      defineESModuleGetters(target, getters) {
        for (const [name, spec] of Object.entries(getters)) {
          target[name] =
            String(spec).includes('Timer.sys.mjs') ?
              cb => setTimeout(cb, 0)
            : resolveSandboxLazyModule(name, spec);
        }
      },
    },
    Services: {
      prefs: makePrefs({}),
      appinfo: {platformVersion: '140.0'},
      vc: {compare: comparePlatformVersions},
      dirsvc: {get: key => makeNsIFile(key === 'XREExeF' ? exePath : grePath)},
    },
    Ci: new Proxy({}, {get: () => ({})}),
    console,
    queueMicrotask,
  };
  vm.runInContext(source, vm.createContext(sandbox), {filename: 'scriptsUpdater.sys.mjs'});
  return sandbox;
}

/** The real module's fxFolderDir() for the given dirsvc values. */
function realModuleFxFolderDir(exePath, grePath) {
  const sandbox = evaluateRealModule(exePath, grePath);
  assert.equal(typeof sandbox.fxFolderDir, 'function', 'the module must export fxFolderDir');
  return sandbox.fxFolderDir();
}

test('the tab fallback agrees with the module: ordinary install keeps GreD', async () => {
  const exePath = 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';
  const grePath = 'C:\\Program Files\\Mozilla Firefox';
  // No fxFolderDir in the legacy namespace → the tab must run its fallback.
  const {state} = await runTab({
    moduleExports: legacyNamespace({...LEGACY_CONFIG}),
    config: {...LEGACY_CONFIG},
    exePath,
    grePath,
  });
  assert.equal(realModuleFxFolderDir(exePath, grePath), grePath);
  assert.equal(
    state.configDir,
    grePath,
    'tab fallback must match the module on an ordinary install'
  );
});

test('the tab fallback agrees with the module: a snap install maps to /etc/firefox', async () => {
  const exePath = '/snap/firefox/1234/usr/lib/firefox/firefox';
  const grePath = '/snap/firefox/1234/usr/lib/firefox';
  const {state} = await runTab({
    moduleExports: legacyNamespace({...LEGACY_CONFIG}),
    config: {...LEGACY_CONFIG},
    exePath,
    grePath,
    platform: 'linux',
  });
  assert.equal(realModuleFxFolderDir(exePath, grePath), '/etc/firefox');
  assert.equal(
    state.configDir,
    '/etc/firefox',
    'tab fallback must match the module on a snap install'
  );
});

/* ---------------- a hold is not a permission problem ---------------- */
// installConfigFiles() copies into the LIVE install dir (GreD), where Defender,
// the indexer or the browser itself can hold a file for a moment. It falls
// through to the elevated helper on any failure — but an incidental hold must
// not cost the user a UAC prompt that fixes nothing. The hold is retried
// first; only a copy that still fails escalates. No E2E leg can provoke a sharing
// violation, so it is pinned here against injected IOUtils failures.

/**
 * A module namespace with one file to install for the config package, plus the
 * real module's hold-retry when `holdRetry` is on (the seam resolves it at
 * load; a legacy namespace carries none and must escalate on the first hold).
 *
 * @param {{holdRetry: boolean}} opts
 * @returns {Object}
 */
function configInstallNamespace({holdRetry}) {
  const names = legacyNamespace({...LEGACY_CONFIG}, {utilsUpdateNeeded: false});
  // The REAL module's retry, not a stand-in: this test's claim is that the tab
  // routes the copy through it, and a hand-written stub could agree with a
  // stale idea of the hold signature while the module moved on.
  const realModule = evaluateRealModule();
  assert.equal(
    typeof realModule.withFileHoldRetry,
    'function',
    'the module must export withFileHoldRetry for the tab to use'
  );
  return {
    ...names,
    checkScriptsUpdateNeeded: async () => ({
      fxFolder: {
        updateNeeded: true,
        date: '2026-10-02',
        remoteHash: 'a'.repeat(64),
        files: ['config.js'],
      },
      utils: {updateNeeded: false, date: '2026-09-26', remoteHash: 'b'.repeat(64), files: []},
      updaterUi: {updateNeeded: false, date: '', remoteHash: '', files: []},
    }),
    extractZipFlatten: async () => '/tmp/extracted',
    ...(holdRetry ? {withFileHoldRetry: realModule.withFileHoldRetry} : {}),
  };
}

/** A Gecko-style file error, the way IOUtils rejects a held target. */
function fileHoldError(name = 'NS_ERROR_FILE_IS_LOCKED') {
  return Object.assign(new Error(name), {name, result: 0x80520015});
}

/**
 * Drive the real install flow and report what the user was asked for.
 *
 * @param {{holdRetry?: boolean; copy: () => Promise<void>}} opts
 */
async function runConfigInstall({holdRetry = true, copy}) {
  const moduleExports = configInstallNamespace({holdRetry});
  const {engine, subprocessCalls} = await runTab({
    moduleExports,
    config: {...LEGACY_CONFIG},
    ioUtils: {copy},
  });
  const progress = [];
  engine.onProgress = (...args) => progress.push(args);
  await engine.install(['config']);
  return {progress, subprocessCalls};
}

test('config install: a transient hold is retried, not escalated to UAC', async () => {
  let attempts = 0;
  const {progress, subprocessCalls} = await runConfigInstall({
    copy: async () => {
      attempts += 1;
      if (attempts === 1) throw fileHoldError();
    },
  });
  assert.equal(attempts, 2, 'the held copy must be retried, exactly once here');
  assert.deepEqual(subprocessCalls, [], 'a hold must never reach the elevated helper');
  assert.ok(
    progress.some(args => String(args[1]).startsWith('Configuration files installed.')),
    `expected a plain success message, got ${JSON.stringify(progress)}`
  );
});

test('config install: a hold that outlives the retry budget still escalates', async () => {
  let attempts = 0;
  const {progress, subprocessCalls} = await runConfigInstall({
    copy: async () => {
      attempts += 1;
      throw fileHoldError();
    },
  });
  assert.equal(attempts, 4, 'the hold is retried to the budget, then given up on');
  assert.equal(subprocessCalls.length, 1, 'a copy that keeps failing escalates to the helper');
  assert.ok(
    progress.some(args => String(args[1]).includes('Requesting administrator permission')),
    `expected the elevation prompt, got ${JSON.stringify(progress)}`
  );
});

test('config install: a non-hold failure escalates immediately, without the retry budget', async () => {
  let attempts = 0;
  const {subprocessCalls} = await runConfigInstall({
    copy: async () => {
      attempts += 1;
      throw new Error('NS_ERROR_FILE_CANT_BE_CREATED');
    },
  });
  assert.equal(attempts, 1, 'only holds are retried; a real failure escalates at once');
  assert.equal(subprocessCalls.length, 1);
});

test('config install: a legacy module without the hold retry still escalates', async () => {
  // The seam must stay tolerant: a module predating the export keeps the
  // pre-existing escalate-on-any-failure path (the tolerance issue #383 is
  // about, in the install direction).
  let attempts = 0;
  const {subprocessCalls} = await runConfigInstall({
    holdRetry: false,
    copy: async () => {
      attempts += 1;
      throw fileHoldError();
    },
  });
  assert.equal(attempts, 1, 'without the export there is no retry to ride the hold out');
  assert.equal(subprocessCalls.length, 1, 'the old path escalates, which is still correct');
});
