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

// Fixture mirrors the independent-filter e2e workflow: separate
// installer/updater/core outputs, per-job `if:`s, and an `applicability:`
// block in the gate.
const FIXTURE = `name: X
on:
  pull_request:
jobs:
  # ── filter ──
  changes:
    name: detect changed paths
    outputs:
      installer: \${{ steps.filter.outputs.installer }}
      updater: \${{ steps.filter.outputs.updater }}
      core: \${{ steps.filter.outputs.core }}
    steps:
      - uses: actions/checkout
        if: runner.os == 'Windows'
  snapshot:
    needs: changes
    if: needs.changes.outputs.updater == 'true' || needs.changes.outputs.core == 'true'
    runs-on: ubuntu-latest
  installer:
    needs: changes
    if: needs.changes.outputs.installer == 'true'
    runs-on: ubuntu-latest
  e2e-gate:
    name: E2E gate
    if: always()
    needs: [changes, snapshot, installer]
    steps:
      - uses: actions/checkout
      - uses: ./.github/actions/verify-gate
        with:
          changes-result: \${{ needs.changes.result }}
          branch: \${{ needs.changes.outputs.installer == 'true' || needs.changes.outputs.updater == 'true' || needs.changes.outputs.core == 'true' }}
          branch-label: E2E-relevant changes
          applicability: |-
            snapshot:\${{ needs.changes.outputs.updater == 'true' || needs.changes.outputs.core == 'true' }}
            installer:\${{ needs.changes.outputs.installer == 'true' }}
          results: |-
            snapshot:\${{ needs.snapshot.result }}
            installer:\${{ needs.installer.result }}
          required: snapshot installer
          skip-guard: snapshot installer
`;

const CONTRACT = {
  file: 'e2e.yml',
  gate: 'e2e-gate',
  gatedIfs: {
    snapshot: "needs.changes.outputs.updater == 'true' || needs.changes.outputs.core == 'true'",
    installer: "needs.changes.outputs.installer == 'true'",
  },
  applicability: ['snapshot', 'installer'],
};

test('parseJobs: collects job names, needs, ifs, and the verify-gate with block', () => {
  const jobs = parseJobs(FIXTURE);
  assert.deepEqual([...jobs.keys()], ['changes', 'snapshot', 'installer', 'e2e-gate']);
  // Step-level if (8-space) is NOT a job-level if.
  assert.deepEqual(jobs.get('changes').ifs, []);
  assert.deepEqual(jobs.get('installer').ifs, ["needs.changes.outputs.installer == 'true'"]);
  assert.deepEqual(jobs.get('installer').needs, ['changes']);
  assert.deepEqual(jobs.get('e2e-gate').ifs, ['always()']);
  assert.deepEqual(jobs.get('e2e-gate').needs, ['changes', 'snapshot', 'installer']);
  assert.deepEqual(jobs.get('e2e-gate').with.results, ['snapshot', 'installer']);
  assert.deepEqual(jobs.get('e2e-gate').with.applicability, ['snapshot', 'installer']);
  assert.equal(jobs.get('e2e-gate').with.required, 'snapshot installer');
  assert.equal(jobs.get('e2e-gate').with['skip-guard'], 'snapshot installer');
});

test('checkWorkflow: a compliant workflow passes', () => {
  const errors = checkWorkflow(FIXTURE, CONTRACT);
  assert.deepEqual(errors, []);
});

test('checkWorkflow: job missing from gate needs is flagged', () => {
  const broken = FIXTURE.replace(
    'needs: [changes, snapshot, installer]',
    'needs: [changes, snapshot]'
  );
  const errors = checkWorkflow(broken, CONTRACT);
  assert.ok(errors.some(e => e.includes('installer') && e.includes('bypass the gate')));
});

test('checkWorkflow: a gated job that lost its filter if is flagged', () => {
  const broken = FIXTURE.replace(
    "  installer:\n    needs: changes\n    if: needs.changes.outputs.installer == 'true'",
    '  installer:\n    needs: changes'
  );
  const errors = checkWorkflow(broken, CONTRACT);
  assert.ok(
    errors.some(e =>
      e.includes("must carry the path-filter 'if: needs.changes.outputs.installer == 'true''")
    )
  );
});

test('checkWorkflow: an always-report job must not gain a job-level if', () => {
  const withIf = FIXTURE.replace(
    '  snapshot:\n    needs: changes',
    "  snapshot:\n    needs: changes\n    if: needs.changes.outputs.installer == 'true'"
  );
  const errors = checkWorkflow(withIf, {
    file: 'ci.yml',
    gate: 'e2e-gate',
    noJobIf: ['snapshot'],
  });
  assert.ok(errors.some(e => e.includes('snapshot') && e.includes('always-report design')));
});

test('checkWorkflow: gate without if: always() is flagged', () => {
  const broken = FIXTURE.replace('    if: always()\n', '');
  const errors = checkWorkflow(broken, CONTRACT);
  assert.ok(errors.some(e => e.includes("must carry 'if: always()'")));
});

test('checkWorkflow: a needed job absent from verify-gate results is flagged', () => {
  const broken = FIXTURE.replace('snapshot:${{ needs.snapshot.result }}\n', '');
  const errors = checkWorkflow(broken, CONTRACT);
  assert.ok(
    errors.some(e => e.includes("needs 'snapshot'") && e.includes('results do not include it'))
  );
});

