// test/unit/publish/componentReleases.test.mjs — unit tests for the pure
// helpers of tools/publish/componentReleases.mjs (issue #72). The GitHub sync
// routine hits the network — not unit-tested.
//
// paths.js/publishMode.mjs are argv-coupled, so --mode=prod is pushed before
// import (the same pattern the other publish unit tests use).

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath, pathToFileURL} from 'node:url';

process.argv.push('--mode=prod');

const moduleUrl = pathToFileURL(
  fileURLToPath(new URL('../../../tools/publish/componentReleases.mjs', import.meta.url))
).href;
const {componentDate, scriptsTag, installerTag, groupBuilt, renderComponentBody, componentAssets} =
  await import(moduleUrl);

test('componentDate: YYYY-MM-DD UTC, injectable clock', () => {
  assert.equal(componentDate(new Date('2026-09-09T23:30:00Z')), '2026-09-09');
  // A date near midnight stays on the UTC side.
  assert.match(componentDate(new Date('2026-01-01T00:00:00Z')), /^2026-01-01$/);
});

test('tags: date-stamped, per component', () => {
  assert.equal(scriptsTag('2026-09-09'), 'scripts-2026-09-09');
  assert.equal(installerTag('2026-09-09'), 'installer-2026-09-09');
});

test('groupBuilt: updater-ui excluded from scripts; helpers ride with installer; deduped', () => {
  const {scripts, installer} = groupBuilt({
    builtZips: ['utils', 'fx-folder', 'updater-ui'],
    builtInstallers: ['win', 'linux'],
    builtHelpers: ['linux', 'aarch64', 'linux'],
  });
  assert.deepEqual(scripts, ['utils', 'fx-folder']);
  assert.deepEqual(installer, ['win', 'linux', 'aarch64']);
});

test('groupBuilt: empty buckets stay empty', () => {
  assert.deepEqual(groupBuilt({builtZips: ['updater-ui'], builtInstallers: [], builtHelpers: []}), {
    scripts: [],
    installer: [],
  });
});

test('renderComponentBody: lists artifacts and points back at latest', () => {
  const body = renderComponentBody('scripts', '2026-09-09', ['utils.zip', 'fx-folder.zip']);
  assert.match(body, /Package zips \(utils, fx-folder\) — 2026-09-09/);
  assert.match(body, /- utils\.zip/);
  assert.match(body, /releases\/latest/);
  assert.match(body, /hashes\.json/);

  const installerBody = renderComponentBody('installer', '2026-09-09', [
    'installer_win.exe',
    'helper_win.exe',
    'helper_win.exe.sha256',
  ]);
  assert.match(installerBody, /Installer \+ helper binaries — 2026-09-09/);
  assert.match(installerBody, /- installer_win\.exe/);

  const empty = renderComponentBody('installer', '2026-09-09', []);
  assert.match(empty, /no artifacts this date/);
});

// The CodeRabbit Major finding on the first draft: groupBuilt unions
// installers+helpers, so a partial rebuild (helper leg skipped) must not
// touch the helper accessor — the old inline loop read the staged helper path
// for every unioned platform and threw ENOENT, silently dropping the whole
// installer- release.
test('componentAssets: partial rebuild contributes only artifacts actually built', () => {
  const access = {
    installer: p => `installer_${p}.exe`,
    helper: p => `helper_${p}.exe`,
    helperSha: p => `helper_${p}.exe.sha256`,
    installerPath: p => `staged/installer-${p}`, // throws for unstaged in real life
    helperPath: p => {
      if (p !== 'win') throw new Error(`ENOENT: ${p} helper not staged`);
      return `staged/helper-${p}`;
    },
    sidecar: () => Buffer.from('abc'),
  };
  const built = {builtInstallers: ['win', 'linux'], builtHelpers: ['win']};
  const assets = componentAssets(['win', 'linux'], built, access);
  assert.deepEqual([...assets.keys()].sort(), [
    'helper_win.exe',
    'helper_win.exe.sha256',
    'installer_linux.exe',
    'installer_win.exe',
  ]);
});

test('componentAssets: nothing built → empty map', () => {
  const assets = componentAssets(
    [],
    {builtInstallers: [], builtHelpers: []},
    {installer: p => p, helper: p => p, helperSha: p => p}
  );
  assert.equal(assets.size, 0);
});
