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
  buildMetaIssueBody,
  buildStatusTable,
  collectDrift,
  collectValidatedDrift,
  compareBaseline,
  formatAge,
  formatCheck,
  formatRunDate,
  formatSize,
  isFailureIssueTitle,
  issueBody,
  issueTitle,
  parseContentRange,
  renderHistory,
  seedHistoryFromBaseline,
  sha256File,
  shortSha,
  statusTag,
  updateHistory,
  validatedCell,
  VALIDATED_BROWSERS,
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

test('VALIDATED_BROWSERS: exactly the hard-gate browser legs', () => {
  assert.deepEqual(VALIDATED_BROWSERS, ['firefox', 'firefox-dev']);
});

test('collectValidatedDrift: matching record yields no drift', () => {
  const validated = {
    browsers: {'firefox': {version: '154.0.1'}, 'firefox-dev': {version: '155.0b3'}},
  };
  const versions = {'firefox': '154.0.1', 'firefox-dev': '155.0b3'};
  assert.deepEqual(collectValidatedDrift(validated.browsers, versions), []);
});

test('collectValidatedDrift: a new release, a missing record, and a lookup failure are flagged', () => {
  const validated = {firefox: {version: '153.0'}};
  const versions = {
    'firefox': '154.0.1', // validated 153.0 → drift
    'firefox-dev': '155.0b3', // never validated → drift (even though current)
  };
  const drift = collectValidatedDrift(validated, versions);
  assert.ok(
    drift.some(d => d.includes('firefox: E2E validated 153.0, current release is 154.0.1'))
  );
  assert.ok(drift.some(d => d.includes('firefox-dev: never validated')));
  assert.equal(drift.length, 2);
});

