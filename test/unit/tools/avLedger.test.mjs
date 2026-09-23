// SPDX-License-Identifier: MIT

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  VERDICT_ORDER,
  engineCounts,
  isCleared,
  isDevBinary,
  isWatchedRelease,
  issueBodyFor,
  issueTitleFor,
  ledgerEntry,
  ledgerStats,
  ledgerTable,
  mergeLedger,
  pickPublishedBinaries,
  shortHash,
} from '../../../tools/ci/avLedger.mjs';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

const entry = (over = {}) =>
  ledgerEntry({
    file: 'installer_win.exe',
    sha256: HASH_A,
    size: 231_424,
    verdict: 'clean',
    stats: {malicious: 0, suspicious: 0, harmless: 68, undetected: 4},
    flags: [],
    threshold: 3,
    source: 'publish',
    at: '2026-09-22T00:00:00Z',
    ...over,
  });

test('pickPublishedBinaries: installers and helpers, dev suffixes included', () => {
  const names = [
    'installer_win.exe',
    'installer_win-dev.exe',
    'helper_win.exe',
    'helper_win.exe.sha256',
    'helper_mac',
    'installer_linux_aarch64',
    'hashes.json',
    'utils.zip',
    'updater-ui.zip',
    'index.html',
    'README.md',
    'installer.ico',
  ];
  assert.deepEqual(pickPublishedBinaries(names), [
    'helper_mac',
    'helper_win.exe',
    'installer_linux_aarch64',
    'installer_win-dev.exe',
    'installer_win.exe',
  ]);
  assert.deepEqual(pickPublishedBinaries(undefined), []);
});

test('isWatchedRelease: latest + the installer-<date> snapshots, nothing else', () => {
  assert.equal(isWatchedRelease('latest'), true);
  assert.equal(isWatchedRelease('installer-2026-09-22'), true);
  assert.equal(isWatchedRelease('scripts-2026-09-22'), false, 'script snapshots carry no binaries');
  assert.equal(isWatchedRelease('installer-2026-9-2'), false, 'the date form is fixed');
  assert.equal(isWatchedRelease('v1.0.0'), false);
  assert.equal(isWatchedRelease(undefined), false);
});

test('isDevBinary: only the -dev artifact suffix counts', () => {
  assert.equal(isDevBinary('installer_win-dev.exe'), true);
  assert.equal(isDevBinary('helper_linux-dev'), true);
  assert.equal(isDevBinary('installer_win.exe'), false);
  assert.equal(isDevBinary('installer_dev.exe'), false);
});

test('ledgerEntry: rejects a malformed hash or verdict, normalizes flags', () => {
  assert.throws(() => entry({sha256: 'not-a-hash'}), /bad sha256/);
  assert.throws(() => entry({verdict: 'maybe'}), /bad verdict/);
  const e = entry({flags: ['Zillya', 'Bkav']});
  assert.deepEqual(e.flags, ['Bkav', 'Zillya']);
  assert.equal(e.observations, 1);
  assert.equal(e.threshold, 3);
});

test('ledgerEntry: an unknown verdict keeps its reason', () => {
  const e = entry({
    verdict: 'unknown',
    stats: undefined,
    reason: 'VirusTotal has never seen these bytes',
  });
  assert.equal(e.verdict, 'unknown');
  assert.equal(e.malicious, null);
  assert.match(e.reason, /never seen/);
});

test('mergeLedger: a new hash is added, an existing one accumulates history', () => {
  const first = mergeLedger(null, [entry()], {at: '2026-09-22T00:00:00Z'});
  assert.equal(Object.keys(first.files).length, 1);
  assert.equal(first.version, 1);

  // Re-checked later, same bytes: firstSeen survives, observations count up.
  const warn = entry({
    verdict: 'warn',
    stats: {malicious: 1, suspicious: 0, harmless: 67, undetected: 4},
    flags: ['Bkav'],
    source: 'av-watchdog',
    at: '2026-09-29T00:00:00Z',
  });
  const second = mergeLedger(first, [warn], {at: '2026-09-29T00:00:00Z'});
  const merged = second.files[HASH_A];
  assert.equal(merged.firstSeen, '2026-09-22T00:00:00Z');
  assert.equal(merged.lastSeen, '2026-09-29T00:00:00Z');
  assert.equal(merged.observations, 2);
  assert.equal(merged.verdict, 'warn', 'the worst verdict ever seen is kept');
  assert.equal(merged.lastVerdict, 'warn');
  assert.deepEqual(merged.flags, ['Bkav']);
});

