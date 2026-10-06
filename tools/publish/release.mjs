#!/usr/bin/env node
// tools/publish/release.mjs — thin alias for dispatching a publish to CI.
//
// Prod publishes are CI-only (ADR 0026, prodCiGuard.mjs): the complete
// cross-OS installer set is buildable only by the Pages publish workflow's
// per-OS matrix. This script is a discoverable front door for the dispatch:
// a PROD publish first runs the ~30 s drift-check probe (the same shared gate
// pages.yml enforces in-run), so a drift morning never burns a publish
// dispatch on a run the probe could have predicted would fail; on drift the
// URL watchdog is dispatched FOR the operator with the measured re-run timing
// (#347). Every step announces its expected duration before it starts — the
// terminal never blocks silently — and the re-run after remediation is
// explicit. The commands are repo-scoped (`--repo`), so no `gh repo
// set-default` is needed:
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
//   node tools/publish/release.mjs --include=installer,helper  # any ADR 0030 role list
//   node tools/publish/release.mjs --include=all --ref=<branch> # dispatch another branch's workflow
//   node tools/publish/release.mjs --include=all --force        # rebuild + re-upload even when unchanged
//
// There is no bare `pnpm publish` script — the pnpm presets above are the
// documented front doors, and this file is the generic form they wrap. It
// exists because `--include` is a UNION, so a preset cannot be narrowed to an
// exact role list (`publish:installer -- --include=packages` = installer AND
// packages); `--mode`, by contrast, is last-wins.
//
// The publish scope is OPT-IN and REQUIRED: `--include=<roles>` (or a preset
// above; `all` = full publish). A missing, empty or invalid --include fails
// loudly here — before any dispatch — instead of guessing a scope.
//
// The wrapper owns --force/--mode/--include/--ref (it maps them to the
// workflow inputs / gh flags); any other `-f key=value` is passed through to
// gh verbatim — through spawnSync's argv array, never a shell, so nothing is
// interpolated. The only thing the wrapper waits on is the pre-flight probe
// (~30 s) and, on drift, the watchdog dispatch announcement — never the
// publish matrix or any E2E. (--stage is the exception: it is the full local
// staging pipeline of tools/publish/stageFlow.mjs, which watches and downloads
// by design.) The workflow's own gates (main-only for prod, E2E-green commit,
// browser-version drift) are what the guard requires; this alias cannot
// bypass them, it merely pre-flights and triggers them.

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
/** The publish pre-flight probe: the shared drift gate, dispatchable (#347). */
const PROBE_WORKFLOW = 'drift-check.yml';
/** Dispatched for the operator when the probe reports drift. */
const WATCHDOG_WORKFLOW = 'url-watchdog.yml';
/**
 * Every gh call targets the repo explicitly — no `gh repo set-default`
 * dependency (#347).
 */
const REPO = 'onemen/firefox-scripts';

/**
 * gh argv prefix addressing REPO explicitly (the first two tokens of every gh
 * call).
 */
export function repoFlag() {
  return ['-R', REPO];
}

/** GitHub Actions run URL for a run id. */
export function runUrl(id) {
  return `https://github.com/${REPO}/actions/runs/${id}`;
}

/** ISO timestamp `deltaMs` from now — the dispatch-discovery window marker. */
export function nowIso(deltaMs = 0) {
  return new Date(Date.now() + deltaMs).toISOString();
}

/**
 * Hard cap on probe re-polls (~5 s apart → ~5 min): the probe finishes in ~30 s
 * in every measured run; the cap is the fail-open boundary, never the expected
 * wait.
 */
const PROBE_MAX_POLLS = 60;

/**
 * Discovery retries after a probe dispatch (2 s apart, ~20 s total): the run
 * record lags the dispatch API's 200 by seconds. A first-query miss must retry
 * here — fail-open on this race was the 2026-09-28 bug (a real drift verdict
 * went unread and the wrapper published into the in-run gate).
 */
const PROBE_DISCOVERY_RETRIES = 10;

/**
 * Consecutive gh errors tolerated while polling the probe's status before the
 * wait degrades to 'unobservable' (3 × 5 s ≈ 10 s of sustained failure). One
 * blip must not abandon a healthy probe (#361); a real gh outage should still
 * fail fast into the documented fail-open instead of burning the poll cap.
 */
const PROBE_ERROR_STREAK = 3;

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

