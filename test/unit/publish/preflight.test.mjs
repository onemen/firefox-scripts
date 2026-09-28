// test/unit/publish/preflight.test.mjs — the publish wrapper's probe-first
// pre-flight (#347): repo-scoped argv, probe dispatch/wait/verdict, and the
// fail-open + drift-notice branches of runPreflight.

import {test} from 'node:test';
import assert from 'node:assert/strict';

const {
  buildDispatchArgs,
  buildProbeArgs,
  repoFlag,
  waitForProbeRun,
  probeVerdict,
  runPreflight,
  DispatchNotFoundError,
} = await import('../../../tools/publish/release.mjs');

test('every gh argv is repo-scoped — no gh repo set-default dependency (#347)', () => {
  assert.deepEqual(repoFlag(), ['-R', 'onemen/firefox-scripts']);
  assert.equal(buildDispatchArgs({include: ['all']})[0], '-R');
  assert.equal(buildDispatchArgs({include: ['all']})[1], 'onemen/firefox-scripts');
  assert.deepEqual(buildProbeArgs(), [
    '-R',
    'onemen/firefox-scripts',
    'workflow',
    'run',
    'drift-check.yml',
    '--ref',
    'main',
  ]);
});

test('waitForProbeRun: maps conclusions; unobservable on sustained gh errors or the poll cap', () => {
  assert.equal(
    waitForProbeRun(
      1,
      () => {},
      () => ({status: 'completed', conclusion: 'success'})
    ),
    'success'
  );
  assert.equal(
    waitForProbeRun(
      1,
      () => {},
      () => ({status: 'completed', conclusion: 'failure'})
    ),
    'failure'
  );
  // A single gh error is a transient (#361); PROBE_ERROR_STREAK consecutive
  // errors are sustained failure — the fail-open fires, after exactly 3 polls.
  let calls = 0;
  assert.equal(
    waitForProbeRun(
      1,
      () => {},
      () => {
        calls += 1;
        return null;
      }
    ),
    'unobservable'
  );
  assert.equal(calls, 3);
  assert.equal(
    waitForProbeRun(
      1,
      () => {},
      () => ({status: 'in_progress', conclusion: null})
    ),
    'unobservable'
  );
});

test('waitForProbeRun: transient gh errors and in-progress polls never abandon a healthy run (#361)', () => {
  const script = (...results) => {
    let i = 0;
    return () => results[Math.min(i++, results.length - 1)];
  };
  // Two blips, then completion — the verdict is read, not lost.
  assert.equal(
    waitForProbeRun(1, () => {}, script(null, null, {status: 'completed', conclusion: 'success'})),
    'success'
  );
  // A blip streak resets on any successful poll.
  assert.equal(
    waitForProbeRun(
      1,
      () => {},
      script(null, null, {status: 'in_progress', conclusion: null}, null, null, {
        status: 'completed',
        conclusion: 'failure',
      })
    ),
    'failure'
  );
});

const ghLog = lines => argv => {
  assert.equal(argv[0], '-R');
  assert.equal(argv[1], 'onemen/firefox-scripts');
  return {
    status: 0,
    stdout: lines.map(l => `probe\tUNKNOWN STEP\t2026-09-28T00:00:00Z ${l}`).join('\n'),
  };
};

test('probeVerdict: drift lines from the probe log, verbatim and annotated', () => {
  const v = probeVerdict(
    1,
    ghLog([
      '##[error]firefox-dev: 157.0b4 → 157.0b5',
      '##[error]run the URL watchdog workflow (refreshes the baseline + triggers browser-specific E2E), then re-dispatch publish.',
    ])
  );
  assert.deepEqual(v, {verdict: 'drift', drift: ['firefox-dev: 157.0b4 → 157.0b5']});
});

test('probeVerdict: the e2e-missing remedy line picks the other verdict', () => {
  const v = probeVerdict(
    1,
    ghLog([
      '##[error]no successful E2E workflow run for commit abc — let the E2E run on main finish (or re-run it), then re-dispatch publish.',
    ])
  );
  assert.deepEqual(v, {verdict: 'e2e-missing', drift: []});
});

test('probeVerdict: unparseable log → unobservable (fail-open upstream)', () => {
  assert.deepEqual(probeVerdict(1, ghLog(['something else'])), {
    verdict: 'unobservable',
    drift: [],
  });
  assert.deepEqual(
    probeVerdict(1, () => ({status: 1, stdout: ''})),
    {
      verdict: 'unobservable',
      drift: [],
    }
  );
});

const okDispatch = () => ({status: 0, stdout: ''});

test('runPreflight: green probe → green (the happy path, ~30 s announced first)', () => {
  const log = [];
  const out = runPreflight({
    dispatch: argv => {
      log.push(argv.join(' '));
      return okDispatch(argv);
    },
    find: workflow => {
      log.push(`find:${workflow}`);
      return {databaseId: 7};
    },
    status: () => ({status: 'completed', conclusion: 'success'}),
    verdict: () => {
      throw new Error('verdict must not be called on a green run');
    },
    sleep: () => {},
  });
  assert.deepEqual(out, {verdict: 'green', drift: []});
  assert.ok(log[0].includes('workflow run drift-check.yml --ref main'));
  assert.equal(log[1], 'find:drift-check.yml');
});

test('runPreflight: probe dispatch failed → fail-open green (in-run gate still enforces)', () => {
  const out = runPreflight({
    dispatch: () => ({status: 1, stderr: 'gh: not logged in'}),
    find: () => {
      throw new Error('must not search for a run');
    },
    sleep: () => {},
  });
  assert.deepEqual(out, {verdict: 'green', drift: []});
});

