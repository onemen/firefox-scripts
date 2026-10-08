// tools/ci/batch-review.mjs — local batched CodeRabbit review across PRs.
//
// The CodeRabbit free plan allows ~1 review/hour (shared between the bot and
// the CLI), so reviewing each PR separately burns the quota. This script
// merges the heads of several PR branches onto ONE temp branch and runs a
// single `cr review` over the combined diff — one quota slot, N PRs.
//
// Usage and the full flag list: `node tools/ci/batch-review.mjs --help` (the
// canonical copy is the USAGE constant below, so the help text cannot drift
// from what the parser accepts).
//
// After the review the script prints the findings it could anchor, writes them
// to dist/review/batch-findings.json for the ADR 0020 posting step, and points
// at the protocol; it also sweeps cr's own coderabbit-update-* temp dirs.
//
// Exit codes: 0 = review ran (or dry-run); 2 = nothing to review / bad usage;
//             3 = cr failed; 4 = CodeRabbit rate limit hit (retry later).
//// Notes:
//   - Local use needs only a browser login: run `cr auth login` once (device
//     flow, no API key). An agentic API key (cr-...) is required only for
//     headless CI — see the headless integration docs; user API keys are
//     rejected by the CLI.
//   - On rate limit the CLI does not retry automatically; this script detects
//     the condition and tells you, or waits and retries once with --wait.
//   - cr's findings carry a file + line range in the terminal output (an OSC-8
//     hyperlink plus a plain `path:from-to` label). parseFindings() extracts
//     them so the agent can post line-anchored review threads straight from the
//     report instead of re-deriving the anchor from the diff.
// - `git worktree` is used so your current checkout is never touched; the
//   temp branch lives in a scratch worktree under the repo's .git.
// - After the review, the temp branch and worktree are removed and your
//   checkout is left exactly as it was.

import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';

const REPO = 'onemen/firefox-scripts';

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts});
  if (res.error) throw res.error;
  if (res.status !== 0 && !opts.ignoreFail) {
    throw new Error(`${cmd} ${args.join(' ')} exited ${res.status}: ${res.stderr?.trim()}`);
  }
  return res;
}

function gh(args, opts = {}) {
  return run('gh', args, opts);
}

/**
 * The canonical usage text — `--help` prints exactly this. It lives here, not
 * only in the header comment, because an agent (or a human) who asks for help
 * cannot see a comment: before this existed, `--help` fell into the
 * unknown-flag branch and answered "Unknown flag: --help" while the complete
 * flag list sat unread a few lines up in the same file.
 */
export const USAGE = `Usage (from a clean-enough checkout, on main):

  node tools/ci/batch-review.mjs --pr 57 --pr 59
  node tools/ci/batch-review.mjs --branch buffy/37-install-applies --branch buffy/53-manual-install-updater
  node tools/ci/batch-review.mjs --open            # all open PR branches
  node tools/ci/batch-review.mjs --open --since 3d  # PRs updated recently
  node tools/ci/batch-review.mjs --pr 57 --agent    # pass --agent to cr
  node tools/ci/batch-review.mjs --check           # show cr usage report only
  node tools/ci/batch-review.mjs --pr 57 --wait 60 # retry once after an hour if rate-limited

Flags:
  --pr <number>      GitHub PR number (resolves to its head branch). Repeatable.
  --branch <ref>     Git branch/ref to include. Repeatable.
  --open             Include every open PR's head branch.
  --since <age>      With --open, only PRs updated within <age> (e.g. 3d, 12h).
  --base <ref>       Branch to merge onto (default: origin/main).
  --keep             Keep the temp branch after review (default: delete).
  --agent            Pass --agent to cr review (structured findings).
  --dry-run          List what would be merged without running cr.
  --check            Show \`cr usage\` (period review count + reset date) and exit.
  --wait <minutes>   If cr is rate-limited, wait this long and retry once.
  --temp-grace <min> Age below which a coderabbit-update-* dir in %TEMP% is
                     treated as possibly in use by another cr run (default 30).
  -h, --help         Print this text and exit.

After a review the findings report is written to dist/review/batch-findings.json
and archived under review-history/; both are gitignored local artifacts, and the
ADR 0020 posting protocol applies to the findings.`;