/*
 * ── Pre-flight (the #347 probe-first design) ─────────────────────────────
 * A PROD publish first dispatches drift-check.yml — the same shared
 * .github/actions/drift-gate composite pages.yml enforces in-run — and waits
 * for its verdict (~30 s; the probe IS fast on purpose). Every wait is
 * announced with its expected duration; on drift the URL watchdog is
 * dispatched FOR the operator and the command exits with the measured re-run
 * timing. The re-run after remediation is explicit by design.
 */

/**
 * gh argv for the PROBE dispatch (main: the probe covers the commit a prod
 * publish will build).
 */
export function buildProbeArgs() {
  return [...repoFlag(), 'workflow', 'run', PROBE_WORKFLOW, '--ref', 'main'];
}

/**
 * A dispatch of `workflow` is not visible in the Actions list yet — the run
 * record lags the dispatch API's 200 by seconds (observed ~3 s on 2026-09-28: a
 * single discovery query fired too early, the wrapper failed open and
 * dispatched the real publish straight into the in-run gate, #347 follow-up).
 * Callers RETRY on this error; only a gh error (null) is fail-open.
 */
export class DispatchNotFoundError extends Error {}

/**
 * The newest workflow_dispatch run of `workflow` created at/after `afterIso`.
 * Event-filtered so a human's manual dispatch seconds earlier cannot be
 * mistaken for ours. Throws DispatchNotFoundError when gh answered but no run
 * is listed yet; returns null when gh itself failed (callers fail open).
 *
 * @param {string} workflow
 * @param {string} afterIso
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
  let runs;
  try {
    runs = JSON.parse(res.stdout).filter(r => r.event === 'workflow_dispatch');
  } catch {
    return null;
  }
  if (runs.length === 0) {
    throw new DispatchNotFoundError(`${workflow}: no dispatch run listed since ${afterIso} yet`);
  }
  return runs[0];
}

/**
 * A run's {status, conclusion} (null when gh errors).
 *
 * @param {number} runId
 * @returns {{status: string; conclusion: string | null} | null}
 */
