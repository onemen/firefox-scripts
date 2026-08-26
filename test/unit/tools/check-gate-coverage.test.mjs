// test/unit/tools/check-gate-coverage.test.mjs — Unit tests for the static
// gate-contract checker (tools/check-gate-coverage.mjs). The real workflow
// files are asserted by `pnpm check:gates` itself; these tests pin the parser
// and the contract rules with fixtures.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const scriptUrl = pathToFileURL(path.join(REPO_ROOT, 'tools', 'check-gate-coverage.mjs')).href;
const {checkWorkflow, parseJobs} = await import(scriptUrl);

const FIXTURE = `name: X
on:
  pull_request:
jobs:
  # ── filter ──
  changes:
    name: detect changed paths
    outputs:
      e2e: \${{ steps.filter.outputs.e2e }}
    steps:
      - uses: actions/checkout
        if: runner.os == 'Windows'
  snapshot:
    needs: changes
    if: needs.changes.outputs.e2e == 'true'
    runs-on: ubuntu-latest
  installer:
    needs: changes
    if: needs.changes.outputs.e2e == 'true'
    runs-on: ubuntu-latest
  e2e-gate:
    name: E2E gate
    if: always()
    needs: [changes, snapshot, installer]
    steps:
      - run: echo ok
`;

test('parseJobs: collects job names, job-level needs + if, ignores step-level if', () => {
  const jobs = parseJobs(FIXTURE);
  assert.deepEqual([...jobs.keys()], ['changes', 'snapshot', 'installer', 'e2e-gate']);
  // Step-level if (8-space) is NOT a job-level if.
  assert.deepEqual(jobs.get('changes').ifs, []);
  assert.deepEqual(jobs.get('installer').ifs, ["needs.changes.outputs.e2e == 'true'"]);
  assert.deepEqual(jobs.get('installer').needs, ['changes']);
  assert.deepEqual(jobs.get('e2e-gate').ifs, ['always()']);
  assert.deepEqual(jobs.get('e2e-gate').needs, ['changes', 'snapshot', 'installer']);
});

test('checkWorkflow: a compliant workflow passes', () => {
  const errors = checkWorkflow(FIXTURE, {
    file: 'e2e.yml',
    gate: 'e2e-gate',
    branchKey: 'e2e',
    gated: ['snapshot', 'installer'],
  });
  assert.deepEqual(errors, []);
});

test('checkWorkflow: job missing from gate needs is flagged', () => {
  const broken = FIXTURE.replace(
    'needs: [changes, snapshot, installer]',
    'needs: [changes, snapshot]'
  );
  const errors = checkWorkflow(broken, {
    file: 'e2e.yml',
    gate: 'e2e-gate',
    branchKey: 'e2e',
    gated: ['snapshot', 'installer'],
  });
  assert.ok(errors.some(e => e.includes('installer') && e.includes('bypass the gate')));
});

test('checkWorkflow: a gated job that lost its filter if is flagged', () => {
  const broken = FIXTURE.replace(
    "  installer:\n    needs: changes\n    if: needs.changes.outputs.e2e == 'true'",
    '  installer:\n    needs: changes'
  );
  const errors = checkWorkflow(broken, {
    file: 'e2e.yml',
    gate: 'e2e-gate',
    branchKey: 'e2e',
    gated: ['snapshot', 'installer'],
  });
  assert.ok(
    errors.some(e =>
      e.includes("must carry the path-filter 'if: needs.changes.outputs.e2e == 'true''")
    )
  );
});

test('checkWorkflow: an always-report job must not gain a job-level if', () => {
  const withIf = FIXTURE.replace(
    '  snapshot:\n    needs: changes',
    "  snapshot:\n    needs: changes\n    if: needs.changes.outputs.e2e == 'true'"
  );
  const errors = checkWorkflow(withIf, {
    file: 'ci.yml',
    gate: 'e2e-gate',
    branchKey: 'publish',
    noJobIf: ['snapshot'],
  });
  assert.ok(errors.some(e => e.includes('snapshot') && e.includes('always-report design')));
});

test('checkWorkflow: gate without if: always() is flagged', () => {
  const broken = FIXTURE.replace('    if: always()\n', '');
  const errors = checkWorkflow(broken, {
    file: 'e2e.yml',
    gate: 'e2e-gate',
    branchKey: 'e2e',
    gated: ['snapshot', 'installer'],
  });
  assert.ok(errors.some(e => e.includes("must carry 'if: always()'")));
});
