// publishMode.mjs — mode + dev-run identity shared by every publish component.
//
// `--mode=prod|dev` is REQUIRED for all publish operations (upload /
// upload:local): there is no silent default, so
// an accidental prod publish is impossible without consciously typing
// --mode=prod.
//
//   prod  → the `latest` release (RELEASE_NAME) + the gh-pages Pages branch.
//          Only allowed when the current git branch is 'main' (enforced by
//          publishCommon.enforceMainOnly).
//   dev   → a per-run `dev-build-<id>` branch ONLY (no release — zips,
//          hashes, helpers and installer binaries all travel via the branch,
//          served through jsDelivr), namespaced artifacts (ASSET_SUFFIX
//          '-dev').  Works from any branch; CI deletes the branch when tests
//          finish, developers delete it manually.  Never touches
//          latest/gh-pages.
//
// This module is deliberately dependency-free and NEVER throws on a missing
// --mode: the config generators (generateUpdaterConfig.mjs,
// syncGeneratedFiles.mjs, createZip.mjs) run without a mode — via the
// installer Makefile or createZip's publish-time regeneration — and must stay
// prod by default.  Only the publish CLIs (upload.mjs) require the flag, via
// paths.js (which imports this module) and requireMode().

import {execSync} from 'child_process';
import path from 'path';
import {fileURLToPath} from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const REPO_ROOT = path.resolve(__dirname, '..', '..');

export const MODES = ['prod', 'dev'];

/** --mode=… from argv, or undefined when absent. */
function rawModeArg() {
  const arg = process.argv.find(a => a.startsWith('--mode='));
  return arg ? arg.slice('--mode='.length) : undefined;
}

/** 'prod' | 'dev' | undefined — tolerant; generators rely on undefined=prod. */
export const MODE = rawModeArg();

/**
 * --local (upload:local): build a self-contained snapshot whose URLs all point
 * at the installer's own HTTP server (http://localhost:<DEFAULT_PORT>/) instead
 * of GitHub, so the built installer works offline against
 * dist/<mode>-<branch>-<hash>/ without pushing anything. Orthogonal to MODE:
 * prod-local keeps plain asset names, dev-local keeps '-dev' names.
 */
export const LOCAL = process.argv.includes('--local');

/** The dev asset suffix: '-dev' in dev mode, '' in prod/unknown mode. */
export const ASSET_SUFFIX = MODE === 'dev' ? '-dev' : '';

/**
 * Build-identity override for `--ref=<branch|commit>` runs: upload.mjs checks
 * out the ref in a temporary worktree and re-executes itself there with these
 * env vars set, so the child build names its snapshot/dev-branch/release after
 * the ref instead of the detached-HEAD "HEAD-<sha>". Empty for a normal run.
 */
export const REF_NAME = process.env.FIREFOX_SCRIPTS_REF_NAME || '';
export const REF_SHA = process.env.FIREFOX_SCRIPTS_REF_SHA || '';

/** Current git branch + short sha, honoring the --ref identity override. */
function gitBranchAndSha() {
  let branch = 'unknown';
  let sha = 'dirty';
  if (REF_NAME) {
    branch = REF_NAME;
    sha = REF_SHA || sha;
  } else {
    try {
      branch = execSync('git rev-parse --abbrev-ref HEAD', {
        encoding: 'utf-8',
        cwd: REPO_ROOT,
      }).trim();
    } catch {
      /* keep fallback */
    }
    try {
      sha = execSync('git rev-parse --short=7 HEAD', {
        encoding: 'utf-8',
        cwd: REPO_ROOT,
      }).trim();
    } catch {
      /* keep fallback */
    }
  }
  return {branch, sha};
}

/**
 * Absolute path of this run's local snapshot directory,
 * dist/<mode>-<branch>-<sha>/. Only meaningful for --local builds (the snapshot
 * the config's file:// URLs point at); returns the deterministic path in every
 * mode so the generated config can embed it.
 */
export function localSnapshotDir() {
  const {branch, sha} = gitBranchAndSha();
  const mode = MODE || 'prod';
  const safeBranch = branch.replace(/[^\w.-]+/g, '-');
  return path.join(REPO_ROOT, 'dist', `${mode}-${safeBranch}-${sha}`);
}

/**
 * --note="<label>" (dev only): label this test build. Slugified into the
 * dev-build id (spaces and other non-name characters become '-'), so two builds
 * off the same branch carry intent-revealing branch names: --mode=dev
 * --note="v1.0 RC" → dev-build-main-v1.0-RC-<sha> With --tag it also leads the
 * release page's title and body. Empty for a plain test publish.
 */
const DEV_NOTE_ARG = (() => {
  const arg = process.argv.find(a => a.startsWith('--note='));
  return arg ? arg.slice('--note='.length) : '';
})();
export const DEV_NOTE = DEV_NOTE_ARG;

/**
 * --tag (dev only): create the RC-style prerelease page for this dev build. The
 * only release-creating path — without it a dev publish is branch-only (ADR
 * 0026).
 */
export const DEV_TAG = process.argv.includes('--tag');

/**
 * Slugify a --note label for embedding in the dev-build id: whitespace runs
 * become single '-', characters outside [\w.-] are dropped.
 */
export function slugifyDevNote(note) {
  return (
    String(note || '')
      .trim()
      // Drop disallowed characters first (an em-dash between spaces leaves two
      // spaces that the next step collapses), then fold whitespace to '-'.
      .replace(/[^\w\s.-]/g, '')
      .replace(/\s+/g, '-')
  );
}

/**
 * Per-run dev-build branch identity: `dev-build-<id>`, where `<id>` is the
 * DEV_BUILD_ID env var, or `<current-branch>[-<note-slug>]-<short-sha>` (--note
 * labels the id; stable for re-runs of the same commit + note, unique across
 * commits), or a timestamp fallback when git is unavailable.
 *
 * Exported pure for unit tests; DEV_BUILD_ID below applies the live argv/env.
 */
export function devBuildId({branch, sha, note, envId}) {
  if (envId) return envId;
  const notePart = slugifyDevNote(note);
  return `${branch.replace(/[^\w.-]+/g, '-')}${notePart ? `-${notePart}` : ''}-${sha}`;
}

/** Full dev-branch id for this run. */
export const DEV_BUILD_ID = devBuildId({
  branch: gitBranchAndSha().branch,
  sha: gitBranchAndSha().sha,
  note: DEV_NOTE,
  envId: process.env.DEV_BUILD_ID,
});

/** Full branch name holding dev artifacts. */
export const DEV_BRANCH = `dev-build-${DEV_BUILD_ID}`;

/** @returns The validated mode; throws when missing or invalid. */
export function requireMode() {
  if (MODE === undefined) {
    throw new Error(
      'Missing required --mode=prod|dev.\n' +
        '  --mode=prod  publish to the latest release + gh-pages (requires branch main)\n' +
        '  --mode=dev   publish to the dev-build-<id> branch only ' +
        '(any branch; never touches latest/gh-pages)'
    );
  }
  if (MODE !== 'dev' && (process.argv.some(a => a.startsWith('--note=')) || DEV_TAG)) {
    throw new Error('--note= and --tag are dev-mode only (they label dev-build-<id> builds).');
  }
  if (!MODES.includes(MODE)) {
    throw new Error(`Unknown --mode='${MODE}' (expected prod|dev)`);
  }
  return MODE;
}
