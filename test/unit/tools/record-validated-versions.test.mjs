// test/unit/tools/record-validated-versions.test.mjs — Unit tests for the
// pure helpers in tools/ci/record-validated-versions.mjs (the GitHub comment
// and record write hit the network / env — not unit-tested).

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const scriptUrl = pathToFileURL(
  path.join(REPO_ROOT, 'tools', 'ci', 'record-validated-versions.mjs')
).href;
const {
  collectLegVersions,
  collectForkVersions,
  mergeForkRecord,
  planRollingComment,
  BROWSER_LEG_OSES,
  FORK_RECORD_FILE,
  VALIDATION_MARKER,
} = await import(scriptUrl);
const watchdogUrl = pathToFileURL(
  path.join(REPO_ROOT, 'tools', 'check-browser-downloads.mjs')
).href;
const {VALIDATED_BROWSERS} = await import(watchdogUrl);

/** Write one leg artifact (the e2e-version-<browser>-<os>.json shape). */
function writeLeg(dir, browser, os, version) {
  const file = path.join(dir, `e2e-version-${browser}-${os}.json`);
  fs.writeFileSync(file, JSON.stringify({browser, os, version}));
}

/** A temp dir containing a full agreeing leg set for every validated browser. */
function fullLegSet(dir, {versionOf = () => '155.0.1'} = {}) {
  for (const browser of VALIDATED_BROWSERS) {
    for (const os of BROWSER_LEG_OSES[browser]) {
      writeLeg(dir, browser, os, versionOf(browser));
    }
  }
}

test('collectForkVersions: a single-browser dispatch records that fork alone', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forks-one-'));
  try {
    // The watchdog's `browser=librewolf` dispatch: one fork, one Windows leg.
    writeLeg(tmp, 'librewolf', 'windows-latest', '156.0.1-1');
    assert.deepEqual(collectForkVersions(tmp), {
      librewolf: {version: '156.0.1-1', os: 'windows-latest'},
    });
  } finally {
    fs.rmSync(tmp, {recursive: true, force: true});
  }
});

test('collectForkVersions: absent forks are omitted, never an error', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forks-none-'));
  try {
    // A run whose fork legs were path-skipped still has the hard-gate artifacts
    // — that must yield an empty fork map, not a throw (the merge carries the
    // older entries forward).
    fullLegSet(tmp);
    assert.deepEqual(collectForkVersions(tmp), {});
  } finally {
    fs.rmSync(tmp, {recursive: true, force: true});
  }
});

test('collectForkVersions: fork legs that disagree throw', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forks-clash-'));
  try {
    // browser-matrix and (hypothetically) another leg disagreeing on zen.
    writeLeg(tmp, 'zen', 'windows-latest', '1.22.2b');
    writeLeg(tmp, 'zen', 'windows-latest-x', '1.22.3b');
    assert.throws(() => collectForkVersions(tmp), /zen: legs disagree/);
  } finally {
    fs.rmSync(tmp, {recursive: true, force: true});
  }
});

test('collectForkVersions: a fork artifact from an unexpected OS throws', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forks-os-'));
  try {
    writeLeg(tmp, 'floorp', 'ubuntu-24.04', '12.18.0');
    assert.throws(() => collectForkVersions(tmp), /floorp: version artifact from an unexpected OS/);
  } finally {
    fs.rmSync(tmp, {recursive: true, force: true});
  }
});

test('collectForkVersions: an EMPTY os is unknown, never silently accepted', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forks-emptyos-'));
  try {
    // The real PR #304 bug: browser-matrix has no `os` matrix key, so
    // `${{ matrix.os }}` expanded to "" and the leg uploaded `"os":""`. That
    // must be a hard error (the recording job runs only on a dispatch, so it
    // would otherwise surface days later), not a pass with an unnamed OS.
    writeLeg(tmp, 'zen', '', '1.22.2b');
    assert.throws(
      () => collectForkVersions(tmp),
      /zen: version artifact from an unexpected OS \(\?\)/
    );
  } finally {
    fs.rmSync(tmp, {recursive: true, force: true});
  }
});

test('mergeForkRecord: this run wins, the forks it did not cover carry forward', () => {
  const previous = {
    forks: {zen: {version: '1.22.2b', os: 'windows-latest', validatedAt: '2026-09-18T00:00:00Z'}},
  };
  const found = {librewolf: {version: '156.0.1-1', os: 'windows-latest'}};
  const merged = mergeForkRecord(previous, found, {
    validatedAt: '2026-09-22T00:00:00Z',
    runId: '42',
    runUrl: 'https://example.invalid/run/42',
    sha: 'abc123',
  });
  assert.deepEqual(merged.zen, {
    version: '1.22.2b',
    os: 'windows-latest',
    validatedAt: '2026-09-18T00:00:00Z',
  });
  assert.deepEqual(merged.librewolf, {
    version: '156.0.1-1',
    os: 'windows-latest',
    validatedAt: '2026-09-22T00:00:00Z',
    runId: '42',
    runUrl: 'https://example.invalid/run/42',
    sha: 'abc123',
  });
});

