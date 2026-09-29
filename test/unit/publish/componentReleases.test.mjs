// test/unit/publish/componentReleases.test.mjs — unit tests for the pure
// helpers of tools/publish/componentReleases.mjs (issue #72). The GitHub sync
// routine hits the network — not unit-tested.
//
// paths.js/publishMode.mjs are argv-coupled, so --mode=prod is pushed before
// import (the same pattern the other publish unit tests use).

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

process.argv.push('--mode=prod');

const moduleUrl = pathToFileURL(
  fileURLToPath(new URL('../../../tools/publish/componentReleases.mjs', import.meta.url))
).href;
const {
  componentDate,
  scriptsTag,
  installerTag,
  groupBuilt,
  renderComponentBody,
  WINDOWS_ONLY_INSTALLER_NOTE,
  componentAssets,
  renderSelfUpdatePayload,
  shouldAppendManagedBlock,
  parseSelfUpdateBlock,
  mergeSelfUpdateBlock,
  scriptsAssetNames,
  renderLatestDownloads,
  updateLatestDownloads,
  newestInstallerDate,
  LATEST_MANAGED_START,
  LATEST_MANAGED_END,
} = await import(moduleUrl);

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
    groupBuilt({
      builtZips: ['updater-ui'],
      builtInstallers: [],
      builtHelpers: ['win'],
    }),
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

test('renderComponentBody: installer bodies carry the Windows-only SmartScreen/UAC note LAST', () => {
  // Maintainer request (2026-09-27): the README's SmartScreen paragraph belongs
  // on the installer release pages (#184's user-facing standard). Scripts
  // bodies stay installer-note-free (zips, not the installer flow).
  const withBlock = renderComponentBody(
    'installer',
    '2026-09-09',
    ['installer_win.exe'],
    {},
    '{"installerDate":"2026-09-09"}'
  );
  const noteAt = withBlock.indexOf(WINDOWS_ONLY_INSTALLER_NOTE);
  const blockAt = withBlock.indexOf('```json');
  assert.ok(noteAt > -1, 'note present');
  assert.ok(blockAt > -1, 'managed block present');
  assert.ok(
    noteAt > blockAt,
    'note rides AFTER the managed block — the parser reads the block from the body tail region'
  );
  assert.match(withBlock, /Windows only.*SmartScreen.*More info → Run anyway/s);
  assert.match(withBlock, /checksum-verified elevation/);

  // Collapsed managed block (issue #356 item 2, the #341 collapse): the fence
  // rides inside a <details> whose tags are single-line (GitHub's CommonMark
  // strips raw HTML blocks of their newlines — multi-line tags would swallow
  // the fence). Scripts bodies carry no wrapper.
  assert.match(withBlock, /<details>\n<summary>⚙ Managed self-update block[^\n]*<\/summary>\n/);
  assert.match(withBlock, /```json\n\{"installerDate":"2026-09-09"\}\n```\n<\/details>/);

  const bare = renderComponentBody('installer', '2026-09-09', ['installer_win.exe']);
  assert.match(bare, /Windows only/);
  // The note is the last thing in the body (trailing \n after it).
  assert.ok(bare.trimEnd().endsWith(WINDOWS_ONLY_INSTALLER_NOTE));

  // Scripts bodies: no installer note.
  const scripts = renderComponentBody('scripts', '2026-09-09', ['utils.zip']);
  assert.doesNotMatch(scripts, /SmartScreen/);
  assert.doesNotMatch(scripts, /Windows only/);
});

test('componentAssets: exactly the installers built, each with its sidecar (issue #324)', () => {
  // Sidecar values are derived from the staged binary bytes, so the staged
  // files must exist for the map build to read them.
  const staged = fs.mkdtempSync(path.join(os.tmpdir(), 'fxs-compassets-'));
  try {
    for (const p of ['win', 'linux']) {
      fs.writeFileSync(path.join(staged, `installer-${p}`), Buffer.from(`bytes-${p}`));
    }
    const access = {
      installer: p => `installer_${p}.exe`,
      installerSha: p => `installer_${p}.exe.sha256`,
      installerPath: p => path.join(staged, `installer-${p}`),
    };
    const built = {builtInstallers: ['win', 'linux']};
    const assets = componentAssets(['win', 'linux'], built, access);
    assert.deepEqual([...assets.keys()].sort(), [
      'installer_linux.exe',
      'installer_linux.exe.sha256',
      'installer_win.exe',
      'installer_win.exe.sha256',
    ]);
    // Binary values stay staged paths; sidecar values are rendered Buffers.
    assert.equal(assets.get('installer_win.exe'), access.installerPath('win'));
    assert.match(
      assets.get('installer_win.exe.sha256').toString('utf-8'),
      /^[0-9a-f]{64} {2}installer_win\.exe\n$/
    );
  } finally {
    fs.rmSync(staged, {recursive: true, force: true});
  }
});

