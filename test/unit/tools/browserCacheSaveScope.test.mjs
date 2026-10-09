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
// "A save" includes the IMPLICIT one: plain `actions/cache@` restores and then
// saves in a post-job step of its own, with no `if:` a ref guard could ride on.
// That is how the snap payload kept writing on PR refs after the explicit saves
// were guarded — measured 2026-10-09: 236 MB of `snap-firefox-9036` on
// `refs/pull/489/merge`. So the scanner counts any `actions/cache@` as a save
// site, and a job passes only when its saves declare their scope: a job-level
// non-PR guard, or a main-only `if:` on EVERY save step (one unguarded sibling
// is enough to write on a PR ref, so a guarded save beside it must not launder
// the job).
//
// The e2e.yml recorders are covered too: their saves are legitimate (main's
// publish pre-flight reads them through a restore-key prefix), but only
// because their jobs cannot run on a PR ref. A further payload cache added to
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

/**
 * The steps of a composite action that run `actions/cache/restore|save`. Only
 * valid for the composite: it splits on 4-space list items, which is a
 * composite action's step indent (a workflow job indents steps 6 spaces) —
 * {@link cacheStepsAt} is the shape that works on both.
 */
function cacheSteps(text, kind) {
  return stepBlocks(text).filter(b => b.includes(`actions/cache/${kind}@`));
}

/** One block per composite step (` -` at the steps indentation). */
function stepBlocks(text) {
  return stripComments(text)
    .split(/^ {4}- /m)
    .slice(1);
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
  // A folded (`>-`) or literal (`|`) block marker is not part of the
  // expression: a job-level `if: >-` condition otherwise starts with `>-`, and
  // no expression-level pattern could match it.
  const parts = [lines[at].replace(/^\s*if:\s*/, '').replace(/^[>|][+-]?\s*/, '')];
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

/** A step's `name:`, or a placeholder when it has none. */
function stepName(block) {
  return (block.match(/name:\s*(.+)/)?.[1] ?? 'unnamed step').trim();
}

/**
 * Every step that WRITES a cache entry — an explicit `actions/cache/save@`, or
 * the combined `actions/cache@` whose post-job step saves implicitly — as the
 * step's own text, so its `if:` can be read.
 *
 * Indentation-agnostic on purpose: the step is grown out from the `uses:` line
 * back to its `- ` item and forward to the first line indented at or above that
 * item, which is where a step ends in a composite action (steps at 4 spaces)
 * and in a workflow job (steps at 6) alike.
 *
 * @param {string} text an action's or workflow job's text
 * @returns {string[]} the step blocks
 */
function cacheSaveSteps(text) {
  return cacheStepsAt(text, /actions\/cache(?:@|\/save@)/);
}

/**
 * The `actions/cache/restore@` steps in a composite action or workflow job.
 *
 * @param {string} text
 * @returns {string[]}
 */
function cacheRestoreSteps(text) {
  return cacheStepsAt(text, /actions\/cache\/restore@/);
}

/**
 * The steps whose `uses:` matches `usesRe`, as step blocks (see
 * {@link cacheSaveSteps}).
 *
 * @param {string} text
 * @param {RegExp} usesRe a regex the `uses:` line must match
 * @returns {string[]}
 */
function cacheStepsAt(text, usesRe) {
  const lines = stripComments(text).split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    if (!usesRe.test(lines[i])) continue;
    let start = i;
    while (start > 0 && !/^ *- /.test(lines[start])) start--;
    const indent = lines[start].match(/^ */)[0].length;
    let end = i + 1;
    while (end < lines.length) {
      const line = lines[end];
      if (line.trim() !== '' && line.match(/^ */)[0].length <= indent) break;
      end++;
    }
    blocks.push(lines.slice(start, end).join('\n'));
  }
  return blocks;
}

/**
 * Save steps that are not restricted to the default branch. Returning the
 * violation (rather than a boolean) lets the failure name the step.
 *
 * @param {string} text an action file's text
 * @returns {string[]} the offending save steps' names
 */
function unguardedSaves(text) {
  return cacheSaveSteps(text)
    .filter(block => !MAIN_ONLY.test(ifExpression(block)))
    .map(stepName);
}

/**
 * A condition whose FIRST conjunct rules out a `pull_request` event — false for
 * a PR run whichever other conjuncts hold, because `&&` binds tighter than `||`
 * and the conjunct is ANDed into the rest of the expression.
 */
const FIRST_CONJUNCT_EXCLUDES_PR =
  /^(?:always\(\) && )?(?:github\.event_name == '(?:workflow_dispatch|schedule|push)'|github\.ref == 'refs\/heads\/main')(?=$| &&)/;

/**
 * Whether a job's own condition proves it never runs on a `pull_request` event,
 * i.e. never writes a `refs/pull/<n>/merge` entry:
 *
 * - an event/ref test as the FIRST conjunct (`always() && github.event_name ==
 *   'workflow_dispatch' && …`, or a `refs/heads/main` ref guard) — see
 *   {@link FIRST_CONJUNCT_EXCLUDES_PR}; or
 * - `github.event_name != 'pull_request'` with no `||` before it: a conjunct of
 *   an AND chain.
 *
 * A bare mention is NOT enough — `github.event_name == 'workflow_dispatch' ||
 * needs.changes.outputs.updater == 'true'` is true on a PR with those paths
 * changed, which is how the snap payload kept saving on PR refs while every
 * explicit save was already guarded.
 *
 * @param {string} head a job's text up to its `steps:`
 * @returns {boolean}
 */