test('checkWorkflow: an unclassified results job is flagged', () => {
  const broken = FIXTURE.replace(
    'required: snapshot installer\n          skip-guard: snapshot installer',
    'required: installer\n          skip-guard: installer'
  );
  const errors = checkWorkflow(broken, CONTRACT);
  assert.ok(
    errors.some(e => e.includes("results include 'snapshot'") && e.includes('not classified'))
  );
});

test('checkWorkflow: a classified job absent from results is flagged', () => {
  const broken = FIXTURE.replace(
    'skip-guard: snapshot installer',
    'skip-guard: snapshot installer builder'
  );
  const errors = checkWorkflow(broken, CONTRACT);
  assert.ok(
    errors.some(
      e => e.includes("classifies 'builder'") && e.includes('not in the verify-gate results')
    )
  );
});

test('checkWorkflow: an applicability block missing a filtered job is flagged', () => {
  const broken = FIXTURE.replace(
    "            installer:${{ needs.changes.outputs.installer == 'true' }}\n",
    ''
  );
  const errors = checkWorkflow(broken, CONTRACT);
  assert.ok(errors.some(e => e.includes("applicability block is missing 'installer'")));
});

test('checkWorkflow: a gate step that no longer uses verify-gate is flagged', () => {
  const broken = FIXTURE.replace(
    '- uses: ./.github/actions/verify-gate',
    '- uses: ./.github/actions/some-other-gate'
  );
  const errors = checkWorkflow(broken, CONTRACT);
  assert.ok(errors.some(e => e.includes('must use ./.github/actions/verify-gate exactly once')));
});

test('parseJobs: with: blocks belonging to other actions are not collected', () => {
  // A `with:` block on a non-verify-gate step (checkout's fetch-depth) inside
  // the gate job must never be read as gate wiring.
  const mixed = FIXTURE.replace(
    '      - uses: actions/checkout\n      - uses: ./.github/actions/verify-gate',
    '      - uses: actions/checkout\n        with:\n          fetch-depth: 0\n      - uses: ./.github/actions/verify-gate'
  );
  const jobs = parseJobs(mixed);
  assert.equal(jobs.get('e2e-gate').with['fetch-depth'], undefined);
  // The verify-gate step's own wiring is untouched by the skipped block.
  assert.deepEqual(jobs.get('e2e-gate').with.results, ['snapshot', 'installer']);
  assert.equal(jobs.get('e2e-gate').with.required, 'snapshot installer');
  assert.equal(jobs.get('e2e-gate').verifyGateUses, 1);
});

test('parseJobs: counts verify-gate uses per job', () => {
  const jobs = parseJobs(FIXTURE);
  assert.equal(jobs.get('e2e-gate').verifyGateUses, 1);
  assert.equal(jobs.get('changes').verifyGateUses, 0);
  assert.equal(jobs.get('snapshot').verifyGateUses, 0);
});

// ── post-gate contract (#4): jobs that run AFTER the gate (need it) are
// exempt from needs-coverage but pinned by their own rules.
const WITH_POST_GATE = FIXTURE.replace(
  '  e2e-gate:',
  `  record-validation:\n    needs: e2e-gate\n    if: always()\n    runs-on: ubuntu-latest\n  e2e-gate:`
);
const POST_GATE_CONTRACT = {...CONTRACT, postGate: ['record-validation']};

test('checkWorkflow: a post-gate job (needs the gate) passes needs-coverage', () => {
  // Without the postGate exemption the recorder would be flagged as bypassing
  // the gate (it is deliberately NOT in the gate's needs).
  const exempt = checkWorkflow(WITH_POST_GATE, POST_GATE_CONTRACT);
  assert.deepEqual(exempt, []);
  const flagged = checkWorkflow(WITH_POST_GATE, CONTRACT);
  assert.ok(flagged.some(e => e.includes('record-validation') && e.includes('bypass the gate')));
});

test('checkWorkflow: a post-gate job must exist', () => {
  const errors = checkWorkflow(FIXTURE, POST_GATE_CONTRACT);
  assert.ok(errors.some(e => e.includes("post-gate job 'record-validation' not found")));
});

test('checkWorkflow: a post-gate job must need the gate', () => {
  const broken = WITH_POST_GATE.replace(
    '  record-validation:\n    needs: e2e-gate',
    '  record-validation:'
  );
  const errors = checkWorkflow(broken, POST_GATE_CONTRACT);
  assert.ok(errors.some(e => e.includes("'record-validation' must need 'e2e-gate'")));
});

test('checkWorkflow: a post-gate job in the gate needs would be a cycle', () => {
  const cyclic = WITH_POST_GATE.replace(
    'needs: [changes, snapshot, installer]',
    'needs: [changes, snapshot, installer, record-validation]'
  );
  const errors = checkWorkflow(cyclic, POST_GATE_CONTRACT);
  assert.ok(errors.some(e => e.includes('record-validation') && e.includes('cycle')));
});

test('checkWorkflow: a post-gate job in verify-gate results is rejected', () => {
  const broken = WITH_POST_GATE.replace(
    '            snapshot:${{ needs.snapshot.result }}',
    '            snapshot:${{ needs.snapshot.result }}\n            record-validation:${{ needs.record-validation.result }}'
  );
  const errors = checkWorkflow(broken, POST_GATE_CONTRACT);
  assert.ok(
    errors.some(e => e.includes("results must not include post-gate job 'record-validation'"))
  );
});
