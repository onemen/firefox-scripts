#!/usr/bin/env node
// tools/publish/buildEpoch.mjs — print SOURCE_DATE_EPOCH for the Windows builds.
//
// SOURCE_DATE_EPOCH is what pins the PE TimeDateStamp (#162): without it GNU ld
// stamps the COFF header with the link time, so every build of the same commit
// is a new binary with a new sha256, a new VirusTotal analysis and a new
// Microsoft WDSI submission hash. The value is the last commit touching the
// BINARIES' input set — not HEAD's (issue #322 B1, ADR 0036): a docs-only
// commit must not re-roll the shipped bytes.
//
// Why a script and not a `$(shell git …)` line in installer/Makefile:
//
//   * `git log -- <relative path>` resolves the pathspec against GIT'S working
//     directory, so the answer depends on where make happened to run the shell
//     — a cwd-dependent value that silently changes the bytes.
//   * a path-limited `git log` that matches NOTHING is not an error: git exits
//     0 and prints nothing. The usual guard (`… 2>/dev/null || echo FALLBACK`)
//     cannot see that, so SOURCE_DATE_EPOCH becomes the EMPTY string — and
//     binutils treats empty as "unset", falling back to the link time. That is
//     the 2026-09-25 CI failure (run 36177261598): two `snapshot:prod` runs of
//     fb2daf9 produced different installer + helper PEs while the zips matched,
//     because the binaries carried link-time stamps and the zips carry none.
//
// Resolving the epoch here — from the repo root, with the same path lists the
// inner build dates use (generateBuildDates.mjs) and an environment stripped of
// an inherited GIT_DIR — makes the value independent of the shell, of the cwd
// and of any hook that exported git state. "Nothing matched" is a hard error
// instead of a silent wall-clock build. Never fall back to the current time.

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
 * The paths whose history decides the epoch: the UNION of both binaries' input
 * sets, so any commit that can change either PE moves the stamp (the
 * `:(exclude)` magic in the installer list is dropped — the epoch must cover
 * helper/ too). Single source with the inner dates, per ADR 0036.
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
 * The git-derived PE epoch.
 *
 * @param {string} root repo root
 * @returns {{epoch: number; source: 'git' | 'no-git'}} source is 'git' when the
 *   value came from history, 'no-git' when the fixed fallback was used
 * @throws when git answered — and the answer was nothing / not a number / from
 *   a shallow clone. An empty epoch must fail the build, never pass silently.
 */
export function buildEpoch(root = ROOT) {
  const paths = epochPathspecs(root);
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
      `git log printed '${out}' for the build-epoch pathspecs — expected a commit epoch. ` +
        'An empty SOURCE_DATE_EPOCH makes binutils stamp the PE with the link time, so every ' +
        'build of the same commit would ship different bytes (#162/#322). Refusing to continue.'
    );
  }
  return {epoch: Number(out), source: 'git'};
}

export function main() {
  const {epoch, source} = buildEpoch();
  if (process.argv.includes('--verbose')) {
    console.error(
      `buildEpoch: ${epoch} (${source}) — ${epochPathspecs().length} pathspecs from ${ROOT}`
    );
  }
  // The Makefile captures stdout: print the number and nothing else.
  console.log(String(epoch));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main();
}
