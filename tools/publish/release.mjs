#!/usr/bin/env node
// tools/publish/release.mjs — thin alias for dispatching a publish to CI.
//
// Prod publishes are CI-only (ADR 0026, prodCiGuard.mjs): the complete
// cross-OS installer set is buildable only by the Pages publish workflow's
// per-OS matrix. This script is a discoverable front door for the dispatch —
// exactly `gh workflow run pages.yml`, nothing more:
//
//   pnpm release                       # full prod publish (mode defaults to prod)
//   pnpm release -- --mode=dev         # dev-build-<id> branch instead
//   pnpm release:packages              # zips + updater-ui only (--skip=installer,helper)
//   pnpm release:installer             # installer + helper only (--skip=packages)
//   pnpm release -- --skip=installer   # any ADR 0030 role list
//   pnpm release -- --ref=<branch>     # dispatch another branch's workflow
//   pnpm release -- --force            # rebuild + re-upload even when unchanged
//
// The wrapper owns --force/--mode/--skip/--ref (it maps them to the workflow
// inputs / gh flags); any other `-f key=value` is passed through to gh
// verbatim — through spawnSync's argv array, never a shell, so nothing is
// interpolated. No watch mode, no output parsing — follow the run in the
// Actions tab. The workflow's own gates (main-only for prod, E2E-green commit,
// browser-version drift) are what the guard requires; this alias cannot
// bypass them, it merely triggers them.

import {spawnSync} from 'node:child_process';
import {SKIP_ROLES} from './publishScope.mjs';

const WORKFLOW = 'pages.yml';

/**
 * gh argv for the dispatch (exported for the unit tests).
 *
 * @param {{
 *   force?: boolean;
 *   mode?: string;
 *   skip?: string[];
 *   ref?: string;
 *   passthrough?: string[];
 * }} opts
 */
export function buildDispatchArgs({
  force = false,
  mode = 'prod',
  skip = [],
  ref = '',
  passthrough = [],
} = {}) {
  const args = ['workflow', 'run', WORKFLOW];
  // gh dispatches the default branch unless told otherwise — a dev publish
  // from a feature branch needs --ref to point at that branch's workflow.
  if (ref) args.push('--ref', ref);
  args.push('-f', `mode=${mode}`);
  if (force) args.push('-f', 'force=true');
  if (skip.length > 0) args.push('-f', `skip=${[...skip].join(',')}`);
  args.push(...passthrough);
  return args;
}

/**
 * Parse wrapper args (exported for unit tests). `--skip=a,b` is validated
 * against the publish roles here, so a typo fails before the dispatch instead
 * of inside the CI run. Unknown non-`-f` flags are rejected; `-f key=value`
 * pairs pass through verbatim (the documented gh escape hatch).
 *
 * @param {string[]} [argv]
 */
export function parseReleaseArgs(argv = process.argv.slice(2)) {
  const opts = {force: false, mode: 'prod', skip: [], ref: '', passthrough: []};
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
    } else if (a.startsWith('--skip=')) {
      const value = a.slice('--skip='.length).trim();
      if (value === '') throw new Error('--skip= needs at least one role');
      for (const raw of value.split(',')) {
        const role = raw.trim();
        if (!SKIP_ROLES.includes(role)) {
          throw new Error(`Unknown --skip role '${role}' (expected ${SKIP_ROLES.join('|')})`);
        }
        if (!opts.skip.includes(role)) opts.skip.push(role);
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
        `Unknown flag: ${a} (supported: --force, --mode=prod|dev, --skip=<roles>, --ref=<branch>, -f key=value)`
      );
    }
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
    opts.skip.length > 0 ? `PARTIAL publish — held back: ${opts.skip.join(', ')}` : 'full publish';
  console.log(
    `✓ ${opts.mode.toUpperCase()} ${what} dispatched — the cross-OS matrix builds in CI.\n` +
      '  Watch: gh run list --workflow pages.yml --limit 1 (or the Actions tab).'
  );
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main();
}
