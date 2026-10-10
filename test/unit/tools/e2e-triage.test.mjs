// test/unit/tools/e2e-triage.test.mjs — the nightly revalidation's triage
// logic: which jobs count as failed legs, and how a failure set is
// turned into one deduped, self-closing issue.
//
// The I/O (run-job listing, issue create/comment/close) hits the GitHub API
// and is not unit-tested; these pin the decisions the API results flow
// through — because the whole point of the job is that a red nightly is SEEN,
// and the ways it can stay invisible are exactly these: a leg mis-classified
// as not-failed, a failure set that collides with a different one's issue, or
// a triage issue the watchdog's own green sweep closes.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const toolUrl = pathToFileURL(path.join(REPO_ROOT, 'tools', 'ci', 'e2e-triage.mjs')).href;

const {
  failedLegs,
  failuresHash,
  triageTitle,
  isTriageIssueTitle,
  triageBody,
  TRIAGE_LABEL,
  recoveredPerBrowserIssues,
} = await import(toolUrl);

// The per-browser title-maker lives in the reporting layer — e2e-triage
// imports it from there, so the tests do the same (one source, no drift).
const {triageIssueTitle: perBrowserTitle} = await import(
  pathToFileURL(path.join(REPO_ROOT, 'tools', 'ci', 'watchdog-report.mjs')).href
);

const leg = (name, conclusion = 'failure') => ({name, conclusion, html_url: `u/${name}`});

test('failedLegs: a failed leg is reported, with its conclusion and link', () => {
  assert.deepEqual(failedLegs([leg('updater E2E · firefox · windows-latest')]), [
    {
      name: 'updater E2E · firefox · windows-latest',
      conclusion: 'failure',
      html_url: 'u/updater E2E · firefox · windows-latest',
    },
  ]);
});

test('failedLegs: every conclusion that means "validated nothing"', () => {
  const jobs = ['failure', 'timed_out', 'startup_failure', 'action_required'].map(c =>
    leg(`leg-${c}`, c)
  );
  assert.equal(failedLegs(jobs).length, 4);
});

test('failedLegs: a skipped leg is a legitimate outcome, not a failure', () => {
  assert.deepEqual(failedLegs([leg('snap Firefox E2E · ubuntu-24.04', 'skipped')]), []);
});

test('failedLegs: a cancelled leg is not news (the run is going away)', () => {
  assert.deepEqual(failedLegs([leg('updater E2E · nightly · macos-latest', 'cancelled')]), []);
});

test('failedLegs: the gate and the triage job itself never make the list', () => {
  const jobs = [
    {name: 'E2E gate', conclusion: 'failure', html_url: 'u/gate'},
    {name: 'triage nightly revalidation', conclusion: 'failure', html_url: 'u/triage'},
    leg('updater E2E · firefox · ubuntu-24.04'),
  ];
  assert.deepEqual(
    failedLegs(jobs).map(l => l.name),
    ['updater E2E · firefox · ubuntu-24.04']
  );
});

test('failedLegs: sorted by name, so the hash cannot depend on GitHub’s job order', () => {
  const names = ['b leg', 'a leg', 'c leg'];
  const sorted = failedLegs(names.map(n => leg(n))).map(l => l.name);
  assert.deepEqual(
    sorted,
    [...sorted].sort((a, b) => a.localeCompare(b))
  );
  assert.deepEqual(sorted, ['a leg', 'b leg', 'c leg']);
});

test('failuresHash: the same set hashes alike, a different set does not', () => {
  const a = failuresHash([leg('updater A'), leg('updater B')]);
  const b = failuresHash([leg('updater B'), leg('updater A')]);
  const c = failuresHash([leg('updater A')]);
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{12}$/);
});

test('triageTitle: singular, plural, and the hash identity in the title', () => {
  const one = triageTitle([leg('updater E2E · firefox · windows-latest')]);
  const two = triageTitle([leg('a'), leg('b')]);
  assert.match(one, /^\[e2e nightly\] 1 leg failed — [0-9a-f]{12}$/);
  assert.match(two, /^\[e2e nightly\] 2 legs failed — [0-9a-f]{12}$/);
  assert.notEqual(one, two);
});

