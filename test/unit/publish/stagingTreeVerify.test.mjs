// test/unit/publish/stagingTreeVerify.test.mjs — the staging-tree
// completeness contract between pass 1 and the single writer of the two-pass
// publish (build-and-upload.yml, P2-16 / audit 2026-10-06 §6.6).
//
// The check is an inline `node -e` step: it re-reads what a staged publish
// would ship (the union of every build leg's build-manifest.*.json against
// dist/.build) and must fail the run BY ASSET NAME when a staged file is
// missing. Because the logic lives inside YAML, a regression that deletes or
// mangles the step surfaces only as a publish that silently ships an
// incomplete binary set — every other contract stays green.
//
// So these tests extract THE REAL step out of the workflow (presence is
// itself asserted, and it must run before the pass-2 publish step) and
// execute its script against fixture trees:
//
//   - complete tree → exit 0, every asset listed;
//   - a missing staged file → exit 1, stderr names the missing asset;
//   - no manifests at all (idle publish) → exit 0.

import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

import {load} from 'js-yaml';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'build-and-upload.yml');
const VERIFY_STEP = 'Verify staging tree';
const PUBLISH_STEP = 'Publish (pass 2';

// test-hygiene: every mkdtemp root created here is removed by the sweep.
const tempRoots = [];
after(() => {
  for (const root of tempRoots) fs.rmSync(root, {recursive: true, force: true});
});

/**
 * Locate the Verify staging tree step in its job (jobId, step list, index).
 * Returns null when the step was deleted or renamed — the contract itself.
 */
function findVerifyStep() {
  const doc = load(fs.readFileSync(WORKFLOW, 'utf8').replace(/\r\n/g, '\n'));
  for (const [jobId, job] of Object.entries(doc.jobs ?? {})) {
    const steps = job.steps ?? [];
    const index = steps.findIndex(s => s && s.name === VERIFY_STEP);
    if (index !== -1) return {jobId, steps, index, step: steps[index]};
  }
  return null;
}

/**
 * The step's inline `node -e` JavaScript, extracted from the workflow (fails
 * the test with a shape message if the step stops being a node -e invocation).
 *
 * @returns {{found: object; js: string}}
 */
function verifyScript() {
  const found = findVerifyStep();
  assert.ok(
    found,
    `build-and-upload.yml has no '${VERIFY_STEP}' step — the staging completeness check was removed or renamed`
  );
  const run = String(found.step.run ?? '').trim();
  const prefix = 'node -e "';
  assert.ok(
    run.startsWith(prefix) && run.endsWith('"'),
    `the '${VERIFY_STEP}' step is no longer a plain node -e invocation — update this extraction: ${run.slice(0, 80)}`
  );
  return {found, js: run.slice(prefix.length, -1)};
}

/**
 * Run the extracted script against a fixture staging tree in a tmp dir.
 *
 * @param {string} js
 * @param {{manifests?: Record<string, object>; files?: string[]}} fixture
 */
function runVerify(js, {manifests = {}, files = []} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'staging-verify-'));
  tempRoots.push(root);
  const buildDir = path.join(root, 'dist', '.build');
  fs.mkdirSync(buildDir, {recursive: true});
  for (const [name, manifest] of Object.entries(manifests)) {
    fs.writeFileSync(path.join(buildDir, name), JSON.stringify(manifest));
  }
  for (const relPath of files) {
    const target = path.join(buildDir, relPath);
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.writeFileSync(target, 'fixture staged bytes');
  }
  const res = spawnSync(process.execPath, ['-e', js], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (res.error) throw res.error;
  return {status: res.status, stdout: res.stdout || '', stderr: res.stderr || ''};
}

const MANIFESTS = {
  'build-manifest.win.json': {
    files: [
      {relPath: 'installer/installer_win.exe', asset: 'installer_win.exe'},
      {relPath: 'helper/helper_win.exe', asset: 'helper_win.exe'},
    ],
  },
  'build-manifest.linux.json': {
    files: [{relPath: 'scripts/scripts.zip', asset: 'scripts.zip'}],
  },
};
const STAGED_FILES = [
  'installer/installer_win.exe',
  'helper/helper_win.exe',
  'scripts/scripts.zip',
];

test('the workflow ships the verify step, and it runs before the pass-2 publish', () => {
  const {found} = verifyScript();
  const publishIdx = found.steps.findIndex(s => s && String(s.name).startsWith(PUBLISH_STEP));
  assert.ok(publishIdx !== -1, `job ${found.jobId} has no '${PUBLISH_STEP}…' step`);
  assert.ok(
    found.index < publishIdx,
    `job ${found.jobId}: '${VERIFY_STEP}' must run before the pass-2 publish step`
  );
});

test('complete staging tree → exit 0, every asset listed', () => {
  const {js} = verifyScript();
  const {status, stdout} = runVerify(js, {manifests: MANIFESTS, files: STAGED_FILES});
  assert.equal(status, 0, stdout);
  assert.match(stdout, /staging tree complete:/);
  for (const asset of ['installer_win.exe', 'helper_win.exe', 'scripts.zip']) {
    assert.ok(stdout.includes(asset), `stdout must list ${asset}`);
  }
});

test('a missing staged file fails the run BY ASSET NAME', () => {
  const {js} = verifyScript();
  const {status, stderr} = runVerify(js, {
    manifests: MANIFESTS,
    files: STAGED_FILES.filter(f => f !== 'helper/helper_win.exe'),
  });
  assert.equal(status, 1, 'an incomplete staging tree must fail the publish');
  assert.match(stderr, /staged files missing after artifact merge/);
  assert.match(stderr, /helper_win\.exe/, 'stderr must name the missing asset');
});

test('no manifests at all (idle publish) → exit 0', () => {
  const {js} = verifyScript();
  const {status, stdout} = runVerify(js);
  assert.equal(status, 0, stdout);
  assert.match(stdout, /no rebuilt binaries — idle publish/);
});
