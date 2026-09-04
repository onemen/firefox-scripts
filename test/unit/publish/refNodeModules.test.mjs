'use strict';

import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {linkNodeModules, unlinkNodeModules} from '../../../tools/publish/refNodeModules.mjs';

/** One disposable parent/worktree pair; cleaned up after each test. */
function makePair() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'rnm-parent-'));
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'rnm-worktree-'));
  return {
    parent,
    worktree,
    cleanup() {
      fs.rmSync(parent, {recursive: true, force: true});
      fs.rmSync(worktree, {recursive: true, force: true});
    },
  };
}

describe('refNodeModules: linkNodeModules', () => {
  it('exposes the parent install inside the worktree and resolves packages through it', () => {
    const {parent, worktree, cleanup} = makePair();
    try {
      fs.mkdirSync(path.join(parent, 'node_modules', 'minimatch', 'dist'), {recursive: true});
      fs.writeFileSync(
        path.join(parent, 'node_modules', 'minimatch', 'package.json'),
        JSON.stringify({name: 'minimatch', version: '9.0.0'})
      );

      const link = linkNodeModules(parent, worktree);
      assert.equal(link, path.join(worktree, 'node_modules'));
      assert.equal(
        JSON.parse(fs.readFileSync(path.join(link, 'minimatch', 'package.json'), 'utf8')).version,
        '9.0.0'
      );
      // Same files, not a copy: writing through the link lands in the parent.
      fs.writeFileSync(path.join(link, 'minimatch', 'probe'), 'x');
      assert.ok(fs.existsSync(path.join(parent, 'node_modules', 'minimatch', 'probe')));
    } finally {
      cleanup();
    }
  });

  it('replaces a stale worktree node_modules before linking', () => {
    const {parent, worktree, cleanup} = makePair();
    try {
      fs.mkdirSync(path.join(worktree, 'node_modules', 'stale-pkg'), {recursive: true});
      fs.mkdirSync(path.join(parent, 'node_modules', 'fresh-pkg'), {recursive: true});

      linkNodeModules(parent, worktree);

      assert.ok(fs.existsSync(path.join(worktree, 'node_modules', 'fresh-pkg')));
      assert.ok(!fs.existsSync(path.join(worktree, 'node_modules', 'stale-pkg')));
    } finally {
      cleanup();
    }
  });

  it('accepts relative paths (resolved against cwd, not the link dir)', () => {
    const {parent, worktree, cleanup} = makePair();
    try {
      fs.mkdirSync(path.join(parent, 'node_modules', 'rel-pkg'), {recursive: true});
      // Relative forms: one correct relative to cwd, one that would resolve
      // wrong if symlinkSync interpreted it against the link's directory.
      const relParent = path.relative(process.cwd(), parent);
      const link = linkNodeModules(relParent, path.relative(process.cwd(), worktree));
      assert.ok(link, 'link created');
      assert.ok(fs.existsSync(path.join(link, 'rel-pkg')));
    } finally {
      cleanup();
    }
  });

  it('returns null when the parent has no install (caller falls back or fails with guidance)', () => {
    const {parent, worktree, cleanup} = makePair();
    try {
      assert.equal(linkNodeModules(parent, worktree), null);
    } finally {
      cleanup();
    }
  });
});

describe('refNodeModules: unlinkNodeModules', () => {
  it('removes the link but never the parent install', () => {
    const {parent, worktree, cleanup} = makePair();
    try {
      fs.mkdirSync(path.join(parent, 'node_modules', 'real-pkg'), {recursive: true});
      linkNodeModules(parent, worktree);

      unlinkNodeModules(worktree);

      assert.ok(!fs.existsSync(path.join(worktree, 'node_modules')));
      assert.ok(fs.existsSync(path.join(parent, 'node_modules', 'real-pkg')));
    } finally {
      cleanup();
    }
  });

  it('is a no-op when the link is absent', () => {
    const {worktree, cleanup} = makePair();
    try {
      assert.doesNotThrow(() => unlinkNodeModules(worktree));
    } finally {
      cleanup();
    }
  });
});
