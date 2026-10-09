// test/unit/tools/browserCacheSaveScope.test.mjs — the ref-scope contract for
// the browser payload caches.
//
// GitHub scopes every cache entry to the ref of the run that wrote it: a
// `pull_request` run writes into `refs/pull/<n>/merge`, and the docs are
// explicit that such an entry "can only be restored by re-runs of the pull
// request. It cannot be restored by the base branch or other pull requests"
// (dependency-caching reference, "Cache access for low-trust workflow
// triggers" / "Restrictions for accessing a cache"). Reads are one-way the
// other way around: a run restores from its own ref first and then falls
// through to the default branch.
//
// So a PR-ref entry is a private copy that dies with the PR. `setup-browser`
// saved both payloads with a bare `if: success()`, on every event — measured
// 2026-10-09 (issue #462 family): 34 of the repo's 58 entries / 4.27 GB of
// 6.57 GB were PR-scoped, and each open PR added a fresh set. The two halves
// below are the whole contract:
//
//   1. a SAVE runs on the default branch only (ADR 0044);
//   2. a RESTORE is never ref-guarded — a PR leg must still find main's entry
//      through the default-branch fallback, which is what makes (1) affordable.
//
// The e2e.yml recorders are covered too: their saves are legitimate (main's
// publish pre-flight reads them through a restore-key prefix), but only
// because their jobs cannot run on a PR ref. A third payload cache added to
// either file has to say where it writes.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const ACTION = path.join(ROOT, '.github', 'actions', 'setup-browser', 'action.yml');
const E2E = path.join(ROOT, '.github', 'workflows', 'e2e.yml');

/** Read a tracked text file with LF normalized (a local copy can linger CRLF). */
function read(file) {
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

/** Drop whole-line YAML/shell comments so prose can never satisfy a check. */
function stripComments(text) {
  return text
    .split('\n')
    .filter(line => !/^[ \t]*#/.test(line))
    .join('\n');
}

/** One block per composite step (` -` at the steps indentation). */
function stepBlocks(text) {
  return stripComments(text)
    .split(/^ {4}- /m)
    .slice(1);
}

/** The steps of a composite action that run `actions/cache/restore|save`. */
function cacheSteps(text, kind) {
  return stepBlocks(text).filter(b => b.includes(`actions/cache/${kind}@`));
}

/**
 * A composite step's `if:` expression, or '' when it has none (a step with no
 * condition runs on every event).
 *
 * @param {string} block one step block from {@link stepBlocks}
 * @returns {string}
 */
function ifExpression(block) {
  const lines = block.split('\n');
  const at = lines.findIndex(l => /^\s+if:/.test(l));
  if (at === -1) return '';
  const indent = lines[at].match(/^\s*/)[0].length;
  const parts = [lines[at].replace(/^\s*if:\s*/, '')];
  // A folded `if:` (`>-` or a bare expression) continues on more-indented
  // lines; stop at the next sibling key.
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (line.match(/^\s*/)[0].length <= indent) break;
    parts.push(line.trim());
  }
  return parts.join(' ').trim();
}

/** Whether an `if:` expression limits the step to the default branch. */
const MAIN_ONLY = /github\.ref == 'refs\/heads\/main'/;

/**
 * Save steps that are not restricted to the default branch. Returning the
 * violation (rather than a boolean) lets the failure name the step.
 *
 * @param {string} text an action file's text
 * @returns {string[]} the offending save steps' names
 */
/** A step block's `name:`, or a placeholder when it has none. */
function stepName(block) {
  return (block.match(/name:\s*(.+)/)?.[1] ?? 'unnamed step').trim();
}

function unguardedSaves(text) {
  return cacheSteps(text, 'save')
    .filter(b => !MAIN_ONLY.test(ifExpression(b)))
    .map(stepName);
}

/**
 * e2e.yml jobs that save a cache but cannot prove they never run on a PR ref.
 * The recorder jobs are gated by event name, the intended main-only shape by
 * ref; either satisfies the contract.
 *
 * @param {string} text the workflow's text
 * @returns {string[]} the offending job names
 */
function prReachableSaveJobs(text) {
  const nonPr =
    /github\.ref == 'refs\/heads\/main'|github\.event_name != 'pull_request'|github\.event_name == 'workflow_dispatch'/;
  const jobs = stripComments(text).split(/^ {2}([a-z][\w-]*):$/m);
  const offenders = [];
  // The split alternates name, body, name, body, … — the leading slice is the
  // pre-`jobs:` text.
  for (let i = 1; i < jobs.length; i += 2) {
    const [name, body] = [jobs[i], jobs[i + 1] ?? ''];
    if (!/actions\/cache\/save@/.test(body)) continue;
    if (!nonPr.test(body)) offenders.push(name);
  }
  return offenders;
}

const action = read(ACTION);
const e2e = read(E2E);

test('every setup-browser cache save is restricted to the default branch', () => {
  const saves = cacheSteps(action, 'save').map(stepName);
  // Both payloads (the installer and the extracted portable dir) are saved.
  assert.deepEqual(saves, [
    'Save browser installer cache',
    'Save extracted portable browser cache',
  ]);
  assert.deepEqual(unguardedSaves(action), []);
});

test('no setup-browser cache restore is ref-guarded', () => {
  // The PR path *depends* on the default-branch fallback; a restore that only
  // ran on main would leave every PR leg cold even with main warm.
  const restores = cacheSteps(action, 'restore');
  assert.ok(restores.length >= 4, `expected the installer/dir restores, found ${restores.length}`);
  for (const block of restores) {
    assert.doesNotMatch(
      ifExpression(block),
      MAIN_ONLY,
      `restore step must not be main-only:\n${block.slice(0, 120)}`
    );
  }
});

test('the detector fires on an unguarded save and passes a guarded one', () => {
  const unguarded = [
    'runs:',
    '  using: composite',
    '  steps:',
    '    - name: Save browser installer cache',
    '      if: success()',
    '      uses: actions/cache/save@deadbeef # v6.1.0',
    '      with:',
    '        path: x',
    '        key: y',
  ].join('\n');
  assert.deepEqual(unguardedSaves(unguarded), ['Save browser installer cache']);

  const guarded = unguarded
    .replace('if: success()', "if: success() && github.ref == 'refs/heads/main'")
    .replace('Save browser installer cache', 'Save browser installer cache');
  assert.deepEqual(unguardedSaves(guarded), []);

  const noCondition = unguarded.replace('      if: success()\n', '');
  assert.deepEqual(unguardedSaves(noCondition), ['Save browser installer cache']);
});

test('every e2e.yml cache save is unreachable from a PR ref', () => {
  assert.deepEqual(prReachableSaveJobs(e2e), []);
});

test('the e2e job scanner fires on a PR-reachable save', () => {
  const fixture = [
    'jobs:',
    '  some-job:',
    '    if: always()',
    '    steps:',
    '      - uses: actions/cache/save@deadbeef # v6.1.0',
    '  gated-job:',
    "    if: github.event_name != 'pull_request'",
    '    steps:',
    '      - uses: actions/cache/save@deadbeef # v6.1.0',
  ].join('\n');
  assert.deepEqual(prReachableSaveJobs(fixture), ['some-job']);
});
