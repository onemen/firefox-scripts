#!/usr/bin/env node
// tools/publish/release.mjs — thin alias for dispatching a publish to CI.
//
// Prod publishes are CI-only (ADR 0026, prodCiGuard.mjs): the complete
// cross-OS installer set is buildable only by the Pages publish workflow's
// per-OS matrix. This script is a discoverable front door for the dispatch —
// exactly `gh workflow run pages.yml`, nothing more:
//
//   pnpm release:all                   # full prod publish (mode defaults to prod)
//   pnpm release:packages              # zips + updater-ui only (--include=packages)
//   pnpm release:installer             # installer + helper only (--include=installer)
//   pnpm release -- --include=all --mode=dev     # dev-build-<id> branch instead
//   pnpm release -- --include=installer,helper   # any ADR 0030 role list
//   pnpm release -- --include=all --ref=<branch> # dispatch another branch's workflow
//   pnpm release -- --include=all --force        # rebuild + re-upload even when unchanged
//
// The publish scope is OPT-IN and REQUIRED: `--include=<roles>` (or a preset
// above; `all` = full publish). A missing, empty or invalid --include fails
// loudly here — before any dispatch — instead of guessing a scope.
//
// The wrapper owns --force/--mode/--include/--ref (it maps them to the
// workflow inputs / gh flags); any other `-f key=value` is passed through to
// gh verbatim — through spawnSync's argv array, never a shell, so nothing is
// interpolated. No watch mode, no output parsing — follow the run in the
// Actions tab. The workflow's own gates (main-only for prod, E2E-green commit,
// browser-version drift) are what the guard requires; this alias cannot
// bypass them, it merely triggers them.

import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {INCLUDE_ROLES} from './publishScope.mjs';

const WORKFLOW = 'pages.yml';

/**
 * gh argv for the dispatch (exported for the unit tests).
 *
 * @param {{
 *   force?: boolean;
 *   mode?: string;
 *   include?: string[];
 *   ref?: string;
 *   passthrough?: string[];
 * }} opts
 */
export function buildDispatchArgs({
  force = false,
  mode = 'prod',
  include = [],
  ref = '',
  passthrough = [],
} = {}) {
  const args = ['workflow', 'run', WORKFLOW];
  // gh dispatches the default branch unless told otherwise — a dev publish
  // from a feature branch needs --ref to point at that branch's workflow.
  if (ref) args.push('--ref', ref);
  args.push('-f', `mode=${mode}`);
  if (force) args.push('-f', 'force=true');
  if (include.length > 0) args.push('-f', `include=${[...include].join(',')}`);
  args.push(...passthrough);
  return args;
}

/**
 * Parse wrapper args (exported for unit tests). `--include=a,b` is REQUIRED and
 * validated against the publish roles here, so a missing/empty/invalid scope
 * fails before the dispatch instead of inside the CI run. Unknown non-`-f`
 * flags are rejected; `-f key=value` pairs pass through verbatim (the
 * documented gh escape hatch).
 *
 * @param {string[]} [argv]
 */
export function parseReleaseArgs(argv = process.argv.slice(2)) {
  const opts = {
    force: false,
    mode: 'prod',
    include: [],
    ref: '',
    passthrough: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') continue;
    if (a === '--force') {
      opts.force = true;
    } else if (a.startsWith('--mode=')) {
      const mode = a.slice('--mode='.length);
      if (mode !== 'prod' && mode !== 'dev') {
        throw new Error(`--mode must be prod|dev, got '${mode}'`);
      }
      opts.mode = mode;
    } else if (a.startsWith('--include=')) {
      const value = a.slice('--include='.length).trim();
      if (value === '') throw new Error('--include= needs at least one role');
      if (value === 'all') {
        if (!opts.include.includes('all')) opts.include.push('all');
        continue;
      }
      for (const raw of value.split(',')) {
        const role = raw.trim();
        // `all` is accepted anywhere in the list (kept as the explicit marker).
        if (role === 'all') {
          if (!opts.include.includes('all')) opts.include.push('all');
          continue;
        }
        if (!INCLUDE_ROLES.includes(role)) {
          throw new Error(
            `Unknown --include role '${role}' (expected ${INCLUDE_ROLES.join('|')}|all)`
          );
        }
        if (!opts.include.includes(role)) opts.include.push(role);
      }
    } else if (a.startsWith('--ref=')) {
      opts.ref = a.slice('--ref='.length).trim();
      if (!opts.ref) throw new Error('--ref= needs a branch or tag');
    } else if (a === '-f') {
      const pair = argv[++i];
      if (!pair || !pair.includes('=')) throw new Error('-f needs a key=value pair');
      opts.passthrough.push('-f', pair);
    } else if (a.startsWith('-f') && a.length > 2) {
      const pair = a.slice(2);
      if (!pair.includes('=')) throw new Error('-f needs a key=value pair');
      opts.passthrough.push('-f', pair);
    } else {
      throw new Error(
        `Unknown flag: ${a} (supported: --force, --mode=prod|dev, --include=<roles>, --ref=<branch>, -f key=value)`
      );
    }
  }
  if (opts.include.length === 0) {
    throw new Error(
      'Missing --include=<roles> — state what this run publishes ' +
        '(packages|installer|helper, comma-separated, or all).\n' +
        '  Presets: pnpm release:all / release:packages / release:installer'
    );
  }
  return opts;
}

export function main() {
  let opts;
  try {
    opts = parseReleaseArgs();
  } catch (e) {
    console.error(String(e.message));
    process.exitCode = 1;
    return;
  }
  const res = spawnSync('gh', buildDispatchArgs(opts), {encoding: 'utf8'});
  if (res.error || res.status !== 0) {
    console.error(
      `Dispatch failed: ${res.error?.message || (res.stderr || '').trim()}\n` +
        '  (is `gh` installed and logged in? `gh auth status`)'
    );
    process.exitCode = 1;
    return;
  }
  const what =
    opts.include[0] === 'all' || opts.include.length === INCLUDE_ROLES.length ?
      'full publish'
    : `PARTIAL publish — publishing: ${opts.include.join(', ')}`;
  console.log(
    `✓ ${opts.mode.toUpperCase()} ${what} dispatched — the cross-OS matrix builds in CI.\n` +
      '  Watch: gh run list --workflow pages.yml --limit 1 (or the Actions tab).'
  );
}

// Direct invocation only (imported by the unit tests for buildDispatchArgs).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