export function parseArgs(argv) {
  const args = {
    prs: [],
    branches: [],
    open: false,
    since: null,
    base: 'origin/main',
    keep: false,
    agent: false,
    dryRun: false,
    check: false,
    help: false,
    wait: null,
    tempGrace: 30,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const value = () => argv[++i];
    switch (argv[i]) {
      case '--pr': {
        const raw = value();
        const n = Number(raw);
        if (!Number.isInteger(n) || n <= 0) throw new Error(`Invalid --pr: ${raw ?? ''}`);
        args.prs.push(n);
        break;
      }
      case '--branch': {
        const v = value();
        if (!v) throw new Error('Missing value for --branch');
        args.branches.push(v);
        break;
      }
      case '--open':
        args.open = true;
        break;
      case '--since': {
        const v = value();
        if (!v) throw new Error('Missing value for --since');
        args.since = v;
        break;
      }
      case '--base': {
        const v = value();
        if (!v) throw new Error('Missing value for --base');
        args.base = v;
        break;
      }
      case '--keep':
        args.keep = true;
        break;
      case '--agent':
        args.agent = true;
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--check':
        args.check = true;
        break;
      case '-h':
      case '--help':
        args.help = true;
        break;
      case '--wait':
        args.wait = Number(value());
        if (!Number.isFinite(args.wait) || args.wait < 0) {
          throw new Error(`Invalid --wait minutes: ${argv[i - 1]}`);
        }
        break;
      case '--temp-grace':
        args.tempGrace = Number(value());
        if (!Number.isFinite(args.tempGrace) || args.tempGrace < 0) {
          throw new Error(`Invalid --temp-grace minutes: ${argv[i - 1]}`);
        }
        break;
      case '--':
        // pnpm forwards the `--` separator to the script; ignore it.
        break;
      default:
        throw new Error(`Unknown flag: ${argv[i]}`);
    }
  }
  return args;
}

// Match the CLI's rate-limit / quota messaging (the GitHub bot reports
// "Review rate limit exceeded"; the CLI exits non-zero with similar text).
const RATE_LIMIT_RE =
  /rate[ -]?limit|quota|exhausted|too many (requests|reviews)|\b429\b|try again later/i;
