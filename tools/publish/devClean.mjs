#!/usr/bin/env node

// tools/publish/devClean.mjs — remove dev-build-<id> branches and tags.
//
// `pnpm upload --mode=dev` publishes to a disposable `dev-build-<id>` branch
// (see publishMode.mjs) plus a release of the same name; over time those
// accumulate on origin and locally. This tool deletes them.
//
// Usage:
//   pnpm dev-clean --id <id>            delete one dev build
//                                         (<id> like `main-abc1234` or the full
//                                         `dev-build-main-abc1234` name)
//   pnpm dev-clean --all                prune every dev-build-* branch + tag
//   pnpm dev-clean --id <id> --dry-run  list what would be deleted, change nothing
//   pnpm dev-clean --all --local-only   skip remote (GitHub) deletion
//   pnpm dev-clean --all --remote-only  skip local (git) deletion
//
// Default scope is both local + remote. Local deletion uses git; remote uses
// the GitHub API with GITHUB_TOKEN_VAR (from .env). The current branch is never
// deleted. An --id that matches nothing fails loudly (no accidental globbing).

import {spawnSync} from 'node:child_process';
import {getGitHubToken, createOctokit, REPO_ROOT} from './publishCommon.mjs';
import {GITHUB_TOKEN_VAR, REPO_NAME, REPO_OWNER} from './paths.js';

const DEV_PREFIX = 'dev-build-';

/** Normalize a user-supplied id to the full dev-build-<id> ref name. */
export function normalizeId(raw) {
  const id = String(raw).trim();
  return id.startsWith(DEV_PREFIX) ? id : DEV_PREFIX + id;
}

/** Parse + validate CLI args (exported for unit tests). */
export function parseArgs(argv = process.argv.slice(2)) {
  const opts = {
    id: null,
    all: false,
    dryRun: false,
    localOnly: false,
    remoteOnly: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--id' && argv[i + 1]) {
      opts.id = normalizeId(argv[++i]);
    } else if (a === '--all') {
      opts.all = true;
    } else if (a === '--dry-run') {
      opts.dryRun = true;
    } else if (a === '--local-only') {
      opts.localOnly = true;
    } else if (a === '--remote-only') {
      opts.remoteOnly = true;
    } else if (a === '--help') {
      opts.help = true;
    } else {
      throw new Error(`Unknown argument '${a}'`);
    }
  }
  if (opts.help) return opts;
  if (opts.id && opts.all) {
    throw new Error('--id and --all are mutually exclusive');
  }
  if (!opts.id && !opts.all) {
    throw new Error(
      'Pass --id <id> to delete one dev build, or --all to prune every dev-build-* ref'
    );
  }
  if (opts.localOnly && opts.remoteOnly) {
    throw new Error('--local-only and --remote-only are mutually exclusive');
  }
  return opts;
}

/** Run git with an argument array (no shell), returning {status, stdout}. */
function git(args) {
  const res = spawnSync('git', args, {cwd: REPO_ROOT, encoding: 'utf-8'});
  if (res.error) throw res.error;
  return {status: res.status, stdout: res.stdout || ''};
}

/** Local dev-build branches + tags. */
export function listLocalRefs() {
  const {stdout} = git([
    'for-each-ref',
    `refs/heads/${DEV_PREFIX}*`,
    `refs/tags/${DEV_PREFIX}*`,
    '--format=%(refname)',
  ]);
  const branches = [];
  const tags = [];
  for (const line of stdout.split('\n')) {
    const name = line.trim();
    if (!name) continue;
    if (name.startsWith('refs/heads/')) branches.push(name.slice('refs/heads/'.length));
    else if (name.startsWith('refs/tags/')) tags.push(name.slice('refs/tags/'.length));
  }
  return {branches, tags};
}

/** Remote (origin) dev-build branches + tags via the GitHub API. */
export async function listRemoteRefs(octokit) {
  const branches = [];
  const tags = [];
  for (const kind of ['heads', 'tags']) {
    const {data} = await octokit.git.listMatchingRefs({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      ref: `${kind}/${DEV_PREFIX}`,
    });
    for (const ref of data) {
      (kind === 'heads' ? branches : tags).push(ref.ref.slice(`refs/${kind}/`.length));
    }
  }
  return {branches, tags};
}

/**
 * Decide which refs to delete for the given options.
 *
 * @param {{branches: string[]; tags: string[]}} local
 * @param {{branches: string[]; tags: string[]}} remote
 * @returns {{
 *   local: {branches: string[]; tags: string[]};
 *   remote: {branches: string[]; tags: string[]};
 * }}
 */
