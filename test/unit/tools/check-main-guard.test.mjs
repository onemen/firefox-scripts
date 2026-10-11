// test/unit/tools/check-main-guard.test.mjs — the main-worktree commit guard.
//
// Task work happens in worktrees; the shared checkout stays clean. The guard
// refuses commits made in the main checkout (where `.git` is a directory —
// linked worktrees carry a `.git` file) except paths in the tracked
// allowlist. Failing-first for #518.

import {test} from 'node:test';
import assert from 'node:assert/strict';

import {isMainWorktreeDir, refusedFiles, parseAllowlist} from '../../../tools/check-main-guard.mjs';

test('isMainWorktreeDir: a `.git` directory means the main checkout', () => {
  assert.equal(isMainWorktreeDir('.git'), true);
  assert.equal(isMainWorktreeDir('/repo/.git/worktrees/505-tickets'), false);
  assert.equal(isMainWorktreeDir('.git/worktrees/505-tickets'), false);
});

test('parseAllowlist: blanks and comments drop out', () => {
  assert.deepEqual(parseAllowlist('# nothing allowed\n\n  \n'), []);
  assert.deepEqual(parseAllowlist('docs/ci-inventory.md\ndist/scratch/\n'), [
    'docs/ci-inventory.md',
    'dist/scratch/',
  ]);
});

test('refusedFiles: empty allowlist refuses everything; dir prefixes cover trees', () => {
  assert.deepEqual(refusedFiles(['a/b.mjs'], []), ['a/b.mjs']);
  assert.deepEqual(refusedFiles(['a/b.mjs'], ['a/']), []);
  assert.deepEqual(refusedFiles(['a/b.mjs', 'c.md'], ['a/']), ['c.md']);
  assert.deepEqual(refusedFiles([], []), []);
});

test('refusedFiles: exact file entries allow just that file', () => {
  assert.deepEqual(refusedFiles(['docs/x.md'], ['docs/x.md']), []);
  assert.deepEqual(refusedFiles(['docs/y.md'], ['docs/x.md']), ['docs/y.md']);
});