test('runPreflight: unobservable probe → fail-open green, never a wrong verdict', () => {
  const out = runPreflight({
    dispatch: okDispatch,
    find: () => ({databaseId: 9}),
    status: () => null,
    sleep: () => {},
  });
  assert.deepEqual(out, {verdict: 'green', drift: []});
});

test('runPreflight: drift → immediate notice + watchdog dispatched + exit signal', () => {
  const dispatched = [];
  const out = runPreflight({
    dispatch: argv => {
      dispatched.push(argv.join(' '));
      return okDispatch(argv);
    },
    find: workflow => ({databaseId: workflow === 'url-watchdog.yml' ? 12 : 7}),
    status: () => ({status: 'completed', conclusion: 'failure'}),
    verdict: () => ({verdict: 'drift', drift: ['firefox-dev: 157.0b4 → 157.0b5']}),
    sleep: () => {},
  });
  assert.deepEqual(out, {verdict: 'drift', drift: ['firefox-dev: 157.0b4 → 157.0b5']});
  assert.ok(dispatched.some(a => a.includes('workflow run url-watchdog.yml --ref main')));
});

test('runPreflight: drift with a failed watchdog dispatch still reports the drift', () => {
  const out = runPreflight({
    dispatch: argv => (argv.includes('url-watchdog.yml') ? {status: 1} : okDispatch(argv)),
    find: () => ({databaseId: 7}),
    status: () => ({status: 'completed', conclusion: 'failure'}),
    verdict: () => ({verdict: 'drift', drift: ['zen: 1.22.3b → 1.23.0b']}),
    sleep: () => {},
  });
  assert.deepEqual(out, {verdict: 'drift', drift: ['zen: 1.22.3b → 1.23.0b']});
});

test('runPreflight: probe run not listed YET → retries discovery, then reads the verdict (the 2026-09-28 race)', () => {
  const log = [];
  let attempts = 0;
  const out = runPreflight({
    dispatch: () => ({status: 0, stdout: ''}),
    find: () => {
      attempts++;
      if (attempts < 3) throw new DispatchNotFoundError('not listed yet');
      return {databaseId: 7};
    },
    status: () => ({status: 'completed', conclusion: 'success'}),
    sleep: ms => log.push(`sleep${ms}`),
  });
  assert.deepEqual(out, {verdict: 'green', drift: []});
  assert.equal(attempts, 3);
  assert.deepEqual(log, ['sleep2000', 'sleep2000']);
});

test('runPreflight: discovery never finds the run → STOP as unobservable — never publish unread', () => {
  const log = [];
  let attempts = 0;
  const out = runPreflight({
    dispatch: () => ({status: 0, stdout: ''}),
    find: () => {
      attempts++;
      throw new DispatchNotFoundError('not listed yet');
    },
    sleep: () => log.push('sleep'),
  });
  assert.deepEqual(out, {verdict: 'unobservable', drift: []});
  assert.equal(attempts, 10); // PROBE_DISCOVERY_RETRIES — bounded, not infinite
  assert.equal(log.length, 9); // no sleep after the final attempt
});

test('runPreflight: find returns null (gh error) → fail-open green, NOT a stop (CodeRabbit #350)', () => {
  const out = runPreflight({
    dispatch: () => ({status: 0, stdout: ''}),
    find: () => null, // gh failed — never throws, just reports nothing
    sleep: () => {
      throw new Error('must not retry a gh error');
    },
  });
  assert.deepEqual(out, {verdict: 'green', drift: []});
});

test('runPreflight: watchdog run not listed yet → drift verdict kept, no escape (CodeRabbit #350)', () => {
  let watchdogLookups = 0;
  const out = runPreflight({
    dispatch: () => ({status: 0, stdout: ''}),
    find: workflow => {
      if (workflow === 'url-watchdog.yml') {
        watchdogLookups++;
        throw new DispatchNotFoundError('not listed yet');
      }
      return {databaseId: 7};
    },
    status: () => ({status: 'completed', conclusion: 'failure'}),
    verdict: () => ({verdict: 'drift', drift: ['firefox-dev: 157.0b4 → 157.0b5']}),
    sleep: () => {},
  });
  assert.deepEqual(out, {verdict: 'drift', drift: ['firefox-dev: 157.0b4 → 157.0b5']});
  assert.equal(watchdogLookups, 10); // retried, then degraded to no URL — never thrown
});

test('runPreflight: a non-discovery error from find propagates (not swallowed as a race)', () => {
  assert.throws(
    () =>
      runPreflight({
        dispatch: () => ({status: 0, stdout: ''}),
        find: () => {
          throw new Error('boom');
        },
        sleep: () => {},
      }),
    /boom/
  );
});

test('runPreflight: e2e-missing → reported with its remedy, no watchdog dispatched', () => {
  const dispatched = [];
  const out = runPreflight({
    dispatch: argv => {
      dispatched.push(argv.join(' '));
      return okDispatch(argv);
    },
    find: () => ({databaseId: 7}),
    status: () => ({status: 'completed', conclusion: 'failure'}),
    verdict: () => ({verdict: 'e2e-missing', drift: []}),
    sleep: () => {},
  });
  assert.deepEqual(out, {verdict: 'e2e-missing', drift: []});
  assert.ok(!dispatched.some(a => a.includes('url-watchdog.yml')));
});