export function isRateLimited(output) {
  return RATE_LIMIT_RE.test(String(output || ''));
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Convert a --since age like '3d' or '12h' to a Unix timestamp (seconds).
// jq's `now` is seconds, so we compute the cutoff in JS and pass it as a
// number instead of evaluating arithmetic in jq.
export function ageToUnixSeconds(age) {
  const m = /^(\d+)([smhdw])$/.exec(String(age || ''));
  if (!m) throw new Error(`Invalid --since age: ${age} (use e.g. 30d, 12h, 30m)`);
  const mult = {s: 1, m: 60, h: 3600, d: 86400, w: 604800}[m[2]];
  return Math.floor(Date.now() / 1000) - Number(m[1]) * mult;
}

/**
 * @param {{since?: string}} [opts] --since age (e.g. '30d'); absent = no age
 *   filter
 */
function openPrBranches({since} = {}) {
  const jq =
    since ?
      `.[] | select(.updatedAt >= ${ageToUnixSeconds(since)}) | .headRefName`
    : '.[] | .headRefName';
  const out = gh([
    'pr',
    'list',
    '-R',
    REPO,
    '--state',
    'open',
    '--json',
    'headRefName,updatedAt',
    '--jq',
    jq,
  ]);
  return parseOpenPrBranchesOutput(out.stdout);
}

function prHeadBranch(pr) {
  const out = gh([
    'pr',
    'view',
    String(pr),
    '-R',
    REPO,
    '--json',
    'headRefName',
    '--jq',
    '.headRefName',
  ]);
  return out.stdout.trim();
}

function worktreePath() {
  return join(tmpdir(), `cr-batch-${process.pid}`);
}

/**
 * Tear down the temp review worktree (and its branch, unless kept).
 *
 * `git worktree remove --force` alone is not enough on Windows: it can fail the
 * filesystem delete partway (deep node_modules paths exceeding MAX_PATH) while
 * still deregistering the worktree, leaving a husk dir behind that the script
 * would never name. So the removal is layered: the git remove first
 * (authoritative for the registration), then a plain recursive delete of
 * whatever is left of the directory, then `git worktree prune` (cleans a
 * registration that outlived its directory), and a loud warning only if the
 * directory still could not be deleted — a husk is always safe to remove by
 * hand, and now the user is told so instead of it rotting in %TEMP% silently.
 *
 * Injectable (run/existsSync/rmSync/log) so the failure ladder is unit-tested
 * without git or the filesystem.
 *
 * @param {string} wtree absolute path of the temp worktree
 * @param {string} tempBranch the temp branch name
 * @param {{
 *   run?: typeof spawnSyncGit;
 *   keep?: boolean;
 *   existsSync?: (p: string) => boolean;
 *   rmSync?: typeof fs.rmSync;
 *   log?: (...a: unknown[]) => void;
 * }} [deps]
 */
export function removeTempWorktree(
  wtree,
  tempBranch,
  {
    run = spawnSyncGit,
    keep = false,
    existsSync = fs.existsSync,
    rmSync = fs.rmSync,
    log = () => {},
  } = {}
) {
  run('git', ['worktree', 'remove', '--force', wtree], {ignoreFail: true});
  // rmSync throws if it exhausts its retries — caught, not propagated: this
  // helper runs in a finally, and a cleanup failure must never mask the
  // original error or skip the prune/branch cleanup below.
  let removalError;
  if (existsSync(wtree)) {
    try {
      rmSync(wtree, {recursive: true, force: true, maxRetries: 3, retryDelay: 300});
    } catch (err) {
      removalError = err;
    }
  }
  run('git', ['worktree', 'prune'], {ignoreFail: true});
  if (existsSync(wtree)) {
    log(`⚠ could not fully remove the temp worktree: ${wtree}`);
    if (removalError) log(`  rmSync gave up: ${removalError.message}`);
    log('  It is deregistered (git worktree prune is safe) — delete it by hand.');
  }
  if (!keep) run('git', ['branch', '-D', tempBranch], {ignoreFail: true});
}

/** run() default for the injectable: the module-level git runner. */
function spawnSyncGit(cmd, args, opts) {
  return run(cmd, args, opts);
}

// ── findings → anchors ───────────────────────────────────────────────────
// `cr review` prints each finding as
//
//   minor [Functional Correctness]
//   → <OSC-8 hyperlink>docs/auto-updater.md:250-255<OSC-8 close>
//
//   <body>
//
// The label after the hyperlink is the anchor an ADR 0020 review thread needs
// (`path` + the last line), so it is parsed out here instead of leaving every
// agent to re-derive it from the diff — and to re-derive it wrong on a range.

/**
 * Write the findings report — twice, on purpose.
 *
 * - `dist/review/batch-findings.json` is the current run's canonical report, the
 *   one the ADR 0020 posting step reads. It is overwritten each run and removed
 *   up front, so a stale one can never be mistaken for a fresh one.
 * - `review-history/batch-findings-<ISO>.json` is the durable archive. `dist/` is
 *   gitignored scratch that ordinary commands delete — an `rm -rf dist` during
 *   unrelated work has already eaten a real report — so the copy that survives
 *   lives outside it, timestamped so successive runs accumulate instead of
 *   overwriting one another.
 *
 * @param {string} json the serialized report
 * @param {{keep?: boolean}} [opts] `keep: false` writes only the current report
 * @returns {{current: string; archive: string | null}} paths written
 */
export function writeFindingsReport(json, {keep = true} = {}) {
  const current = join('dist', 'review', 'batch-findings.json');
  fs.rmSync(current, {force: true});
  fs.mkdirSync(join('dist', 'review'), {recursive: true});
  fs.writeFileSync(current, json);
  if (!keep) return {current, archive: null};
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archive = join('review-history', `batch-findings-${stamp}.json`);
  fs.mkdirSync('review-history', {recursive: true});
  fs.writeFileSync(archive, json);
  return {current, archive};
}

/** OSC-8 hyperlinks and SGR colour runs. */
// Control characters are exactly what this strips — that is the point.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b\[[0-9;]*[A-Za-z]/g;

/** `minor [Functional Correctness]` — cr's severity + category line. */
const FINDING_HEAD_RE = /^(trivial|minor|major|critical) \[([^\]]+)\]$/i;

