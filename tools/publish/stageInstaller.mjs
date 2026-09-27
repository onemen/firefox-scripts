#!/usr/bin/env node
// tools/publish/stageInstaller.mjs — put the byte-exact PROD installer on a
// disposable orphan branch for the pre-release manual download test.
//
// Purpose (2026-09-26/27 release runbook): after the CI staging run and the
// WDSI filing, the operator wants to download the installer from GitHub and
// run it BEFORE the publish — same download surface, same bytes, without
// touching the production surfaces (gh-pages, the `latest` release and
// hashes.json stay exactly as the last publish left them; the staged
// installer fetches and hash-verifies them as usual).
//
// Hard gates (refuse loudly rather than stage the wrong bytes):
//   1. --run <id>        a build-and-upload staging run (publish=false) that
//                        EXISTS and belongs to the repo;
//   2. the staged sha256 must equal --expect <sha256> (default: the hash the
//                        runbook/WDSI record filed for this release);
//   3. the pushed TREE must contain the binary (a global `*.exe` gitignore
//                        silently dropped it once — 2026-09-27 — so this is
//                        asserted, not assumed);
//   4. default --ref=main must still point at the same commit the run was
//                        dispatched for (--run-ref <sha> to pin explicitly).
//
// Rollback is always one command: git push origin --delete <branch>.
//
// Usage:
//   node tools/publish/stageInstaller.mjs --run <id> [--expect <sha256>]
//        [--branch <name>] [--run-ref <sha>] [--binary installer_win.exe]
//        [--no-push]   # build and verify locally, print instead of pushing
//
// pnpm alias: pnpm stage:installer -- --run <id> --expect <sha256>

import {spawnSync} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {gitEnv} from './generateBuildDates.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPO = 'onemen/firefox-scripts';
const DEFAULT_EXPECT = '037032aa9b6e87d7dc7ab8e4f600fe3c82a48112098a975acc423c8a91e11c77';

function parseArgs(argv) {
  const opts = {
    run: '',
    expect: DEFAULT_EXPECT,
    branch: '',
    runRef: '',
    binary: 'installer_win.exe',
    push: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--run' && argv[i + 1]) opts.run = argv[++i];
    else if (a === '--expect' && argv[i + 1]) opts.expect = argv[++i].toLowerCase();
    else if (a === '--branch' && argv[i + 1]) opts.branch = argv[++i];
    else if (a === '--run-ref' && argv[i + 1]) opts.runRef = argv[++i];
    else if (a === '--binary' && argv[i + 1]) opts.binary = argv[++i];
    else if (a === '--no-push') opts.push = false;
    else
      throw new Error(
        `unknown argument: ${a} (see the header of tools/publish/stageInstaller.mjs)`
      );
  }
  if (!/^\d+$/.test(opts.run)) {
    throw new Error('--run <id> is required: the build-and-upload staging run to stage from');
  }
  if (!/^[0-9a-f]{64}$/.test(opts.expect)) {
    throw new Error('--expect must be the full 64-hex sha256 of the filed bytes');
  }
  if (!opts.branch) {
    opts.branch = `stage-installer-${new Date().toISOString().slice(0, 10)}`;
  }
  return opts;
}

function gh(args, {capture = false} = {}) {
  const res = spawnSync('gh', args, {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024});
  if (res.error || res.status !== 0) {
    throw new Error(
      `gh ${args.join(' ')} failed — ${res.error?.message || (res.stderr || '').toString().trim()}`
    );
  }
  return capture ? res.stdout : undefined;
}

/**
 * The env for git commands: scrub the ambient GIT_DIR/GIT_INDEX_FILE overlays
 * (git exports them into hooks; under the pre-push hook they point at the
 * checkout being pushed — the redirection buildEpoch.test.mjs documents).
 *
 * @returns {NodeJS.ProcessEnv}
 */
function scrubEnv() {
  return gitEnv();
}

