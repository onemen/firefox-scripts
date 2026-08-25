// tools/test/unit/repointLocalConfig.test.mjs — Unit tests for the E2E
// shared-snapshot config repoint (tools/test/e2e/helpers.mjs).

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const helpersUrl = pathToFileURL(
  path.join(REPO_ROOT, 'tools', 'test', 'e2e', 'helpers.mjs')
).href;
const {repointLocalConfig} = await import(helpersUrl);

const CONFIG_TEMPLATE = (dist) => `export const CONFIG = {
  HASHES_URL: 'file://${dist}/hashes.json',
  ZIP_BASE_URL: 'file://${dist}',
  LOCAL_DIST_PATH: '${dist}',
  ASSET_SUFFIX: '-dev',
};`;

function setup(contents) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'repoint-'));
  const chromeUtils = path.join(tmp, 'chrome', 'utils');
  const cfg = path.join(chromeUtils, 'updater', 'updater-config.sys.mjs');
  fs.mkdirSync(path.dirname(cfg), {recursive: true});
  fs.writeFileSync(cfg, contents);
  return {tmp, chromeUtils, cfg};
}

test('repointLocalConfig: rewrites the baked builder path to the local snapshot dir', () => {
  const {tmp, chromeUtils, cfg} = setup(
    CONFIG_TEMPLATE('/home/runner/work/firefox-scripts/firefox-scripts/dist/dev-HEAD-abc1234')
  );
  try {
    const local = 'D:/a/firefox-scripts/firefox-scripts/dist/dev-HEAD-abc1234';
    const changed = repointLocalConfig(chromeUtils, local);
    assert.equal(changed, true);
    const text = fs.readFileSync(cfg, 'utf-8');
    assert.match(text, new RegExp(`HASHES_URL: 'file://${local}/hashes.json'`));
    assert.match(text, new RegExp(`ZIP_BASE_URL: 'file://${local}'`));
    assert.match(text, new RegExp(`LOCAL_DIST_PATH: '${local}'`));
    assert.ok(!text.includes('/home/runner/'), 'no builder path remains');
  } finally {
    fs.rmSync(tmp, {recursive: true, force: true});
  }
});

test('repointLocalConfig: no-op when the config already points at this snapshot', () => {
  const {tmp, chromeUtils, cfg} = setup(
    CONFIG_TEMPLATE('/home/runner/work/firefox-scripts/firefox-scripts/dist/dev-HEAD-abc1234')
  );
  try {
    const before = fs.readFileSync(cfg, 'utf-8');
    const changed = repointLocalConfig(chromeUtils, '/home/runner/work/firefox-scripts/firefox-scripts/dist/dev-HEAD-abc1234');
    assert.equal(changed, false);
    assert.equal(fs.readFileSync(cfg, 'utf-8'), before);
  } finally {
    fs.rmSync(tmp, {recursive: true, force: true});
  }
});

test('repointLocalConfig: returns false when the config file is missing', () => {
  const {tmp} = setup(''); // empty chromeUtils without the config
  try {
    const chromeUtils = path.join(tmp, 'chrome', 'utils');
    assert.equal(repointLocalConfig(chromeUtils, '/some/dist'), false);
  } finally {
    fs.rmSync(tmp, {recursive: true, force: true});
  }
});

test('repointLocalConfig: leaves a non-local (remote) config untouched', () => {
  const {tmp, chromeUtils, cfg} = setup(
    "export const CONFIG = {\n  HASHES_URL: 'https://onemen.github.io/firefox-scripts/hashes.json',\n  LOCAL_DIST_PATH: '',\n};"
  );
  try {
    const before = fs.readFileSync(cfg, 'utf-8');
    assert.equal(repointLocalConfig(chromeUtils, '/some/dist'), false);
    assert.equal(fs.readFileSync(cfg, 'utf-8'), before);
  } finally {
    fs.rmSync(tmp, {recursive: true, force: true});
  }
});