/**
 * `docs/auto-updater.md:250-255` and the `:250` single-line form. The path
 * class excludes `:` so the separator is unambiguous, and the range form is its
 * own pattern rather than an optional group over `(\d+)` (no ambiguous
 * adjacency). Both are re-checked with FILE_SUFFIX_RE before they count.
 */
const ANCHOR_RANGE_RE = /^([^:\s]+):(\d+)-(\d+)$/;
const ANCHOR_SINGLE_RE = /^([^:\s]+):(\d+)$/;
/** An anchor must point at a file, not at a bare word. */
const FILE_SUFFIX_RE = /\.[A-Za-z0-9]+$/;

/** Trailing summary chatter that belongs to the run, not to a finding. */
const TAIL_RE = /^(?:Review complete\b|Review completed\b|\d+ findings?\b|Print all AI prompts)/i;

/**
 * Strip ANSI/OSC-8 escapes and normalize line endings.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripAnsi(text) {
  return String(text ?? '')
    .replace(ANSI_RE, '')
    .replace(/\r\n/g, '\n');
}

/**
 * Parse `cr review` output into findings with their posting anchors.
 *
 * A finding the CLI printed without an anchor is still returned (`path: null`)
 * rather than dropped: the agent must triage it, and an unanchored finding
 * falls back to the review-body form ADR 0020 allows.
 *
 * @param {string} stdout raw `cr review` stdout
 * @returns {{
 *   severity: string;
 *   category: string;
 *   path: string | null;
 *   startLine: number | null;
 *   line: number | null;
 *   body: string;
 * }[]}
 */
export function parseFindings(stdout) {
  const findings = [];
  let current = null;
  for (const raw of stripAnsi(stdout).split('\n')) {
    const head = FINDING_HEAD_RE.exec(raw.trim());
    if (head) {
      current = {
        severity: head[1].toLowerCase(),
        category: head[2],
        path: null,
        startLine: null,
        line: null,
        body: [],
      };
      findings.push(current);
      continue;
    }
    if (!current) continue;
    const trimmed = raw.replace(/^[\s→>-]+/, '').trim();
    if (!trimmed) continue;
    if (TAIL_RE.test(trimmed)) {
      current = null; // the run's summary starts here
      continue;
    }
    if (/^[\s\u2500-\u257f]+$/.test(trimmed)) {
      current = null; // a box-drawing rule closes the finding's body
      continue;
    }
    const range = ANCHOR_RANGE_RE.exec(trimmed);
    const anchor = range ?? ANCHOR_SINGLE_RE.exec(trimmed);
    if (anchor && FILE_SUFFIX_RE.test(anchor[1]) && !current.path) {
      current.path = anchor[1].replace(/\\/g, '/');
      current.startLine = Number(anchor[2]);
      current.line = range ? Number(anchor[3]) : Number(anchor[2]);
      continue;
    }
    current.body.push(trimmed);
  }
  return findings.map(f => ({...f, body: f.body.join('\n')}));
}

/**
 * The findings as JSON, for the ADR 0020 posting step (one entry per accepted
 * finding becomes one line-anchored thread).
 *
 * @param {ReturnType<typeof parseFindings>} findings
 * @param {{refs?: string[]; base?: string}} [opts]
 * @returns {string}
 */
export function findingsJson(findings, {refs = [], base = 'origin/main'} = {}) {
  return `${JSON.stringify(
    {
      protocol: 'ADR 0020 — assess each finding, post the accepted ones as line-anchored threads',
      base,
      refs,
      count: findings.length,
      findings,
    },
    null,
    2
  )}\n`;
}

/**
 * A compact table for the terminal: what to triage, and where to post it.
 *
 * @param {ReturnType<typeof parseFindings>} findings
 * @returns {string}
 */
export function findingsTable(findings) {
  if (findings.length === 0) return 'No findings parsed from the cr output.';
  const rows = findings.map((f, i) => {
    const where =
      f.path ?
        `${f.path}:${f.startLine === f.line ? f.line : `${f.startLine}-${f.line}`}`
      : '(no anchor in output — derive it before posting)';
    return `  ${i + 1}. [${f.severity}] ${f.category} — ${where}`;
  });
  return `Findings parsed from the cr output:\n${rows.join('\n')}`;
}

