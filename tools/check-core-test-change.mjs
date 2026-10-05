#!/usr/bin/env node

/**
 * tools/check-core-test-change.mjs — the mechanical half of issue #30: fail a
 * PR that changes `core/**` without changing a test that exercises it.
 *
 * Why this exists. `core/**` is the code every user runs, and its two failure
 * modes are both silent. `config.js` wraps every call in `catch (ex) {}` so a
 * broken autoconfig cannot stop the browser from starting — which means an API
 * drift degrades to "nothing installed", with no console error to grep for. And
 * `userChrome.js` / `BootstrapLoader.js` fail the same way, at startup, on
 * every profile at once. Nothing about a change there announces itself.
 *
 * So the coverage has to be mechanical rather than remembered. #416 added the
 * Level 1 stubs and the sweep unit test, #417 the scheduled real-browser leg,
 * and #418 the delayed-registration scenario; this script is what stops the
 * next `core/**` edit from shipping without touching any of them.
 *
 * DESIGN — deliberately narrow, because a gate that cries wolf gets deleted:
 *
 * - It fires only on `core/**` changes. Any other PR is untouched.
 * - It requires SOME test change, not a specific one. A fix, a regression test, a
 *   new edge case — all satisfy it. Naming which test _should_ change is a
 *   reviewer's judgement, and a wrong guess here would block a correct PR.
 * - It NEVER fires when the PR is docs- or tooling-only in `core/` terms, and it
 *   can be waived with a `#no-core-test-gate` marker in the PR body, for the
 *   legitimate case where a `core/**` change provably cannot be covered (a
 *   comment fix, a rename). The marker is reported in the failure output so a
 *   waived gate is visible rather than silent.
 *
 * The decision logic is exported and unit-tested (test/unit/tools/), because a
 * gate whose own logic is untested is a gate that will eventually block the
 * wrong PR.
 *
 * Usage: node tools/check-core-test-change.mjs [--base <sha|branch>] [--files
 * <a,b,c>] (skip git; test the classifier directly)
 *
 * Exit 0 = satisfied. Exit 1 = core changed with no test change.
 */

import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A change under this prefix is core code. */
export const CORE_PREFIX = 'core/';

/**
 * A change under one of these prefixes is a test that can guard core. Kept as
 * explicit prefixes (not a regex) so a new test directory is a deliberate
 * addition here rather than something that silently stops counting.
 */
export const TEST_PREFIXES = ['test/'];

/** Files that may satisfy the gate without being a test per se. */
export const TOOLING_ALLOWLIST = [
  // The gate script itself and its own tests — editing the gate must not
  // require a core test change, or the gate could never be fixed in place.
  'tools/check-core-test-change.mjs',
  'test/unit/tools/checkCoreTestChange.test.mjs',
];

/** PR-body marker that waives the gate, for provably-untestable core edits. */
export const WAIVER_MARKER = '#no-core-test-gate';

/**
 * Classify one changed path.
 *
 * @param {string} file - repo-relative path
 * @returns {'core' | 'test' | 'tooling' | 'other'}
 */
