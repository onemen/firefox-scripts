// test/unit/publish/releaseGate.test.mjs — the publish wrapper's gate watch
// and remediation chain (issue #347): repo-scoped gh argv, the gate-verdict
// classifier, the poll watchers, and the drift chain's termination.

import {test} from 'node:test';
import assert from 'node:assert/strict';

const {
  buildDispatchArgs,
  parseReleaseArgs,
  repoFlag,
  classifyGateJobs,
  watchGateJob,
  waitForRun,
  waitForValidationRecord,
  awaitValidation,
} = await import('../../../tools/publish/release.mjs');

const gateJob = (conclusion, steps = []) => ({
  name: 'check browser version drift',
  conclusion,
  steps: steps.map(([name, stepConclusion]) => ({name, conclusion: stepConclusion})),
});

const recordJob = conclusion => ({name: 'record validated browser versions', conclusion});

/** Fake clock: hasTime() is false once `limit` tick() calls have passed. */
function fakeClock(limit) {
  let n = 0;
  return {tick: () => ++n, hasTime: () => n < limit};
}

test('every gh argv is repo-scoped — no gh repo set-default dependency (#347)', () => {
  assert.deepEqual(repoFlag(), ['-R', 'onemen/firefox-scripts']);
  assert.equal(buildDispatchArgs({include: ['all']})[0], '-R');
  assert.equal(buildDispatchArgs({include: ['all']})[1], 'onemen/firefox-scripts');
});

test('--no-wait is gone: one command always carries the run through (#347)', () => {
  assert.throws(() => parseReleaseArgs(['--include=all', '--no-wait']), /Unknown flag/);
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

test('classifyGateJobs: a missing E2E run for the commit chains the E2E workflow', () => {
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

test('watchGateJob: first read green — no sleep, no clock consumed', () => {
  const calls = [];
  const clock = fakeClock(5);
  const verdict = watchGateJob(
    1,
    () => calls.push('sleep'),
    () => {
      calls.push('fetch');
      return [gateJob('success')];
    },
    clock.hasTime
  );
  assert.deepEqual(verdict, {outcome: 'green'});
  assert.deepEqual(calls, ['fetch']);
});

test('watchGateJob: pending then green — one re-poll, ~20 s apart', () => {
  const calls = [];
  let n = 0;
  const verdict = watchGateJob(
    1,
    ms => calls.push(`sleep${ms}`),
    () => {
      calls.push('fetch');
      return ++n === 1 ? [] : [gateJob('success')];
    },
    () => true
  );
  assert.deepEqual(verdict, {outcome: 'green'});
  assert.deepEqual(calls, ['fetch', 'sleep20000', 'fetch']);
});

test('watchGateJob: a gh error stops the chain as unobservable — never a wrong verdict', () => {
  const verdict = watchGateJob(
    1,
    () => {},
    () => null,
    () => true
  );
  assert.deepEqual(verdict, {outcome: 'unobservable'});
});

test('watchGateJob: an exhausted clock stops the chain as unobservable', () => {
  const clock = fakeClock(1);
  const verdict = watchGateJob(1, clock.tick, () => [gateJob(null)], clock.hasTime);
  assert.deepEqual(verdict, {outcome: 'unobservable'});
});

test('waitForRun: maps the run conclusion — success, failure, unobservable on gh error', () => {
  assert.equal(
    waitForRun(
      1,
      () => {},
      () => ({status: 'completed', conclusion: 'success'}),
      () => true
    ),
    'success'
  );
  assert.equal(
    waitForRun(
      1,
      () => {},
      () => ({status: 'completed', conclusion: 'failure'}),
      () => true
    ),
    'failure'
  );
  assert.equal(
    waitForRun(
      1,
      () => {},
      () => null,
      () => true
    ),
    'unobservable'
  );
});

test('waitForRun: in-progress runs re-poll until completed', () => {
  const calls = [];
  let n = 0;
  const verdict = waitForRun(
    1,
    () => calls.push('sleep'),
    () => {
      calls.push('status');
      return ++n < 3 ?
          {status: 'in_progress', conclusion: null}
        : {status: 'completed', conclusion: 'success'};
    },
    () => true
  );
  assert.equal(verdict, 'success');
  assert.deepEqual(calls, ['status', 'sleep', 'status', 'sleep', 'status']);
});

test('waitForValidationRecord: success / failure / skipped-is-not-applicable', () => {
  assert.equal(
    waitForValidationRecord(
      1,
      () => {},
      () => [recordJob('success')],
      () => true
    ),
    'success'
  );
  assert.equal(
    waitForValidationRecord(
      1,
      () => {},
      () => [recordJob('failure')],
      () => true
    ),
    'failure'
  );
  assert.equal(
    waitForValidationRecord(
      1,
      () => {},
      () => [recordJob('skipped')],
      () => true
    ),
    'not-applicable'
  );
});

test('waitForValidationRecord: pending (job running) polls until recorded', () => {
  const calls = [];
  let n = 0;
  const verdict = waitForValidationRecord(
    1,
    () => calls.push('sleep'),
    () => {
      calls.push('fetch');
      return ++n < 2 ? [recordJob(null)] : [recordJob('success')];
    },
    () => true
  );
  assert.equal(verdict, 'success');
  assert.deepEqual(calls, ['fetch', 'sleep', 'fetch']);
});

test('awaitValidation: watchdog green + a dispatch recording → validated (the drift day, one command)', () => {
  const log = [];
  const clock = fakeClock(50);
  const outcome = awaitValidation(
    () => log.push('sleep'),
    clock.hasTime,
    {databaseId: 10},
    () => [recordJob('success')],
    () => ({status: 'completed', conclusion: 'success'}),
    () => [{databaseId: 20}]
  );
  assert.equal(outcome, 'validated');
});

test('awaitValidation: fork escapes are passed over until the full run records', () => {
  let n = 0;
  const outcomes = ['not-applicable', 'success'];
  const outcome = awaitValidation(
    () => {},
    () => true,
    null, // no watchdog wait (already done upstream)
    () => [recordJob(outcomes[Math.min(n++, 1)])],
    () => ({status: 'completed', conclusion: 'success'}),
    () => [{databaseId: 21}, {databaseId: 22}]
  );
  assert.equal(outcome, 'validated');
});

test('awaitValidation: a failed watchdog run stops with watchdog-failed', () => {
  const outcome = awaitValidation(
    () => {},
    () => true,
    {databaseId: 10},
    () => [recordJob('success')],
    () => ({status: 'completed', conclusion: 'failure'}),
    () => []
  );
  assert.equal(outcome, 'watchdog-failed');
});

test('awaitValidation: a failed validation record stops the chain — the only E2E stop', () => {
  const outcome = awaitValidation(
    () => {},
    () => true,
    null,
    () => [recordJob('failure')],
    () => ({status: 'completed', conclusion: 'success'}),
    () => [{databaseId: 20}]
  );
  assert.equal(outcome, 'validation-failed');
});

test('awaitValidation: losing sight of the E2E job list stops as unobservable', () => {
  const outcome = awaitValidation(
    () => {},
    () => true,
    null,
    () => null,
    () => ({status: 'completed', conclusion: 'success'}),
    () => [{databaseId: 20}]
  );
  assert.equal(outcome, 'unobservable');
});