// ── cr's own %TEMP% leftovers ────────────────────────────────────────────
// The CLI stages each run in a coderabbit-update-* dir and never removes it,
// so every review leaves one behind in the OS temp dir (the same dir this repo's
// hygiene test polices, and the user's Temp on Windows). The sweep runs before
// and after the review; an entry younger than the grace period is left alone
// and reported, because a cr run in another thread could still own it.

/**
 * True when something still holds the directory open.
 *
 * The probe is an atomic rename to a scratch name: a live `cr` process keeps
 * its working directory open, and on Windows that makes the rename fail with
 * EBUSY/EPERM. If the rename succeeds the directory was free, so it is renamed
 * straight back (the same path the caller will delete). Anything unexpected — a
 * permissions error, an exotic filesystem — answers `true`, because the cost of
 * keeping a stale directory is one leftover file, while deleting a live one
 * breaks a running review.
 *
 * @param {string} dir
 * @returns {boolean} true = in use (do not delete)
 */
export function defaultIsLocked(dir) {
  const probe = `${dir}.sweeping-${process.pid}-${Date.now()}`;
  try {
    fs.renameSync(dir, probe);
  } catch {
    return true; // EBUSY/EPERM/EACCES: assume a live owner
  }
  try {
    fs.renameSync(probe, dir);
    return false;
  } catch {
    // It moved but would not move back — do not lose the directory.
    return true;
  }
}

/**
 * Remove stale `coderabbit-update-*` dirs from the OS temp dir.
 *
 * Injectable (readdirSync/statSync/rmSync/now/log) so the age rule is unit
 * tested without touching the filesystem.
 *
 * @param {{
 *   graceMs?: number;
 *   tmpDir?: string;
 *   readdirSync?: typeof fs.readdirSync;
 *   statSync?: typeof fs.statSync;
 *   rmSync?: typeof fs.rmSync;
 *   now?: () => number;
 *   log?: (...a: unknown[]) => void;
 *   isLocked?: (dir: string) => boolean;
 * }} [opts]
 * @returns {{removed: string[]; kept: {path: string; ageMs: number}[]}}
 */
export function cleanupCoderabbitTemp({
  graceMs = 30 * 60_000,
  tmpDir = tmpdir(),
  readdirSync = fs.readdirSync,
  statSync = fs.statSync,
  rmSync = fs.rmSync,
  now = Date.now,
  log = () => {},
  // A directory is only swept if nothing has touched it for `graceMs` AND no
  // cr process holds it open. Age alone is not ownership: a review can run
  // longer than the grace window without updating its directory's mtime, and
  // `--temp-grace 0` would otherwise make a live run's dir eligible instantly.
  isLocked = defaultIsLocked,
} = {}) {
  const removed = [];
  const kept = [];
  let entries;
  try {
    entries = readdirSync(tmpDir);
  } catch {
    return {removed, kept}; // no readable temp dir: nothing to sweep
  }
  for (const name of entries.filter(n => /^coderabbit-update-/.test(n))) {
    const full = join(tmpDir, name);
    let ageMs;
    try {
      ageMs = now() - statSync(full).mtimeMs;
    } catch {
      continue; // vanished under us
    }
    if (ageMs < graceMs) {
      kept.push({path: full, ageMs, reason: 'within grace'});
      continue;
    }
    // Old enough, but a live cr run still has it open — that is a stronger
    // signal than mtime in either direction, so keep it.
    let locked;
    try {
      locked = isLocked(full);
    } catch {
      locked = true; // cannot prove it is free; never delete on a doubt
    }
    if (locked) {
      kept.push({path: full, ageMs, reason: 'in use by a running cr'});
      continue;
    }
    try {
      rmSync(full, {recursive: true, force: true, maxRetries: 3, retryDelay: 300});
      removed.push(full);
    } catch (err) {
      log(`⚠ could not remove a stale cr temp dir: ${full} (${err.message})`);
      kept.push({path: full, ageMs, reason: 'undeletable'});
    }
  }
  return {removed, kept};
}

function mergedDiffStat(base, refs) {
  // A conservative estimate of what the combined diff touches: union of each
  // ref's file list vs base. Real merges can differ slightly.
  const files = new Set();
  for (const ref of refs) {
    const out = run('git', ['diff', '--name-only', `${base}...${ref}`], {ignoreFail: true});
    for (const f of out.stdout.trim().split('\n').filter(Boolean)) files.add(f);
  }
  return files.size;
}

