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
  renderSelfUpdateBlock,
  parseSelfUpdateBlock,
  mergeSelfUpdateBlock,
  scriptsAssetNames,
  renderLatestDownloads,
  updateLatestDownloads,
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

test('renderSelfUpdateBlock: JSON with installerDate + download map', () => {
  const block = renderSelfUpdateBlock('2026-09-13', {
    'installer_win.exe': 'https://x/win',
    'installer_linux': 'https://x/linux',
  });
  const parsed = JSON.parse(block);
  assert.equal(parsed.installerDate, '2026-09-13');
  assert.equal(parsed.download['installer_win.exe'], 'https://x/win');
  assert.equal(parsed.download.installer_linux, 'https://x/linux');
});

test('parseSelfUpdateBlock: round-trips the fenced managed block', () => {
  const block = renderSelfUpdateBlock('2026-09-13', {'installer_win.exe': 'https://x/win'});
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
  const prior = {installerDate: '2026-09-12', download: {installer_mac: 'https://x/stale'}};
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
  // The verify line rides under the table, inside the managed section.
  assert.match(
    section,
    /Verify before use: each file has a `\.sha256` sidecar; the installer itself hash-verifies every package it fetches\./
  );
  // The managed markers wrap the section.
  assert.ok(section.startsWith(LATEST_MANAGED_START));
  assert.ok(section.trimEnd().endsWith(LATEST_MANAGED_END));
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
