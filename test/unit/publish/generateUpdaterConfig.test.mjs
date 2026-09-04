// test/unit/publish/generateUpdaterConfig.test.mjs — Unit tests for
// tools/publish/generateUpdaterConfig.mjs.
//
// MODE/LOCAL are captured from process.argv at module load, so per-mode behavior
// is verified by spawning child processes (config-probe.mjs) rather than
// re-importing.  The pure helpers are tested in-process.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'child_process';
import path from 'path';
import {fileURLToPath} from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  applyDevOverrides,
  applyInstallerLocalOverrides,
  applyUpdaterLocalOverrides,
  effectiveConfig,
  readConfig,
} = await import('../../../tools/publish/generateUpdaterConfig.mjs');

const PROBE = path.join(__dirname, 'config-probe.mjs');

/** Run the probe with extra argv; returns the parsed JSON. */
function probe(...args) {
  const r = spawnSync(process.execPath, [PROBE, ...args], {encoding: 'utf-8'});
  assert.equal(r.status, 0, `probe failed (${args.join(' ')}): ${r.stderr}`);
  return JSON.parse(r.stdout);
}

const prodConfig = readConfig();

test('readConfig parses installer.conf into a flat key/value map', () => {
  assert.equal(prodConfig.REPO_OWNER, 'onemen');
  assert.ok(prodConfig.ZIP_DOWNLOAD_REPO);
  assert.ok(prodConfig.RELEASE_NAME);
});

test('applyDevOverrides rewrites URLs to the dev-build jsDelivr base', () => {
  const dev = applyDevOverrides(prodConfig);
  assert.equal(dev.RELEASE_NAME, 'dev-build');
  assert.equal(dev.ASSET_SUFFIX, '-dev');
  assert.match(
    dev.ZIP_BASE_URL,
    /^https:\/\/cdn\.jsdelivr\.net\/gh\/onemen\/firefox-scripts@dev-build-/
  );
  assert.equal(dev.HASHES_URL, `${dev.ZIP_BASE_URL}/hashes.json`);
});

test('applyInstallerLocalOverrides points the C installer at localhost', () => {
  const loc = applyInstallerLocalOverrides(prodConfig);
  assert.equal(loc.ZIP_BASE_URL, `http://localhost:${prodConfig.DEFAULT_PORT || '8777'}`);
  assert.equal(loc.HASHES_URL, `${loc.ZIP_BASE_URL}/hashes.json`);
});

test('applyUpdaterLocalOverrides points the in-browser updater at file:// URLs', () => {
  const upd = applyUpdaterLocalOverrides();
  assert.match(upd.ZIP_BASE_URL, /^file:\/\//);
  assert.equal(upd.HASHES_URL, `${upd.ZIP_BASE_URL}/hashes.json`);
});

test('effectiveConfig in prod keeps installer.conf URLs', () => {
  const eff = effectiveConfig(prodConfig);
  assert.equal(eff.ZIP_BASE_URL, prodConfig.ZIP_BASE_URL);
  assert.equal(eff.ASSET_SUFFIX ?? '', '');
});

test('generated module: prod mode — no dev/local flags, github URLs', () => {
  const {module} = probe();
  assert.match(module, /IS_DEV: false/);
  assert.match(module, /IS_LOCAL: false/);
  assert.match(
    module,
    /ZIP_BASE_URL: 'https:\/\/github\.com\/onemen\/firefox-scripts\/releases\/download\//
  );
  assert.doesNotMatch(module, /cdn\.jsdelivr\.net/);
  assert.doesNotMatch(module, /localhost/);
  assert.doesNotMatch(module, /LOCAL_DIST_PATH: '[^']+'/);
});

test('generated module: dev mode — jsDelivr URLs, IS_DEV true, -dev suffix', () => {
  const {module} = probe('--mode=dev');
  assert.match(module, /IS_DEV: true/);
  assert.match(module, /IS_LOCAL: false/);
  // The URL may be prettier-wrapped (ZIP_BASE_URL:\n    'https://...') when the
  // dev-build branch name makes it long (local branches) or kept on one line
  // when it is short (CI's detached HEAD).  Match the URL itself, either way.
  assert.match(module, /https:\/\/cdn\.jsdelivr\.net\/gh\/onemen\/firefox-scripts@dev-build-/);
  assert.match(module, /ASSET_SUFFIX: '-dev'/);
});

test('generated module: prod-local — IS_LOCAL true, file:// URLs, no suffix change', () => {
  const {module} = probe('--mode=prod', '--local');
  assert.match(module, /IS_DEV: false/);
  assert.match(module, /IS_LOCAL: true/);
  assert.match(module, /file:\/\/\//);
  assert.match(module, /dist\/prod-/);
  assert.doesNotMatch(module, /ASSET_SUFFIX: '-dev'/);
});

test('generated module: dev-local — dev suffix retained on top of file:// URLs', () => {
  const {module} = probe('--mode=dev', '--local');
  assert.match(module, /IS_DEV: true/);
  assert.match(module, /IS_LOCAL: true/);
  assert.match(module, /file:\/\/\//);
  assert.match(module, /ASSET_SUFFIX: '-dev'/);
});

test('generated module: UI_BASE_URL points at the manifest host in every mode', () => {
  // Prod: updater-ui.zip is Pages-only (never a release asset, upload.mjs), so
  // the ui base is ZIP_PAGES_URL while package zips come from the release URL
  // (issue #102: ensureUpdaterUi used to fetch it from the release and 404'd).
  const prod = probe();
  assert.match(prod.module, /UI_BASE_URL: 'https:\/\/onemen\.github\.io\/firefox-scripts'/);
  assert.equal(prod.effective.UI_BASE_URL, prod.effective.ZIP_PAGES_URL);
  assert.notEqual(prod.effective.UI_BASE_URL, prod.effective.ZIP_BASE_URL);

  // Dev/local: everything publishes to one base — UI_BASE_URL equals it.
  const dev = probe('--mode=dev');
  assert.equal(dev.effective.UI_BASE_URL, dev.effective.ZIP_BASE_URL);
  const local = probe('--mode=prod', '--local');
  assert.match(local.effective.UI_BASE_URL, /^file:\/\//);
  assert.equal(local.effective.UI_BASE_URL, local.effective.ZIP_BASE_URL);
});
