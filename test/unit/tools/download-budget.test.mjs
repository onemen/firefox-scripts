// test/unit/tools/download-budget.test.mjs — the browser-installer download
// budget must be provably smaller than the job that contains it.
//
// A budget at or above its job's `timeout-minutes` can never report itself: the
// runner kills the job first, and what the user sees is "cancelled" rather than
// "<browser>: download exceeded its 12 min budget" — with no chance for the
// cached-installer fallback (findCachedInstaller) to engage and the leg to test
// the previous release instead of dying. That is exactly how PR #294's
// librewolf leg died on 2026-09-22: 160 MB at 51-61 KB/s against a 20-minute
// cap that equalled the 20-minute budget.
//
// The rule is static, so it is checked here against the real workflow files:
// every job that downloads a browser installer must outlive its budget by at
// least MIN_POST_DOWNLOAD_SLACK_MS.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const E2E = path.join(REPO_ROOT, '.github', 'workflows', 'e2e.yml');
const WATCHDOG = path.join(REPO_ROOT, '.github', 'workflows', 'url-watchdog.yml');
const DOWNLOADS = path.join(REPO_ROOT, 'test', 'e2e', 'shared', 'downloads.mjs');

// Work that still has to happen after the transfer inside the same leg: the
// silent install, the scenario suite, the report/upload steps. A floor, not a
// target — observed legs run installs in ~20 s and finish in 3-4 min total, so
// a leg that only just clears this bar has already been squeezed.
export const MIN_POST_DOWNLOAD_SLACK_MS = 5 * 60_000;

/**
 * The `const DEFAULT_TOTAL_BUDGET_MS = <n> * 60_000;` product, evaluated from
 * the source of truth rather than duplicated here.
 *
 * @param {string} text test/e2e/shared/downloads.mjs
 * @returns {number} epoch-ms budget
 */
export function defaultBudgetMs(text) {
  const match = text.match(/const DEFAULT_TOTAL_BUDGET_MS = ([0-9_*\s]+);/);
  assert.ok(match, 'downloads.mjs must declare DEFAULT_TOTAL_BUDGET_MS');
  return match[1]
    .split('*')
    .map(part => Number(part.trim().replace(/_/g, '')))
    .reduce((a, b) => a * b, 1);
}

/**
 * The workflow-level `DOWNLOAD_TOTAL_BUDGET_MS` override, or null when the
 * workflow keeps the default.
 *
 * @param {string} text a workflow file
 * @returns {number | null}
 */
export function workflowEnvBudget(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex(line => /^env:\s*$/.test(line));
  if (start === -1) return null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\S/.test(line)) break; // the next top-level key ends the block
    const match = line.match(/^\s+DOWNLOAD_TOTAL_BUDGET_MS:\s*['"]?(\d+)['"]?\s*$/);
    if (match) return Number(match[1]);
  }
  return null;
}

/**
 * Every job that declares a timeout, with its body text.
 *
 * @param {string} text a workflow file
 * @returns {{name: string; timeoutMinutes: number | null; body: string}[]}
 */
export function timedJobs(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const jobsStart = lines.findIndex(line => /^jobs:\s*$/.test(line));
  if (jobsStart === -1) return [];
  /** @type {{name: string; body: string[]}[]} */
  const jobs = [];
  for (let i = jobsStart + 1; i < lines.length; i++) {
    const header = lines[i].match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (header) {
      jobs.push({name: header[1], body: []});
      continue;
    }
    jobs.at(-1)?.body.push(lines[i]);
  }
  return jobs.map(job => {
    const body = job.body.join('\n');
    const timeout = body.match(/^\s+timeout-minutes:\s*(\d+)\s*$/m);
    return {name: job.name, timeoutMinutes: timeout ? Number(timeout[1]) : null, body};
  });
}

/**
 * Jobs that install a browser through the `setup-browser` composite — the only
 * path that performs a full installer download and install.
 *
 * Deliberately NOT "anything referencing downloads.mjs": the watchdog's
 * `pr-check` job calls it in `--pr` mode (a 1 KB ranged probe, no download), so
 * a textual match there would demand slack for a transfer that never happens.
 *
 * @param {string} text a workflow file
 * @returns {{name: string; timeoutMinutes: number}[]}
 */
export function downloadingJobs(text) {
  return timedJobs(text)
    .filter(job => /setup-browser/.test(job.body) && job.timeoutMinutes !== null)
    .map(job => ({name: job.name, timeoutMinutes: job.timeoutMinutes}));
}

