#!/usr/bin/env node
// tools/publish/release.mjs — thin alias for dispatching a publish to CI.
//
// Prod publishes are CI-only (ADR 0026, prodCiGuard.mjs): the complete
// cross-OS installer set is buildable only by the Pages publish workflow's
// per-OS matrix. This script is a discoverable front door for the dispatch —
// exactly `gh workflow run pages.yml`, nothing more:
//
//   pnpm publish:all                   # full prod publish (mode defaults to prod)
//   pnpm publish:packages              # zips + updater-ui only (--include=packages)
//   pnpm publish:installer             # installer + helper only (--include=installer)
//   pnpm publish:dev                   # dev-build-<id> branch instead (--mode=dev)
//   pnpm release:stage -- --ref=<branch>  # STAGE-ONLY: build-and-upload.yml publish=false —
//                                         # CI-built bytes for the WDSI submission, publishes nothing
//                                      # (--ref accepts branch/tag; a commit SHA resolves to the
//                                      # branch containing it — the dispatch API takes no SHAs)
//   pnpm publish -- --include=installer,helper   # any ADR 0030 role list
//   pnpm publish -- --include=all --ref=<branch> # dispatch another branch's workflow
//   pnpm publish -- --include=all --force        # rebuild + re-upload even when unchanged
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
// Canonical scrub of the ambient git overlays (GIT_DIR/GIT_INDEX_FILE/…): git
// exports them into hooks, and under the pre-push hook they point at the
// checkout being pushed — an unscrubbed query from a linked worktree would
// read the wrong repository (proven 2026-09-27: a worktree push's GIT_DIR
// redirected test-repo git calls at the shared checkout's ref store).
import {gitEnv} from './generateBuildDates.mjs';

const WORKFLOW = 'pages.yml';

/**
 * The workflow-dispatches API (`gh workflow run --ref`) dispatches only refs
 * that exist ON GITHUB — branch or tag names. A commit SHA is rejected with
 * "HTTP 422: No ref found" (how `release:stage -- --ref=<sha>` failed on
 * 2026-09-27, run 36298110515's dispatch, short and full SHA), and so is a
 * LOCAL-ONLY branch: the endpoint looks at the remote repository, not this
 * checkout (proven the same day — a local feature branch 422'd exactly like the
 * SHA). Resolve a SHA to a remote-tracked branch or tag containing it:
 *
 * 1. `git fetch --quiet` first — a freshly merged main commit is unknown to the
 *    local remote-tracking refs until then, and the refs are what the
 *    resolution reads. A failed fetch (offline) only warns.
 * 2. A hex-WORD that names an existing TAG or remote-tracked branch is a NAME, not
 *    a SHA — it passes through (named refs win over hash interpretation). A
 *    hex-WORD naming only a LOCAL branch fails with the local-only error: the
 *    dispatch API cannot see it.
 * 3. Candidates: remote-tracked branches ON `origin` — the repository these
 *    dispatches target — whose TIP contains the commit (`git branch -r
 *    --contains`) and tags containing it (`git tag --contains`). Candidates
 *    from other remotes are ignored: their names belong to a different
 *    repository on GitHub, and dispatching one here could build a branch of the
 *    wrong repo (CodeRabbit review of this very fix). `origin/HEAD` (a symref
 *    alias, not a name) is skipped; `<remote>/x` maps to the plain `x` the API
 *    expects.
 * 4. Preference: an `origin` branch whose remote tip IS the commit (exact identity
 *    — the fresh-merge case: `origin/main` at the just-merged sha), then a tag
 *    whose target is the commit, then any containing branch — for those the run
 *    builds that ref's target commit, not the requested one, and the notice
 *    says so (exactness is DECIDED, not assumed: the selected ref's commit is
 *    resolved and compared).
 *
 * Non-SHA refs (branch/tag names) pass through untouched: gh already dispatches
 * them and errors loudly for unknown ones.
 *
 * @param {string} ref the --ref value (SHA, branch or tag)
 * @param {string} [cwd] where git runs (tests pass a throwaway repo)
 * @returns {string} a branch/tag name gh can dispatch
 * @throws when the SHA resolves to no commit or no remote-tracked ref contains
 *   it
 */
