'use strict';

// test/unit/docsSite/downloadsHistory.test.mjs
//
// Contract under test: /download shows more than one history per family.
// The releases API returns newest first; deriveDownloadsInfo keeps that order
// while splitting the frozen tags into the installer and script families,
// so each dropdown offers the current build plus every past build a user can
// revert to (issue #28, docs-site).
//
// The fixture below simulates two published histories per family plus the
// moving `latest` tag and one tag from another family that must not leak
// into either dropdown.

import {test} from 'node:test';
import assert from 'node:assert/strict';

import {deriveDownloadsInfo} from '../../../docs-site/src/utils/getDownloadsInfoSync.mjs';

const asset = (name, tag) => ({
  name,
  size: 1,
  href: `https://github.com/onemen/firefox-scripts/releases/download/${tag}/${name}`,
});

const release = (tag, names) => ({
  tag,
  name: tag,
  publishedAt: `${tag.replace(/^[^-]+-/, '')}T00:00:00Z`,
  date: tag.replace(/^[^-]+-/, ''),
  draft: false,
  prerelease: false,
  htmlUrl: `https://github.com/onemen/firefox-scripts/releases/tag/${tag}`,
  assets: names.map(name => asset(name, tag)),
});

/** Two histories per family, newest first, as the releases API returns them. */
const fixture = () => ({
  generatedAt: '2026-10-12T00:00:00.000Z',
  hashesUrl: 'https://onemen.github.io/firefox-scripts/hashes.json',
  packages: {},
  releases: [
    release('latest', ['installer_win.exe', 'utils.zip']),
    release('installer-2026-10-11', ['installer_win.exe']),
    release('core-2026-10-11', ['utils.zip', 'fx-folder.zip']),
    release('installer-2026-09-26', ['installer_win.exe']),
    release('core-2026-09-28', ['utils.zip', 'fx-folder.zip']),
    release('dev-build-abc1234', ['utils.zip']),
  ],
});

const tags = versions => versions.map(v => v.tag);

test('each family lists every frozen history, newest first', () => {
  const {installerReleases, coreReleases} = deriveDownloadsInfo(fixture());
  assert.deepEqual(tags(installerReleases), ['installer-2026-10-11', 'installer-2026-09-26']);
  assert.deepEqual(tags(coreReleases), ['core-2026-10-11', 'core-2026-09-28']);
});

test('the moving latest tag feeds latestAssets, never a family list', () => {
  const {latestRelease, latestAssets, installerReleases, coreReleases} =
    deriveDownloadsInfo(fixture());
  assert.equal(latestRelease.tag, 'latest');
  assert.deepEqual(
    latestAssets.map(a => a.name),
    ['installer_win.exe', 'utils.zip']
  );
  assert.ok(![...installerReleases, ...coreReleases].some(v => v.tag === 'latest'));
});

test('tags from other families leak into neither dropdown', () => {
  const {installerReleases, coreReleases, frozenReleases} = deriveDownloadsInfo(fixture());
  assert.equal(frozenReleases.length, 5);
  assert.ok(!tags(installerReleases).includes('dev-build-abc1234'));
  assert.ok(!tags(coreReleases).includes('dev-build-abc1234'));
});

test('an empty payload keeps the page on its static fallback shape', () => {
  const derived = deriveDownloadsInfo({
    generatedAt: null,
    hashesUrl: 'https://onemen.github.io/firefox-scripts/hashes.json',
    packages: {},
    releases: [],
  });
  assert.equal(derived.latestRelease, null);
  assert.deepEqual(derived.latestAssets, []);
  assert.deepEqual(derived.installerReleases, []);
  assert.deepEqual(derived.coreReleases, []);
});
