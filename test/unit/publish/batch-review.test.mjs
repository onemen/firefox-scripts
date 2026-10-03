// test/unit/publish/batch-review.test.mjs — Unit tests for
// tools/ci/batch-review.mjs (local batched CodeRabbit review).
//
// Only the pure helpers are tested here (arg parsing, output splitting);
// the git-worktree/octopus-merge/cr-review flow requires gh + cr + a repo,
// so it is validated manually with --dry-run.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {
  ageToUnixSeconds,
  cleanupCoderabbitTemp,
  findingsJson,
  findingsTable,
  isRateLimited,
  parseArgs,
  parseFindings,
  parseOpenPrBranchesOutput,
  removeTempWorktree,
  stripAnsi,
} from '../../../tools/ci/batch-review.mjs';

// ── removeTempWorktree (temp-worktree teardown ladder) ─────────────────
// Observed live on Windows: `git worktree remove --force` deregisters the
// worktree but can fail the filesystem delete partway (MAX_PATH over deep
// paths), leaving a cr-batch-* husk in %TEMP% that the old code never named.
// The ladder is: git remove → rmSync of leftovers → prune → loud warning.

test('removeTempWorktree: clean remove — no rmSync, prune, branch deleted', () => {
  const cmds = [];
  const run = (cmd, args) => cmds.push([cmd, ...args]);
  removeTempWorktree('C:/t/cr-batch-1', 'cr-batch-1', {
    run,
    existsSync: () => false,
    rmSync: () => {
      throw new Error('must not be called when the directory is already gone');
    },
  });
  assert.deepEqual(cmds, [
    ['git', 'worktree', 'remove', '--force', 'C:/t/cr-batch-1'],
    ['git', 'worktree', 'prune'],
    ['git', 'branch', '-D', 'cr-batch-1'],
  ]);
});

test('removeTempWorktree: Windows husk — leftover dir gets rmSync, then prune', () => {
  const cmds = [];
  const rms = [];
  let firstProbe = true;
  removeTempWorktree('C:/t/cr-batch-2', 'cr-batch-2', {
    run: (cmd, args) => cmds.push([cmd, ...args]),
    // First probe (before rmSync): the husk exists. Second (after prune): gone.
    existsSync: () => {
      const v = firstProbe;
      firstProbe = false;
      return v;
    },
    rmSync: (p, opts) => rms.push([p, opts.recursive, opts.force, opts.maxRetries > 0]),
  });
  assert.deepEqual(rms, [['C:/t/cr-batch-2', true, true, true]]);
  assert.deepEqual(cmds, [
    ['git', 'worktree', 'remove', '--force', 'C:/t/cr-batch-2'],
    ['git', 'worktree', 'prune'],
    ['git', 'branch', '-D', 'cr-batch-2'],
  ]);
});

test('removeTempWorktree: undeletable husk warns loudly, still deletes the branch', () => {
  const warnings = [];
  const cmds = [];
  removeTempWorktree('C:/t/cr-batch-3', 'cr-batch-3', {
    run: (cmd, args) => cmds.push([cmd, ...args]),
    existsSync: () => true,
    // rmSync genuinely throws when its retries are exhausted (review finding:
    // the throw must never escape a finally or skip the cleanup below it).
    rmSync: () => {
      throw new Error('EBUSY: resource busy or locked');
    },
    log: (...a) => warnings.push(a.join(' ')),
  });
  assert.match(warnings.join('\n'), /could not fully remove the temp worktree/);
  assert.match(warnings.join('\n'), /C:\/t\/cr-batch-3/);
  assert.match(warnings.join('\n'), /EBUSY/, 'the rmSync error surfaces in the warning');
  assert.ok(
    cmds.some(c => c.includes('prune')),
    'prune still runs'
  );
  assert.ok(
    cmds.some(c => c.includes('branch')),
    'branch cleanup still runs'
  );
});

