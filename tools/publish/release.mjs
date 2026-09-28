#!/usr/bin/env node
// tools/publish/release.mjs — thin alias for dispatching a publish to CI.
//
// Prod publishes are CI-only (ADR 0026, prodCiGuard.mjs): the complete
// cross-OS installer set is buildable only by the Pages publish workflow's
// per-OS matrix. This script is a discoverable front door for the dispatch —
// `gh workflow run pages.yml` with an explicit --repo (works without
// `gh repo set-default`, #347) — then, for a prod dispatch, it carries the run
// to completion: watches the pre-publish gate and, when drift (or a missing
// E2E-for-commit record) blocks it, remediates automatically — dispatch the
// URL watchdog / the E2E workflow, wait for the browser validations they
// trigger, re-dispatch the publish — so ONE command finishes the job. The only
// stops are real validation failures (the gate blocking twice, a failed
// publish job) or losing sight of the run (the gates themselves stay in
// pages.yml; this wrapper only chains them):
//
//   pnpm publish:all                   # full prod publish (mode defaults to prod)
//   pnpm publish:packages              # zips + updater-ui only (--include=packages)
//   pnpm publish:installer             # installer + helper only (--include=installer)
//   pnpm publish:dev                   # dev-build-<id> branch instead (--mode=dev)
//   pnpm release:stage                    # THE staging command (one local command): resolves the
//                                         # release commit (origin/main tip or --ref), reuses the existing
//                                         # successful build-and-upload staging run for it (or dispatches
//                                         # one, publish=false — never publishes), waits, downloads the full
//                                         # staged-<os> artifact of this machine's OS (--os=<platform> to
//                                         # override) into dist/release-stage-<short-commit>/ and writes
//                                         # SUMMARY.md there — run id + URL, per-file sha256, VT/Microsoft
//                                         # status (local API; hash lookup first), the WDSI paste block and
//                                         # Next steps. Interrupt-safe: re-running resumes (the run exists).
//                                         # (--ref accepts branch/tag/SHA; a SHA is staged exactly.)
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
// interpolated. After a prod dispatch the wrapper watches its run through the
// Actions API (job list + run status) to a verdict; everything the remediation
// chain needs is already in the workflows it dispatches. (--stage is the exception: it is the full
// local staging pipeline of tools/publish/stageFlow.mjs, which watches and
// downloads by design.) The workflow's own gates (main-only for prod,
// E2E-green commit, browser-version drift) are what the guard requires; this
// alias cannot bypass them, it merely triggers them.

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
const WATCHDOG_WORKFLOW = 'url-watchdog.yml';
const E2E_WORKFLOW = 'e2e.yml';
/**
 * Every gh call targets the repo explicitly — no `gh repo set-default`
 * dependency (#347).
 */
const REPO = 'onemen/firefox-scripts';
/** pages.yml's first job; the publish matrix never starts while it is red. */
const GATE_JOB = 'check browser version drift';
/**
 * The gate's drift step (the "Check browser version drift" run block in
 * pages.yml).
 */
const DRIFT_STEP = 'Check browser version drift';
/**
 * The gate's E2E-for-commit step — needs a real E2E run; the wrapper cannot
 * needs one; the chain dispatches one.
 */
const E2E_STEP_PREFIX = 'Require a successful E2E run for this commit';
/** The E2E job that writes the validated-versions record the publish gate reads. */
const RECORD_JOB = 'record validated browser versions';

/**
 * Total budget for one wrapper run's whole remediation chain (watchdog wait +
 * browser E2E + re-dispatch ×3 attempts). The E2E is the long pole (~10–15 min
 * in recent runs); 45 min covers a chain that remediates twice and still
 * catches the normal day in well under an hour.
 */
const PUBLISH_CHAIN_BUDGET_MIN = 45;

/** Blocking sleep that never keeps the event loop alive past the wait. */
const defaultSleep = ms => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * One Actions job as returned by `gh api repos/<repo>/actions/runs/<id>/jobs`.
 *
 * @typedef {{
 *   name: string;
 *   conclusion: string | null;
 *   steps?: {name: string; conclusion: string | null}[];
 * }} GhJob
 */

