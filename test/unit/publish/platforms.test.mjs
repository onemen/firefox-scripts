// test/unit/publish/platforms.test.mjs — unit tests for the publish platform
// registry (tools/publish/platforms.mjs).
//
// Regression locks for the CodeRabbit review:batch findings on PR #166:
// 1. (major) the aarch64 asset name must be installer_linux_aarch64 /
//    helper_linux_aarch64 — matching the Makefile targets and the updater's
//    download names — not installer_aarch64;
// 2. (minor) platform expansion must dedupe and never double-add a platform.

import {test} from 'node:test';
import assert from 'node:assert/strict';

const {PLATFORM, PLATFORM_LINUX_EXTRA, expandPlatforms, helperAssetName, installerAssetName} =
  await import('../../../tools/publish/platforms.mjs');

test('asset names: prod names match the Makefile outputs and updater filenames', () => {
  assert.equal(installerAssetName('win', ''), 'installer_win.exe');
  assert.equal(installerAssetName('linux', ''), 'installer_linux');
  assert.equal(installerAssetName('mac', ''), 'installer_mac');
  // The #166 major finding: aarch64 spells its asset with the linux_ prefix.
  assert.equal(installerAssetName('aarch64', ''), 'installer_linux_aarch64');
  assert.equal(helperAssetName('aarch64', ''), 'helper_linux_aarch64');
});

test('asset names: -dev suffix lands before the extension (dev snapshot names)', () => {
  assert.equal(installerAssetName('win', '-dev'), 'installer_win-dev.exe');
  assert.equal(installerAssetName('aarch64', '-dev'), 'installer_linux_aarch64-dev');
  assert.equal(helperAssetName('linux', '-dev'), 'helper_linux-dev');
});

test('make targets are untouched by asset naming', () => {
  assert.equal(PLATFORM.aarch64.makeInstaller, 'dist_linux_aarch64');
  assert.equal(PLATFORM.aarch64.makeHelper, 'helper_linux_aarch64');
});

test('expandPlatforms: linux implies the aarch64 twin', () => {
  assert.deepEqual(expandPlatforms(['linux']), ['linux', 'aarch64']);
  assert.deepEqual(expandPlatforms(['win', 'linux', 'mac']), ['win', 'linux', 'aarch64', 'mac']);
});

test('expandPlatforms: explicit aarch64 alone builds the twin only', () => {
  assert.deepEqual(expandPlatforms(['aarch64']), ['aarch64']);
});

test('expandPlatforms: dedupes repeated and implied entries (#166 minor finding)', () => {
  assert.deepEqual(expandPlatforms(['linux', 'linux']), ['linux', 'aarch64']);
  assert.deepEqual(expandPlatforms(['linux', 'aarch64']), ['linux', 'aarch64']);
  assert.deepEqual(expandPlatforms(['aarch64', 'linux']), ['aarch64', 'linux']);
  assert.deepEqual(expandPlatforms([]), []);
});

test('expandPlatforms: unknown platform throws with the valid set', () => {
  assert.throws(() => expandPlatforms(['bogus']), /Unknown platform 'bogus'/);
  assert.throws(() => expandPlatforms(['bogus']), /win\|linux\|aarch64\|mac/);
});

test('linux extra map only expands from linux', () => {
  assert.deepEqual(PLATFORM_LINUX_EXTRA, {linux: 'aarch64'});
});