export function resolveDispatchRef(ref, cwd = process.cwd()) {
  // Not SHA-shaped (6-40 hex) — pass branches/tags through untouched.
  if (!/^[0-9a-f]{6,40}$/i.test(ref)) {
    return ref;
  }
  const env = gitEnv();
  const git = (args, okEmpty = false) => {
    const res = spawnSync('git', args, {cwd, encoding: 'utf8', env});
    const out = (res.stdout || '').trim();
    if (res.status !== 0 || (!okEmpty && out === '')) return '';
    return out;
  };
  // Named dispatchable refs win over SHA interpretation: a hex-WORD branch or
  // tag name ('deadbeef') must reach gh as the NAME, never be read as a hash.
  // Only tag/remote-tracked names pass — the set the dispatch API can see.
  const namedDispatchable = git(
    ['for-each-ref', '--format=%(refname)', `refs/tags/${ref}`, `refs/remotes/*/${ref}`],
    true
  );
  if (namedDispatchable) {
    return ref;
  }
  // A hex-WORD naming only a LOCAL branch would 422 like a SHA (the API
  // dispatches only refs that exist on GitHub) — say so instead of silently
  // resolving the name as if it were a hash of some other commit.
  if (git(['for-each-ref', '--format=%(refname)', `refs/heads/${ref}`], true)) {
    throw new Error(
      `--ref '${ref}' names a local-only branch (no remote-tracking twin). The dispatch ` +
        'API only sees refs that exist on GitHub — push the branch first, or dispatch the ' +
        'remote branch or tag that contains that commit.'
    );
  }
  // Disambiguate the SHA to a full commit id; empty/failed → not a commit here.
  const sha = git(['rev-parse', '--quiet', '--verify', `${ref}^{commit}`]);
  if (!sha) {
    throw new Error(
      `--ref '${ref}' looks like a commit SHA but git cannot resolve it in this ` +
        'repository (unknown or garbage-collected commit). Pass a branch or tag name.'
    );
  }
  const short = sha.slice(0, 12);
  // A freshly merged commit is invisible to the remote-tracking refs until a
  // fetch brings it; the resolution below reads exactly those refs.
  const fetched = spawnSync('git', ['fetch', '--quiet'], {cwd, encoding: 'utf8', env});
  if (fetched.status !== 0) {
    console.error(
      'release: WARNING — git fetch failed; resolving against possibly stale remote-tracking refs.'
    );
  }
  // Remote-tracked branches on ORIGIN whose TIP contains the commit — origin
  // is the repository the dispatch targets, so candidates from other remotes
  // ('upstream', a fork) must not leak in: their plain names belong to a
  // different GitHub repo, and dispatching one here could build a branch of
  // the wrong repo. `<remote>/x` maps to plain `x` (the API's spelling);
  // `*/HEAD` symref aliases are not names.
  const branches = [];
  for (const line of git(['branch', '-r', '--format=%(refname)', '--contains', sha], true).split(
    '\n'
  )) {
    const full = line.trim();
    if (!full.startsWith('refs/remotes/')) continue;
    const withoutPrefix = full.slice('refs/remotes/'.length);
    const slash = withoutPrefix.indexOf('/');
    if (slash <= 0) continue;
    const remote = withoutPrefix.slice(0, slash);
    const plain = withoutPrefix.slice(slash + 1);
    if (remote !== 'origin' || !plain || plain === 'HEAD') continue;
    branches.push({full, plain});
  }
  // Tags containing the commit — dispatchable AND commit-exact.
  const tags = git(['tag', '--contains', sha], true)
    .split('\n')
    .map(name => name.trim())
    .filter(Boolean);
  // Branches whose remote tip IS the commit: exact identity, the fresh-merge
  // case. Everything else builds the branch tip, never the commit itself.
  const tipExact = branches
    .filter(({full}) => git(['rev-parse', '--quiet', '--verify', full]) === sha)
    .map(({plain}) => plain);
  const rest = branches
    .filter(({full}) => git(['rev-parse', '--quiet', '--verify', full]) !== sha)
    .map(({plain}) => plain);
  const candidates = [...new Set([...tipExact, ...tags, ...rest])];
  if (candidates.length === 0) {
    throw new Error(
      `--ref '${ref}' (${short}) resolves to a commit that no remote-tracked branch or tag ` +
        `on 'origin' contains. The workflow-dispatches API dispatches only refs that exist ` +
        'on GitHub (branch/tag names — never SHAs, never local-only branches). Options: ' +
        'dispatch a remote branch that contains the commit (e.g. --ref=main), push a branch ' +
        'at it, or tag it.'
    );
  }
  // Exactness is DECIDED, not assumed: `git tag --contains` also lists tags
  // whose target is a DESCENDANT of the commit, and a non-exact branch builds
  // its tip — resolve the selected ref's actual commit and compare.
  const selected = candidates[0];
  const selectedFull = branches.find(({plain}) => plain === selected)?.full;
  const selectedTip =
    tags.includes(selected) ? git(['rev-parse', '--quiet', '--verify', `${selected}^{commit}`])
    : selectedFull ? git(['rev-parse', '--quiet', '--verify', selectedFull])
    : '';
  const exact = selectedTip === sha;
  const caveat = exact ? '' : ` — the run builds that ref's target commit, not ${short} itself`;
  const order = candidates.length > 1 ? ` (containing: ${candidates.join(', ')})` : '';
  console.error(
    `release: --ref '${ref}' is a commit SHA; dispatching '${candidates[0]}' instead` +
      `${order}${caveat}.`
  );
  return candidates[0];
}