/**
 * gh argv prefix addressing REPO explicitly (first two tokens of every gh
 * call).
 */
export function repoFlag() {
  return ['-R', REPO];
}

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
 * gh argv for the dispatch (exported for the unit tests). The STAGING dispatch
 * lives in stageFlow.mjs — --stage never reaches this function.
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
  const args = [...repoFlag(), 'workflow', 'run', WORKFLOW];
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
    stage: false,
    os: '',
    passthrough: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') continue;
    if (a === '--stage') {
      opts.stage = true;
    } else if (a.startsWith('--os=')) {
      opts.os = a.slice('--os='.length).trim();
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
  // --stage is the full local pipeline (stageFlow.mjs): the scope is always
  // the full staging run, so --include does not apply; --os is its only knob
  // besides --ref.
  if (opts.stage) {
    if (opts.include.length > 0) {
      throw new Error('--include does not apply to --stage (the staging run is always full-scope)');
    }
    return opts;
  }
  if (opts.os) {
    throw new Error('--os is a --stage option (release:stage)');
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

/** GitHub Actions run URL for a run id. */
function runUrl(id) {
  return `https://github.com/${REPO}/actions/runs/${id}`;
}

/**
 * Newest workflow_dispatch run of `workflow` created at/after `afterIso` — the
 * run this wrapper (or its watchdog chain) just dispatched. Event-filtered so a
 * human's manual dispatch seconds earlier cannot be mistaken for ours, and
 * repo-scoped so no gh default-repo is needed (#347). Returns null when gh
 * errors — every caller fails open to the fire-and-forget UX.
 *
 * @param {string} workflow workflow file name
 * @param {string} afterIso ISO timestamp from just before the dispatch
 * @returns {{databaseId: number} | null}
 */
export function findNewestDispatch(workflow, afterIso) {
  const res = spawnSync(
    'gh',
    [
      ...repoFlag(),
      'run',
      'list',
      '--workflow',
      workflow,
      '--created',
      `>=${afterIso.replace(/\.\d+Z$/, 'Z')}`,
      '--limit',
      '5',
      '--json',
      'databaseId,event',
    ],
    {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024}
  );
  if (res.error || res.status !== 0) return null;
  try {
    const runs = JSON.parse(res.stdout).filter(r => r.event === 'workflow_dispatch');
    return runs[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Classify the dispatched run's gate job from the API's job list (pure — the
 * unit tests drive it). `pending` covers queued/in-progress AND a job list that
 * raced the run creation (no gate job yet): the caller re-polls.
 *
 * @param {GhJob[]} jobs
 * @returns {{
 *   outcome: 'green' | 'drift' | 'e2e-missing' | 'failed' | 'pending';
 *   detail?: string;
 * }}
 */
export function classifyGateJobs(jobs) {
  const gate = (jobs ?? []).find(j => j.name === GATE_JOB);
  if (!gate || gate.conclusion === null || gate.conclusion === 'skipped') {
    return {outcome: 'pending'};
  }
  if (gate.conclusion === 'success') return {outcome: 'green'};
  const failedSteps = (gate.steps ?? []).filter(s => s.conclusion === 'failure').map(s => s.name);
  if (failedSteps.includes(DRIFT_STEP)) return {outcome: 'drift'};
  if (failedSteps.some(n => n.startsWith(E2E_STEP_PREFIX))) return {outcome: 'e2e-missing'};
  return {outcome: 'failed', detail: failedSteps.join(', ') || gate.conclusion};
}

function gateJobs(runId) {
  const res = spawnSync(
    'gh',
    [...repoFlag(), 'api', `repos/${REPO}/actions/runs/${runId}/jobs?per_page=10`],
    {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024}
  );
  if (res.error || res.status !== 0) return null;
  try {
    return JSON.parse(res.stdout).jobs;
  } catch {
    return null;
  }
}

/**
 * Watch a run's gate job to a conclusion: one immediate read plus re-polls ~20
 * s apart. `pending` (job not finished / run racing its own creation) keeps the
 * loop going; the caller's clock (`hasTime`) bounds it — out of budget or an
 * unobservable run (gh error) return 'unobservable', never a wrong verdict.
 *
 * @param {number} runId the run's databaseId
 * @param {(ms: number) => void} sleepFn injectable sleep (tests)
 * @param {(id: number) => GhJob[] | null} fetchJobs injectable job fetch
 *   (tests)
 * @param {() => boolean} hasTime injectable clock check (tests)
 * @returns {{
 *   outcome: 'green' | 'drift' | 'e2e-missing' | 'failed' | 'unobservable';
 *   detail?: string;
 * }}
 */
export function watchGateJob(runId, sleepFn, fetchJobs, hasTime) {
  for (let attempt = 0; ; attempt++) {
    if (attempt > 0) {
      if (!hasTime()) return {outcome: 'unobservable'};
      sleepFn(20000);
    }
    const jobs = fetchJobs(runId);
    if (jobs === null) return {outcome: 'unobservable'};
    const {outcome, detail} = classifyGateJobs(jobs);
    if (outcome === 'pending') continue;
    return detail === undefined ? {outcome} : {outcome, detail};
  }
}

/**
 * The API's run status/conclusion (or null when gh fails).
 *
 * @param {number} runId
 * @returns {{status: string; conclusion: string | null} | null}
 */
function runStatus(runId) {
  const res = spawnSync('gh', [...repoFlag(), 'api', `repos/${REPO}/actions/runs/${runId}`], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (res.error || res.status !== 0) return null;
  try {
    const j = JSON.parse(res.stdout);
    return {status: j.status, conclusion: j.conclusion};
  } catch {
    return null;
  }
}

/**
 * Wait a run to completion (re-polls ~20 s apart, bounded by `hasTime`).
 * Queued-vs-running does not matter here — only the final conclusion does.
 *
 * @param {number} runId
 * @param {(ms: number) => void} sleepFn
 * @param {(
 *   id: number
 * ) => {status: string; conclusion: string | null} | null} statusFn
 * @param {() => boolean} hasTime
 * @returns {'success' | 'failure' | 'unobservable'}
 */
export function waitForRun(runId, sleepFn, statusFn, hasTime) {
  for (let attempt = 0; ; attempt++) {
    if (attempt > 0) {
      if (!hasTime()) return 'unobservable';
      sleepFn(20000);
    }
    const st = statusFn(runId);
    if (st === null) return 'unobservable';
    if (st.status === 'completed') return st.conclusion === 'success' ? 'success' : 'failure';
  }
}

/**
 * Wait one e2e.yml run's `record validated browser versions` job to a
 * conclusion — the job that writes the validated-versions record the publish
 * gate reads. It only RUNS in the full-matrix dispatch (browser=all): a
 * single-browser fork escape skips it (its own record job covers forks only),
 * which surfaces as 'not-applicable' — the caller moves on to the next run.
 * Re-polls ~20 s apart, bounded by `hasTime`.
 *
 * @param {number} runId an e2e.yml run's databaseId
 * @param {(ms: number) => void} sleepFn
 * @param {(id: number) => GhJob[] | null} fetchJobs
 * @param {() => boolean} hasTime
 * @returns {'success' | 'failure' | 'not-applicable' | 'unobservable'}
 */
export function waitForValidationRecord(runId, sleepFn, fetchJobs, hasTime) {
  for (let attempt = 0; ; attempt++) {
    if (attempt > 0) {
      if (!hasTime()) return 'unobservable';
      sleepFn(20000);
    }
    const jobs = fetchJobs(runId);
    if (jobs === null) return 'unobservable';
    const rec = (jobs ?? []).find(j => j.name === RECORD_JOB);
    if (rec && rec.conclusion === 'success') return 'success';
    if (rec && rec.conclusion === 'failure') return 'failure';
    if (rec && rec.conclusion === 'skipped') return 'not-applicable';
  }
}

/** Dispatch the URL watchdog on main (the drift path's remediation). */
function dispatchWatchdog() {
  return spawnSync('gh', [...repoFlag(), 'workflow', 'run', WATCHDOG_WORKFLOW, '--ref', 'main'], {
    encoding: 'utf8',
  });
}

/**
 * The workflow_dispatch e2e.yml runs created at/after `afterIso` — the set the
 * watchdog (or this wrapper) dispatched for the remediation: the fork escapes
 * plus the one full-matrix run. Empty when gh fails or none yet (the dispatches
 * lag the watchdog by seconds).
 *
 * @param {string} afterIso
 * @returns {{databaseId: number}[]}
 */
function findE2EDispatches(afterIso) {
  const res = spawnSync(
    'gh',
    [
      ...repoFlag(),
      'run',
      'list',
      '--workflow',
      E2E_WORKFLOW,
      '--created',
      `>=${afterIso.replace(/\.\d+Z$/, 'Z')}`,
      '--limit',
      '10',
      '--json',
      'databaseId,event',
    ],
    {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024}
  );
  if (res.error || res.status !== 0) return [];
  try {
    return JSON.parse(res.stdout).filter(r => r.event === 'workflow_dispatch');
  } catch {
    return [];
  }
}

/**
 * The drift chain, one command: wait for the freshly dispatched watchdog
 * (re-baselines the drifted browsers + dispatches their E2E), then wait until
 * one of those E2E runs records the browser validation the publish gate
 * requires, then re-dispatch the publish and re-watch its gate. Fork escapes
 * run concurrently and finish earlier, but their record job is skipped — only
 * the full-matrix run writes what the gate reads, so 'not-applicable'
 * candidates are passed over and discovery re-runs (~20 s apart) until the full
 * run appears and finishes. This loop is bounded ONLY by the chain budget: the
 * E2E is the long pole (~10–15 min in recent runs, red on the snap leg — #291 —
 * while record-validation still records).
 *
 * @param {(ms: number) => void} sleepFn
 * @param {() => boolean} hasTime
 * @param {{databaseId: number} | null} wdRun the already-dispatched watchdog
 * @returns {'validated' | 'watchdog-failed' | 'validation-failed' | 'unobservable'}
 */
export function awaitValidation(sleepFn, hasTime, wdRun, fetchJobs, statusFn, discover) {
  if (wdRun) {
    console.log(
      `  ✓ url-watchdog dispatched — ${runUrl(wdRun.databaseId)}\n` +
        `    re-baselining the drifted browsers and dispatching their browser E2E…`
    );
    const wd = waitForRun(wdRun.databaseId, sleepFn, statusFn, hasTime);
    if (wd !== 'success') {
      console.error(
        wd === 'failure' ?
          '  ✗ the url-watchdog run failed — see it before re-publishing.'
        : '  ✗ lost sight of the url-watchdog run (gh error or out of time).'
      );
      return wd === 'failure' ? 'watchdog-failed' : 'unobservable';
    }
    console.log('  ✓ watchdog green — browser versions re-baselined, browser E2E dispatched.');
  }
  for (;;) {
    const runs = discover();
    for (const run of runs) {
      const rec = waitForValidationRecord(run.databaseId, sleepFn, fetchJobs, hasTime);
      if (rec === 'success') return 'validated';
      if (rec === 'failure') {
        console.error(
          `  ✗ the browser E2E did NOT record a validation — an E2E leg failed:\n` +
            `    ${runUrl(run.databaseId)}\n` +
            `    (the snap leg failing is #291 and does not block recording — a real\n` +
            `    firefox/firefox-dev/waterfox leg failure does. See the run.)`
        );
        return 'validation-failed';
      }
      if (rec === 'unobservable') return 'unobservable';
      // 'not-applicable': a fork escape — the full-matrix run is elsewhere.
    }
    if (!hasTime()) return 'unobservable';
    sleepFn(20000);
  }
}

export async function main() {
  let opts;
  try {
    opts = parseReleaseArgs();
  } catch (e) {
    console.error(String(e.message));
    process.exitCode = 1;
    return;
  }
  // --stage never reaches the dispatchers below: it IS the local staging
  // pipeline (reuse-or-dispatch → watch → download → SUMMARY.md). The raw
  // --ref goes through untouched — stageFlow stages the exact SHA, it does
  // not need the dispatch API's branch-name resolution.
  if (opts.stage) {
    try {
      const {runStageFlow} = await import('./stageFlow.mjs');
      await runStageFlow({ref: opts.ref, os: opts.os || undefined});
    } catch (e) {
      console.error(`\u2718 release:stage — ${e.message}`);
      process.exitCode = 1;
    }
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
  const what =
    opts.include[0] === 'all' || opts.include.length === INCLUDE_ROLES.length ?
      'full publish'
    : `PARTIAL publish — publishing: ${opts.include.join(', ')}`;
  const watchHint = `gh run list --workflow pages.yml --limit 1 --repo ${REPO}`;
  // Dev publishes are disposable and skip the gates — no chain, no watch.
  if (opts.mode !== 'prod') {
    console.log(
      `✓ ${opts.mode.toUpperCase()} ${what} dispatched — the cross-OS matrix builds in CI.\n` +
        `  Watch: ${watchHint} (or the Actions tab).`
    );
    return;
  }
  // Prod carries the run to completion: watch the gate; on a block, remediate
  // automatically (watchdog / E2E), wait for the browser validations, and
  // re-dispatch — ONE command, no re-run (#347). The only stops are real
  // validation failures, a gate that blocks twice in one chain (needs a human
  // decision), or losing sight of the run; the chain budget bounds the total
  // wait (the E2E is the long pole: ~10–15 min in recent runs).
  const deadline = Date.now() + PUBLISH_CHAIN_BUDGET_MIN * 60_000;
  const hasTime = () => Date.now() < deadline;
  let dispatchedAt = new Date(Date.now() - 5000).toISOString();
  let verdict = null;
  for (let chainAttempt = 1; chainAttempt <= 3; chainAttempt++) {
    const run = findNewestDispatch(WORKFLOW, dispatchedAt);
    if (!run) {
      console.log(
        `✓ ${opts.mode.toUpperCase()} ${what} dispatched — could not identify the run to watch it:\n` +
          `  ${watchHint}`
      );
      return;
    }
    console.log(`✓ dispatched — watching the pre-publish gate (${runUrl(run.databaseId)})…`);
    const watched = watchGateJob(run.databaseId, defaultSleep, gateJobs, hasTime);
    if (watched.outcome === 'green') {
      verdict = {kind: 'green', runId: run.databaseId};
      break;
    }
    if (watched.outcome === 'unobservable') {
      verdict = {kind: 'unobservable', runId: run.databaseId};
      break;
    }
    if (watched.outcome === 'failed') {
      verdict = {kind: 'failed', detail: watched.detail, runId: run.databaseId};
      break;
    }
    // Blocked: remediate. Drift → the watchdog (covers every drifted browser
    // AND the full-matrix E2E whose record job writes what the gate reads);
    // e2e-missing → the E2E workflow directly.
    let wdRun = null;
    if (watched.outcome === 'drift') {
      console.error(
        `✗ pre-publish gate: new browser version(s) since the last watchdog run —\n` +
          `  remediating automatically (no re-run needed; #347).\n` +
          `  ${runUrl(run.databaseId)}`
      );
      const wdRes = dispatchWatchdog();
      if (wdRes.error || wdRes.status !== 0) {
        verdict = {kind: 'watchdog-dispatch-failed'};
        break;
      }
      wdRun = findNewestDispatch(WATCHDOG_WORKFLOW, dispatchedAt);
    } else {
      console.error(
        `✗ pre-publish gate: no successful E2E workflow run for this commit yet —\n` +
          `  dispatching it automatically (no re-run needed; #347).\n` +
          `  ${runUrl(run.databaseId)}`
      );
      const e2eRes = spawnSync(
        'gh',
        [...repoFlag(), 'workflow', 'run', E2E_WORKFLOW, '--ref', 'main', '-f', 'browser=all'],
        {encoding: 'utf8'}
      );
      if (e2eRes.error || e2eRes.status !== 0) {
        verdict = {kind: 'e2e-dispatch-failed'};
        break;
      }
    }
    const outcome = awaitValidation(
      defaultSleep,
      hasTime,
      wdRun && wdRun.databaseId ? wdRun : null,
      gateJobs,
      runStatus,
      () => findE2EDispatches(dispatchedAt)
    );
    if (outcome === 'watchdog-failed') {
      verdict = {kind: 'watchdog-failed'};
      break;
    }
    if (outcome === 'validation-failed') {
      verdict = {kind: 'validation-failed'};
      break;
    }
    if (outcome === 'unobservable') {
      verdict = {kind: 'unobservable-chain'};
      break;
    }
    console.log('  ✓ browser validations recorded — re-dispatching the publish…');
    const redispatchRes = spawnSync('gh', buildDispatchArgs(opts), {encoding: 'utf8'});
    if (redispatchRes.error || redispatchRes.status !== 0) {
      verdict = {kind: 'redispatch-failed'};
      break;
    }
    // Discovery bounds runs by creation time: move the marker forward so the
    // next iteration watches the run we JUST dispatched, never the completed
    // one the loop already remediated.
    dispatchedAt = new Date(Date.now() - 5000).toISOString();
  }
  if (!verdict) verdict = {kind: 'blocked-three-times'};
  switch (verdict.kind) {
    case 'green':
      console.log(
        `✓ pre-publish gate green — ${opts.mode.toUpperCase()} ${what} is building in CI.\n` +
          `  Watch: ${watchHint}\n` +
          `  ${runUrl(verdict.runId)}`
      );
      return;
    case 'unobservable':
      console.error(
        `✗ lost sight of the run (gh error) — the publish may still be running; follow it:\n` +
          `  ${watchHint}\n` +
          `  ${runUrl(verdict.runId)}`
      );
      process.exitCode = 1;
      return;
    case 'unobservable-chain':
      console.error(
        `✗ lost sight of the remediation chain (gh error or the ${PUBLISH_CHAIN_BUDGET_MIN}-min\n` +
          `  budget ran out) — the runs may still be going; follow them, then re-run this command:\n` +
          `  ${watchHint}`
      );
      process.exitCode = 1;
      return;
    case 'failed':
      console.error(
        `✗ pre-publish gate failed (${verdict.detail}) — see the run before re-dispatching.\n` +
          `  ${runUrl(verdict.runId)}`
      );
      process.exitCode = 1;
      return;
    case 'watchdog-dispatch-failed':
      console.error(
        `  the url-watchdog auto-dispatch failed — run it manually, then re-run this command:\n` +
          `    gh workflow run url-watchdog.yml --ref main --repo ${REPO}`
      );
      process.exitCode = 1;
      return;
    case 'e2e-dispatch-failed':
      console.error(
        `  the E2E auto-dispatch failed — run it manually, then re-run this command:\n` +
          `    gh workflow run e2e.yml --ref main -f browser=all --repo ${REPO}`
      );
      process.exitCode = 1;
      return;
    case 'watchdog-failed':
      console.error('  ✗ the url-watchdog run failed — resolve it, then re-run this command.');
      process.exitCode = 1;
      return;
    case 'validation-failed':
      console.error(
        '  ✗ browser E2E validation failed — resolve the failing leg, then re-run this command.'
      );
      process.exitCode = 1;
      return;
    case 'redispatch-failed':
      console.error(
        '  ✗ the automatic re-dispatch failed — the validations are done; just re-run this command.'
      );
      process.exitCode = 1;
      return;
    default:
      console.error(
        `✗ the pre-publish gate blocked three times in one chain (a browser kept releasing,\n` +
          `  or something is oscillating) — this needs a human decision; inspect the runs,\n` +
          `  then re-run this command:\n` +
          `  ${watchHint}`
      );
      process.exitCode = 1;
      return;
  }
}

// Direct invocation only (imported by the unit tests for buildDispatchArgs).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => {
    console.error(`\u2718 release: ${e.message}`);
    process.exitCode = 1;
  });
}