export function selectTargets(local, remote, opts) {
  // The lists arrive pre-filtered (listLocalRefs/listRemoteRefs), but re-check
  // the prefix so a non-dev-build ref can never be selected even if a future
  // caller stops pre-filtering.
  const pick = list =>
    (opts.all ? [...list]
    : list.includes(opts.id) ? [opts.id]
    : []
    ).filter(n => n.startsWith(DEV_PREFIX));
  return {
    local: {branches: pick(local.branches), tags: pick(local.tags)},
    remote: {branches: pick(remote.branches), tags: pick(remote.tags)},
  };
}

/** Current branch name ('' when git cannot tell). */
function currentBranch() {
  const {status, stdout} = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  return status === 0 ? stdout.trim() : '';
}

function deleteLocalBranch(name, dryRun) {
  if (name === currentBranch()) {
    console.log(`  SKIP ${name}: it is the current branch`);
    return true;
  }
  if (dryRun) {
    console.log(`  would delete branch ${name} (local)`);
    return true;
  }
  const {status} = git(['branch', '-D', name]);
  if (status === 0) console.log(`  ✓ deleted branch ${name} (local)`);
  return status === 0;
}

function deleteLocalTag(name, dryRun) {
  if (dryRun) {
    console.log(`  would delete tag ${name} (local)`);
    return true;
  }
  const {status} = git(['tag', '-d', name]);
  if (status === 0) console.log(`  ✓ deleted tag ${name} (local)`);
  return status === 0;
}

async function deleteRemoteRef(octokit, kind, name, dryRun) {
  if (dryRun) {
    console.log(`  would delete ${kind === 'heads' ? 'branch' : 'tag'} ${name} (origin)`);
    return true;
  }
  try {
    await octokit.git.deleteRef({owner: REPO_OWNER, repo: REPO_NAME, ref: `${kind}/${name}`});
    console.log(`  ✓ deleted ${kind === 'heads' ? 'branch' : 'tag'} ${name} (origin)`);
    return true;
  } catch (err) {
    console.error(
      `  ✗ could not delete ${kind === 'heads' ? 'branch' : 'tag'} ${name} (origin): ${err.message}`
    );
    return false;
  }
}

const usage = () =>
  console.log(`Usage: pnpm dev-clean --id <id> | --all [--dry-run] [--local-only | --remote-only]

  --id <id>            delete one dev build (<id> or full dev-build-<id> name)
  --all                prune every dev-build-* branch + tag
  --dry-run            list what would be deleted, change nothing
  --local-only         skip remote (GitHub) deletion
  --remote-only        skip local (git) deletion`);

/** Run the cleanup; returns the process exit code. */
export async function run(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    usage();
    return 0;
  }

  const local = listLocalRefs();
  let octokit = null;
  let remote = {branches: [], tags: []};
  if (!opts.localOnly) {
    const token = getGitHubToken();
    if (!token) {
      throw new Error(
        `${GITHUB_TOKEN_VAR} is not set — needed for remote cleanup. ` +
          `Create a root .env (see .env-example), or pass --local-only.`
      );
    }
    octokit = createOctokit(token);
    remote = await listRemoteRefs(octokit);
  }

  const targets = selectTargets(local, remote, opts);

  // An --id that matches nothing must fail loudly instead of globbing silently.
  if (opts.id && !opts.all) {
    const found = [
      ...targets.local.branches,
      ...targets.local.tags,
      ...targets.remote.branches,
      ...targets.remote.tags,
    ];
    if (found.length === 0) {
      const existing = [
        ...local.branches.map(n => `branch ${n} (local)`),
        ...local.tags.map(n => `tag ${n} (local)`),
        ...remote.branches.map(n => `branch ${n} (origin)`),
        ...remote.tags.map(n => `tag ${n} (origin)`),
      ];
      throw new Error(
        `No dev build matches '${opts.id}'. ` +
          (existing.length ?
            `Existing dev-build refs:\n  ${existing.join('\n  ')}`
          : 'No dev-build refs exist.')
      );
    }
  }

  let ok = true;
  for (const name of targets.local.branches) ok = deleteLocalBranch(name, opts.dryRun) && ok;
  for (const name of targets.local.tags) ok = deleteLocalTag(name, opts.dryRun) && ok;
  for (const name of targets.remote.branches) {
    if (name === currentBranch()) {
      console.log(`  SKIP ${name}: it is the current branch`);
      continue;
    }
    ok = (await deleteRemoteRef(octokit, 'heads', name, opts.dryRun)) && ok;
  }
  for (const name of targets.remote.tags)
    ok = (await deleteRemoteRef(octokit, 'tags', name, opts.dryRun)) && ok;

  if (opts.dryRun) console.log('\n(dry run — nothing was deleted)');
  return ok ? 0 : 1;
}

const isMain = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('devClean.mjs');
if (isMain) {
  run(process.argv.slice(2))
    .then(code => {
      process.exitCode = code;
    })
    .catch(err => {
      console.error('✗ Error:', err.message);
      process.exitCode = 1;
    });
}