test('removeTempWorktree: --keep spares the branch', () => {
  const cmds = [];
  removeTempWorktree('C:/t/cr-batch-4', 'cr-batch-4', {
    run: (cmd, args) => cmds.push([cmd, ...args]),
    existsSync: () => false,
    keep: true,
  });
  assert.ok(!cmds.some(c => c.includes('branch')), 'branch -D must not run when keep=true');
});

test('parseArgs: flags and repeatables', () => {
  const args = parseArgs([
    '--pr',
    '57',
    '--pr',
    '59',
    '--branch',
    'wip/foo',
    '--open',
    '--since',
    '3d',
    '--agent',
    '--keep',
    '--dry-run',
  ]);
  assert.deepEqual(args.prs, [57, 59]);
  assert.deepEqual(args.branches, ['wip/foo']);
  assert.equal(args.open, true);
  assert.equal(args.since, '3d');
  assert.equal(args.base, 'origin/main');
  assert.equal(args.agent, true);
  assert.equal(args.keep, true);
  assert.equal(args.dryRun, true);
});

test('parseArgs: defaults', () => {
  const args = parseArgs(['--pr', '1']);
  assert.deepEqual(args.prs, [1]);
  assert.deepEqual(args.branches, []);
  assert.equal(args.open, false);
  assert.equal(args.since, null);
  assert.equal(args.base, 'origin/main');
  assert.equal(args.keep, false);
  assert.equal(args.agent, false);
  assert.equal(args.dryRun, false);
  assert.equal(args.check, false);
  assert.equal(args.wait, null);
});

test('parseArgs: --check and --wait', () => {
  assert.equal(parseArgs(['--check']).check, true);
  assert.equal(parseArgs(['--pr', '1', '--wait', '45']).wait, 45);
  // --wait 0 is a valid "retry immediately" and must not be treated as absent.
  assert.equal(parseArgs(['--wait', '0']).wait, 0);
  assert.throws(() => parseArgs(['--wait', 'abc']), /Invalid --wait/);
  assert.throws(() => parseArgs(['--wait', '-5']), /Invalid --wait/);
});

test('parseArgs: ignores the pnpm `--` separator', () => {
  // `pnpm review:batch -- <flags>` forwards a literal `--` to the script.
  const args = parseArgs(['--', '--check']);
  assert.equal(args.check, true);
  const mixed = parseArgs(['--pr', '57', '--', '--dry-run']);
  assert.deepEqual(mixed.prs, [57]);
  assert.equal(mixed.dryRun, true);
});

test('isRateLimited: detects rate-limit messaging', () => {
  assert.equal(isRateLimited('Review rate limit exceeded, skipping this review.'), true);
  assert.equal(isRateLimited('quota exhausted for this period'), true);
  assert.equal(isRateLimited('429 Too Many Requests'), true);
  assert.equal(isRateLimited('too many reviews in this window'), true);
  assert.equal(isRateLimited('try again later'), true);
  assert.equal(isRateLimited('merge conflict in package.json'), false);
  assert.equal(isRateLimited(''), false);
});

test('parseArgs: rejects unknown flags', () => {
  assert.throws(() => parseArgs(['--nope']), /Unknown flag: --nope/);
});

test('parseArgs: rejects missing or invalid values', () => {
  assert.throws(() => parseArgs(['--pr']), /Invalid --pr/);
  assert.throws(() => parseArgs(['--pr', 'abc']), /Invalid --pr/);
  assert.throws(() => parseArgs(['--pr', '0']), /Invalid --pr/);
  assert.throws(() => parseArgs(['--pr', '-3']), /Invalid --pr/);
  assert.throws(() => parseArgs(['--branch']), /Missing value for --branch/);
  assert.throws(() => parseArgs(['--since']), /Missing value for --since/);
  assert.throws(() => parseArgs(['--base']), /Missing value for --base/);
});

test('parseOpenPrBranchesOutput: splits and drops empties', () => {
  assert.deepEqual(parseOpenPrBranchesOutput('buffy/a\nbuffy/b\n'), ['buffy/a', 'buffy/b']);
  assert.deepEqual(parseOpenPrBranchesOutput('\n\n'), []);
});