export function parseOpenPrBranchesOutput(stdout) {
  return stdout.trim().split('\n').filter(Boolean);
}

export async function main() {
  const args = parseArgs(process.argv.slice(2));
  const crBin = process.env.CR_BIN || 'cr';

  // --help prints and exits 0: asking for usage is not a usage error.
  if (args.help) {
    console.log(USAGE);
    return;
  }

  // --check: show the usage report without touching anything.
  if (args.check) {
    const usage = run(crBin, ['usage'], {ignoreFail: true});
    if (usage.status !== 0) {
      console.error('cr usage failed — are you logged in? Run `cr auth login` first.');
      console.error(usage.stderr?.trim().slice(-1000));
      process.exit(3);
    }
    console.log(usage.stdout?.trim());
    return;
  }

  // Pre-flight: auth must exist before we build a worktree.
  const auth = run(crBin, ['auth', 'status'], {ignoreFail: true});
  if (auth.status !== 0) {
    console.error(
      'CodeRabbit CLI is not logged in — run `cr auth login` once (browser flow, no API key needed).'
    );
    process.exit(2);
  }

  const refs = [];
  for (const pr of args.prs) refs.push(prHeadBranch(pr));
  refs.push(...args.branches);
  if (args.open) refs.push(...openPrBranches({since: args.since}));
  const unique = [...new Set(refs.filter(Boolean))];
  if (unique.length === 0) {
    console.error('Nothing to review — pass --pr, --branch, or --open.');
    process.exit(2);
  }

  console.log(`Batched CodeRabbit review of ${unique.length} branch(es):`);
  for (const ref of unique) console.log(`  - ${ref}`);
  const fileCount = mergedDiffStat(args.base, unique);
  console.log(`Combined diff vs ${args.base}: ~${fileCount} file(s).`);
  if (args.dryRun) {
    console.log('Dry run — not merging or reviewing.');
    return;
  }

  const wtree = worktreePath();
  const tempBranch = `cr-batch-${process.pid}`;
  // process.exit() would terminate before the finally below runs (leaving the
  // temp worktree behind — observed as orphaned cr-batch-* dirs), so failure
  // paths inside the try throw this and the catch turns it into an exit code.
  class BatchExit extends Error {
    constructor(code) {
      super(`exit ${code}`);
      this.code = code;
    }
  }
  try {
    run('git', ['worktree', 'add', '--detach', wtree, args.base]);
    // Merge the branches sequentially instead of one octopus merge: octopus
    // fails hard when two branches touch the same file even in different
    // regions (e.g. stacked PRs that both edit docs/ci-inventory.md rows),
    // while sequential merges use the normal region-merging strategy and
    // produce the same combined tree for review.
    for (const ref of unique) {
      const mergeRes = run(
        'git',
        ['-C', wtree, 'merge', '--no-edit', '--no-ff', '-m', 'cr batch review', ref],
        {ignoreFail: true}
      );
      if (mergeRes.status !== 0) {
        console.error(
          `Merge failed at ${ref} (conflicts with the already-merged set?). Nothing was reviewed.`
        );
        console.error(mergeRes.stderr?.trim().slice(-2000));
        throw new BatchExit(2);
      }
    }
    run('git', ['-C', wtree, 'switch', '-c', tempBranch]);

    const runCrReview = () => {
      const crArgs = ['review'];
      if (args.agent) crArgs.push('--agent');
      // Sweep before AND after: before clears what earlier runs stranded, after
      // clears whatever this one leaves behind (cr never removes its own dir).
      cleanupCoderabbitTemp({graceMs: args.tempGrace * 60_000, log: console.error});
      return run(crBin, crArgs, {ignoreFail: true, cwd: wtree});
    };
    let cr = runCrReview();
    if (cr.status !== 0) {
      const output = `${cr.stdout || ''}\n${cr.stderr || ''}`;
      if (isRateLimited(output)) {
        console.error('CodeRabbit rate limit hit — the free-plan bucket is ~1 review/hour.');
        if (args.wait !== null) {
          console.error(`Waiting ${args.wait} minute(s), then retrying once...`);
          await sleep(args.wait * 60_000);
          cr = runCrReview();
          if (cr.status !== 0) {
            console.error(`Still rate-limited after the wait (exited ${cr.status}):`);
            console.error(cr.stderr?.trim().slice(-2000));
            throw new BatchExit(4);
          }
        } else {
          console.error(
            'Run `cr usage` for period usage, or rerun later. Pass --wait <minutes> to auto-retry.'
          );
          throw new BatchExit(4);
        }
      } else {
        console.error(`cr review exited ${cr.status}:`);
        console.error(cr.stderr?.trim().slice(-2000));
        throw new BatchExit(3);
      }
    } else if (isRateLimited(`${cr.stdout || ''}\n${cr.stderr || ''}`)) {
      // Defensive: some environments report the limit in a passing exit.
      console.error(
        'Warning: cr exited 0 but reported a rate limit — the review likely did not run.'
      );
    }
    console.log(
      cr.stdout?.trim() ? `\n${cr.stdout.trim()}` : 'cr review completed with no text output.'
    );

    // The findings, with the anchors ADR 0020 threads need, before the agent
    // starts re-reading the raw output.
    const findings = parseFindings(cr.stdout);
    console.log(`\n${findingsTable(findings)}`);
    const reportJson = findingsJson(findings, {refs: unique, base: args.base});
    try {
      const {current, archive} = writeFindingsReport(reportJson);
      console.log(`Anchors + bodies written to ${current}`);
      if (archive) console.log(`Archived to ${resolve(archive)}`);
    } catch (err) {
      // Fatal, not a warning: the log below tells the agent to read this file,
      // and it does not exist. Continuing would point it at nothing (or, at the
      // previous run's findings, which is worse).
      console.error(`✗ could not write the findings report: ${err.message}`);
      console.error('  The ADR 0020 posting step needs this file — fix the path or rerun.');
      process.exitCode = 5;
      return;
    }
    console.log(
      [
        '',
        'Next — ADR 0020 (.agents/skills/cr-batch-review/SKILL.md), not optional:',
        '  1. Assess every finding right / wrong / useless, quoting the disputed line.',
        '  2. Post each accepted finding as its own line-anchored, individually',
        '     resolvable thread (gh api …/pulls/<n>/comments -f path=<path>',
        '     -F line=<last line of the range> -f side=RIGHT), with the',
        '     🤖 provenance marker naming this batch run.',
        '  3. Leave a review record even when nothing is accepted',
        '     (gh pr review <n> --comment) — zero findings is a result, not',
        '     an absence, and it must be one review, not an issue comment.',
        '  4. Stop there. A batch pass writes no fixes and resolves no threads:',
        '     this pass covers PRs it does not own, so the owning agent',
        '     re-assesses each open thread, fixes what it accepts, and',
        '     resolves what it fixed.',
        'An external finding gets the same scrutiny as a local one — assessed, not',
        'rubber-stamped.',
      ].join('\n')
    );
  } catch (err) {
    if (err instanceof BatchExit) {
      process.exitCode = err.code;
      return;
    }
    throw err;
  } finally {
    removeTempWorktree(wtree, tempBranch, {run, keep: Boolean(args.keep), log: console.error});
    const sweep = cleanupCoderabbitTemp({graceMs: args.tempGrace * 60_000, log: console.error});
    if (sweep.removed.length > 0) {
      console.log(`Removed ${sweep.removed.length} stale cr temp dir(s) from the OS temp dir.`);
    }
    if (sweep.kept.length > 0) {
      // `kept` is appended in readdir order across three reasons, so the youngest
      // entry is not necessarily first — compute it rather than assume it.
      const age = Math.round(Math.min(...sweep.kept.map(d => d.ageMs)) / 60_000);
      console.log(
        `Left ${sweep.kept.length} coderabbit-update-* dir(s) alone (youngest ${age} min old; another cr run may own them — --temp-grace to change).`
      );
    }
  }
  console.log(
    args.keep ?
      `\nKept temp branch ${tempBranch} (worktree removed); checkout untouched.`
    : '\nTemp branch removed; checkout untouched.'
  );
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch(err => {
    console.error(err.message);
    process.exit(2);
  });
}
