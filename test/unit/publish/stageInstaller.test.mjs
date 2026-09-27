// test/unit/publish/stageInstaller.test.mjs — the stage-installer tool's pure
// parts (option normalization, argv parsing) plus the wiring pins that keep
// the gates honest.
//
// Why this tool exists: the pre-release manual test needs the byte-exact PROD
// installer downloadable from GitHub BEFORE the publish, without touching
// gh-pages/the release/hashes.json. A disposable orphan branch carries the
// binary; the gates (--run exists, --expect sha256, tree assertion after
// push) exist because every one of them caught a real failure on 2026-09-27:
// a moved main (wrong bytes), a stale --expect (wrong bytes), and the global
// `*.exe` gitignore silently dropping the binary from the pushed tree.
//
// Command surface (operator decision, 2026-09-27): there is deliberately NO
// second pnpm script — release.mjs routes `release:stage -- --save-branch`
// here, so the staging flow stays one front door.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const {parseArgsOrThrow, normalizeStageOpts} =
  await import('../../../tools/publish/stageInstaller.mjs');
const SRC = readFileSync(
  new URL('../../../tools/publish/stageInstaller.mjs', import.meta.url),
  'utf-8'
);

test('normalizeStageOpts: empty --run is allowed (auto-resolve), defaults fill in', () => {
  const o = normalizeStageOpts({});
  assert.equal(o.run, ''); // resolveStageRun picks the newest successful staging run
  assert.equal(o.binary, 'installer_win.exe');
  assert.equal(o.push, true);
  assert.equal(o.force, false);
  assert.match(o.branch, /^stage-installer-\d{4}-\d{2}-\d{2}$/);
  // The filed-hash default is the WDSI submission's sha256.
  assert.equal(o.expect, '037032aa9b6e87d7dc7ab8e4f600fe3c82a48112098a975acc423c8a91e11c77');
});

test('normalizeStageOpts: --expect must be the full 64-hex sha256, --run numeric', () => {
  assert.throws(() => normalizeStageOpts({expect: '037032aa'}), /64-hex/);
  assert.throws(() => normalizeStageOpts({run: 'abc'}), /numeric run id/);
  // Empty run passes (auto-resolve); whitespace-only run is preserved verbatim
  // and must fail the numeric check.
  assert.equal(normalizeStageOpts({run: ''}).run, '');
  assert.throws(() => normalizeStageOpts({run: ' '}), /numeric run id/);
});

test('parseArgs: --run is optional, unknown args still fail loud', () => {
  const opts = parseArgsOrThrow([]);
  assert.equal(opts.run, '');
  assert.equal(parseArgsOrThrow(['--run', '36298110515']).run, '36298110515');
  assert.throws(() => parseArgsOrThrow(['--nonsense']), /unknown argument: --nonsense/);
});

test('parseArgs: --branch defaults to stage-installer-<today>, --no-push flips push off', () => {
  assert.match(SRC, /stage-installer-\$\{new Date\(\)\.toISOString\(\)\.slice\(0, 10\)\}/);
  assert.match(SRC, /'--no-push'\) o\.push = false/);
  const opts = parseArgsOrThrow(['--no-push', '--force']);
  assert.equal(opts.push, false);
  assert.equal(opts.force, true);
});

test('the tool scrubs the ambient git overlays for every git call (hook redirection)', () => {
  // The 2026-09-27 lesson: under the pre-push hook GIT_DIR points at the
  // checkout being pushed; an unscrubbed git call from a linked worktree
  // writes into the wrong repository.
  assert.match(SRC, /import \{gitEnv\} from '\.\/generateBuildDates\.mjs'/);
  assert.match(SRC, /env: scrubEnv\(\)/);
});

test('the tool never shells out through a shell string (argv-array gh and git)', () => {
  assert.doesNotMatch(SRC, /spawnSync\(`(gh|git)/);
  assert.doesNotMatch(SRC, /execSync\('(gh|git) /);
});

test('the binary is force-added and the pushed tree is asserted (the *.exe gitignore lesson)', () => {
  // `git add -A` silently dropped installer_win.exe when the operator's
  // global gitignore carried `*.exe`; the first push shipped a tree without
  // the binary. Pin both halves of the fix.
  assert.match(SRC, /'add', '-f',/);
  assert.match(SRC, /assertRemoteTreeHasBinary/);
  assert.match(SRC, /pushed tree lacks installer_win\.exe/);
});

test('the run head must match the intended commit before anything is staged', () => {
  assert.match(SRC, /head \$\{headSha\.slice\(0, 12\)\} !=/);
  assert.match(SRC, /did not build the commit you mean to stage/);
  // Default intent is origin/main's tip; --run-ref overrides.
  assert.match(SRC, /rev-parse', 'origin\/main'/);
  assert.match(SRC, /--run-ref/);
});

test('only build-and-upload runs may be staged (publish=false surface)', () => {
  // GitHub reports the workflow NAME ("Build and upload"), not the file name.
  assert.match(SRC, /not build-and-upload\.yml/);
  assert.match(SRC, /STAGE_WORKFLOW_RE = \/build\[-_ \]\?and\[-_ \]\?upload\/i/);
});

test('auto-run pick: only successful runs for the intended commit, loudly announced', () => {
  assert.match(SRC, /--status',\s*\n?\s*'success'/);
  assert.match(SRC, /no successful build-and-upload run found for commit/);
  assert.match(SRC, /--save-branch: no --run; using run/);
});

test('there is no standalone pnpm script — release:stage --save-branch is the only front door', () => {
  // The operator asked (2026-09-27) that the staging-branch save not be yet
  // another script; the routing test in release.test.mjs pins the other half.
  const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts['stage:installer'], undefined);
  // The module header must say so, so the next reader does not re-add it.
  assert.match(SRC, /no second\n\/\/ pnpm script/);
});

test('cleanup: failed runs remove the staging worktree and local orphan branch', () => {
  assert.match(SRC, /function cleanupWorktree/);
  // The catch lives INSIDE runStageInstaller (release.mjs routes here too —
  // cleanup must not depend on the standalone CLI's main).
  assert.match(
    SRC,
    /catch \(e\) \{[\s\S]*?cleanupWorktree\(work\);[\s\S]*?'branch', '-D', opts\.branch/
  );
  // A pre-existing branch the run collided with is NOT deleted without --force.
  assert.match(SRC, /orphanCreated \|\| opts\.force/);
  // --force clears a leftover local branch before the orphan checkout (the
  // --no-push preview leaves it registered; a retry must not collide).
  assert.match(SRC, /if \(opts\.force\) \{[\s\S]*?'branch', '-D', opts\.branch/);
});

test('--no-push is verification only: leaves neither worktree nor branch behind', () => {
  // The 2026-09-27 preview leaked both; the next run collided with the branch.
  const nopush = SRC.slice(SRC.indexOf('if (!opts.push)'));
  assert.match(nopush, /cleanupWorktree\(work\);/);
  assert.match(nopush, /'branch', '-D', opts\.branch/);
});

test('rollback stays one documented command (the disposable-branch contract)', () => {
  assert.match(SRC, /git push origin --delete \$\{opts\.branch\}/);
});