test('ageToUnixSeconds: converts human ages to timestamps', () => {
  const now = Math.floor(Date.now() / 1000);
  assert.ok(ageToUnixSeconds('1s') <= now && ageToUnixSeconds('1s') >= now - 2);
  assert.ok(ageToUnixSeconds('30m') < now - 1000 && ageToUnixSeconds('30m') > now - 1900);
  assert.ok(ageToUnixSeconds('3d') < now - 250000 && ageToUnixSeconds('3d') > now - 270000);
  assert.throws(() => ageToUnixSeconds('nope'), /Invalid --since age/);
  assert.throws(() => ageToUnixSeconds('3'), /Invalid --since age/);
});

// ── findings → anchors ───────────────────────────────────────────────────
// ADR 0020 wants one review thread per finding, anchored to path + line on the
// PR head. cr prints that anchor (inside an OSC-8 hyperlink); parsing it here
// is what stops every agent from re-deriving the range from the diff.

/** One finding as cr prints it: severity + category, the anchor, the body. */
function crFinding({
  severity = 'minor',
  category = 'Functional Correctness',
  file = 'docs/auto-updater.md',
  range = '250-255',
  body = 'Separate config-copy behavior from copyFileList() retries.',
} = {}) {
  const label = range ? `${file}:${range}` : file;
  return [
    `  ${severity} [${category}]`,
    `  → \u001b]8;;vscode://file/C:\\Users\\test\\AppData\\Local\\Temp\\cr-batch-1\\${file.replace(
      /\//g,
      '\\'
    )}\u0007${label}\u001b]8;;\u0007`,
    '',
    `  ${body}`,
  ].join('\n');
}

const CR_TAIL = [
  '',
  '────────────────────────────────────────',
  'Review complete',
  '1 finding ✔',
  '',
].join('\n');

test('parseFindings: extracts severity, category and the line range', () => {
  const findings = parseFindings(`${crFinding()}\n${CR_TAIL}`);
  assert.equal(findings.length, 1);
  assert.deepEqual(
    {severity: findings[0].severity, category: findings[0].category},
    {severity: 'minor', category: 'Functional Correctness'}
  );
  assert.equal(findings[0].path, 'docs/auto-updater.md');
  assert.equal(findings[0].startLine, 250);
  assert.equal(findings[0].line, 255, 'the thread anchors to the LAST line of the range');
  assert.match(findings[0].body, /^Separate config-copy/);
});

test('parseFindings: a single-line finding anchors line to itself', () => {
  const [finding] = parseFindings(crFinding({file: 'tools/publish/x.mjs', range: '42'}));
  assert.equal(finding.startLine, 42);
  assert.equal(finding.line, 42);
});

test('parseFindings: several findings, each with its own anchor', () => {
  const out = [
    crFinding({range: '10-12', body: 'First.'}),
    '',
    crFinding({severity: 'major', range: '88', body: 'Second.'}),
    CR_TAIL,
  ].join('\n');
  const findings = parseFindings(out);
  assert.equal(findings.length, 2);
  assert.equal(findings[0].body, 'First.');
  assert.equal(findings[1].severity, 'major');
  assert.equal(findings[1].line, 88);
});

test('parseFindings: an unanchored finding is kept, not dropped', () => {
  // The agent still has to triage it — ADR 0020 just falls back to a review
  // body when no line anchor exists.
  const out = ['  minor [Security]', '', '  Something file-wide.', '', CR_TAIL].join('\n');
  const findings = parseFindings(out);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].path, null);
  assert.equal(findings[0].line, null);
  assert.equal(findings[0].body, 'Something file-wide.');
});

test('parseFindings: the run summary is not swallowed into the last body', () => {
  const findings = parseFindings(`${crFinding({body: 'Real finding.'})}\n${CR_TAIL}`);
  assert.equal(findings[0].body, 'Real finding.');
});

test('parseFindings: no findings in, none out', () => {
  assert.deepEqual(parseFindings(''), []);
  assert.deepEqual(parseFindings('All matched files use Prettier code style!'), []);
});