test('isTriageIssueTitle: prefix match, hash agnostic — a green night closes them all', () => {
  assert.equal(isTriageIssueTitle('[e2e nightly] 1 leg failed — abc123def456'), true);
  assert.equal(isTriageIssueTitle('[e2e nightly] 3 legs failed — 000000000000'), true);
  assert.equal(isTriageIssueTitle('[url-watchdog] firefox new release'), false);
  assert.equal(isTriageIssueTitle(undefined), false);
});

test('triageBody: names the run, lists the legs, and says what closes the issue', () => {
  const body = triageBody([leg('updater E2E · firefox · windows-latest')], 'https://run/1');
  assert.match(body, /Nightly revalidation: https:\/\/run\/1/);
  assert.match(body, /`updater E2E · firefox · windows-latest` \| failure \|/);
  assert.match(body, /closes itself on the first green night/);
});

test('the triage label is its own surface, not the watchdog’s', () => {
  assert.equal(TRIAGE_LABEL, 'e2e-nightly');
  assert.notEqual(TRIAGE_LABEL, 'url-watchdog');
});

test('recoveredPerBrowserIssues: a browser not in the failed set has recovered', () => {
  const open = [
    {number: 11, title: perBrowserTitle('firefox')},
    {number: 12, title: perBrowserTitle('waterfox')},
    {number: 13, title: '[e2e nightly] 2026-10-10 · abc123'}, // aggregate, not per-browser
  ];
  const out = recoveredPerBrowserIssues(open, ['waterfox']);
  assert.deepEqual(out, [{number: 11, title: perBrowserTitle('firefox'), browser: 'firefox'}]);
});

test('recoveredPerBrowserIssues: the helper stays failure-set-shaped; the all-cancelled guard lives in main()', () => {
  // The helper cannot see conclusions, so the "a run that validated nothing
  // closes nothing" decision lives at the call site
  // (`anySuccess ? recoveredPerBrowserIssues(...) : []`). Pinned as
  // documentation — if this helper ever grows a jobs parameter, move the
  // guard inside and delete this comment.
  assert.equal(recoveredPerBrowserIssues.length, 2);
});

test('main(): closes recovered issues only when a gate leg concluded success', () => {
  // The all-cancelled shape: no FAILED legs (so browsers = []) but also no
  // success — recoveredPerBrowserIssues is gated on anySuccess in main(), so
  // the close loop must not run. Verify the source wires the guard on the
  // job list, not on the failure set (whose emptiness here is a false green).
  const src = fs.readFileSync(path.join(REPO_ROOT, 'tools', 'ci', 'e2e-triage.mjs'), 'utf8');
  assert.match(src, /const anySuccess = jobs\.some\(job => job\.conclusion === 'success'\)/);
  assert.match(
    src,
    /const recovered = anySuccess \? recoveredPerBrowserIssues\(open, browsers\) : \[\]/
  );
});

test('recoveredPerBrowserIssues: firefox-dev failing does not cancel firefox recovery', () => {
  // Recovery is per browser: firefox is green this night, so its issue
  // closes even while firefox-dev still fails — and vice versa. The
  // exact-segment browserOfLeg guarantees the failed-set names and the
  // issue-title suffixes are drawn from the same exact-token space, so
  // firefox-dev failing can never suppress the firefox close or the
  // firefox-dev close: each is compared against its own name.
  const open = [{number: 11, title: perBrowserTitle('firefox')}];
  const out = recoveredPerBrowserIssues(open, ['firefox-dev']);
  assert.deepEqual(
    out.map(i => i.browser),
    ['firefox']
  );
});

test('recoveredPerBrowserIssues: still-failing browsers stay open', () => {
  const open = [
    {number: 11, title: perBrowserTitle('firefox')},
    {number: 12, title: perBrowserTitle('firefox-dev')},
  ];
  const out = recoveredPerBrowserIssues(open, ['firefox', 'firefox-dev']);
  assert.deepEqual(out, []);
});

test('recoveredPerBrowserIssues: a green night leaves the close to the green loop', () => {
  // With NO failed browsers, everything open is recovered — but the green
  // close loop (legs.length === 0) handles that night; this helper only
  // runs on partial-recovery nights, where it must behave the same way.
  const open = [{number: 11, title: perBrowserTitle('firefox')}];
  assert.deepEqual(
    recoveredPerBrowserIssues(open, []).map(i => i.browser),
    ['firefox']
  );
});
