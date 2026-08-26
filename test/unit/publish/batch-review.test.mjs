// test/unit/publish/batch-review.test.mjs — Unit tests for
// tools/ci/batch-review.mjs (local batched CodeRabbit review).
//
// Only the pure helpers are tested here (arg parsing, output splitting);
// the git-worktree/octopus-merge/cr-review flow requires gh + cr + a repo,
// so it is validated manually with --dry-run.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  ageToUnixSeconds,
  isRateLimited,
  parseArgs,
  parseOpenPrBranchesOutput,
} from '../../../tools/ci/batch-review.mjs';

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
