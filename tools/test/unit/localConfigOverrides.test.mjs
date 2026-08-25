// tools/test/unit/localConfigOverrides.test.mjs — Unit tests for
// tools/test/e2e/helpers.mjs localConfigOverrides().
//
// Tests: cross-OS snapshot (baked LOCAL_DIST_PATH ≠ local snapshot dir) →
// override prefs pointing at the local snapshot; same path → no-op; missing
// config / missing LOCAL_DIST_PATH → no-op.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const helpersUrl = pathToFileURL(path.join(REPO_ROOT, 'tools', 'test', 'e2e', 'helpers.mjs')).href;
const {localConfigOverrides} = await import(helpersUrl);

const OVERRIDE = 'extensions.firefox-scripts.override.';

/** Write a minimal generated updater-config.sys.mjs with the given dist path. */
function writeConfig(chromeUtils, distPath) {
  const cfg = path.join(chromeUtils, 'updater', 'updater-config.sys.mjs');
  fs.mkdirSync(path.dirname(cfg), {recursive: true});
  fs.writeFileSync(
    cfg,
    `export const CONFIG = {\n  HASHES_URL: 'file:///x/hashes.json',\n  LOCAL_DIST_PATH: '${distPath}',\n};\n`
  );
}

function makeProfile() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fxs-override-'));
}

test('localConfigOverrides: foreign snapshot path → override prefs at local dist', () => {
  const profile = makeProfile();
  try {
    const chromeUtils = path.join(profile, 'chrome', 'utils');
    const snapshotDir = path.join(profile, 'dist', 'dev-HEAD-abc123');
    // Snapshot built on another machine (e.g. the ubuntu CI snapshot).
    writeConfig(chromeUtils, '/home/runner/work/firefox-scripts/firefox-scripts/dist/dev-HEAD-abc123');

    const prefs = localConfigOverrides(chromeUtils, snapshotDir);
    const base = pathToFileURL(snapshotDir.replace(/\\/g, '/')).href.replace(/\/$/, '');
    assert.deepEqual(prefs, {
      [OVERRIDE + 'HASHES_URL']: `${base}/hashes.json`,
      [OVERRIDE + 'ZIP_BASE_URL']: base,
      [OVERRIDE + 'HELPER_BASE_URL']: base,
    });
  } finally {
    fs.rmSync(profile, {recursive: true, force: true});
  }
});

test('localConfigOverrides: same machine path → no overrides', () => {
  const profile = makeProfile();
  try {
    const chromeUtils = path.join(profile, 'chrome', 'utils');
    const snapshotDir = path.join(profile, 'dist', 'dev-HEAD-abc123');
    const local = snapshotDir.replace(/\\/g, '/');
    writeConfig(chromeUtils, local);

    assert.deepEqual(localConfigOverrides(chromeUtils, snapshotDir), {});
  } finally {
    fs.rmSync(profile, {recursive: true, force: true});
  }
});

test('localConfigOverrides: missing config file → no overrides', () => {
  const profile = makeProfile();
  try {
    const chromeUtils = path.join(profile, 'chrome', 'utils');
    assert.deepEqual(localConfigOverrides(chromeUtils, path.join(profile, 'dist')), {});
  } finally {
    fs.rmSync(profile, {recursive: true, force: true});
  }
});

test('localConfigOverrides: config without LOCAL_DIST_PATH → no overrides', () => {
  const profile = makeProfile();
  try {
    const chromeUtils = path.join(profile, 'chrome', 'utils');
    const cfg = path.join(chromeUtils, 'updater', 'updater-config.sys.mjs');
    fs.mkdirSync(path.dirname(cfg), {recursive: true});
    fs.writeFileSync(cfg, 'export const CONFIG = {HASHES_URL: "https://x/hashes.json"};\n');

    assert.deepEqual(localConfigOverrides(chromeUtils, path.join(profile, 'dist')), {});
  } finally {
    fs.rmSync(profile, {recursive: true, force: true});
  }
});