test('mergeLedger: a later clean re-check does not erase an earlier flag', () => {
  const flagged = mergeLedger(null, [entry({verdict: 'fail', flags: ['Microsoft']})], {
    at: '2026-09-22T00:00:00Z',
  });
  const cleared = mergeLedger(
    flagged,
    [entry({verdict: 'clean', source: 'av-watchdog', at: '2026-10-01T00:00:00Z'})],
    {at: '2026-10-01T00:00:00Z'}
  );
  const merged = cleared.files[HASH_A];
  assert.equal(merged.verdict, 'fail', 'the record of the flag survives');
  assert.equal(merged.lastVerdict, 'clean', 'so does the fact that it cleared');
  assert.deepEqual(merged.flags, ['Microsoft']);
  assert.equal(isCleared(cleared, HASH_A), true, 'a cleared hash closes its issue');
});

test('isCleared: only a clean last verdict clears', () => {
  const clean = mergeLedger(null, [entry()], {at: '2026-09-22T00:00:00Z'});
  assert.equal(isCleared(clean, HASH_A), true);
  assert.equal(isCleared(clean, HASH_B), false, 'an unknown hash never clears');

  const justFlagged = mergeLedger(
    clean,
    [entry({verdict: 'warn', flags: ['Ikarus'], at: '2026-09-23T00:00:00Z'})],
    {at: '2026-09-23T00:00:00Z'}
  );
  assert.equal(isCleared(justFlagged, HASH_A), false);
});

test('ledgerStats: counts every band, worst-first ordering is the table sort', () => {
  const ledger = mergeLedger(
    null,
    [
      entry(),
      entry({
        sha256: HASH_B,
        file: 'helper_win.exe',
        verdict: 'fail',
        flags: ['Microsoft'],
        stats: {malicious: 2, suspicious: 0, harmless: 60, undetected: 6},
      }),
    ],
    {at: '2026-09-22T00:00:00Z'}
  );
  assert.deepEqual(ledgerStats(ledger), {fail: 1, warn: 0, clean: 1, unknown: 0, total: 2});
  assert.deepEqual(ledgerStats(null), {fail: 0, warn: 0, clean: 0, unknown: 0, total: 0});

  const table = ledgerTable(ledger);
  assert.match(table, /\| verdict \| artifact \|/);
  const rows = table.split('\n').filter(l => l.startsWith('| ') && !l.startsWith('| ---'));
  // `/^W|^| fail/` matched the empty alternative, so it passed whatever the
  // table contained; assert the verdict cell itself.
  assert.match(rows[1], /\| fail \|/, 'the worst verdict sorts first');
  assert.match(table, /Microsoft/);
  assert.match(table, /aaaaaaaaaaaa…/, 'the hash is shortened for display');
  assert.equal(ledgerTable(null).includes('no observations yet'), true);
});

test('engineCounts: null counts render as a dash, never as zero', () => {
  assert.equal(engineCounts(entry()), '0 malicious / 0 suspicious / 68 harmless / 4 undetected');
  assert.equal(engineCounts({malicious: null}), '—');
});

test('issue text: names the artifact, the hash and the flagging engines', () => {
  const e = entry({verdict: 'fail', flags: ['Microsoft'], sha256: HASH_B});
  assert.equal(issueTitleFor(e), `[av-watchdog] installer_win.exe ${shortHash(HASH_B)} fail`);
  const body = issueBodyFor(e, 'https://example.test/run/1');
  assert.ok(body.includes(HASH_B), 'the issue body names the full hash');
  assert.match(body, /Microsoft/);
  assert.match(body, /https:\/\/example\.test\/run\/1/);
});

test('VERDICT_ORDER: fail is the worst band (index 0)', () => {
  assert.equal(VERDICT_ORDER[0], 'fail');
  assert.equal(VERDICT_ORDER.at(-1), 'unknown');
});
