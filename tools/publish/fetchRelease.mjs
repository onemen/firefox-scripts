#!/usr/bin/env node
// tools/publish/fetchRelease.mjs — download the manual-test set to your machine.
//
// The pre-release (dev build) and post-release (latest) manual tests both need
// the same small set of artifacts on disk: the installer for your OS plus
// utils.zip + fx-folder.zip. Typing the gh incantations by hand is error-prone;
// this wraps them.
//
// Usage:
//   pnpm fetch:release                     # from gh-pages (the published set)
//   pnpm fetch:release -- --dev <branch>   # from the dev-build-<branch> branch
//   pnpm fetch:release -- --run <run-id>   # from a build-and-upload staging run
//                                          # (staged-<os> artifact; that OS's bytes)
//   pnpm fetch:release -- --out <dir>      # destination (default dist/fetched/<source>)
//
// Fetches exactly: installer_<current-os>[.exe] + utils.zip + fx-folder.zip.
// Helpers and updater-ui are updater-consumed artifacts, not manual-test ones;
// add them by hand from the same source if a test ever needs them.

import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const REPO = 'onemen/firefox-scripts';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function fail(message) {
  console.error(`\u2717 fetch:release: ${message}`);
  process.exit(1);
}

function gh(args, {capture = false} = {}) {
  const res = spawnSync(
    'gh',
    args,
    capture ? {encoding: 'buffer', maxBuffer: 256 * 1024 * 1024} : {encoding: 'utf8'}
  );
  if (res.error || res.status !== 0) {
    fail(
      `gh ${args.join(' ')} failed — ${res.error?.message || (res.stderr || '').toString().trim()}`
    );
  }
  return res;
}

/** Parse argv: --dev <branch> | --run <id> | --out <dir>. */
function parseArgs(argv) {
  const opts = {dev: '', run: '', out: ''};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dev' && argv[i + 1]) opts.dev = argv[++i];
    else if (argv[i] === '--run' && argv[i + 1]) opts.run = argv[++i];
    else if (argv[i] === '--out' && argv[i + 1]) opts.out = argv[++i];
    else fail(`unknown argument: ${argv[i]} (see the header of tools/publish/fetchRelease.mjs)`);
  }
  if (opts.dev && opts.run) fail('--dev and --run are mutually exclusive');
  return opts;
}

/** installer asset name for the machine this runs on (platforms.mjs naming). */
export function installerForMyOs(platform = process.platform) {
  if (platform === 'win32') return 'installer_win.exe';
  if (platform === 'darwin') return 'installer_mac';
  if (platform === 'linux') return 'installer_linux';
  return null;
}

/** staged-<os> artifact name for the machine this runs on. */
export function stagedArtifactForMyOs(platform = process.platform) {
  if (platform === 'win32') return 'staged-win';
  if (platform === 'darwin') return 'staged-mac';
  if (platform === 'linux') return 'staged-linux';
  return null;
}

function fetchFromBranch(branch, file, dst) {
  // Branch-hosted artifacts (gh-pages, dev-build-*) via the contents API in raw
  // mode — any size, uses the token gh already has. Files live at branch root.
  const res = gh(
    [
      'api',
      '-H',
      'Accept: application/vnd.github.raw',
      `repos/${REPO}/contents/${file}?ref=${encodeURIComponent(branch)}`,
    ],
    {capture: true}
  );
  fs.writeFileSync(dst, res.stdout);
}

function fetchFromRun(runId, file, dst) {
  // Staging runs upload per-OS artifacts (staged-win / staged-linux /
  // staged-mac); the binary lives under installer/ inside the staging tree.
  const artifact = stagedArtifactForMyOs();
  if (!artifact) fail(`unsupported platform: ${process.platform}`);
  // dist/ is gitignored — a fresh clone may not have it yet.
  fs.mkdirSync(path.join(REPO_ROOT, 'dist'), {recursive: true});
  const tmp = fs.mkdtempSync(path.join(REPO_ROOT, 'dist', '.fetch-'));
  try {
    gh(['run', 'download', String(runId), '-n', artifact, '-D', tmp]);
    const hit = [path.join(tmp, 'installer', file), path.join(tmp, file)].find(p =>
      fs.existsSync(p)
    );
    if (!hit) fail(`${file} not in ${artifact} artifact (looked in installer/ and ./)`);
    fs.copyFileSync(hit, dst);
  } finally {
    fs.rmSync(tmp, {recursive: true, force: true});
  }
}

export function resolveSource(opts) {
  if (opts.run) return {kind: 'run', label: `run ${opts.run}`, branch: ''};
  if (opts.dev)
    return {kind: 'branch', label: `dev-build-${opts.dev}`, branch: `dev-build-${opts.dev}`};
  return {kind: 'branch', label: 'gh-pages', branch: 'gh-pages'};
}

export function resolveOutDir(opts, source) {
  if (opts.out) return opts.out;
  if (source.kind === 'run') return path.join(REPO_ROOT, 'dist', 'fetched', `run-${opts.run}`);
  if (source.kind === 'branch' && source.branch !== 'gh-pages') {
    return path.join(REPO_ROOT, 'dist', 'fetched', `dev-${opts.dev}`);
  }
  return path.join(
    REPO_ROOT,
    'dist',
    'fetched',
    `gh-pages-${new Date().toISOString().slice(0, 10)}`
  );
}

export function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const installer = installerForMyOs();
  if (!installer) fail(`unsupported platform: ${process.platform}`);
  const files = [installer, 'utils.zip', 'fx-folder.zip'];

  const source = resolveSource(opts);
  const outDir = resolveOutDir(opts, source);
  fs.mkdirSync(outDir, {recursive: true});
  console.log(`fetch:release <- ${source.label} -> ${outDir}\n`);

  for (const file of files) {
    const dst = path.join(outDir, file);
    if (source.kind === 'run') fetchFromRun(opts.run, file, dst);
    else fetchFromBranch(source.branch, file, dst);
    console.log(`  + ${file}  (${fs.statSync(dst).size} bytes)`);
  }

  console.log(
    '\nNext: run the installer against a disposable profile and watch the install path end-to-end.'
  );
}

// Direct invocation only (imported by the unit tests for the pure helpers).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
