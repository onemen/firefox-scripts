// test/unit/publish/stageInstaller.test.mjs — the stageInstaller tool's pure
// parts (arg parsing) plus the wiring pins that keep the gates honest.
//
// Why this tool exists: the pre-release manual test needs the byte-exact PROD
// installer downloadable from GitHub BEFORE the publish, without touching
// gh-pages/the release/hashes.json. A disposable orphan branch carries the
// binary; the gates (--run exists, --expect sha256, tree assertion after
// push) exist because every one of them caught a real failure on 2026-09-27:
// a moved main (wrong bytes), a stale --expect (wrong bytes), and the global
// `*.exe` gitignore silently dropping the binary from the pushed tree.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const {parseArgsOrThrow} = await import('../../../tools/publish/stageInstaller.mjs');
const SRC = readFileSync(
  new URL('../../../tools/publish/stageInstaller.mjs', import.meta.url),
  'utf-8'
);

test('parseArgs: --run is required and must be numeric', () => {
  assert.throws(() => parseArgsOrThrow([]), /--run <id> is required/);
  assert.throws(() => parseArgsOrThrow(['--run', 'abc']), /--run <id> is required/);
  // Reaching past parsing into the gh call for a numeric run is fine — the
  // failure then comes from the (absent) network, not the parser.
});

test('parseArgs: --expect must be the full 64-hex sha256', () => {
  assert.throws(() => parseArgsOrThrow(['--run', '1', '--expect', '037032aa']), /64-hex/);
});

test('parseArgs: --branch defaults to stage-installer-<today>, --no-push flips push off', () => {
  assert.match(SRC, /stage-installer-\$\{new Date\(\)\.toISOString\(\)\.slice\(0, 10\)\}/);
  assert.match(SRC, /'--no-push'\) opts\.push = false/);
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
  assert.match(SRC, /build\[-_ \]\?and\[-_ \]\?upload\/i/);
});

test('the package.json alias exists and points at the tool', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts['stage:installer'], 'node tools/publish/stageInstaller.mjs');
});

test('rollback stays one documented command (the disposable-branch contract)', () => {
  assert.match(SRC, /git push origin --delete \$\{opts\.branch\}/);
});
