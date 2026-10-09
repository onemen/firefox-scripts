// test/unit/tools/cron-inventory.test.mjs — the repo's cron inventory.
//
// The scheduled surface is a deliberate, small set: ONE cron drives the
// nightly revalidation (the url-watchdog's 22:00 UTC), the rest are the
// nightly watchdogs and Dependabot. Nothing else may gain a cron without a
// test change, and — the failure this test exists for — a `schedule:` block
// that loses its `cron:` expression is VALID YAML that GitHub accepts and
// then never fires: the nightly revalidation would silently stop and the
// repo would have no E2E run on main at all.
//
// Parsed from the workflow files themselves, so a trigger edit that breaks
// the inventory fails here rather than in production a week later.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const WORKFLOWS = path.join(REPO_ROOT, '.github', 'workflows');

/** Every `- cron: '…'` expression in one workflow file. */
function cronsOf(file) {
  const text = fs.readFileSync(path.join(WORKFLOWS, file), 'utf8').replace(/\r\n/g, '\n');
  return [...text.matchAll(/- cron:\s*'([^']+)'/g)].map(m => m[1]);
}

/** Does the file declare a `schedule:` trigger at all? */
function hasScheduleTrigger(file) {
  const text = fs.readFileSync(path.join(WORKFLOWS, file), 'utf8').replace(/\r\n/g, '\n');
  return /^ {2}schedule:\s*$/m.test(text);
}

/** The exact schedule inventory the repo is allowed to have. */
const EXPECTED = {
  'url-watchdog.yml': ['0 22 * * *'], // the repo's ONLY cron — the nightly revalidation driver
  'core-smoke-nightly.yml': [], // dispatched nightly by the watchdog; no cron of its own
  'e2e.yml': [], // no schedule, no push:[main] — the nightly is main's only E2E run
  'skills-watchdog.yml': ['0 14 * * 1'],
  'runner-watchdog.yml': ['0 20 * * 1'],
  'av-watchdog.yml': ['0 5 * * 1'],
  // Dispatch-only: the scheduled prune moved into the url-watchdog's
  // nightly tick (the repo's only cron) — a weekly window would let the repo
  // sit at the 10 GB cache cap for days.
  'cache-cleanup.yml': [],
};

test('every workflow with a schedule: block carries at least one cron expression', () => {
  const files = fs.readdirSync(WORKFLOWS).filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));
  const broken = files.filter(f => hasScheduleTrigger(f) && cronsOf(f).length === 0);
  assert.deepEqual(
    broken,
    [],
    'schedule: block(s) with NO cron: expression — valid YAML that never fires: ' +
      broken.join(', ')
  );
});

test('the cron inventory is exactly the intended set (one nightly cron)', () => {
  const actual = {};
  for (const file of fs.readdirSync(WORKFLOWS).filter(f => f.endsWith('.yml'))) {
    const crons = cronsOf(file);
    if (crons.length > 0) actual[file] = crons;
  }
  const expected = Object.fromEntries(Object.entries(EXPECTED).filter(([, v]) => v.length > 0));
  assert.deepEqual(actual, expected);
});

test('e2e.yml has neither a schedule: trigger nor a push: [main] trigger', () => {
  const text = fs.readFileSync(path.join(WORKFLOWS, 'e2e.yml'), 'utf8').replace(/\r\n/g, '\n');
  assert.doesNotMatch(text, /^ {2}schedule:\s*$/m);
  // The push trigger is gone entirely — not even narrowed to other branches.
  assert.doesNotMatch(text, /^ {2}push:\s*$/m);
});

test('core-smoke-nightly.yml is dispatch-only (the watchdog drives it nightly)', () => {
  const text = fs
    .readFileSync(path.join(WORKFLOWS, 'core-smoke-nightly.yml'), 'utf8')
    .replace(/\r\n/g, '\n');
  assert.doesNotMatch(text, /^ {2}schedule:\s*$/m);
  assert.match(text, /^ {2}workflow_dispatch:\s*$/m);
});
