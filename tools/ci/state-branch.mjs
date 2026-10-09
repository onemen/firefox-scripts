#!/usr/bin/env node

/**
 * tools/ci/state-branch.mjs — the durable home of the CI state the publish gate
 * and the status table both read (#462).
 *
 * Two files used to live only in `actions/cache` entries:
 *
 * .watchdog/baseline.json keyed url-watchdog-baseline-<run_id>
 * .watchdog-validated/validated.json keyed browser-validated-<run_id>
 *
 * Actions caches are best-effort storage: a 7-day idle TTL, the 10 GB per-repo
 * cap and the nightly `prune-caches.mjs --keep=3` all reach them. On 2026-10-06
 * the repo crossed the cap and GitHub's LRU eviction took both — every browser
 * reported "first run", the E2E-validated column went to `⏳ none` even though
 * the meta issue's rolling comment carried the versions, the nightly re-paid
 * ~900 MB of hashing, and the prod publish pre-flight failed closed because an
 * evicted record is indistinguishable from "never validated" (#462).
 *
 * The fix is the one ADR 0036 already applied to build dates: load-bearing
 * state gets a durable home. Both files are committed to a small ORPHAN branch,
 * `watchdog-state`, which is artifact-only in the sense of ADR 0031 — it is
 * never seeded from `main` and carries nothing but these files. The watchers
 * push after a fetch-with-retry; the readers fetch. The caches are gone rather
 * than kept as an accelerator: two homes for one file means the stale one is
 * indistinguishable from the fresh one, which is the bug.
 *
 * Why git plumbing instead of a checkout or a scratch clone: the state files
 * are written by tools that already ran in the job's checkout, the job already
 * has the publisher's credentials in the checkout's remote, and nothing here
 * may touch the working tree, the index, or the checked-out commit.
 * `hash-object -w`
 *
 * - `ls-tree` + `mktree` + `commit-tree` + `push` do exactly that — no temp
 *   commit, no second worktree, no token copied into a remote URL. The tree is
 *   built FROM the fetched parent (`ls-tree` of the tip, with our entries
 *   replaced), so a push never drops the file the other writer owns; a rejected
 *   push is a retry that re-reads the fresh tip, which is what makes two
 *   concurrent writers (the nightly watchdog and the E2E record job) safe.
 *
 * Usage:
 *
 * node tools/ci/state-branch.mjs fetch [<name>...] # default: every file node
 * tools/ci/state-branch.mjs push <name>... # explicit, never guess
 *
 * Names are the branch-relative file names (baseline.json, validated.json); the
 * local copy comes from the same env vars the tools already honor —
 * BASELINE_DIR and VALIDATED_DIR — so no caller has to repeat a path. Both the
 * git commands and those default paths are relative to the process's own
 * working directory, which is the checked-out repo in CI: running against some
 * other checkout (the one this file happens to live in) is how a push picks up
 * the wrong remote — and, in this repo, the wrong pre-push gate.
 *
 * Exit codes: `push` fails the job on any git error (a state write that did not
 * land must be loud). `fetch` fails on a git error too, EXCEPT when the branch
 * or the file simply does not exist yet — that is the first-run path, and it is
 * silent by design (the readers already render "no state" honestly). A real
 * fetch failure must not be confused with "no state": that is precisely how the
 * eviction masqueraded as a first run.
 *
 * Requires `contents: write` on the pushing job (the readers need only
 * `contents: read` — the checkout's own scope).
 */

import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** The orphan branch that holds the state files (ADR 0046). */
export const STATE_BRANCH = 'watchdog-state';

/**
 * Branch-relative name → where a local copy belongs. Mirrors the env contract
 * the two files' writers and readers already use (`VALIDATED_DIR` is
 * record-validated-versions.mjs's own var name).
 */
export const STATE_FILES = {
  'baseline.json': {envDir: 'BASELINE_DIR', defaultDir: '.watchdog'},
  'validated.json': {envDir: 'VALIDATED_DIR', defaultDir: '.watchdog-validated'},
};

/**
 * The commit identity a state commit carries when the environment does not
 * provide one. `actions/checkout` leaves the job without a
 * `user.name`/`user.email`, and `git commit-tree` refuses to run without one;
 * the bot identity is the honest author for a machine-written state commit. A
 * caller that sets GIT_AUTHOR_* / GIT_COMMITTER_* in its env keeps that
 * identity instead.
 */