test('componentAssets: nothing built → empty map', () => {
  const assets = componentAssets(
    [],
    {builtInstallers: []},
    {installer: p => p, installerSha: p => p, installerPath: p => p}
  );
  assert.equal(assets.size, 0);
});

// ── managed self-update block (ADR 0019 amendment, date-based self-update) ──

test('renderSelfUpdatePayload: mechanismSince + installerDate + download map (#341)', () => {
  const block = renderSelfUpdatePayload('2026-09-13', {
    'installer_win.exe': 'https://x/win',
    'installer_linux': 'https://x/linux',
  });
  const parsed = JSON.parse(block);
  // The cutover rides in the payload so a binary can decide its ingest
  // surface without a second fetch; the conf value is real, assert the shape.
  assert.ok(
    parsed.mechanismSince === undefined || /^\d{4}-\d{2}-\d{2}$/.test(parsed.mechanismSince)
  );
  assert.equal(parsed.installerDate, '2026-09-13');
  assert.equal(parsed.download['installer_win.exe'], 'https://x/win');
  assert.equal(parsed.download.installer_linux, 'https://x/linux');
  // Extra key is transparent to the body parser (same-day merge path).
  const body = `Installer binaries — 2026-09-13.\n\n\`\`\`json\n${block}\n\`\`\`\n`;
  const reparsed = parseSelfUpdateBlock(body);
  assert.equal(reparsed.installerDate, '2026-09-13');
  assert.equal(reparsed.download['installer_win.exe'], 'https://x/win');
});

test('shouldAppendManagedBlock: the block retires only after the transition release (#341)', () => {
  // This module was imported with the REAL config (SELF_UPDATE_MECHANISM_SINCE
  // = 2026-09-29). The block serves PRE-cutover binaries (they parse release
  // bodies only), so it must stay until a post-cutover installer release has
  // shipped — retiring earlier would strand them on a block-less newest tag.
  // No cutover configured → always append (legacy behavior).
  assert.equal(shouldAppendManagedBlock(null), true);
  // No prior installer tag (first publish / listing failed) → fail-safe append.
  assert.equal(shouldAppendManagedBlock('2026-09-01'), true);
  // Prior tag PREDATES the cutover → this publish IS the transition release:
  // append (its binaries read the body; the Pages payload also ships).
  assert.equal(shouldAppendManagedBlock('2026-09-28'), true);
  // A post-cutover release already shipped → retire (every installable binary
  // now reads the Pages payload).
  assert.equal(shouldAppendManagedBlock('2026-09-29'), false);
  assert.equal(shouldAppendManagedBlock('2026-10-01'), false);
});

test('parseSelfUpdateBlock: round-trips the fenced managed block', () => {
  const block = renderSelfUpdatePayload('2026-09-13', {
    'installer_win.exe': 'https://x/win',
  });
  const body = `Installer binaries — 2026-09-13.\n\n- installer_win.exe\n\n\`\`\`json\n${block}\n\`\`\`\n`;
  const parsed = parseSelfUpdateBlock(body);
  assert.equal(parsed.installerDate, '2026-09-13');
  assert.equal(parsed.download['installer_win.exe'], 'https://x/win');
});

test('parseSelfUpdateBlock: null on bodies without a managed block', () => {
  assert.equal(parseSelfUpdateBlock('plain body, no block'), null);
  assert.equal(parseSelfUpdateBlock(''), null);
  assert.equal(parseSelfUpdateBlock(null), null);
  assert.equal(parseSelfUpdateBlock('```json\n{"unrelated": true}\n```'), null);
});

test('mergeSelfUpdateBlock: this run wins, prior same-day entries survive', () => {
  const prior = {
    installerDate: '2026-09-13',
    download: {
      'installer_win.exe': 'https://x/win-morning',
      'installer_mac': 'https://x/mac-morning',
    },
  };
  const merged = mergeSelfUpdateBlock(
    '2026-09-13',
    {'installer_win.exe': 'https://x/win-evening'},
    prior
  );
  assert.equal(merged['installer_win.exe'], 'https://x/win-evening');
  assert.equal(merged.installer_mac, 'https://x/mac-morning');
});

