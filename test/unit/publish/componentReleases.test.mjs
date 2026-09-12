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

test('groupBuilt: updater-ui excluded from scripts; helpers never join a release', () => {
  const {scripts, installer} = groupBuilt({
    builtZips: ['utils', 'fx-folder', 'updater-ui'],
    builtInstallers: ['win', 'linux'],
    builtHelpers: ['linux', 'aarch64', 'linux'],
  });
  assert.deepEqual(scripts, ['utils', 'fx-folder']);
  // Helpers are gh-pages-only (updater fetches them + sidecars) — a rebuilt
  // helper never lands on a release page, and a helper-only rebuild creates
  // no installer-<date> tag at all.
  assert.deepEqual(installer, ['win', 'linux']);
});

test('groupBuilt: helper-only rebuild produces no component release', () => {
  assert.deepEqual(
    groupBuilt({builtZips: ['updater-ui'], builtInstallers: [], builtHelpers: ['win']}),
    {scripts: [], installer: []}
  );
});

test('renderComponentBody: lists artifacts with per-file dates, points back at latest', () => {
  const body = renderComponentBody('scripts', '2026-09-09', ['utils.zip', 'fx-folder.zip'], {
    'utils.zip': '2026-09-02',
  });
  assert.match(body, /Package zips \(utils, fx-folder\) — 2026-09-09/);
  // Per-file dates: manifest date when known, else the release's own date.
  assert.match(body, /- utils\.zip — updated 2026-09-02/);
  assert.match(body, /- fx-folder\.zip — updated 2026-09-09/);
  assert.match(body, /releases\/latest/);
  // User-facing wording: plain English, no internals like hashes.json.
  assert.doesNotMatch(body, /hashes\.json/);
  assert.doesNotMatch(body, /unversioned/);
  assert.doesNotMatch(body, /gh-pages/);
  assert.match(body, /newest files/);

  const installerBody = renderComponentBody('installer', '2026-09-09', ['installer_win.exe']);
  assert.match(installerBody, /Installer binaries — 2026-09-09/);
  assert.match(installerBody, /- installer_win\.exe/);

  const empty = renderComponentBody('installer', '2026-09-09', []);
  assert.match(empty, /no artifacts this date/);
});

test('componentAssets: exactly the installers built — never helpers', () => {
  const access = {
    installer: p => `installer_${p}.exe`,
    installerPath: p => `staged/installer-${p}`,
  };
  const built = {builtInstallers: ['win', 'linux']};
  const assets = componentAssets(['win', 'linux'], built, access);
  assert.deepEqual([...assets.keys()].sort(), ['installer_linux.exe', 'installer_win.exe']);
});

test('componentAssets: nothing built → empty map', () => {
  const assets = componentAssets(
    [],
    {builtInstallers: []},
    {installer: p => p, installerPath: p => p}
  );
  assert.equal(assets.size, 0);
});