const DEFAULT_IDENTITY = {
  GIT_AUTHOR_NAME: 'github-actions[bot]',
  GIT_AUTHOR_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
  GIT_COMMITTER_NAME: 'github-actions[bot]',
  GIT_COMMITTER_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
};

/** How many times a rejected push re-reads the fresh tip before giving up. */
const PUSH_ATTEMPTS = 3;

/**
 * Environment keys that would point git at a DIFFERENT repository than the one
 * in `cwd`. Every git hook exports `GIT_DIR` (and friends) to its children, so
 * a `pnpm test` under the repo's pre-push hook runs with the checkout's `.git`
 * already in the environment — and a state push that silently targeted another
 * repository would be the worst failure this tool can have: it commits a
 * stranger's tree to the state branch. The contract here is "the repo you are
 * standing in", so those keys are dropped rather than honoured.
 */
const REPOSITORY_REDIRECTING_ENV = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_PREFIX',
  'GIT_CEILING_DIRECTORIES',
  'GIT_QUARANTINE_PATH',
  'GIT_NAMESPACE',
];

/**
 * Drop the repository-redirecting keys, keeping everything else (identity,
 * token, run metadata).
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {NodeJS.ProcessEnv}
 */
function cleanGitEnv(env) {
  const out = {...env};
  for (const key of REPOSITORY_REDIRECTING_ENV) delete out[key];
  return out;
}

/**
 * The fetched branch's remote-tracking ref — also the `git show` source.
 *
 * @returns {string}
 */
function trackingRef() {
  return `refs/remotes/origin/${STATE_BRANCH}`;
}

/**
 * Map names to their local files, validating the names.
 *
 * @param {string[]} names branch-relative file names
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [cwd] the checkout the paths are resolved against
 * @returns {{name: string; file: string}[]}
 */
export function resolveTargets(names, env = process.env, cwd = process.cwd()) {
  return names.map(name => {
    const spec = STATE_FILES[name];
    if (!spec) {
      throw new Error(
        `unknown state file ${JSON.stringify(name)} — known: ${Object.keys(STATE_FILES).join(', ')}`
      );
    }
    const dir = env[spec.envDir] || path.join(cwd, spec.defaultDir);
    return {name, file: path.join(dir, name)};
  });
}

/**
 * Run one git command. Buffers in/out so a blob survives the trip byte-for-byte
 * (`git show` of a state file is written back verbatim, never re-encoded).
 *
 * @param {string[]} args
 * @param {{cwd: string; input?: Buffer | string; env?: NodeJS.ProcessEnv}} opts
 * @returns {{status: number; stdout: Buffer; stderr: string}}
 */
function git(args, {cwd, input, env = process.env}) {
  const res = spawnSync('git', args, {
    cwd,
    input,
    // A missing credential must fail the job, never leave it hanging on a
    // credential prompt (there is no tty to answer one).
    env: {...cleanGitEnv(env), GIT_TERMINAL_PROMPT: '0'},
    maxBuffer: 16 * 1024 * 1024,
  });
  if (res.error) throw res.error;
  return {
    status: res.status ?? 1,
    stdout: res.stdout ?? Buffer.alloc(0),
    stderr: (res.stderr ?? Buffer.alloc(0)).toString('utf8'),
  };
}

/**
 * A git error, carrying the command so the message names what failed.
 *
 * @param {string[]} args
 * @param {{stderr: string}} res
 * @returns {Error}
 */
function gitError(args, res) {
  return new Error(`git ${args.join(' ')} failed: ${res.stderr.trim() || 'unknown error'}`);
}

/** Whether a fetch failure means "the branch does not exist yet". */
const ABSENT_REF_RE = /couldn't find remote ref|remote ref .* not found/i;

/**
 * Fetch the state branch into the remote-tracking ref.
 *
 * @param {{cwd: string; log: (line: string) => void}} opts
 * @returns {boolean} false when the branch does not exist yet (first run)
 */
function fetchBranch({cwd, log}) {
  // `+` forces the local ref to follow a branch that was rewritten/created; the
  // depth keeps it to the tip, which is all a push's parent needs.
  const args = ['fetch', '--depth=1', 'origin', `+refs/heads/${STATE_BRANCH}:${trackingRef()}`];
  const res = git(args, {cwd});
  if (res.status === 0) return true;
  if (ABSENT_REF_RE.test(res.stderr)) {
    log(`state: no ${STATE_BRANCH} branch yet — first run`);
    return false;
  }
  throw gitError(args, res);
}