function jobExcludesPullRequests(head) {
  const expr = ifExpression(head).replace(/\s+/g, ' ');
  if (FIRST_CONJUNCT_EXCLUDES_PR.test(expr)) return true;
  const notPr = expr.indexOf("github.event_name != 'pull_request'");
  return notPr !== -1 && !expr.slice(0, notPr).includes('||');
}

/**
 * e2e.yml jobs that save a cache but cannot prove they never run on a PR ref. A
 * job-level guard admits the whole job (the recorder jobs are gated by event
 * name); otherwise every save step in it has to carry a main-only `if:`.
 *
 * @param {string} text the workflow's text
 * @returns {string[]} the offending job names
 */
function prReachableSaveJobs(text) {
  const jobs = stripComments(text).split(/^ {2}([a-z][\w-]*):$/m);
  const offenders = [];
  // The split alternates name, body, name, body, … — the leading slice is the
  // pre-`jobs:` text.
  for (let i = 1; i < jobs.length; i += 2) {
    const [name, body] = [jobs[i], jobs[i + 1] ?? ''];
    const saves = cacheSaveSteps(body);
    if (saves.length === 0) continue;
    // Job-level keys only: a step's `if:` must not stand in for the job's.
    const [head = ''] = body.split(/^\s+steps:/m);
    if (jobExcludesPullRequests(head)) continue;
    if (saves.every(block => MAIN_ONLY.test(ifExpression(block)))) continue;
    offenders.push(name);
  }
  return offenders;
}

const action = read(ACTION);
const e2e = read(E2E);

test('every setup-browser cache save is restricted to the default branch', () => {
  const saves = cacheSaveSteps(action).map(stepName);
  // Both payloads (the installer and the extracted portable dir) are saved, and
  // neither the composite nor this list may grow an implicit `actions/cache@`.
  assert.deepEqual(saves, [
    'Save browser installer cache',
    'Save extracted portable browser cache',
  ]);
  assert.deepEqual(unguardedSaves(action), []);
});

test('the snap payload is saved on the default branch only, restored anywhere', () => {
  const save = cacheSaveSteps(e2e).find(s => stepName(s) === 'Save the snap download');
  assert.ok(save, 'the snap payload saves through an explicit, scopeable step');
  assert.match(ifExpression(save), MAIN_ONLY);
  // ...and it must not run without a resolved revision. The store-down path
  // exits 0 with a seeded older pair, so a save there would write the constant
  // `-store-down-` key — which GitHub never overwrites (the first pair stays
  // forever) and `parseKey` cannot group, so the prefix restore can hand that
  // frozen pair back as the newest seed during an outage.
  assert.match(
    ifExpression(save),
    /steps\.rev\.outputs\.revision != ''/,
    'the store-down fallback must not be saved under a constant key'
  );
  // ...and its restore must stay unguarded: PR legs are meant to live off
  // main's entry through the default-branch fallback.
  const restore = cacheRestoreSteps(e2e).find(
    s => stepName(s) === 'Restore the cached snap download'
  );
  assert.ok(restore, 'the snap payload restores through an explicit restore step');
  assert.doesNotMatch(ifExpression(restore), MAIN_ONLY);
  // The payload is `~/snap-pkg`, which the download step populates — a save
  // that ran before it would cache an empty directory.
  const workflow = stripComments(e2e).split('\n');
  const saveAt = workflow.findIndex(l => /name: Save the snap download/.test(l));
  const downloadAt = workflow.findIndex(l => /name: Download snap \(revision-pinned/.test(l));
  assert.ok(downloadAt !== -1 && saveAt > downloadAt, 'the save follows the download');
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

  // The combined action saves implicitly and is a save site too — the shape
  // the snap payload had while it wrote on PR refs.
  const implicit = unguarded.replace('actions/cache/save@', 'actions/cache@');
  assert.deepEqual(unguardedSaves(implicit), ['Save browser installer cache']);
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
    '  dispatch-job:',
    '    if: >-',
    "      always() && github.event_name == 'workflow_dispatch' && needs.x.result == 'success'",
    '    steps:',
    '      - uses: actions/cache/save@deadbeef # v6.1.0',
    '  or-guarded-job:',
    '    if: >-',
    "      github.event_name == 'schedule' || github.event_name == 'workflow_dispatch' || needs.changes.outputs.core == 'true'",
    '    steps:',
    '      - uses: actions/cache/save@deadbeef # v6.1.0',
  ].join('\n');
  // The OR shape is the snap job's old condition: it mentions a dispatch, and
  // is still true on a PR whose paths match.
  assert.deepEqual(prReachableSaveJobs(fixture), ['some-job', 'or-guarded-job']);
});

test('the job scanner counts an implicit save and an unguarded sibling', () => {
  const fixture = [
    'jobs:',
    '  implicit-job:',
    '    if: always()',
    '    steps:',
    '      - uses: actions/cache@deadbeef # v6.1.0',
    '  step-guarded-job:',
    '    steps:',
    '      - uses: actions/cache/restore@deadbeef # v6.1.0',
    '        with:',
    '          path: x',
    '      - name: Save snap download',
    '        uses: actions/cache/save@deadbeef # v6.1.0',
    "        if: success() && github.ref == 'refs/heads/main'",
    '  half-guarded-job:',
    '    steps:',
    '      - uses: actions/cache/save@deadbeef # v6.1.0',
    "        if: github.ref == 'refs/heads/main'",
    '      - uses: actions/cache@deadbeef # v6.1.0',
  ].join('\n');
  // The implicit save is a save; a main-only sibling does not license an
  // unguarded one beside it; a step-level guard IS enough on its own.
  assert.deepEqual(prReachableSaveJobs(fixture), ['implicit-job', 'half-guarded-job']);
});