test('stripAnsi: removes OSC-8 hyperlinks and colour runs', () => {
  const raw = '\u001b[1mminor\u001b[0m \u001b]8;;file:///x\u0007docs/a.md:1\u001b]8;;\u0007';
  assert.equal(stripAnsi(raw), 'minor docs/a.md:1');
  assert.equal(stripAnsi('a\r\nb'), 'a\nb');
});

test('findingsTable / findingsJson: carry the anchor and the ADR 0020 pointer', () => {
  const findings = parseFindings(`${crFinding()}\n${CR_TAIL}`);
  const table = findingsTable(findings);
  assert.match(table, /1\. \[minor\] Functional Correctness — docs\/auto-updater\.md:250-255/);
  const json = JSON.parse(findingsJson(findings, {refs: ['fix/a'], base: 'origin/main'}));
  assert.equal(json.count, 1);
  assert.match(json.protocol, /ADR 0020/);
  assert.deepEqual(json.refs, ['fix/a']);
  assert.equal(json.findings[0].line, 255);
  assert.equal(findingsTable([]), 'No findings parsed from the cr output.');
});

// ── cr's own %TEMP% leftovers ────────────────────────────────────────────
// The CLI stages each run in a coderabbit-update-* dir and never removes it, so
// every review leaves one in the OS temp dir — the same dir this repo's hygiene
// test polices, and the user's Temp on Windows.

const NOW = 1_700_000_000_000;

test('cleanupCoderabbitTemp: removes stale cr dirs, keeps young ones', () => {
  const entries = [
    'coderabbit-update-old',
    'coderabbit-update-new',
    'cr-batch-12256',
    'fxs-utils-1234',
  ];
  const removed = [];
  const {removed: gone, kept} = cleanupCoderabbitTemp({
    graceMs: 30 * 60_000,
    tmpDir: '/t',
    now: () => NOW,
    readdirSync: () => entries,
    statSync: p => ({mtimeMs: p.endsWith('old') ? NOW - 3_600_000 : NOW - 60_000}),
    rmSync: p => removed.push(p),
  });
  // join() so the expectation matches the platform separator the helper uses.
  const oldPath = join('/t', 'coderabbit-update-old');
  const newPath = join('/t', 'coderabbit-update-new');
  assert.deepEqual(gone, [oldPath]);
  assert.deepEqual(removed, [oldPath]);
  assert.deepEqual(kept, [{path: newPath, ageMs: 60_000}]);
});

test('cleanupCoderabbitTemp: an undeletable dir is reported, never thrown', () => {
  const logged = [];
  const {removed, kept} = cleanupCoderabbitTemp({
    graceMs: 1000,
    tmpDir: '/t',
    now: () => NOW,
    readdirSync: () => ['coderabbit-update-locked'],
    statSync: () => ({mtimeMs: NOW - 10_000}),
    rmSync: () => {
      throw new Error('EBUSY: resource busy or locked');
    },
    log: msg => logged.push(msg),
  });
  assert.deepEqual(removed, []);
  assert.equal(kept.length, 1);
  assert.match(logged[0], /could not remove a stale cr temp dir.*EBUSY/);
});

test('cleanupCoderabbitTemp: an unreadable temp dir is a no-op, not a crash', () => {
  const {removed, kept} = cleanupCoderabbitTemp({
    tmpDir: '/nope',
    readdirSync: () => {
      throw new Error('ENOENT');
    },
  });
  assert.deepEqual(removed, []);
  assert.deepEqual(kept, []);
});

test('parseArgs: --temp-grace defaults to 30 minutes and parses', () => {
  assert.equal(parseArgs([]).tempGrace, 30);
  assert.equal(parseArgs(['--temp-grace', '5']).tempGrace, 5);
  assert.equal(parseArgs(['--temp-grace', '0']).tempGrace, 0);
  assert.throws(() => parseArgs(['--temp-grace', 'soon']), /Invalid --temp-grace/);
  assert.throws(() => parseArgs(['--temp-grace']), /Invalid --temp-grace/);
});
