// test/unit/tools/ci-job-timeouts.test.mjs — every job in every workflow sets
// `timeout-minutes`.
//
// Born from #509: `core-smoke-nightly.yml` set no job timeout, so a hung step
// would hold the runner for GitHub's 6-hour default. A missing timeout is
// invisible until the night it bites, so the contract covers all of
// `.github/workflows/*.yml`, not just the file that was missing it.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const WORKFLOWS_DIR = path.join(REPO_ROOT, '.github/workflows');

/** Read a workflow file with LF normalized (a local copy can linger as CRLF). */
function readWorkflow(file) {
  return fs.readFileSync(path.join(WORKFLOWS_DIR, file), 'utf8').replace(/\r\n/g, '\n');
}

/**
 * Every job in a workflow file, with the raw text of its body. Same small shape
 * as the workflow-contract suites: a job is a 2-space-indented mapping key
 * under a top-level `jobs:` key.
 *
 * @param {string} text a workflow file
 * @returns {{name: string; body: string}[]}
 */
export function workflowJobs(text) {
  const lines = text.split('\n');
  const jobsStart = lines.findIndex(line => /^jobs:[ \t]*$/.test(line));
  if (jobsStart === -1) return [];
  /** @type {{name: string; body: string[]}[]} */
  const jobs = [];
  for (let i = jobsStart + 1; i < lines.length; i++) {
    const header = lines[i].match(/^ {2}([A-Za-z0-9_-]+):[ \t]*$/);
    if (header) {
      jobs.push({name: header[1], body: []});
      continue;
    }
    jobs.at(-1)?.body.push(lines[i]);
  }
  return jobs.map(job => ({name: job.name, body: job.body.join('\n')}));
}

/**
 * Jobs without a `timeout-minutes:` key at the job indentation (4 spaces). A
 * step-level key (6+ spaces) must not satisfy the check — only the job-level
 * timeout bounds the whole job.
 *
 * @param {{name: string; body: string}[]} jobs
 * @returns {string[]}
 */
export function missingTimeoutViolations(jobs) {
  return jobs.filter(job => !/^ {4}timeout-minutes:[ \t]*\S+/m.test(job.body)).map(job => job.name);
}

test('every job in every workflow sets timeout-minutes', () => {
  const files = fs
    .readdirSync(WORKFLOWS_DIR)
    .filter(file => file.endsWith('.yml'))
    .sort();
  assert.ok(files.length > 0, 'expected workflow files — the directory shape changed');
  const failures = files.flatMap(file =>
    missingTimeoutViolations(workflowJobs(readWorkflow(file))).map(job => `${file} / ${job}`)
  );
  assert.deepEqual(failures, [], failures.join('\n'));
});

test('missingTimeoutViolations: a job without the key is a violation', () => {
  const fixture = [
    'jobs:',
    '  gate:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: node foo.mjs',
  ].join('\n');
  assert.deepEqual(missingTimeoutViolations(workflowJobs(fixture)), ['gate']);

  const fixed = fixture.replace(
    '    runs-on: ubuntu-latest',
    '    runs-on: ubuntu-latest\n    timeout-minutes: 10'
  );
  assert.deepEqual(missingTimeoutViolations(workflowJobs(fixed)), []);
});

test('missingTimeoutViolations: a step-level key does not satisfy the check', () => {
  // `timeout-minutes` is a job-level key; a step that happens to carry the
  // words deeper-indented must not vacate the contract.
  const fixture = [
    'jobs:',
    '  gate:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: echo timeout-minutes: 10',
  ].join('\n');
  assert.deepEqual(missingTimeoutViolations(workflowJobs(fixture)), ['gate']);
});