/**
 * The tip commit of the fetched branch, or '' when it has none.
 *
 * @param {string} cwd
 * @returns {string}
 */
function tipCommit(cwd) {
  const res = git(['rev-parse', '--verify', '--quiet', trackingRef()], {cwd});
  return res.status === 0 ? res.stdout.toString('utf8').trim() : '';
}

/**
 * When a state file was last written: the committer date of the newest commit
 * that touched it, falling back to the tip's date. The local mtime is set from
 * this so the watchdog's cache-hit telemetry ("written … ago") keeps its
 * meaning — a fresh checkout would otherwise always report "0 s ago" and hide a
 * state that stopped updating weeks ago.
 *
 * @param {string} cwd
 * @param {string} name branch-relative file name
 * @param {string} tip
 * @returns {Date | null}
 */
function lastWritten(cwd, name, tip) {
  for (const args of [
    ['log', '-1', '--format=%cI', tip, '--', name],
    ['log', '-1', '--format=%cI', tip],
  ]) {
    const res = git(args, {cwd});
    const iso = res.status === 0 ? res.stdout.toString('utf8').trim() : '';
    if (iso) {
      const when = new Date(iso);
      if (Number.isFinite(when.getTime())) return when;
    }
  }
  return null;
}

/**
 * Read the requested state files out of the branch into their local paths.
 *
 * Best-effort by design for the two "nothing there" cases — no branch (first
 * run) and no file on it — because every reader already renders absent state
 * honestly. Any other failure throws: a fetch that errored must never look like
 * a cold cache, which is the exact confusion #462 was.
 *
 * @param {string[]} names
 * @param {{
 *   cwd?: string;
 *   env?: NodeJS.ProcessEnv;
 *   log?: (line: string) => void;
 * }} [opts]
 * @returns {Promise<{name: string; present: boolean}[]>}
 */
export async function fetchState(
  names,
  {cwd = process.cwd(), env = process.env, log = console.log} = {}
) {
  const targets = resolveTargets(names, env, cwd);
  if (!fetchBranch({cwd, log})) {
    return targets.map(t => ({name: t.name, present: false}));
  }
  const tip = tipCommit(cwd);
  return targets.map(({name, file}) => {
    const res = git(['show', `${trackingRef()}:${name}`], {cwd});
    if (res.status !== 0) {
      log(`state: ${STATE_BRANCH} carries no ${name} — leaving it absent`);
      return {name, present: false};
    }
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, res.stdout);
    const when = lastWritten(cwd, name, tip);
    if (when) fs.utimesSync(file, when, when);
    log(`state: ${name} ← ${STATE_BRANCH} (written ${when ? when.toISOString() : 'unknown'})`);
    return {name, present: true};
  });
}

/**
 * Commit the named local files to the state branch and push them.
 *
 * The tree is the fetched parent's tree with our entries replaced, so a commit
 * never drops the other writer's file. A push that is rejected (the other
 * writer pushed first) re-reads the fresh tip and rebuilds — the parent's tree
 * is the merge, and each writer only ever replaces its own file, so the two
 * converge. An unchanged tree is not committed at all: state that did not
 * change should not add a commit per nightly run.
 *
 * @param {string[]} names
 * @param {{
 *   cwd?: string;
 *   env?: NodeJS.ProcessEnv;
 *   log?: (line: string) => void;
 * }} [opts]
 * @returns {Promise<{name: string; commit: string | null}[]>}
 */
