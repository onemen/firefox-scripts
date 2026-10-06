// test/unit/tools/e2e-triage.test.mjs — the nightly revalidation's triage
// logic (#380): which jobs count as failed legs, and how a failure set is
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
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const toolUrl = pathToFileURL(path.join(REPO_ROOT, 'tools', 'ci', 'e2e-triage.mjs')).href;

const {failedLegs, failuresHash, triageTitle, isTriageIssueTitle, triageBody, TRIAGE_LABEL} =
  await import(toolUrl);

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
