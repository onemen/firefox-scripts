#!/usr/bin/env node
// tools/publish/release.mjs — thin alias for dispatching the prod publish.
//
// Prod publishes are CI-only (ADR 0026, prodCiGuard.mjs): the complete
// cross-OS installer set is buildable only by the Pages publish workflow's
// per-OS matrix. This script is a discoverable front door for the dispatch —
// exactly `gh workflow run pages.yml -f mode=prod`, nothing more:
//
//   pnpm release              # dispatch the prod publish
//   pnpm release -- --force   # rebuild + re-upload even when hashes are unchanged
//
// No watch mode, no output parsing — follow the run in the Actions tab.
// The workflow's own gate (main-only, internal FXS_INTERNAL_CI marker) is what
// the guard requires; this alias cannot bypass it, it merely triggers it.

import {spawnSync} from 'node:child_process';

/** gh argv for the prod dispatch (exported for the unit test). */
export function buildDispatchArgs({force = false} = {}) {
  const args = ['workflow', 'run', 'pages.yml', '-f', 'mode=prod'];
  if (force) args.push('-f', 'force=true');
  return args;
}

/** Parse wrapper args (exported for unit tests). */
export function parseReleaseArgs(argv = process.argv.slice(2)) {
  const opts = {force: false};
  for (const a of argv) {
    if (a === '--force') opts.force = true;
    else if (a === '--') continue;
    else throw new Error(`Unknown flag: ${a} (supported: --force)`);
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
  console.log(
    '✓ Prod publish dispatched — the full cross-OS matrix builds in CI.\n' +
      '  Watch: gh run list --workflow pages.yml --limit 1 (or the Actions tab).'
  );
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main();
}
