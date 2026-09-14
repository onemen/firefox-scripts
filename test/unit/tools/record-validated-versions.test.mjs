// test/unit/tools/record-validated-versions.test.mjs — Unit tests for the
// pure helpers in tools/ci/record-validated-versions.mjs (the GitHub comment
// and record write hit the network / env — not unit-tested).

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const scriptUrl = pathToFileURL(
  path.join(REPO_ROOT, 'tools', 'ci', 'record-validated-versions.mjs')
).href;
const {collectLegVersions, planRollingComment, BROWSER_LEG_OSES, VALIDATION_MARKER} = await import(
  scriptUrl
);
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
    fs.writeFileSync(path.join(tmp, 'e2e-version-firefox-ubuntu-latest.json'), 'not json');
    assert.throws(() => collectLegVersions(tmp), /unreadable version artifact/);
    fs.writeFileSync(
      path.join(tmp, 'e2e-version-firefox-ubuntu-latest.json'),
      JSON.stringify({os: 'ubuntu-latest'}) // missing browser + version
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