test('mergeForkRecord: a cold record (null) starts from this run', () => {
  const merged = mergeForkRecord(
    null,
    {zen: {version: '1.22.2b', os: 'windows-latest'}},
    {
      validatedAt: '2026-09-22T00:00:00Z',
      runId: null,
      runUrl: null,
      sha: null,
    }
  );
  assert.deepEqual(Object.keys(merged), ['zen']);
  assert.equal(merged.zen.version, '1.22.2b');
});

test('the fork record is never the file the publish pre-flight reads', () => {
  // The whole safety argument for --forks-only: validated.json is compared
  // against the current releases by check-browser-downloads --require-validated,
  // so a fork run must not be able to write it.
  assert.equal(FORK_RECORD_FILE, 'forks.json');
  assert.notEqual(FORK_RECORD_FILE, 'validated.json');
});

test('--forks-only: writes forks.json, carries the other forks, never validated.json', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forks-cli-'));
  const versions = path.join(tmp, 'legs');
  const out = path.join(tmp, 'out');
  fs.mkdirSync(versions, {recursive: true});
  fs.mkdirSync(out, {recursive: true});
  try {
    // A previous record (the restored cache): zen already validated last week.
    fs.writeFileSync(
      path.join(out, FORK_RECORD_FILE),
      JSON.stringify({
        recordedAt: '2026-09-18T00:00:00Z',
        runUrl: null,
        sha: null,
        forks: {
          zen: {version: '1.22.2b', os: 'windows-latest', validatedAt: '2026-09-18T00:00:00Z'},
        },
      })
    );
    writeLeg(versions, 'librewolf', 'windows-latest', '156.0.1-1');
    execFileSync(
      'node',
      [path.join(REPO_ROOT, 'tools', 'ci', 'record-validated-versions.mjs'), '--forks-only'],
      {
        env: {
          ...process.env,
          E2E_VERSIONS_DIR: versions,
          VALIDATED_DIR: out,
          GITHUB_RUN_ID: '99',
          GITHUB_STEP_SUMMARY: '',
          GITHUB_TOKEN: '',
          GITHUB_REPOSITORY: '',
        },
        stdio: 'pipe',
      }
    );
    const record = JSON.parse(fs.readFileSync(path.join(out, FORK_RECORD_FILE), 'utf8'));
    assert.deepEqual(Object.keys(record.forks).sort(), ['librewolf', 'zen']);
    assert.equal(record.forks.librewolf.version, '156.0.1-1');
    assert.equal(record.forks.zen.version, '1.22.2b');
    assert.equal(record.runUrl, null, 'no GITHUB_SERVER_URL/REPOSITORY → no run link');
    assert.equal(
      fs.existsSync(path.join(out, 'validated.json')),
      false,
      '--forks-only must not create the publish pre-flight record'
    );
  } finally {
    fs.rmSync(tmp, {recursive: true, force: true});
  }
});

test('--forks-only: no fork artifacts at all is a hard error', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forks-empty-'));
  const versions = path.join(tmp, 'legs');
  fs.mkdirSync(versions, {recursive: true});
  try {
    fullLegSet(versions); // hard-gate legs only: nothing to pin a fork to
    assert.throws(
      () =>
        execFileSync(
          'node',
          [path.join(REPO_ROOT, 'tools', 'ci', 'record-validated-versions.mjs'), '--forks-only'],
          {
            env: {
              ...process.env,
              E2E_VERSIONS_DIR: versions,
              VALIDATED_DIR: path.join(tmp, 'out'),
              GITHUB_STEP_SUMMARY: '',
              GITHUB_TOKEN: '',
              GITHUB_REPOSITORY: '',
            },
            stdio: 'pipe',
          }
        ),
      /no fork version artifacts found/
    );
  } finally {
    fs.rmSync(tmp, {recursive: true, force: true});
  }
});

test('collectLegVersions: agreeing legs across all OSes yield the record', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'legs-ok-'));
  try {
    fullLegSet(tmp, {
      versionOf: b =>
        b === 'firefox' ? '155.0.1'
        : b === 'waterfox' ? '6.7.2'
        : '156.0b3',
    });
    const out = collectLegVersions(tmp);
    assert.deepEqual(out, {
      'firefox': {version: '155.0.1'},
      'firefox-dev': {version: '156.0b3'},
      'waterfox': {version: '6.7.2'},
    });
  } finally {
    fs.rmSync(tmp, {recursive: true, force: true});
  }
});

test('collectLegVersions: a missing waterfox windows leg throws (single-OS validated browser)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'legs-wfx-'));
  try {
    // Firefox/firefox-dev legs complete, but the required waterfox leg never
    // uploaded its artifact — the record must not be written with a hole.
    fullLegSet(tmp);
    fs.rmSync(path.join(tmp, 'e2e-version-waterfox-windows-latest.json'));
    assert.throws(() => collectLegVersions(tmp), /waterfox: missing version artifacts/);
  } finally {
    fs.rmSync(tmp, {recursive: true, force: true});
  }
});