test('collectValidatedDrift: version lookup failure is flagged', () => {
  const validated = {'firefox': {version: '154.0.1'}, 'firefox-dev': {version: '155.0b3'}};
  const drift = collectValidatedDrift(validated, {'firefox': '154.0.1', 'firefox-dev': ''});
  assert.deepEqual(drift, ['firefox-dev: version lookup failed']);
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

test('statusTag: tags each run status', () => {
  assert.equal(statusTag('ok'), '✅ up to date');
  assert.equal(statusTag('new-version'), '🆕 new version');
  assert.equal(statusTag('first-run'), '⏳ first run');
  assert.equal(statusTag('lookup-failed'), '❌ lookup failed');
  assert.equal(statusTag('endpoint-failed'), '⚠️ endpoint failed');
  assert.equal(statusTag('download-failed'), '⚠️ download failed');
  assert.equal(statusTag('size-change'), '🔄 size changed');
});

test('formatRunDate: UTC short date, never the full URL', () => {
  assert.equal(formatRunDate('2026-09-05T07:36:11Z'), 'Sep 5');
  assert.equal(formatRunDate(null), '—');
  assert.equal(formatRunDate('garbage'), '—');
});

test('formatCheck: short date link or bare date', () => {
  assert.equal(
    formatCheck('2026-09-05T07:36:11Z', 'https://github.com/o/r/actions/runs/1'),
    '[Sep 5](https://github.com/o/r/actions/runs/1)'
  );
  assert.equal(formatCheck('2026-09-05T07:36:11Z', ''), 'Sep 5');
});

test('formatSize / shortSha: human units', () => {
  assert.equal(formatSize(93298280), '89.0 MB');
  assert.equal(formatSize(null), '—');
  assert.equal(
    shortSha('3e53b343e7d8bd109b217a0fd279ee5cadd7d9a8434d7c185dc65e88e80ffe9e'),
    '`3e53b3…`'
  );
  assert.equal(shortSha(null), '—');
});

test('buildStatusTable: six rows, short links, fallback on failed browsers', () => {
  const results = {
    'firefox': {status: 'ok'},
    'firefox-dev': {status: 'new-version'},
    'librewolf': {status: 'lookup-failed'},
    'floorp': {status: 'ok'},
    'zen': {status: 'ok'},
    'waterfox': {status: 'ok'},
  };
  const baseline = {
    firefox: {
      version: '155.0.1',
      size: 91715344,
      sha256: '27a24fcdde805cb6a34c5c102e98ebfe5f0302078202376d2828f8797ed80298',
      checkedAt: '2026-09-05T07:00:00Z',
      checkedUrl: 'https://github.com/onemen/firefox-scripts/actions/runs/1',
    },
    librewolf: {
      version: '154.0.1-2',
      size: 165878432,
      sha256: '1d9fe9440a765cb6d51e1256423eaab6e2522f4bd2de644827b019d3205dca91',
      checkedAt: '2026-08-31T12:08:43Z',
      checkedUrl: 'https://github.com/onemen/firefox-scripts/actions/runs/2',
    },
  };
  const table = buildStatusTable({results, baseline});
  const lines = table.split('\n');
  assert.equal(lines.length, 8); // header + separator + 6 browsers
  const firefox = lines.find(l => l.startsWith('| firefox '));
  assert.match(
    firefox,
    /\| 155\.0\.1 \| 87\.5 MB · `27a24f…` \| \[Sep 5\]\(https:\/\/github\.com\/onemen\/firefox-scripts\/actions\/runs\/1\) \| ✅ up to date \| — \| ⏳ none \|/
  );
  const librewolf = lines.find(l => l.startsWith('| librewolf '));
  assert.match(librewolf, /\| 154\.0\.1-2 \| 158\.2 MB · `1d9fe9…` \| \[Aug 31\]\(/);
  assert.match(librewolf, /\| ❌ lookup failed \| cached: 154\.0\.1-2 · \[Aug 31\]/);
  assert.match(librewolf, /\| — \|$/); // advisory fork → no E2E cell

  // A failed full-download verification must render as failed with the
  // CI-cache fallback, not default to 'ok' (results[browser] was unset).
  const tableDl = buildStatusTable({
    results: {zen: {status: 'download-failed'}},
    baseline: {
      zen: {
        version: '1.21.15b',
        size: 103432224,
        sha256: 'd5f25e1ab86a4df8ae1db6c4f38e7b5eae9d4a22d2be0e8a8f5e0b0a6e9d6a11',
        checkedAt: '2026-08-25T10:00:00Z',
        checkedUrl: '',
      },
    },
  });
  const zen = tableDl.split('\n').find(l => l.startsWith('| zen '));
  assert.match(zen, /\| ⚠️ download failed \| cached: 1\.21\.15b · Aug 25 \|/);
  const dev = lines.find(l => l.startsWith('| firefox-dev '));
  assert.match(dev, /\| 🆕 new version \|/);
  const waterfox = lines.find(l => l.startsWith('| waterfox '));
  assert.match(waterfox, /\| — \| — · — \| — \| ✅ up to date \| — \| — \|/);
});

test('validatedCell / E2E validated column: match, stale, none, fork', () => {
  const validated = {
    browsers: {'firefox': {version: '155.0.1'}, 'firefox-dev': {version: '156.0b2'}},
  };
  assert.equal(validatedCell('firefox', {version: '155.0.1'}, validated), '✅ 155.0.1');
  assert.equal(validatedCell('firefox', {version: '155.0.2'}, validated), '⏳ 155.0.1');
  assert.equal(validatedCell('firefox', {version: '155.0.1'}, null), '⏳ none');
  assert.equal(validatedCell('librewolf', {version: '155.0-1'}, validated), '—');
  const table = buildStatusTable({
    results: {firefox: {status: 'ok'}},
    baseline: {firefox: {version: '155.0.1'}},
    validated,
  });
  const row = table.split('\n').find(l => l.startsWith('| firefox '));
  assert.match(row, /\| ✅ 155\.0\.1 \|$/);
});

test('updateHistory: appends and caps at the max', () => {
  const entry = {date: 'new'};
  assert.deepEqual(updateHistory([], entry), [entry]);
  const base = Array.from({length: 10}, (_, i) => ({date: `run-${i}`}));
  const capped = updateHistory(base, entry, {max: 10});
  assert.equal(capped.length, 10);
  assert.equal(capped.at(-1), entry);
  assert.equal(capped[0].date, 'run-1'); // oldest trimmed
});

test('seedHistoryFromBaseline: baseline-only seed until real updates exist', () => {
  const baseline = {
    firefox: {version: '155.0.1', size: 91715344, sha256: '27a24f'},
  };
  const seed = seedHistoryFromBaseline(baseline);
  assert.equal(seed.length, 1);
  assert.equal(seed[0].kind, 'baseline');
  assert.deepEqual(seed[0].changes[0], {
    browser: 'firefox',
    version: '155.0.1',
    size: 91715344,
    sha256: '27a24f',
  });
  assert.deepEqual(seedHistoryFromBaseline({}), []);
});

test('renderHistory: baseline seed vs real update entries', () => {
  const baseline = renderHistory([
    {
      kind: 'baseline',
      changes: [
        {
          browser: 'firefox',
          version: '155.0.1',
          size: 91715344,
          sha256: '27a24fcdde805cb6a34c5c102e98ebfe5f0302078202376d2828f8797ed80298',
        },
      ],
    },
  ]);
  assert.match(baseline, /^- baseline: firefox 155\.0\.1 · 87\.5 MB · `27a24f…`$/);
  const update = renderHistory([
    {
      date: '2026-09-05T07:36:11Z',
      runUrl: 'https://github.com/o/r/actions/runs/1',
      changes: [
        {
          browser: 'firefox-dev',
          prevVersion: '156.0b2',
          newVersion: '156.0b3',
          size: 93298280,
          sha256: '3e53b343e7d8bd109b217a0fd279ee5cadd7d9a8434d7c185dc65e88e80ffe9e',
        },
      ],
    },
  ]);
  assert.match(
    update,
    /^- \[Sep 5\]\(https:\/\/github\.com\/o\/r\/actions\/runs\/1\) — update: firefox-dev 156\.0b2 → 156\.0b3 · 89\.0 MB · `3e53b3…`$/
  );
});

test('buildMetaIssueBody: status table + history, no date in the header', () => {
  const table = '| Browser | Last verified | ...';
  const body = buildMetaIssueBody({
    table,
    history: '- [Sep 5](u) — update: firefox 155.0 → 155.0.1 · 87.5 MB · `27a24f…`',
  });
  assert.match(body, /^## Watchdog status\n\n/);
  assert.match(body, /## Version history \(runs with real updates\)/);
  assert.doesNotMatch(body, /\d{4}-\d{2}-\d{2}/); // header carries no run date — body changes only with content
  const bare = buildMetaIssueBody({table, history: ''});
  assert.doesNotMatch(bare, /Version history/);
});

test('isFailureIssueTitle: the auto-close set per browser', () => {
  assert.ok(
    isFailureIssueTitle(
      'librewolf',
      '[url-watchdog] librewolf download check failed: version lookup failed: timeout'
    )
  );
  assert.ok(isFailureIssueTitle('librewolf', '[url-watchdog] librewolf version lookup failed'));
  assert.ok(
    isFailureIssueTitle('librewolf', '[url-watchdog] librewolf same version, binary size changed')
  );
  assert.ok(!isFailureIssueTitle('librewolf', '[url-watchdog] firefox 155.0 → 155.0.1'));
  assert.ok(!isFailureIssueTitle('librewolf', '[url-watchdog] status'));
});