export function getRunStatus(runId) {
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
 * Wait the probe run to completion (re-polls ~5 s apart; the probe is ~30 s
 * end-to-end, so a coarse poll and a hard round cap are enough). A single gh
 * error is a transient to retry (#361); 'unobservable' — the fail-open — is
 * reserved for SUSTAINED failure (PROBE_ERROR_STREAK consecutive errors) or the
 * poll cap, never one strike.
 *
 * @param {number} runId
 * @param {(ms: number) => void} [sleepFn] injectable sleep (tests)
 * @param {(
 *   id: number
 * ) => {status: string; conclusion: string | null} | null} [statusFn]
 * @returns {'success' | 'failure' | 'unobservable'}
 */
export function waitForProbeRun(
  runId,
  sleepFn = ms => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
  statusFn = getRunStatus
) {
  // A null status is a gh/network blip, not evidence about the run — a single
  // miss abandoned healthy probes on release day (issue #361: every 2026-09-28
  // drift-check run completed, yet "probe run lost" fired twice). Same lesson
  // as #350 for discovery: a transient is a race to retry. The fail-open
  // boundary is SUSTAINED failure (PROBE_ERROR_STREAK consecutive gh errors,
  // ~10 s) or the poll cap — never one strike.
  let errorStreak = 0;
  for (let attempt = 0; attempt < PROBE_MAX_POLLS; attempt++) {
    if (attempt > 0) sleepFn(5000);
    const st = statusFn(runId);
    if (st === null) {
      errorStreak += 1;
      if (errorStreak >= PROBE_ERROR_STREAK) return 'unobservable';
      continue;
    }
    errorStreak = 0;
    if (st.status === 'completed') return st.conclusion === 'success' ? 'success' : 'failure';
  }
  return 'unobservable';
}

/**
 * Pull the verdict + drift listing out of the probe run's LOG. The probe's
 * Report step renders the blocked browsers as error annotations
 * (`##[error]firefox-dev: 157.0b4 → 157.0b5`) plus one fixed remedy line —
 * exactly what `gh run view --log` shows once the run completed. The drift
 * lines are surfaced to the operator verbatim; the remedy line's shape picks
 * drift vs e2e-missing. Unparseable/gh-error → 'unobservable' (the caller fails
 * open; pages.yml re-checks in-run).
 *
 * @param {number} runId
 * @param {(argv: string[]) => {status: number; stdout: string} | null} [ghFn]
 * @returns {{
 *   verdict: 'green' | 'drift' | 'e2e-missing' | 'unobservable';
 *   drift: string[];
 * }}
 */
export function probeVerdict(runId, ghFn) {
  const run =
    ghFn ?? (argv => spawnSync('gh', argv, {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024}));
  const res = run([...repoFlag(), 'run', 'view', String(runId), '--log']);
  if (!res || res.status !== 0) return {verdict: 'unobservable', drift: []};
  const lines = (res.stdout || '')
    .split(/\r?\n/)
    .filter(line => line.includes('##[error]'))
    .map(line => line.replace(/^.*?##\[error\]/, '').trim())
    .filter(Boolean);
  const drift = lines.filter(l => /^[a-z-]+: \S.+ → /.test(l));
  const e2eMissing = lines.some(l => l.startsWith('no successful E2E workflow run'));
  if (e2eMissing && drift.length === 0) return {verdict: 'e2e-missing', drift};
  if (drift.length > 0) return {verdict: 'drift', drift};
  return {verdict: 'unobservable', drift: []};
}

/**
 * The PROD pre-flight, with the operator informed at every step: 'pre-flight:
 * checking browser versions + E2E coverage (~30 s)…' green → '✓ pre-flight
 * green — publishing.' drift → the listing + the watchdog dispatched FOR them +
 * measured re-run timing, then exit 1 (the re-run is explicit, #347).
 * e2e-missing → the E2E-for-commit remedy with its timing, exit 1. unobservable
 * → fail-open: name it, point at the run, and publish anyway — pages.yml's
 * in-run gate remains the moment of truth.
 *
 * @param {{
 *   dispatch?: (argv: string[]) => {status: number; stderr?: string} | null;
 *   find?: (workflow: string, afterIso: string) => {databaseId: number} | null;
 *   status?: (
 *     id: number
 *   ) => {status: string; conclusion: string | null} | null;
 *   verdict?: (id: number) => {verdict: string; drift: string[]};
 *   sleep?: (ms: number) => void;
 * }} [seams]
 *   injectable for the unit tests
 * @returns {{
 *   verdict: 'green' | 'drift' | 'e2e-missing' | 'unobservable';
 *   drift: string[];
 * }}
 */
export function runPreflight(seams = {}) {
  const dispatch = seams.dispatch ?? (argv => spawnSync('gh', argv, {encoding: 'utf8'}));
  const find = seams.find ?? findNewestDispatch;
  const status = seams.status ?? getRunStatus;
  const verdictOf = seams.verdict ?? probeVerdict;
  const sleep =
    seams.sleep ?? (ms => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms));

  console.log('pre-flight: checking browser versions + E2E coverage (~30 s)…');
  const afterIso = nowIso(-5000);
  const res = dispatch(buildProbeArgs());
  if (!res || res.status !== 0) {
    console.error(
      `  ✗ could not dispatch ${PROBE_WORKFLOW}${res?.stderr ? ` — ${(res.stderr || '').trim()}` : ''}.\n` +
        '  Continuing WITHOUT pre-flight — pages.yml checks the same gates in-run.\n' +
        '  (is `gh` installed and logged in? `gh auth status`)'
    );
    return {verdict: 'green', drift: []};
  }
  // Discovery retries: the run record lags the dispatch API by seconds, and
  // publishing past an unread probe is exactly the bug this loop prevents —
  // "not listed YET" is a race to retry. Exhausted discovery STOPS the
  // publish; a gh ERROR stays fail-open (documented contract; CodeRabbit PR
  // #350) — pages.yml re-checks the gates in-run either way.
  let probe = null;
  let discoveryExhausted = false;
  for (let attempt = 1; attempt <= PROBE_DISCOVERY_RETRIES; attempt++) {
    try {
      probe = find(PROBE_WORKFLOW, afterIso);
      break;
    } catch (e) {
      if (!(e instanceof DispatchNotFoundError)) throw e;
      if (attempt === PROBE_DISCOVERY_RETRIES) {
        discoveryExhausted = true;
        break;
      }
      console.log('  (probe run not listed yet — retrying discovery…)');
      sleep(2000);
    }
  }
  if (discoveryExhausted) {
    console.error(
      `  ✗ the probe dispatch went through but its run never appeared in the\n` +
        `  Actions list (${PROBE_DISCOVERY_RETRIES} attempts over ~${PROBE_DISCOVERY_RETRIES * 2} s) — STOPPING, not\n` +
        `  publishing unread: check ${PROBE_WORKFLOW} manually, then re-run this command.\n` +
        `  https://github.com/${REPO}/actions`
    );
    return {verdict: 'unobservable', drift: []};
  }
  if (!probe) {
    // gh error (null), not a race: the documented fail-open.
    console.log(
      `  (could not read the probe run — continuing; pages.yml checks the\n` +
        `  same gates in-run)\n  https://github.com/${REPO}/actions`
    );
    return {verdict: 'green', drift: []};
  }
  const outcome = waitForProbeRun(probe.databaseId, sleep, status);
  if (outcome === 'unobservable') {
    console.log(
      `  (probe run lost — continuing; pages.yml checks the same gates in-run)\n` +
        `  ${runUrl(probe.databaseId)}`
    );
    return {verdict: 'green', drift: []};
  }
  if (outcome === 'success') {
    return {verdict: 'green', drift: []};
  }
  const {verdict, drift} = verdictOf(probe.databaseId);
  if (verdict === 'green') {
    // The run failed but the verdict says green (e.g. the report step only):
    // surface it and continue — the in-run gate re-checks anyway.
    console.log(
      `  (probe run reported failure without a drift verdict — continuing)\n  ${runUrl(probe.databaseId)}`
    );
    return {verdict: 'green', drift: []};
  }
  if (verdict === 'drift') {
    console.error(
      `✗ pre-flight: browser version drift — publishing would ship to a browser version no E2E has validated:\n` +
        drift.map(d => `    - ${d}`).join('\n') +
        `\n  → dispatching the URL watchdog for you now (re-baselines the browsers +\n` +
        `    dispatches their browser E2E; measured chain: watchdog ~1 min, E2E ~10–15 min —\n` +
        `    the E2E page shows RED on 'snap Firefox E2E · ubuntu-24.04' while the snap-store\n` +
        `    outage (#291) lasts; it still records and unblocks the publish).\n` +
        `  → re-run this command in ~15 min; the publish itself takes ~4 min.`
    );
    const wdRes = dispatch([...repoFlag(), 'workflow', 'run', WATCHDOG_WORKFLOW, '--ref', 'main']);
    if (!wdRes || wdRes.status !== 0) {
      console.error(
        `  ✗ the watchdog auto-dispatch failed — run it manually:\n` +
          `    gh workflow run url-watchdog.yml --ref main --repo ${REPO}`
      );
      return {verdict: 'drift', drift};
    }
    // The watchdog run URL is cosmetic — the dispatch IS the remediation. A
    // discovery miss here must not escape runPreflight (CodeRabbit PR #350):
    // retry briefly, then degrade to printing the notice without a URL.
    let wdRun = null;
    for (let attempt = 1; attempt <= PROBE_DISCOVERY_RETRIES; attempt++) {
      try {
        wdRun = find(WATCHDOG_WORKFLOW, afterIso);
        break;
      } catch (e) {
        if (!(e instanceof DispatchNotFoundError)) throw e;
        if (attempt === PROBE_DISCOVERY_RETRIES) break;
        sleep(2000);
      }
    }
    console.error(
      `  ✓ url-watchdog dispatched${wdRun ? ` — ${runUrl(wdRun.databaseId)}` : ''}.\n` +
        `  Re-run THIS command when the chain is done — it pre-flights again and publishes.`
    );
    return {verdict: 'drift', drift};
  }
  // e2e-missing: the E2E run for this commit has not finished (or never ran).
  console.error(
    `✗ pre-flight: no successful E2E workflow run for this commit yet —\n` +
      `  the publish would be blocked in-run. Let the E2E run on main finish\n` +
      `  (typically ~10–15 min including queue; watch:\n` +
      `    gh run list --workflow e2e.yml --commit <sha> --repo ${REPO}\n` +
      `  or re-dispatch it manually), then re-run this command.`
  );
  return {verdict: 'e2e-missing', drift};
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
  // The pre-flight probe runs before a PROD dispatch only: dev publishes are
  // disposable, skip the gates, and keep the plain fire-and-forget UX.
  if (opts.mode === 'prod') {
    const preflight = runPreflight();
    if (preflight.verdict === 'green') {
      console.log('✓ pre-flight green — publishing.');
    } else {
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
  console.log(
    `✓ ${opts.mode.toUpperCase()} ${what} dispatched — the cross-OS matrix builds in CI.\n` +
      `  Watch: ${watchHint} (or the Actions tab).`
  );
}

// Direct invocation only (imported by the unit tests for buildDispatchArgs).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => {
    console.error(`\u2718 release: ${e.message}`);
    process.exitCode = 1;
  });
}
