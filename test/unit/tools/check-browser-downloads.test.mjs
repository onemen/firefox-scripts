// test/unit/tools/check-browser-downloads.test.mjs — Unit tests for the pure
// helpers in tools/check-browser-downloads.mjs (the version/endpoint checks,
// the full-download pass, and issue creation hit the network and the GitHub
// API — not unit-tested).

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const scriptUrl = pathToFileURL(path.join(REPO_ROOT, 'tools', 'check-browser-downloads.mjs')).href;
const {
  collectDrift,
  compareBaseline,
  formatAge,
  issueBody,
  issueTitle,
  parseContentRange,
  sha256File,
} = await import(scriptUrl);

test('compareBaseline: first run, new version, unchanged', () => {
  assert.equal(compareBaseline(null, {version: '154.0.1'}), 'first-run');
  assert.equal(compareBaseline({version: '153.0'}, {version: '154.0.1'}), 'new-version');
  assert.equal(compareBaseline({version: '154.0.1'}, {version: '154.0.1'}), 'ok');
});

test('collectDrift: unchanged baseline yields no drift', () => {
  const baseline = {
    'firefox': {version: '154.0.1'},
    'firefox-dev': {version: '155.0b3'},
    'librewolf': {version: '154.0-2'},
    'floorp': {version: '12.16.2'},
    'zen': {version: '1.0.1'},
    'waterfox': {version: 'G9.0'},
  };
  const versions = Object.fromEntries(
    Object.entries(baseline).map(([browser, entry]) => [browser, entry.version])
  );
  assert.deepEqual(collectDrift(baseline, versions), []);
});

test('collectDrift: a new version, a missing baseline, and a lookup failure are flagged', () => {
  const baseline = {'firefox': {version: '153.0'}, 'firefox-dev': {version: '155.0b3'}};
  const versions = {
    'firefox': '154.0.1', // new version → drift
    'firefox-dev': '155.0b3', // unchanged
    'librewolf': '154.0-2', // not in baseline → drift
    'floorp': '', // lookup failed → drift
    'zen': '1.0.1', // not in baseline → drift
    'waterfox': 'G9.0', // not in baseline → drift
  };
  const drift = collectDrift(baseline, versions);
  assert.ok(drift.some(d => d.includes('firefox: 153.0 → 154.0.1')));
  assert.ok(drift.some(d => d.includes('librewolf: not in baseline')));
  assert.ok(drift.some(d => d.includes('floorp: version lookup failed')));
  assert.equal(drift.length, 5);
});

test('issueTitle: rot, new-version and size-change titles are dedup keys', () => {
  assert.equal(
    issueTitle('rot', 'librewolf', {reason: 'HTTP 404'}),
    '[url-watchdog] librewolf download check failed: HTTP 404'
  );
  assert.equal(
    issueTitle('new-version', 'floorp', {prevVersion: '12.16.2', newVersion: '12.17.0'}),
    '[url-watchdog] floorp 12.16.2 → 12.17.0'
  );
  assert.equal(
    issueTitle('size-change', 'zen'),
    '[url-watchdog] zen same version, binary size changed'
  );
});

test('issueBody: new-version body carries the verified SHA-256 ledger', () => {
  const body = issueBody(
    {
      kind: 'new-version',
      browser: 'librewolf',
      prevVersion: '154.0-2',
      newVersion: '154.0.1-2',
      size: 153225824,
      sha256: 'ec27c770aa951b8f11541ce5c4fa2d15ec8d7fe613662505ce9ab00b196a100e',
    },
    'https://github.com/onemen/firefox-scripts/actions/runs/1'
  );
  assert.match(body, /Watchdog run: https:\/\/github\.com/);
  assert.match(body, /New librewolf release: 154\.0-2 → 154\.0\.1-2/);
  assert.match(body, /Verified SHA-256 \(153225824 bytes\): `ec27c770aa/);
});

test('formatAge: human-readable baseline age, clamped at 0', () => {
  assert.equal(formatAge(0), '0m');
  assert.equal(formatAge(8 * 60_000), '8m');
  assert.equal(formatAge(5 * 3_600_000 + 12 * 60_000), '5h 12m');
  assert.equal(formatAge(3 * 86_400_000 + 2 * 3_600_000), '3d 2h');
  assert.equal(formatAge(-5_000), '0m'); // clock skew → clamp, no negative
});

test('parseContentRange: total size or null', () => {
  assert.equal(parseContentRange('bytes 0-1023/104857600'), 104857600);
  assert.equal(parseContentRange(null), null);
  assert.equal(parseContentRange(''), null);
  assert.equal(parseContentRange('bytes */0'), 0);
});

test('sha256File: streams a file into its SHA-256', async () => {
  const tmp = path.join(os.tmpdir(), `watchdog-hash-${process.pid}.txt`);
  try {
    fs.writeFileSync(tmp, 'abc');
    // Known SHA-256 vector for 'abc'.
    assert.equal(
      await sha256File(tmp),
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
  } finally {
    fs.rmSync(tmp, {force: true});
  }
});
