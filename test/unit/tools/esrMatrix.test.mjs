// test/unit/tools/esrMatrix.test.mjs — the meta-issue-marker fallback contract:
// ESR_WATCHDOG_MARKERS is ONE issue body, parsed whole. Splitting
// it shredded the comma-keyed marker JSON and the wipe fallback (#462) always
// degraded to the generic serving-ESR leg — pinned as a live-process contract
// (the script decides from process.env, so the tests exec it).

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const TOOL = path.join(ROOT, 'tools', 'ci', 'esrMatrix.mjs');

/**
 * Run esrMatrix.mjs with NO baseline (the wipe shape) and one env marker.
 *
 * @returns {{stdout: string}}
 */
function runWithMarker(marker) {
  const stdout = execFileSync(
    process.execPath,
    [TOOL, path.join(ROOT, 'definitely', 'not', 'here.json')],
    {
      encoding: 'utf8',
      env: {...process.env, ESR_WATCHDOG_MARKERS: marker},
      cwd: ROOT,
    }
  );
  return {stdout};
}

/**
 * Same run, capturing both streams (stdout must stay pure matrix JSON, so the
 * tier-3 marker can only live on stderr).
 *
 * @returns {{stdout: string; stderr: string}}
 */
function runTool(marker) {
  const run = spawnSync(
    process.execPath,
    [TOOL, path.join(ROOT, 'definitely', 'not', 'here.json')],
    {
      encoding: 'utf8',
      env: {...process.env, ESR_WATCHDOG_MARKERS: marker},
      cwd: ROOT,
    }
  );
  assert.equal(run.status, 0, `esrMatrix.mjs must stay green: ${run.stderr}`);
  return {stdout: run.stdout, stderr: run.stderr};
}

// A comma INSIDE the marker JSON is the exact input that shredded the old
// comma-split: the workflow passes the whole issue body, and a JSON body
// comma-survives only when parsed whole.
const BODY_WITH_COMMAS = [
  'prose with, a comma',
  '',
  '<!-- watchdog:data',
  '{"esr":{"majors":[140,153],"versions":{"140":"140.14.0esr","153":"153.3.1esr"}}}',
  '-->',
].join('\n');

test('ESR_WATCHDOG_MARKERS: the whole issue body parses despite commas inside it', () => {
  const {stdout} = runWithMarker(BODY_WITH_COMMAS);
  assert.deepEqual(JSON.parse(stdout), ['firefox-esr-140', 'firefox-esr-153']);
});

test('ESR_WATCHDOG_MARKERS: no parseable marker degrades to the generic serving-ESR leg', () => {
  const {stdout} = runWithMarker('a body without any marker block');
  assert.deepEqual(JSON.parse(stdout), ['firefox-esr']);
});

test('ESR_WATCHDOG_MARKERS: empty env degrades to the generic serving-ESR leg', () => {
  const {stdout} = runWithMarker('');
  assert.deepEqual(JSON.parse(stdout), ['firefox-esr']);
});

test('tier-3 fallback carries a stable machine-parsable stderr marker', () => {
  // #507: the workflow surfaces tier-3 as a ::warning:: by grepping stderr
  // for this marker — stdout must stay pure matrix JSON, so the marker can
  // only live on stderr. Both tier-3 paths (unparseable marker, empty env)
  // must emit it; a healthy tier-1/2 run must not.
  for (const marker of ['a body without any marker block', '']) {
    const {stderr} = runTool(marker);
    assert.match(stderr, /esr-matrix: tier-3 generic fallback/);
  }
  const {stderr} = runTool(BODY_WITH_COMMAS);
  assert.doesNotMatch(stderr, /esr-matrix: tier-3 generic fallback/);
});

test('e2e.yml surfaces the tier-3 fallback as a workflow warning', () => {
  // The coupling #507 exists for: the tool can only warn on stderr (stdout
  // is the matrix JSON), so the workflow must bridge the marker to a
  // ::warning:: — otherwise the marker warns into the void and the run still
  // looks clean-green.
  const e2e = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'e2e.yml'), 'utf8');
  assert.match(e2e, /grep -q "esr-matrix: tier-3"/);
  assert.match(e2e, /::warning::esr-matrix is on the tier-3 generic fallback/);
});