export async function pushState(
  names,
  {cwd = process.cwd(), env = process.env, log = console.log} = {}
) {
  const targets = resolveTargets(names, env, cwd);
  const missing = targets.filter(t => !fs.existsSync(t.file));
  if (missing.length > 0) {
    throw new Error(
      `refusing to push missing state file(s): ${missing.map(t => t.name).join(', ')} — ` +
        'the caller writes the file before pushing it'
    );
  }
  const message = `state: ${names.join(', ')} (run ${env.GITHUB_RUN_ID || 'local'})`;
  const identity = {...DEFAULT_IDENTITY, ...env};

  for (let attempt = 1; attempt <= PUSH_ATTEMPTS; attempt++) {
    const hadBranch = fetchBranch({cwd, log});
    const parent = hadBranch ? tipCommit(cwd) : '';
    if (hadBranch && !parent) {
      throw new Error(`fetched ${STATE_BRANCH} but could not resolve its tip`);
    }

    // Parent tree entries, verbatim (`<mode> <type> <sha>\t<name>`) — the exact
    // shape `git mktree` reads back.
    const entries = new Map();
    if (parent) {
      const res = git(['ls-tree', parent], {cwd});
      if (res.status !== 0) throw gitError(['ls-tree', parent], res);
      for (const line of res.stdout.toString('utf8').split('\n')) {
        if (!line) continue;
        const [meta, name] = line.split('\t');
        if (name) entries.set(name, meta);
      }
    }

    for (const {name, file} of targets) {
      const args = ['hash-object', '-w', '--stdin', '--no-filters'];
      const res = git(args, {cwd, input: fs.readFileSync(file)});
      if (res.status !== 0) throw gitError(args, res);
      entries.set(name, `100644 blob ${res.stdout.toString('utf8').trim()}`);
    }

    const mktreeArgs = ['mktree'];
    const treeRes = git(mktreeArgs, {
      cwd,
      input: [...entries].map(([name, meta]) => `${meta}\t${name}\n`).join(''),
    });
    if (treeRes.status !== 0) throw gitError(mktreeArgs, treeRes);
    const tree = treeRes.stdout.toString('utf8').trim();

    if (parent) {
      const parentTreeRes = git(['rev-parse', `${parent}^{tree}`], {cwd});
      if (parentTreeRes.status !== 0) throw gitError(['rev-parse'], parentTreeRes);
      if (parentTreeRes.stdout.toString('utf8').trim() === tree) {
        log(`state: ${names.join(', ')} unchanged — nothing to push`);
        return targets.map(t => ({name: t.name, commit: null}));
      }
    }

    const commitArgs = ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', message];
    const commitRes = git(commitArgs, {cwd, env: identity});
    if (commitRes.status !== 0) throw gitError(commitArgs, commitRes);
    const commit = commitRes.stdout.toString('utf8').trim();

    const pushArgs = ['push', 'origin', `${commit}:refs/heads/${STATE_BRANCH}`];
    const pushRes = git(pushArgs, {cwd, env: identity});
    if (pushRes.status === 0) {
      log(`state: pushed ${names.join(', ')} to ${STATE_BRANCH} (${commit.slice(0, 7)})`);
      return targets.map(t => ({name: t.name, commit}));
    }
    if (attempt === PUSH_ATTEMPTS) throw gitError(pushArgs, pushRes);
    log(
      `state: push attempt ${attempt} rejected — ${pushRes.stderr.trim() || 'no stderr'} — ` +
        're-reading the tip and retrying'
    );
  }
  // Unreachable: the loop returns or throws on its last attempt.
  throw new Error(`push to ${STATE_BRANCH} did not converge`);
}

/** The CLI's usage text. */
const USAGE = `usage: node tools/ci/state-branch.mjs <fetch|push> [<name>...]

  fetch [<name>...]  materialize state files from the ${STATE_BRANCH} branch
                     (default: every known file)
  push  <name>...    commit + push the named local state files (explicit)

known files: ${Object.keys(STATE_FILES).join(', ')}`;

async function main() {
  const [command, ...names] = process.argv.slice(2);
  if (command === 'fetch') {
    await fetchState(names.length > 0 ? names : Object.keys(STATE_FILES));
    return;
  }
  if (command === 'push') {
    if (names.length === 0) {
      // An implicit "push everything" is how a job ends up publishing state it
      // never wrote — e.g. the E2E record job pushing a stale baseline.json it
      // happened to have in the checkout.
      throw new Error(`push needs at least one file name\n\n${USAGE}`);
    }
    await pushState(names);
    return;
  }
  console.log(USAGE);
  if (command !== undefined && command !== '--help') process.exit(1);
}

// Guard on basename so tests can import the helpers without running the CLI
// (same pattern as check-browser-downloads.mjs).
const isMain = process.argv[1] && path.basename(process.argv[1]) === 'state-branch.mjs';
if (isMain) {
  main().catch(err => {
    console.error(`✗ ${err.message}`);
    process.exit(1);
  });
}
