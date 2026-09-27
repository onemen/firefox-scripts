import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {assertFullHistory, datePathspecs, gitEnv} from './generateBuildDates.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

/**
 * The value used when there is no git history to read at all (exported tarball
 * or a copy without .git) — the constant installer/Makefile carried before this
 * script existed. A FIXED epoch, deliberately: a plausible-looking date that is
 * identical for every such build, so those builds stay reproducible.
 */
export const FALLBACK_EPOCH = 1785600000;

/**
 * Which PE's input set to resolve the epoch against: 'installer' or 'helper'.
 * The Makefile stamps each PE with ITS OWN epoch (per-binary since the
 * 2026-09-26 amendment, ADR 0036): a commit touching installer-only inputs must
 * not re-roll the helper's bytes — its compile set (helper sources +
 * _builddate.h + manifest + ico + toolchain) is untouched, and shipping a
 * changed sha256 invalidates the binary's WDSI submission for nothing.
 *
 * @param {string} binary
 * @param {string} root repo root
 * @returns {string[]} pathspecs
 */
function binaryPathspecs(binary, root = ROOT) {
  const {installer, helper} = datePathspecs(root);
  const list =
    binary === 'helper' ? helper
    : binary === 'installer' ? installer
    : null;
  if (!list) {
    throw new Error(`buildEpoch: unknown binary '${binary}' (expected 'installer' | 'helper')`);
  }
  // The installer list's `:(exclude)` magic keeps helper/ out of ITS set; the
  // helper list is all-positive. Both are used verbatim by `git log`.
  return list;
}

/**
 * The union of both binaries' input sets — the epoch every PE shared before the
 * per-binary amendment. Kept for callers that legitimately need one value for
 * the whole tree (e.g. release-state tooling); the PE TimeDateStamps no longer
 * use it.
 *
 * @param {string} root repo root
 * @returns {string[]} absolute paths, de-duplicated
 */
export function epochPathspecs(root = ROOT) {
  const {installer, helper} = datePathspecs(root);
  const positive = [...installer, ...helper].filter(p => !p.includes(':(exclude)'));
  return [...new Set(positive)];
}

/**
 * Shared resolver: `git log -1 --format=%ct` over `paths`, with the same
 * hard-fail semantics the epoch has always had — "nothing matched" throws (an
 * empty SOURCE_DATE_EPOCH stamps the link time, #162/#322) and "no git at all"
 * returns the fixed fallback.
 *
 * @param {string[]} paths
 * @param {string} root repo root
 * @param {string} what what the paths are for (error messages)
 * @returns {{epoch: number; source: 'git' | 'no-git'}}
 */
function epochFromPaths(paths, root, what) {
  // Probe first so "no git at all" (a tarball) is distinguishable from a
  // history that is present but unusable.
  try {
    execFileSync('git', ['rev-parse', '--is-shallow-repository'], {
      cwd: root,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: gitEnv(),
    });
  } catch {
    return {epoch: FALLBACK_EPOCH, source: 'no-git'};
  }
  assertFullHistory(root);
  // execFileSync, not a shell string: no quoting or path-mangling layer can
  // change which paths git is asked about.
  const out = execFileSync('git', ['log', '-1', '--format=%ct', '--', ...paths], {
    cwd: root,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: gitEnv(),
  }).trim();
  if (!/^\d+$/.test(out)) {
    throw new Error(
      `git log printed '${out}' for the ${what} build-epoch pathspecs — expected a commit epoch. ` +
        'An empty SOURCE_DATE_EPOCH makes binutils stamp the PE with the link time, so every ' +
        'build of the same commit would ship different bytes (#162/#322). Refusing to continue.'
    );
  }
  return {epoch: Number(out), source: 'git'};
}

/**
 * The git-derived PE epoch for ONE binary ('installer' | 'helper') — the last
 * commit touching exactly that binary's input set, the same list its inner
 * build date and publish hash derive from (ADR 0036, per-binary since
 * 2026-09-26). Each PE is stamped with its own value: "date moved ⇔ bytes
 * moved" must hold per binary, and a commit outside a binary's input set must
 * not invalidate its WDSI submission.
 *
 * @param {string} binary 'installer' | 'helper'
 * @param {string} root repo root
 * @returns {{epoch: number; source: 'git' | 'no-git'}}
 * @throws when git answered — and the answer was nothing / not a number / from
 *   a shallow clone.
 */
export function buildEpoch(binary = 'installer', root = ROOT) {
  return epochFromPaths(binaryPathspecs(binary, root), root, binary);
}

/**
 * The pre-amendment union epoch (both pathspec lists merged) — every PE shared
 * it before the 2026-09-26 per-binary amendment. Kept only for callers that
 * legitimately need one value for the whole tree.
 *
 * @param {string} root repo root
 * @returns {{epoch: number; source: 'git' | 'no-git'}}
 */
export function buildEpochUnion(root = ROOT) {
  return epochFromPaths(epochPathspecs(root), root, 'union');
}

export function main() {
  // Optional argv[2]: which binary's epoch to print ('installer' | 'helper').
  // No argument = the union epoch (kept for release-state tooling; the
  // Makefile's PE stamps always pass the binary).
  const arg = process.argv[2];
  const binary = arg === 'installer' || arg === 'helper' ? arg : null;
  const {epoch, source} = binary ? buildEpoch(binary) : buildEpochUnion();
  if (process.argv.includes('--verbose')) {
    console.error(`buildEpoch: ${epoch} (${source}) — ${binary ?? 'union'} pathspecs from ${ROOT}`);
  }
  // The Makefile captures stdout: print the number and nothing else.
  console.log(String(epoch));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main();
}