test('mergeSelfUpdateBlock: prior entries from a DIFFERENT date are dropped', () => {
  const prior = {
    installerDate: '2026-09-12',
    download: {installer_mac: 'https://x/stale'},
  };
  const merged = mergeSelfUpdateBlock('2026-09-13', {'installer_win.exe': 'https://x/win'}, prior);
  assert.deepEqual(merged, {'installer_win.exe': 'https://x/win'});
});

test('mergeSelfUpdateBlock: no prior → just this run', () => {
  assert.deepEqual(mergeSelfUpdateBlock('2026-09-13', {a: 'u'}), {a: 'u'});
});

// ── complete package set on the scripts tag (issue #354) ──

test('scriptsAssetNames: the FULL staged set rides along, updater-ui never does', () => {
  // A run that rebuilt only utils must still publish fx-folder.zip — the
  // missing-asset shape the #157 purge left on `latest` and scripts-<date>.
  assert.deepEqual(scriptsAssetNames(['utils'], ['utils', 'fx-folder', 'updater-ui']), [
    'utils',
    'fx-folder',
  ]);
  // Union keeps first-seen order and dedupes.
  assert.deepEqual(scriptsAssetNames(['fx-folder'], ['utils']), ['fx-folder', 'utils']);
  // Empty staged list (legacy callers) → just the rebuilt set.
  assert.deepEqual(scriptsAssetNames(['utils']), ['utils']);
  assert.deepEqual(scriptsAssetNames([], []), []);
});

// ── the `latest` downloads table (issue #354, maintainer rule 2026-09-28) ──

