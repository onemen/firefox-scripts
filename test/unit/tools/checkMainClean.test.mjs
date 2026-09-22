// SPDX-License-Identifier: MIT

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  compareToBaseline,
  formatReport,
  mainWorktree,
  parseStatus,
  parseWorktrees,
} from '../../../tools/check-main-clean.mjs';

const PORCELAIN = [
  'worktree C:/code/repo',
  'HEAD 3ab890eaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  'branch refs/heads/main',
  '',
  'worktree C:/code/repo/worktrees/task-a',
  'HEAD 3ab890eaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  'branch refs/heads/task/a',
  '',
  'worktree C:/code/repo/worktrees/detached',
  'HEAD 3ab890eaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  'detached',
  '',
].join('\n');

test('parseWorktrees: splits blocks and keeps flags', () => {
  const trees = parseWorktrees(PORCELAIN);
  assert.equal(trees.length, 3);
  assert.deepEqual(
    trees.map(t => t.path),
    ['C:/code/repo', 'C:/code/repo/worktrees/task-a', 'C:/code/repo/worktrees/detached']
  );
  assert.equal(trees[0].branch, 'refs/heads/main');
  assert.equal(trees[2].detached, true);
  assert.equal(trees[1].detached, false);
  // No trailing blank line in the input: the last block still lands.
  assert.equal(parseWorktrees(PORCELAIN.trimEnd()).length, 3);
});

test('mainWorktree: the first non-bare entry is the shared checkout', () => {
  const trees = parseWorktrees(PORCELAIN);
  assert.equal(mainWorktree(trees).path, 'C:/code/repo');
  const bareOnly = parseWorktrees('worktree C:/code/bare.git\nHEAD abc\nbare\n');
  assert.equal(mainWorktree(bareOnly), null);
});

test('parseStatus: codes, paths and renames', () => {
  const entries = parseStatus(
    [' M docs/DEVELOPING.md', '?? tools/new.mjs', 'R  old/a.md -> new/a.md', ''].join('\n')
  );
  assert.deepEqual(entries, [
    {code: ' M', path: 'docs/DEVELOPING.md'},
    {code: '??', path: 'tools/new.mjs'},
    {code: 'R ', path: 'new/a.md'},
  ]);
});

test('compareToBaseline: only paths that are new or changed count', () => {
  const baseline = {
    head: 'aaa',
    entries: [{code: ' M', path: 'docs/DEVELOPING.md'}],
  };
  const current = {
    head: 'aaa',
    entries: [
      {code: ' M', path: 'docs/DEVELOPING.md'}, // pre-existing, unchanged
      {code: ' M', path: 'AGENTS.md'}, // leaked
      {code: '??', path: 'tools/stray.mjs'}, // leaked
    ],
  };
  const result = compareToBaseline(baseline, current);
  assert.deepEqual(
    result.newlyDirty.map(e => e.path),
    ['AGENTS.md', 'tools/stray.mjs']
  );
  assert.equal(result.headMoved, false);
  assert.equal(result.recorded, true);
});

test('compareToBaseline: a code change on a pre-existing path is a finding', () => {
  const baseline = {head: 'aaa', entries: [{code: ' M', path: 'AGENTS.md'}]};
  const current = {head: 'aaa', entries: [{code: 'A ', path: 'AGENTS.md'}]};
  assert.deepEqual(
    compareToBaseline(baseline, current).newlyDirty.map(e => e.code),
    ['A ']
  );
});

test('compareToBaseline: without a baseline every dirty path is a finding', () => {
  const current = {head: 'aaa', entries: [{code: ' M', path: 'docs/x.md'}]};
  const result = compareToBaseline(null, current);
  assert.equal(result.recorded, false);
  assert.deepEqual(
    result.newlyDirty.map(e => e.path),
    ['docs/x.md']
  );
});

test('compareToBaseline: cleaned paths and a moved HEAD are reported, not failed', () => {
  const baseline = {head: 'aaa', entries: [{code: ' M', path: 'docs/x.md'}]};
  const current = {head: 'bbb', entries: []};
  const result = compareToBaseline(baseline, current);
  assert.deepEqual(result.newlyDirty, []);
  assert.deepEqual(result.cleaned, ['docs/x.md']);
  assert.equal(result.headMoved, true);
});

test('formatReport: names the leaked paths and the recovery command', () => {
  const current = {head: '3ab890eaaaa', entries: [{code: ' M', path: 'AGENTS.md'}]};
  const result = compareToBaseline({head: '3ab890eaaaa', entries: []}, current);
  const text = formatReport({
    mainPath: 'C:/code/repo',
    currentPath: 'C:/code/repo/worktrees/task-a',
    current,
    result,
    recordedAt: '2026-09-22T00:00:00Z',
  });
  assert.match(text, /✗ the shared checkout gained 1 change/);
  assert.match(text, / {4} M AGENTS\.md/);
  assert.match(text, /git -C C:\/code\/repo checkout -- <paths>/);
});

test('formatReport: clean, and running inside the shared checkout is called out', () => {
  const current = {head: '3ab890eaaaa', entries: []};
  const text = formatReport({
    mainPath: 'C:/code/repo',
    currentPath: 'C:/code/repo/worktrees/task-a',
    current,
    result: compareToBaseline({head: '3ab890eaaaa', entries: []}, current),
    recordedAt: '2026-09-22T00:00:00Z',
  });
  assert.match(text, /✓ unchanged since the baseline/);

  const inside = formatReport({
    mainPath: 'C:/code/repo',
    currentPath: 'C:/code/repo',
    current,
    result: compareToBaseline(null, current),
  });
  assert.match(inside, /you are running inside the shared checkout/);
  assert.match(inside, /✓ clean/, 'a clean shared checkout passes even with no baseline');
});
