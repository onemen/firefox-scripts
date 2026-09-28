// test/unit/publish/releaseGate.test.mjs — the publish wrapper's gate watch
// (issue #347): repo-scoped gh argv, the gate-verdict classifier, and the
// poll loop's fail-open behavior.

import {test} from 'node:test';
import assert from 'node:assert/strict';

const {buildDispatchArgs, parseReleaseArgs, repoFlag, classifyGateJobs, watchDispatchGate} =
  await import('../../../tools/publish/release.mjs');

const gateJob = (conclusion, steps = []) => ({
  name: 'check browser version drift',
  conclusion,
  steps: steps.map(([name, stepConclusion]) => ({name, conclusion: stepConclusion})),
});

test('every gh argv is repo-scoped — no gh repo set-default dependency (#347)', () => {
  assert.deepEqual(repoFlag(), ['-R', 'onemen/firefox-scripts']);
  assert.equal(buildDispatchArgs({include: ['all']})[0], '-R');
  assert.equal(buildDispatchArgs({include: ['all']})[1], 'onemen/firefox-scripts');
});

test('parseReleaseArgs: --no-wait restores fire-and-forget; the unknown-flag message lists it', () => {
  assert.equal(parseReleaseArgs(['--include=all']).noWait, false);
  assert.equal(parseReleaseArgs(['--include=all', '--no-wait']).noWait, true);
  assert.throws(() => parseReleaseArgs(['--include=all', '--wait']), /--no-wait/);
});

test('classifyGateJobs: green gate', () => {
  assert.deepEqual(classifyGateJobs([gateJob('success')]), {outcome: 'green'});
});

test('classifyGateJobs: missing job / null / skipped conclusions are pending (run raced us)', () => {
  assert.deepEqual(classifyGateJobs([]), {outcome: 'pending'});
  assert.deepEqual(classifyGateJobs([gateJob(null)]), {outcome: 'pending'});
  assert.deepEqual(classifyGateJobs([gateJob('skipped')]), {outcome: 'pending'});
});

test('classifyGateJobs: the drift step drives the watchdog chain', () => {
  const jobs = [
    gateJob('failure', [
      ['Restore watchdog baseline', 'success'],
      ['Check browser version drift', 'failure'],
      ['Require a successful E2E run for this commit (prod)', 'skipped'],
    ]),
  ];
  assert.deepEqual(classifyGateJobs(jobs), {outcome: 'drift'});
});

test('classifyGateJobs: a missing E2E run for the commit is reported, never chained', () => {
  const jobs = [
    gateJob('failure', [
      ['Check browser version drift', 'success'],
      ['Require a successful E2E run for this commit (prod)', 'failure'],
    ]),
  ];
  assert.deepEqual(classifyGateJobs(jobs), {outcome: 'e2e-missing'});
});

test('classifyGateJobs: an unexpected gate failure carries its step names', () => {
  const jobs = [gateJob('failure', [['Prune stale Actions caches', 'failure']])];
  assert.deepEqual(classifyGateJobs(jobs), {
    outcome: 'failed',
    detail: 'Prune stale Actions caches',
  });
});

test('watchDispatchGate: returns the first non-pending verdict', () => {
  const calls = [];
  const verdict = watchDispatchGate(
    1,
    () => calls.push('sleep'),
    () => {
      calls.push('fetch');
      return [gateJob('success')];
    }
  );
  assert.deepEqual(verdict, {outcome: 'green'});
  assert.deepEqual(calls, ['fetch']);
});

test('watchDispatchGate: pending then green — exactly one re-poll, no sleep before the first read', () => {
  const calls = [];
  let n = 0;
  const verdict = watchDispatchGate(
    1,
    () => calls.push('sleep'),
    () => {
      calls.push('fetch');
      return ++n === 1 ? [] : [gateJob('success')];
    }
  );
  assert.deepEqual(verdict, {outcome: 'green'});
  assert.deepEqual(calls, ['fetch', 'sleep', 'fetch']);
});

test('watchDispatchGate: exhausted polls stay pending — never a wrong verdict', () => {
  const verdict = watchDispatchGate(
    1,
    () => {},
    () => [gateJob(null)]
  );
  assert.deepEqual(verdict, {outcome: 'pending'});
});

test('watchDispatchGate: an unobservable run (gh error) fails open as unobservable', () => {
  const verdict = watchDispatchGate(
    1,
    () => {},
    () => null
  );
  assert.deepEqual(verdict, {outcome: 'unobservable'});
});