test('renderLatestDownloads: one row per downloadable asset, dated by its own upload', () => {
  const section = renderLatestDownloads([
    {name: 'fx-folder.zip', updatedAt: '2026-09-28T11:52:03Z'},
    {name: 'utils.zip', updatedAt: '2026-09-28T11:36:55Z'},
    {name: 'installer_win.exe', updatedAt: '2026-09-28T12:20:00Z'},
    {name: 'installer_win.exe.sha256', updatedAt: '2026-09-28T12:20:00Z'},
  ]);
  assert.match(
    section,
    /\| \[`utils\.zip`\]\(https:\/\/github\.com\/onemen\/firefox-scripts\/releases\/latest\/download\/utils\.zip\) \| User scripts \(the main package\) \| 2026-09-28 \|/
  );
  assert.match(section, /\| \[`fx-folder\.zip`\].*\| The `fx-folder` core loader \| 2026-09-28 \|/);
  assert.match(
    section,
    /\| \[`installer_win\.exe`\].*\| Windows installer \(`\.exe`\) \| 2026-09-28 \|/
  );
  // Sidecars are NOT rows — the verify line covers them.
  assert.doesNotMatch(section, /sha256`\]/);
  // The verify line rides under the tables, inside the managed section.
  assert.match(
    section,
    /Verify before use: each file has a `\.sha256` sidecar; the installer itself hash-verifies every package it fetches\./
  );
  // The managed markers wrap the section.
  assert.ok(section.startsWith(LATEST_MANAGED_START));
  assert.ok(section.trimEnd().endsWith(LATEST_MANAGED_END));
});

test('renderLatestDownloads: Packages and Installer sub-tables (#356 item 1)', () => {
  // GitHub returns assets in upload order; the managed table groups them into
  // two labeled sub-tables regardless. Canonical order within each table.
  const section = renderLatestDownloads([
    {name: 'installer_linux_aarch64', updatedAt: '2026-09-28T12:20:00Z'},
    {name: 'fx-folder.zip', updatedAt: '2026-09-28T11:52:03Z'},
    {name: 'installer_linux', updatedAt: '2026-09-28T12:20:00Z'},
    {name: 'installer_mac', updatedAt: '2026-09-28T12:20:00Z'},
    {name: 'installer_win.exe', updatedAt: '2026-09-28T12:20:00Z'},
    {name: 'utils.zip', updatedAt: '2026-09-28T11:36:55Z'},
  ]);
  const packagesAt = section.indexOf('Packages');
  const installerAt = section.indexOf('Installer (per platform, sidecars ride each binary)');
  assert.ok(packagesAt > -1, 'Packages label present');
  assert.ok(installerAt > packagesAt, 'Installer label after Packages label');
  const utilsAt = section.indexOf('[`utils.zip`]');
  const fxFolderAt = section.indexOf('[`fx-folder.zip`]');
  const winAt = section.indexOf('[`installer_win.exe`]');
  const macAt = section.indexOf('[`installer_mac`]');
  const linuxAt = section.indexOf('[`installer_linux`]');
  const armAt = section.indexOf('[`installer_linux_aarch64`]');
  // Packages table: utils first, fx-folder second, both above the label.
  assert.ok(utilsAt > packagesAt && utilsAt < installerAt, 'utils.zip in Packages table');
  assert.ok(fxFolderAt > utilsAt && fxFolderAt < installerAt, 'fx-folder.zip second');
  // Installer table, canonical platform order, all below the Installer label.
  assert.ok(winAt > installerAt, 'installer_win.exe first in Installer table');
  assert.ok(macAt > winAt && macAt < linuxAt && linuxAt < armAt, 'mac → linux → aarch64 order');
  // Exactly two tables, one header each.
  assert.equal(section.split('| File | What it is | Updated |').length - 1, 2);
});

test('renderLatestDownloads: installer rows carry the VERSION date, packages their upload date (#356 item 3)', () => {
  // Maintainer decision 2026-09-29: the installer tag date IS the installer's
  // version (the binaries bake it as VERSIONINFO FileVersion — screenshot:
  // 1.0.2026.926 for the 2026-09-26 build) — so the latest table shows it,
  // not the upload timestamp. Zips keep the upload-date logic (#354).
  const section = renderLatestDownloads(
    [
      {name: 'utils.zip', updatedAt: '2026-09-28T11:36:55Z'},
      {name: 'fx-folder.zip', updatedAt: '2026-09-28T11:52:03Z'},
      {name: 'installer_win.exe', updatedAt: '2026-09-28T12:20:00Z'},
      {name: 'installer_mac', updatedAt: '2026-09-28T12:20:00Z'},
    ],
    {installerDate: '2026-09-26'}
  );
  // Installer rows: the version date, despite the 09-28 upload timestamp.
  assert.match(section, /\| \[`installer_win\.exe`\].*\| 2026-09-26 \|/);
  assert.match(section, /\| \[`installer_mac`\].*\| 2026-09-26 \|/);
  // Package rows: own upload dates, unchanged.
  assert.match(section, /\| \[`utils\.zip`\].*\| 2026-09-28 \|/);
  assert.match(section, /\| \[`fx-folder\.zip`\].*\| 2026-09-28 \|/);
});

test('renderLatestDownloads: PER-ASSET version dates for partial publishes (CodeRabbit on #367)', () => {
  // pages.yml builds win → linux → mac sequentially. The win job rebuilt only
  // its binary: its row shows the fresh build date, the platforms NOT rebuilt
  // keep their own upload date (their binaries on `latest` are still the
  // previous version — stamping the fresh date would lie about them).
  const section = renderLatestDownloads(
    [
      {name: 'installer_win.exe', updatedAt: '2026-09-29T12:00:00Z'},
      {name: 'installer_mac', updatedAt: '2026-09-26T09:00:00Z'},
      {name: 'installer_linux', updatedAt: '2026-09-26T10:00:00Z'},
      {name: 'installer_linux_aarch64', updatedAt: '2026-09-26T10:00:00Z'},
    ],
    {installerDatesByAsset: {'installer_win.exe': '2026-09-29'}}
  );
  assert.match(section, /\| \[`installer_win\.exe`\].*\| 2026-09-29 \|/);
  assert.match(section, /\| \[`installer_mac`\].*\| 2026-09-26 \|/);
  assert.match(section, /\| \[`installer_linux`\].*\| 2026-09-26 \|/);
  assert.match(section, /\| \[`installer_linux_aarch64`\].*\| 2026-09-26 \|/);
});

test('renderLatestDownloads: without a version the installer rows fall back to upload dates', () => {
  // First runs / no installer tag yet: display-only fallback, never a crash.
  const section = renderLatestDownloads([
    {name: 'installer_win.exe', updatedAt: '2026-09-28T12:20:00Z'},
  ]);
  assert.match(section, /\| \[`installer_win\.exe`\].*\| 2026-09-28 \|/);
});

test('newestInstallerDate: newest installer-<date> tag wins, other tags ignored', () => {
  assert.equal(
    newestInstallerDate([
      'latest',
      'scripts-2026-09-28',
      'installer-2026-09-26',
      'installer-2026-09-12',
      'dev-build-42',
    ]),
    '2026-09-26'
  );
  assert.equal(newestInstallerDate(['latest', 'scripts-2026-09-28']), null);
  assert.equal(newestInstallerDate([]), null);
  // ISO dates sort lexicographically == chronologically (year boundary too).
  assert.equal(newestInstallerDate(['installer-2026-12-31', 'installer-2027-01-02']), '2027-01-02');
});

test('updateLatestDownloads: replaces the managed region, keeps manual prose', () => {
  const manual = 'SmartScreen note and AV prose that must survive.';
  const old = renderLatestDownloads([{name: 'utils.zip', updatedAt: '2026-09-01T00:00:00Z'}]);
  const body = `${manual}\n\n${old}\n\nMore manual text after.`;
  const fresh = renderLatestDownloads([
    {name: 'utils.zip', updatedAt: '2026-09-28T11:36:55Z'},
    {name: 'fx-folder.zip', updatedAt: '2026-09-28T11:52:03Z'},
  ]);
  const out = updateLatestDownloads(body, fresh);
  // Manual prose untouched, old table gone, new table present.
  assert.ok(out.includes(manual));
  assert.ok(out.includes('More manual text after.'));
  assert.ok(!out.includes('2026-09-01'));
  // Exactly one managed region: the splice replaced the old one (a stray
  // second START marker would mean the old section was appended, not replaced).
  let starts = 0;
  for (
    let i = out.indexOf(LATEST_MANAGED_START);
    i !== -1;
    i = out.indexOf(LATEST_MANAGED_START, i + 1)
  )
    starts++;
  assert.equal(starts, 1);
});

test('updateLatestDownloads: appends the managed section when the body has none', () => {
  const section = renderLatestDownloads([{name: 'utils.zip', updatedAt: '2026-09-28T11:36:55Z'}]);
  const out = updateLatestDownloads('manual prose only', section);
  assert.match(out, /^manual prose only/);
  assert.ok(out.includes(LATEST_MANAGED_START));
  // Unterminated managed region (crashed earlier edit): treated as absent —
  // append, never mangle the manual text.
  const broken = `prose\n\n${LATEST_MANAGED_START}\n\njunk`;
  const out2 = updateLatestDownloads(broken, section);
  assert.ok(out2.includes('prose'));
  assert.ok(out2.includes('junk'));
});

test('parseSelfUpdateBlock: round-trips the DETAILS-WRAPPED fenced block (#356 item 2)', () => {
  // The published shape after the collapse: <details> wrapper around the same
  // ```json fence. The backwards brace walk + fence scan must both stay
  // wrapper-transparent — this body IS the same-day-merge input.
  const block = renderSelfUpdatePayload('2026-09-13', {
    'installer_win.exe': 'https://x/win',
    'installer_mac': 'https://x/mac',
  });
  const body = renderComponentBody('installer', '2026-09-13', ['installer_win.exe'], {}, block);
  assert.match(body, /<details>/);
  const parsed = parseSelfUpdateBlock(body);
  assert.ok(parsed, 'wrapped body still parses');
  assert.equal(parsed.installerDate, '2026-09-13');
  assert.equal(parsed.download['installer_win.exe'], 'https://x/win');
  assert.equal(parsed.download.installer_mac, 'https://x/mac');
});

test('parseSelfUpdateBlock: bare (unfenced) block keeps the nested download map', () => {
  // A body where GitHub serves the block unescaped/outside a fence: the
  // balanced-brace extractor must keep the nested map — a [^{}]* regex
  // would truncate it and the same-day merge would lose prior URLs.
  const body =
    'Installer binaries — 2026-09-13.\n{"installerDate":"2026-09-13","download":{"installer_win.exe":"https://x/win","installer_mac":"https://x/mac"}}\ntext after';
  const parsed = parseSelfUpdateBlock(body);
  assert.equal(parsed.installerDate, '2026-09-13');
  assert.equal(parsed.download['installer_win.exe'], 'https://x/win');
  assert.equal(parsed.download.installer_mac, 'https://x/mac');
});
