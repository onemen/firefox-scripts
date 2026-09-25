#!/usr/bin/env node
// tools/e2e-prepush.mjs — the pre-push local E2E gate (`pnpm test:e2e:prepush`).
//
// Contract (2026-09-22): before pushing changes that need an E2E test to a PR,
// run ONE updater leg locally on the developer OS with Nightly, so the
// embarrassing failures surface in ~1-2 minutes instead of a ~6-minute CI
// round-trip. This is a convenience gate, not the CI gate: the full matrix
// still runs (and is still authoritative) in CI.
//
// What it does:
//   1. Snapshot: reuses the newest dist/ snapshot whose branch matches HEAD;
//      if there is none, builds one via `pnpm snapshot:dev`
//      (requires a CLEAN worktree — commit your changes first).
//   2. Runs one updater leg with Nightly (the fastest channel that ships the
//      same privileged-code surfaces CI exercises; override with
//      E2E_PREPUSH_FIREFOX or --firefox <path>).
//   3. Prints a push/no-push verdict and exits 0/1 accordingly.
//
// Skipped/failed snapshot build and E2E failures are reported, never hidden.

import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {cwd: REPO_ROOT, encoding: 'utf-8', ...opts});
}

function fail(message) {
  console.error(`\n✗ e2e-prepush: ${message}`);
  process.exit(1);
}

// ── Args ───────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
let firefox = process.env.E2E_PREPUSH_FIREFOX || '';
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--firefox' && argv[i + 1]) firefox = argv[++i];
  else if (argv[i] === '--help') {
    console.log(
      'Usage: pnpm test:e2e:prepush [--firefox <path>]\n' +
        '\n' +
        'Reuses a branch-matching dev snapshot (or builds one via snapshot:dev —\n' +
        'needs a clean worktree), then runs one updater leg on Nightly.\n' +
        'Browser override: --firefox <path> or E2E_PREPUSH_FIREFOX.'
    );
    process.exit(0);
  } else {
    fail(`unknown argument: ${argv[i]} (see --help)`);
  }
}

console.log('e2e-prepush: local E2E gate (one updater leg on Nightly)');
console.log('='.repeat(60));

// ── 1. Snapshot: reuse or build ────────────────────────────────────────────

// Newest dist snapshot whose recorded branch matches the current one. Mirrors
// findSnapshot()'s branch-check semantics without running a browser step.
function branchMatchingSnapshot() {
  const distDir = path.join(REPO_ROOT, 'dist');
  if (!fs.existsSync(distDir)) return null;
  const branch = sh('git', ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
  const dirs = fs
    .readdirSync(distDir)
    .filter(d => d.startsWith(`dev-${branch}-`))
    .sort();
  for (const dir of dirs.reverse()) {
    const full = path.join(distDir, dir);
    if (fs.existsSync(path.join(full, 'manifest.json'))) return full;
  }
  return null;
}

let snapshot = branchMatchingSnapshot();
if (snapshot) {
  console.log(`\n[1/2] snapshot: reusing ${path.basename(snapshot)} (branch match)`);
} else {
  const dirty = sh('git', ['status', '--porcelain']).stdout.trim();
  if (dirty) {
    fail(
      'no branch-matching snapshot in dist/ and the worktree is dirty.\n' +
        '  Commit your changes first (snapshot:dev requires a clean worktree),\n' +
        '  or build a snapshot manually: pnpm snapshot:dev'
    );
  }
  console.log('\n[1/2] snapshot: none for this branch — building via snapshot:dev…');
  const build = sh('pnpm', ['snapshot:dev'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (build.status !== 0) {
    fail('snapshot:dev failed (see output above).');
  }
  snapshot = branchMatchingSnapshot();
  if (!snapshot) {
    fail('snapshot:dev reported success but produced no branch-matching snapshot.');
  }
  console.log(`  built ${path.basename(snapshot)}`);
}

// ── 2. One updater leg ─────────────────────────────────────────────────────

// Contract: the leg runs on NIGHTLY (freshest channel that ships the same
// privileged-code surfaces CI exercises). Resolution order: --firefox /
// E2E_PREPUSH_FIREFOX → the portable nightly from `pnpm e2e:portable nightly`
// (see DEVELOPING.md) → the installed Nightly.
function resolveNightly() {
  if (firefox) return firefox;
  const candidates =
    process.platform === 'win32' ?
      [
        path.join(
          process.env.USERPROFILE || '',
          'Documents',
          'FireFox',
          'portable',
          'nightly',
          'firefox.exe'
        ),
        'C:\\Program Files\\Firefox Nightly\\firefox.exe',
      ]
    : process.platform === 'darwin' ?
      [
        path.join(
          process.env.HOME || '',
          'Documents/FireFox/portable/nightly/Firefox Nightly.app/Contents/MacOS/firefox'
        ),
        '/Applications/Firefox Nightly.app/Contents/MacOS/firefox',
      ]
    : [path.join(process.env.HOME || '', '.cache/firefox-scripts-e2e/nightly/firefox')];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

const nightly = resolveNightly();
if (!nightly) {
  fail(
    'no Nightly found (looked: portable nightly from `pnpm e2e:portable nightly`,\n' +
      '  then the installed Nightly). Install one, or pass --firefox <path> / set\n' +
      '  E2E_PREPUSH_FIREFOX.'
  );
}
console.log(`\n[2/2] updater leg on ${nightly}…`);
const runArgs = ['test/e2e/updater/updater-e2e.mjs', '--snapshot', snapshot, '--firefox', nightly];

const result = sh(process.execPath, runArgs, {stdio: 'inherit'});
if (result.status !== 0) {
  console.error(
    '\n' +
      '='.repeat(60) +
      `\ne2e-prepush: ✗ FAILED — do NOT push. Fix locally, then re-run:\n` +
      `  pnpm test:e2e:prepush\n` +
      `  (or reproduce directly: node test/e2e/updater/updater-e2e.mjs --snapshot ${snapshot}${firefox ? ` --firefox "${firefox}"` : ''})`
  );
  process.exit(1);
}

console.log(
  '\n' +
    '='.repeat(60) +
    '\ne2e-prepush: ✓ ALL GREEN — safe to push. Full-matrix validation still runs in CI.'
);