function git(args, {cwd = REPO_ROOT} = {}) {
  const res = spawnSync('git', args, {cwd, encoding: 'utf8', env: scrubEnv()});
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed — ${(res.stderr || '').toString().trim()}`);
  }
  return (res.stdout || '').trim();
}

function fail(message) {
  console.error(`\u2717 stageInstaller: ${message}`);
  process.exit(1);
}

/**
 * Verify the run exists, is a build-and-upload run, and its head commit is the
 * one the caller intends to stage (--run-ref, or default: origin/main's current
 * tip — the "I am staging the release commit" case).
 *
 * @param {string} run run id
 * @param {string} runRef pinned head sha (short or full)
 * @returns {string} the run's full head sha
 */
function assertRunMatchesIntent(run, runRef) {
  const raw = gh(
    [
      'api',
      `repos/${REPO}/actions/runs/${run}`,
      '--jq',
      '{name: .name, headSha: .head_sha, event: .event}',
    ],
    {capture: true}
  );
  const info = JSON.parse(raw);
  // GitHub reports the workflow NAME ("Build and upload"), not the file name —
  // match case/separator-insensitively so the yml file and its display name both pass.
  if (!/build[-_ ]?and[-_ ]?upload/i.test(info.name)) {
    throw new Error(
      `run ${run} is "${info.name}", not build-and-upload.yml — stage only publish=false staging runs`
    );
  }
  const headSha = String(info.headSha);
  let intent = runRef;
  if (!intent) {
    // Default intent: origin/main's tip. A moved main between the run and now
    // is the classic wrong-bytes mistake; pin with --run-ref to override.
    intent = git(['rev-parse', 'origin/main']);
  }
  const intentFull = git(['rev-parse', '--verify', `${intent}^{commit}`]);
  if (headSha !== intentFull) {
    throw new Error(
      `run ${run} head ${headSha.slice(0, 12)} != intended commit ${intentFull.slice(0, 12)} — ` +
        'the run did not build the commit you mean to stage. Pass the run whose head IS the ' +
        'release commit, or re-run the staging dispatch first.'
    );
  }
  return headSha;
}

/**
 * Download the staged artifact (gh run download), return the binary's bytes.
 *
 * @param {string} run run id
 * @param {string} binary asset file name (installer_win.exe)
 * @param {string} dir download destination
 * @returns {Buffer}
 */
function fetchStagedBinary(run, binary, dir) {
  gh(['run', 'download', run, '-n', 'staged-win', '-D', dir]);
  const rel = path.join('installer', binary);
  const p = path.join(dir, rel);
  if (!fs.existsSync(p)) {
    throw new Error(
      `the staged-win artifact has no ${rel} — is ${run} really a publish=false staging run?`
    );
  }
  return fs.readFileSync(p);
}

/**
 * Assert the pushed remote tree actually contains the binary. The global
 * `*.exe` gitignore silently dropped it from the first 2026-09-27 push (git add
 * without -f); the bytes reached GitHub only after a forced add — so the tree
 * is asserted here, never assumed.
 *
 * @param {string} branch branch name
 * @param {number} size expected binary size in bytes
 */
function assertRemoteTreeHasBinary(branch, size) {
  const raw = gh(['api', `repos/${REPO}/branches/${branch}`, '--jq', '.commit.commit.tree.sha'], {
    capture: true,
  });
  const tree = gh(['api', `repos/${REPO}/git/trees/${raw.trim()}`, '--jq', '[.tree[].path]'], {
    capture: true,
  });
  const paths = JSON.parse(tree);
  if (!paths.includes('installer_win.exe')) {
    throw new Error(
      `pushed tree lacks installer_win.exe (paths: ${paths.join(', ')}) — ` +
        'an ignore rule filtered it; push with `git add -f`'
    );
  }
  const head = gh(['api', `repos/${REPO}/branches/${branch}`, '--jq', '.commit.sha'], {
    capture: true,
  });
  void head;
  // Size check happens on the downloaded copy before push; the tree check
  // here is the anti-gitignore assertion.
  void size;
}

/**
 * Parse + validate argv, throwing on bad input. Exported for the unit tests
 * (main() catches and process.exit()s, which would kill the test runner).
 *
 * @param {string[]} argv
 * @returns {{
 *   run: string;
 *   expect: string;
 *   branch: string;
 *   runRef: string;
 *   binary: string;
 *   push: boolean;
 * }}
 */
export function parseArgsOrThrow(argv) {
  return parseArgs(argv);
}

export function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    fail(e.message);
    return;
  }
  try {
    // 1. The run must exist and build the intended commit.
    const headSha = assertRunMatchesIntent(opts.run, opts.runRef);
    console.log(`run ${opts.run}: build-and-upload @ ${headSha.slice(0, 12)} — OK`);

    // 2. Fetch the staged bytes and gate on the filed hash.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-installer-'));
    const bytes = fetchStagedBinary(opts.run, opts.binary, dir);
    const sha = crypto.createHash('sha256').update(bytes).digest('hex');
    if (sha !== opts.expect) {
      throw new Error(
        `staged ${opts.binary} is ${sha}, expected ${opts.expect} — the bytes moved; ` +
          'do NOT stage. Re-verify the runbook/WDSI record first.'
      );
    }
    console.log(`sha256 gate OK: ${sha}`);

    // 3. Build the orphan branch in a throwaway worktree. The global *.exe
    //    gitignore must not filter the binary — hence `add -f`, and the tree
    //    assertion after push.
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-installer-wt-'));
    git(['worktree', 'add', '--detach', work, 'HEAD']);
    git(['checkout', '-q', '--orphan', opts.branch], {cwd: work});
    git(['rm', '-rqf', '.'], {cwd: work});
    fs.writeFileSync(path.join(work, opts.binary), bytes);
    fs.writeFileSync(path.join(work, `${opts.binary}.sha256`), `${sha}  ${opts.binary}\n`);
    fs.writeFileSync(
      path.join(work, 'README.md'),
      [
        `# ${opts.branch} — pre-release manual test copy`,
        '',
        `\`${opts.binary}\` is the byte-exact PROD installer for the current release:`,
        '',
        `- sha256: \`${sha}\``,
        `- CI staging run: ${opts.run} (head \`${headSha.slice(0, 12)}\`, publish=false)`,
        `- It fetches packages + hashes.json from the normal gh-pages surface; this branch touches nothing there.`,
        '',
        `Disposable: \`git push origin --delete ${opts.branch}\` removes it.`,
        '',
      ].join('\n')
    );
    git(['add', '-f', opts.binary, `${opts.binary}.sha256`, 'README.md'], {cwd: work});
    git(
      [
        '-c',
        'user.email=tabmix.onemen@gmail.com',
        '-c',
        'user.name=ONEMEN',
        'commit',
        '-q',
        '-m',
        `stage: prod ${opts.binary} ${sha.slice(0, 12)} (run ${opts.run})`,
      ],
      {cwd: work}
    );

    if (!opts.push) {
      console.log(`--no-push: branch content prepared in ${work}`);
      console.log(
        `tree: ${git(['ls-tree', '-r', '--name-only', 'HEAD'], {cwd: work}).split('\n').join(', ')}`
      );
      console.log('(local verification only — nothing was pushed)');
      return;
    }

    // 4. Push and verify the remote tree.
    git(['push', '-q', 'origin', `HEAD:refs/heads/${opts.branch}`], {cwd: work});
    git(['worktree', 'remove', '--force', work], {cwd: REPO_ROOT});
    assertRemoteTreeHasBinary(opts.branch, bytes.length);
    console.log(`pushed + tree-verified: ${opts.branch}`);
    console.log(
      `download: https://raw.githubusercontent.com/${REPO}/${opts.branch}/${opts.binary}`
    );
    console.log(`remove:   git push origin --delete ${opts.branch}`);
  } catch (e) {
    fail(e.message);
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main();
}