/**
 * gh argv for the dispatch (exported for the unit tests).
 *
 * @param {{
 *   force?: boolean;
 *   mode?: string;
 *   include?: string[];
 *   ref?: string;
 *   stage?: boolean;
 *   passthrough?: string[];
 * }} opts
 */
export function buildDispatchArgs({
  force = false,
  mode = 'prod',
  include = [],
  ref = '',
  stage = false,
  passthrough = [],
} = {}) {
  // --stage targets the build-and-upload workflow in its stage-only default:
  // publish=false builds + stages the ship-bound bytes and uploads them as
  // run artifacts — no publish target is touched (the WDSI staging run).
  const args = ['workflow', 'run', stage ? 'build-and-upload.yml' : WORKFLOW];
  // gh dispatches the default branch unless told otherwise — a dev publish
  // from a feature branch needs --ref to point at that branch's workflow.
  if (ref) args.push('--ref', ref);
  args.push('-f', `mode=${mode}`);
  if (stage) args.push('-f', 'publish=false');
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
    stage: false,
    passthrough: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') continue;
    if (a === '--stage') {
      opts.stage = true;
    } else if (a === '--force') {
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
      if (!opts.ref) throw new Error('--ref= needs a branch, tag or commit SHA');
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
        `Unknown flag: ${a} (supported: --stage, --force, --mode=prod|dev, --include=<roles>, --ref=<branch>, -f key=value)`
      );
    }
  }
  if (opts.include.length === 0) {
    throw new Error(
      'Missing --include=<roles> — state what this run publishes ' +
        '(packages|installer|helper, comma-separated, or all).\n' +
        '  Presets: pnpm publish:all / publish:packages / publish:installer / publish:dev'
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
  // The dispatch API accepts only branch/tag refs — resolve a SHA --ref to a
  // containing branch before dispatching (loud failure when it cannot be).
  if (opts.ref) {
    try {
      opts.ref = resolveDispatchRef(opts.ref);
    } catch (e) {
      console.error(`Dispatch failed: ${e.message}`);
      process.exitCode = 1;
      return;
    }
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
  if (opts.stage) {
    console.log(
      `✓ STAGE-ONLY ${opts.mode.toUpperCase()} dispatch sent to build-and-upload.yml (publish=false).
` +
        '  Nothing is published — the staged bytes land in the staged-<os> artifacts.\n' +
        '  Watch:   gh run list --workflow build-and-upload.yml --limit 1\n' +
        '  Then:    pnpm fetch:release -- --run <run-id>   # download for the manual test\n' +
        '  And:     pnpm scan:vt <downloaded installer> <downloaded helper>  # WDSI evidence'
    );
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