/**
 * The jobs whose cap cannot outlive their own download budget.
 *
 * @param {{
 *   jobs: {name: string; timeoutMinutes: number}[];
 *   budgetMs: number;
 * }} args
 * @returns {string[]} human-readable violations (empty = the contract holds)
 */
export function budgetViolations({jobs, budgetMs}) {
  return jobs
    .filter(job => job.timeoutMinutes * 60_000 - budgetMs < MIN_POST_DOWNLOAD_SLACK_MS)
    .map(job => {
      const slackMin = Math.floor((job.timeoutMinutes * 60_000 - budgetMs) / 60_000);
      return (
        `${job.name}: timeout-minutes ${job.timeoutMinutes} leaves ${slackMin} min after the ` +
        `${budgetMs / 60_000}-minute download budget (needs ${MIN_POST_DOWNLOAD_SLACK_MS / 60_000} min)`
      );
    });
}

test('e2e.yml: every browser leg outlives the download budget by the slack floor', () => {
  const text = fs.readFileSync(E2E, 'utf8');
  const budgetMs = workflowEnvBudget(text) ?? defaultBudgetMs(fs.readFileSync(DOWNLOADS, 'utf8'));
  const jobs = downloadingJobs(text);
  assert.ok(jobs.length > 0, 'expected downloading legs in e2e.yml');
  const violations = budgetViolations({jobs, budgetMs});
  assert.deepEqual(violations, [], violations.join('\n'));
});

test('e2e.yml: the budget is pinned explicitly (so the margin cannot evaporate)', () => {
  const override = workflowEnvBudget(fs.readFileSync(E2E, 'utf8'));
  assert.notEqual(
    override,
    null,
    'e2e.yml must set DOWNLOAD_TOTAL_BUDGET_MS — relying on the 20-minute default ties it to the 20-minute legs'
  );
});

test('url-watchdog.yml: its verification download fits inside the check job', () => {
  // The watchdog's `check` job downloads each new release in full to hash it,
  // inside the module's 20-minute default budget — so the 30-minute cap is what
  // keeps that budget reportable.
  const text = fs.readFileSync(WATCHDOG, 'utf8');
  const job = timedJobs(text).find(j => j.name === 'check');
  assert.ok(job, 'expected a `check` job in url-watchdog.yml');
  const budgetMs = workflowEnvBudget(text) ?? defaultBudgetMs(fs.readFileSync(DOWNLOADS, 'utf8'));
  const violations = budgetViolations({
    jobs: [{name: job.name, timeoutMinutes: job.timeoutMinutes}],
    budgetMs,
  });
  assert.deepEqual(violations, [], violations.join('\n'));
});

test('budgetViolations: a leg whose cap equals the budget is a violation', () => {
  const jobs = [{name: 'updater E2E · librewolf · windows-latest', timeoutMinutes: 20}];
  const equal = budgetViolations({jobs, budgetMs: 20 * 60_000});
  assert.equal(equal.length, 1);
  assert.match(equal[0], /librewolf/);
  assert.match(equal[0], /needs 5 min/);
  // The current fix: 12 min budget inside the same 20-minute leg.
  assert.deepEqual(budgetViolations({jobs, budgetMs: 12 * 60_000}), []);
  // A leg that only just clears the bar is not a violation — the floor is a
  // minimum (8 minutes of margin is the design); a budget one second past the
  // floor is.
  assert.deepEqual(budgetViolations({jobs, budgetMs: 15 * 60_000}), []);
  assert.equal(budgetViolations({jobs, budgetMs: 15 * 60_000 + 1_000}).length, 1);
});

test('downloadingJobs: jobs that never fetch a browser are ignored', () => {
  // Covers both the no-timeout case and the false positive that motivated the
  // predicate: a job that merely runs `downloads.mjs --pr` (ranged probe).
  const fixture = [
    'jobs:',
    '  changes:',
    '    runs-on: ubuntu-latest',
    '    timeout-minutes: 5',
    '    steps:',
    '      - run: echo hi',
    '  browser:',
    '    runs-on: windows-latest',
    '    timeout-minutes: 20',
    '    steps:',
    '      - uses: ./.github/actions/setup-browser',
    '        with:',
    '          browser: librewolf',
    '  no-timeout:',
    '    steps:',
    '      - uses: ./.github/actions/setup-browser',
  ].join('\n');
  assert.deepEqual(downloadingJobs(fixture), [{name: 'browser', timeoutMinutes: 20}]);
});
