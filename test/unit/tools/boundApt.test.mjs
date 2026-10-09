// test/unit/tools/boundApt.test.mjs — the #461 stall-fail-fast contract for
// .github/actions/bound-apt.
//
// Issue #461's acceptance asks that a stalled archive mirror fail in bounded
// time rather than at the job timeout. A live stall cannot be produced in CI,
// so this pins the properties that make the bound real, all read out of the
// wrapper's own script text:
//
//   1. both apt verbs run under a hard `timeout` wrapper (a hung fetch is
//      SIGTERMed instead of blocking the step);
//   2. the update bound is ≤ 120 s — the number the issue names — so the worst
//      case for a stalled mirror is two minutes, not a 15-20 minute job;
//   3. retries are finite (3 attempts) with backoff, so a persistent stall
//      still terminates;
//   4. the total worst case (timeout × attempts + backoff sleeps) fits inside
//      the tightest job timeout that uses the action;
//   5. acquire + dpkg-lock timeouts are set, so the inner HTTP fetches and a
//      contended dpkg lock cannot outlive the outer bound.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const WRAPPER = path.join(ROOT, '.github', 'actions', 'bound-apt', 'action.yml');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'e2e.yml');

const raw = fs.readFileSync(WRAPPER, 'utf8');

test('both apt verbs run under a hard timeout wrapper', () => {
  const update = raw.match(/timeout\s+(\d+)\s+sudo\s+apt-get\s+update/);
  const install = raw.match(/timeout\s+(\d+)\s+sudo\s+apt-get\s+install/);
  assert.ok(update, 'apt-get update must run under `timeout`');
  assert.ok(install, 'apt-get install must run under `timeout`');
});

test('the update bound is at most the 120 s the issue names', () => {
  const update = raw.match(/timeout\s+(\d+)\s+sudo\s+apt-get\s+update/);
  const bound = Number(update[1]);
  assert.ok(bound <= 120, `update bound must be <= 120 s, got ${bound}`);
});

test('retries are finite with backoff, and the last attempt does not sleep', () => {
  const attempts = raw.match(/attempt=1/);
  const limit = raw.match(/\[\s*"\$attempt"\s+-le\s+(\d+)\s*\]/);
  assert.ok(attempts, 'wrapper must initialise an attempt counter');
  assert.ok(limit, 'wrapper must bound the retry loop');
  assert.ok(Number(limit[1]) <= 3, `attempts must stay small and finite, got ${limit[1]}`);
  assert.match(raw, /delay=\$\(\(delay \* 2\)\)/, 'backoff must grow between attempts');
  // The sleep must be guarded by the attempt check, or the run pays a settle
  // pause after its final failure too — that is what made the running bound
  // exceed the asserted one (CodeRabbit, run 2026-10-09).
  const beforeSleep = raw.slice(0, raw.indexOf('sleep "$delay"'));
  assert.match(
    beforeSleep,
    /if\s+\[\s*"\$attempt"\s+-le\s+3\s*\];\s*then/,
    'the backoff sleep must be conditional on another attempt remaining'
  );
});

test('worst-case stall time fits inside every apt-consuming job budget', () => {
  // The job timeouts of the workflows/actions that consume the wrapper. A
  // stalled mirror runs the wrapper's full worst case (every attempt times
  // out), so that number must stay under the smallest of these budgets —
  // otherwise a stall still cancels the job at its timeout, which is the bug
  // #461 exists to remove.
  const budgets = [
    [WORKFLOW, 20], // e2e.yml legs (snapshot 15, legs 20 — the 20 is the binding bound)
    [path.join(ROOT, '.github', 'workflows', 'ci.yml'), 15],
    [path.join(ROOT, '.github', 'workflows', 'core-smoke-nightly.yml'), 15],
    [path.join(ROOT, '.github', 'workflows', 'pages.yml'), 30],
  ];
  const tightest = Math.min(...budgets.map(([, m]) => m));
  const updateBound = Number(raw.match(/timeout\s+(\d+)\s+sudo\s+apt-get\s+update/)[1]);
  const installBound = Number(raw.match(/timeout\s+(\d+)\s+sudo\s+apt-get\s+install/)[1]);
  const attempts = Number(raw.match(/\[\s*"\$attempt"\s+-le\s+(\d+)\s*\]/)[1]);
  // Derive the sleeps from the script's own backoff: base `delay=N`, doubled
  // each attempt, and emitted only while another attempt remains (so
  // attempts-1 sleeps). Summing the series beats a hand-written formula that
  // can silently disagree with the loop.
  const base = Number(raw.match(/delay=(\d+)/)[1]);
  let sleeps = 0;
  let delay = base;
  for (let i = 1; i < attempts; i++) {
    sleeps += delay;
    delay *= 2;
  }
  const worstCase = (updateBound + installBound) * attempts + sleeps;
  assert.ok(
    worstCase < tightest * 60,
    `worst-case stall ${worstCase}s must stay under the ${tightest}-minute job budget`
  );
});

test('acquire and dpkg-lock timeouts are set', () => {
  for (const opt of [
    'Acquire::Retries',
    'Acquire::http::Timeout',
    'Acquire::https::Timeout',
    'DPkg::Lock::Timeout',
  ]) {
    // Plain substring: the option names carry no regex metacharacters we care
    // about, and a literal check keeps the security lint clean.
    assert.ok(raw.includes(opt), `${opt} must be set`);
  }
});