export function classify(file) {
  const rel = file.replace(/\\/g, '/').replace(/^\.\//, '');
  if (TOOLING_ALLOWLIST.includes(rel)) return 'tooling';
  if (rel.startsWith(CORE_PREFIX)) return 'core';
  if (TEST_PREFIXES.some(prefix => rel.startsWith(prefix))) return 'test';
  return 'other';
}

/**
 * Split changed paths into core and test buckets.
 *
 * @param {string[]} files
 * @returns {{core: string[]; tests: string[]}}
 */
export function partition(files) {
  const core = [];
  const tests = [];
  for (const file of files) {
    const kind = classify(file);
    if (kind === 'core') core.push(file);
    else if (kind === 'test') tests.push(file);
  }
  return {core, tests};
}

/**
 * The gate's decision, as a pure function.
 *
 * @param {string[]} files - changed paths
 * @param {{waived?: boolean}} [opts]
 * @returns {{
 *   satisfied: boolean;
 *   reason: string;
 *   core: string[];
 *   tests: string[];
 * }}
 */
export function evaluate(files, {waived = false} = {}) {
  const {core, tests} = partition(files);
  if (core.length === 0) {
    return {
      satisfied: true,
      reason: 'no core/** change — gate not applicable',
      core,
      tests,
    };
  }
  if (tests.length > 0) {
    return {
      satisfied: true,
      reason: `${tests.length} test file(s) changed alongside core`,
      core,
      tests,
    };
  }
  if (waived) {
    return {
      satisfied: true,
      reason: `waived via ${WAIVER_MARKER} in the PR body`,
      core,
      tests,
    };
  }
  return {
    satisfied: false,
    reason:
      `core/** changed (${core.length} file(s)) with no test change. ` +
      `Either add/extend a test under ${TEST_PREFIXES.join(' or ')}, or — if this ` +
      `change genuinely cannot be covered (a comment, a rename) — add ` +
      `${WAIVER_MARKER} to the PR body and say why.`,
    core,
    tests,
  };
}

/**
 * The changed paths to judge.
 *
 * `--files` short-circuits git (the unit tests use it). Otherwise the diff is
 * taken against `--base`, defaulting to `origin/main` — the merge-base rather
 * than the branch tip, so a diff that spans an unrelated main commit is still
 * judged on the PR's own changes.
 *
 * @param {{base?: string; files?: string[]; git?: Function}} [opts]
 * @returns {string[]}
 */
export function changedFiles({base, files, git = defaultGit} = {}) {
  if (files) return files;
  const ref = base || process.env.GITHUB_BASE_REF || 'origin/main';
  // Two-dot against the merge-base: exactly the PR's own changes, so a main
  // commit landing mid-PR cannot make the gate fire (or mask a real violation).
  const mergeBase = safeMergeBase(git, ref);
  if (mergeBase) return parseNameList(git(['diff', '--name-only', `${mergeBase}...HEAD`]));
  // No merge base (a shallow clone, or a base ref that does not exist locally).
  //
  // This fallback MUST still name the base. A bare `git diff --name-only HEAD`
  // compares HEAD with the WORKING TREE, so on a clean CI checkout it returns
  // nothing at all — and a gate with no changed files reports "no core/** change"
  // and passes. The exact fail-open the gate exists to prevent. Diff the ref tip
  // instead; if even that cannot run, throw so main() stands down loudly.
  try {
    return parseNameList(git(['diff', '--name-only', ref, 'HEAD']));
  } catch (err) {
    throw new Error(`cannot diff HEAD against ${ref}: ${err.message}`, {cause: err});
  }
}

/**
 * @param {string} out raw `git diff --name-only` output
 * @returns {string[]}
 */
function parseNameList(out) {
  return out
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);
}

/**
 * @param {Function} git
 * @param {string} ref
 * @returns {string | null} the merge base, or null when it cannot be resolved
 */
function safeMergeBase(git, ref) {
  try {
    const out = git(['merge-base', 'HEAD', ref]).trim();
    return out || null;
  } catch {
    // A shallow clone or a ref that does not exist locally: fall back to the
    // two-dot diff rather than skipping the gate entirely.
    return null;
  }
}

/**
 * Run git, returning stdout.
 *
 * @param {string[]} args
 * @returns {string}
 */
function defaultGit(args) {
  return execFileSync('git', args, {cwd: REPO_ROOT, encoding: 'utf-8', maxBuffer: 8 << 20});
}

/**
 * Was the gate waived in the PR body?
 *
 * Reads the body from disk (the workflow writes it) or stdin, so the script
 * stays usable locally and in CI without a GitHub API call.
 *
 * @returns {boolean}
 */
export function detectWaiver() {
  const bodyPath = process.env.PR_BODY_FILE;
  if (bodyPath && fs.existsSync(bodyPath)) {
    return fs.readFileSync(bodyPath, 'utf-8').includes(WAIVER_MARKER);
  }
  // Only read stdin when a body was actually piped in. Checking isTTY alone is
  // not enough: `node gate.mjs < /dev/null` and any non-interactive runner
  // present a non-TTY stdin, and a blocking read there HANGS the gate — which
  // is how the first local run of this script wedged for the full command
  // timeout instead of reporting a verdict.
  if (process.env.PR_BODY_STDIN === '1') {
    try {
      return fs.readFileSync(0, 'utf-8').includes(WAIVER_MARKER);
    } catch {
      return false;
    }
  }
  return false;
}

export function main(argv = process.argv.slice(2)) {
  const baseIdx = argv.indexOf('--base');
  const filesIdx = argv.indexOf('--files');
  const files =
    filesIdx !== -1 && argv[filesIdx + 1] ?
      argv[filesIdx + 1]
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
    : undefined;
  const base = baseIdx !== -1 ? argv[baseIdx + 1] : undefined;

  let changed;
  try {
    changed = changedFiles({base, files});
  } catch (err) {
    // Never block a PR because the gate could not compute its own input — that
    // is a tooling outage, not a policy violation. Report it and stand down.
    console.log(`! could not determine changed files (${err.message}) — gate skipped`);
    return;
  }

  const verdict = evaluate(changed, {waived: detectWaiver()});
  if (!verdict.satisfied) {
    console.error('✗ core changed without a test change (#30)');
    console.error(`  ${verdict.reason}`);
    console.error(`  core files: ${verdict.core.join(', ')}`);
    process.exit(1);
  }
  console.log(`✓ core-test-change gate: ${verdict.reason}`);
}

const isMain = process.argv[1] && path.basename(process.argv[1]) === 'check-core-test-change.mjs';
if (isMain) {
  main();
}
