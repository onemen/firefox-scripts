// tools/ci/batch-review.mjs — local batched CodeRabbit review across PRs.
//
// The CodeRabbit free plan allows ~1 review/hour (shared between the bot and
// the CLI), so reviewing each PR separately burns the quota. This script
// merges the heads of several PR branches onto ONE temp branch and runs a
// single `cr review` over the combined diff — one quota slot, N PRs.
//
// Usage (from a clean-enough checkout, on main):
//
//   node tools/ci/batch-review.mjs --pr 57 --pr 59
//   node tools/ci/batch-review.mjs --branch buffy/37-install-applies --branch buffy/53-manual-install-updater
//   node tools/ci/batch-review.mjs --open            # all open PR branches
//   node tools/ci/batch-review.mjs --open --since 3d  # PRs updated recently
//   node tools/ci/batch-review.mjs --pr 57 --agent    # pass --agent to cr
//   node tools/ci/batch-review.mjs --check           # show cr usage report only
//   node tools/ci/batch-review.mjs --pr 57 --wait 60 # retry once after an hour if rate-limited
//
// Flags:
//   --pr <number>      GitHub PR number (resolves to its head branch). Repeatable.
//   --branch <ref>     Git branch/ref to include. Repeatable.
//   --open             Include every open PR's head branch.
//   --since <age>      With --open, only PRs updated within <age> (e.g. 3d, 12h).
//   --base <ref>       Branch to merge onto (default: origin/main).
//   --keep             Keep the temp branch after review (default: delete).
//   --agent            Pass --agent to cr review (structured findings).
//   --dry-run          List what would be merged without running cr.
//   --check            Show `cr usage` (period review count + reset date) and exit.
//   --wait <minutes>   If cr is rate-limited, wait this long and retry once.
//
// Exit codes: 0 = review ran (or dry-run); 2 = nothing to review / bad usage;
//             3 = cr failed; 4 = CodeRabbit rate limit hit (retry later).
//
// Notes:
// - Local use needs only a browser login: run `cr auth login` once (device
//   flow, no API key). An agentic API key (cr-...) is required only for
//   headless CI — see the headless integration docs; user API keys are
//   rejected by the CLI.
// - On rate limit the CLI does not retry automatically; this script detects
//   the condition and tells you, or waits and retries once with --wait.
// - `git worktree` is used so your current checkout is never touched; the
//   temp branch lives in a scratch worktree under the repo's .git.
// - After the review, the temp branch and worktree are removed and your
//   checkout is left exactly as it was.

import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

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
    wait: null,
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
      case '--wait':
        args.wait = Number(value());
        if (!Number.isFinite(args.wait) || args.wait < 0) {
          throw new Error(`Invalid --wait minutes: ${argv[i - 1]}`);
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
  try {
    run('git', ['worktree', 'add', '--detach', wtree, args.base]);
    const octopus = unique.map(ref => `'${ref}'`).join(' ');
    const mergeRes = run(
      'bash',
      ['-lc', `cd '${wtree}' && git merge --no-edit --no-ff -m 'cr batch review' ${octopus}`],
      {ignoreFail: true}
    );
    if (mergeRes.status !== 0) {
      console.error('Merge failed (conflicts?). Nothing was reviewed.');
      console.error(mergeRes.stderr?.trim().slice(-2000));
      process.exit(2);
    }
    run('bash', ['-lc', `cd '${wtree}' && git switch -c '${tempBranch}'`]);

    const runCrReview = () => {
      const crArgs = ['review'];
      if (args.agent) crArgs.push('--agent');
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
            process.exit(4);
          }
        } else {
          console.error(
            'Run `cr usage` for period usage, or rerun later. Pass --wait <minutes> to auto-retry.'
          );
          process.exit(4);
        }
      } else {
        console.error(`cr review exited ${cr.status}:`);
        console.error(cr.stderr?.trim().slice(-2000));
        process.exit(3);
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
  } finally {
    run('git', ['worktree', 'remove', '--force', wtree], {ignoreFail: true});
    if (!args.keep) run('git', ['branch', '-D', tempBranch], {ignoreFail: true});
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