test('collectLegVersions: missing directory throws (legs did not run)', () => {
  assert.throws(() => collectLegVersions('/nonexistent/e2e-versions'), /not found/);
  assert.throws(() => collectLegVersions(''), /not found/);
});

test('collectLegVersions: a missing OS leg throws (holes must not record)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'legs-hole-'));
  try {
    fullLegSet(tmp);
    // Drop the windows leg of firefox.
    fs.rmSync(path.join(tmp, 'e2e-version-firefox-windows-latest.json'));
    assert.throws(() => collectLegVersions(tmp), /firefox: missing version artifacts.*windows/);
  } finally {
    fs.rmSync(tmp, {recursive: true, force: true});
  }
});

test('collectLegVersions: disagreeing OS legs throw', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'legs-disagree-'));
  try {
    fullLegSet(tmp, {versionOf: () => '155.0.1'});
    writeLeg(tmp, 'firefox', 'macos-latest', '155.0.2'); // one leg installed newer
    assert.throws(() => collectLegVersions(tmp), /firefox: OS legs disagree/);
  } finally {
    fs.rmSync(tmp, {recursive: true, force: true});
  }
});

test('collectLegVersions: malformed artifact content throws', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'legs-malformed-'));
  try {
    fullLegSet(tmp);
    fs.writeFileSync(path.join(tmp, 'e2e-version-firefox-ubuntu-24.04.json'), 'not json');
    assert.throws(() => collectLegVersions(tmp), /unreadable version artifact/);
    fs.writeFileSync(
      path.join(tmp, 'e2e-version-firefox-ubuntu-24.04.json'),
      JSON.stringify({os: 'ubuntu-24.04'}) // missing browser + version
    );
    assert.throws(() => collectLegVersions(tmp), /malformed version artifact/);
  } finally {
    fs.rmSync(tmp, {recursive: true, force: true});
  }
});

test('collectLegVersions: an extra unvalidated-browser artifact is ignored', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'legs-extra-'));
  try {
    fullLegSet(tmp);
    writeLeg(tmp, 'librewolf', 'windows-latest', '155.0-1'); // advisory fork — not recorded
    const out = collectLegVersions(tmp);
    assert.deepEqual(Object.keys(out).sort(), [...VALIDATED_BROWSERS].sort());
  } finally {
    fs.rmSync(tmp, {recursive: true, force: true});
  }
});

test('planRollingComment: posts when no validation comment exists yet', () => {
  const plan = planRollingComment([{id: 1, body: 'unrelated discussion'}], 'b');
  assert.deepEqual(plan, {mode: 'post', deleteIds: []});
  assert.deepEqual(planRollingComment([], 'b'), {mode: 'post', deleteIds: []});
});

test('planRollingComment: patches in place when versions changed', () => {
  const plan = planRollingComment(
    [{id: 7, body: `${VALIDATION_MARKER} firefox=155.0.1 — [run](old)`}],
    `${VALIDATION_MARKER} firefox=155.0.2 — [run](new)`
  );
  assert.deepEqual(plan, {mode: 'patch', commentId: 7, deleteIds: []});
});

test('planRollingComment: noop only when the single comment is byte-identical', () => {
  const body = `${VALIDATION_MARKER} firefox=155.0.1 · firefox-dev=156.0b4 — [run](r)`;
  const plan = planRollingComment([{id: 7, body}], body);
  assert.deepEqual(plan, {mode: 'noop', commentId: 7, deleteIds: []});
  // Same versions but a different run link → still patch (body must match exactly).
  const changed = planRollingComment([{id: 7, body}], body.replace('(r)', '(r2)'));
  assert.equal(changed.mode, 'patch');
});

test('planRollingComment: collapses duplicates, keeping the oldest as primary', () => {
  const comments = [
    {id: 31, body: `${VALIDATION_MARKER} firefox=155.0.1 — [run](dup2)`}, // newer dup
    {id: 5, body: 'unrelated'},
    {id: 30, body: `${VALIDATION_MARKER} firefox=155.0.1 — [run](dup1)`}, // oldest — kept
  ];
  const plan = planRollingComment(comments, `${VALIDATION_MARKER} firefox=155.0.1 — [run](new)`);
  assert.equal(plan.mode, 'patch');
  assert.equal(plan.commentId, 30); // permalink stays stable
  assert.deepEqual(plan.deleteIds, [31]);
});

test('planRollingComment: duplicate collapse works even when content already matches', () => {
  const body = `${VALIDATION_MARKER} firefox=155.0.1 — [run](r)`;
  const plan = planRollingComment(
    [
      {id: 2, body},
      {id: 1, body},
    ],
    body
  );
  assert.equal(plan.mode, 'patch'); // not noop — the duplicate must go
  assert.equal(plan.commentId, 1);
  assert.deepEqual(plan.deleteIds, [2]);
});
