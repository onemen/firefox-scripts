#!/usr/bin/env node

/**
 * Dependency hand-off for `--ref` builds (tools/publish/upload.mjs →
 * runRefBuild): a fresh `git worktree add` carries no node_modules (gitignored,
 * never materialized), so the ref's own publish scripts — re-executed inside
 * the worktree by design — crash on their first npm import.
 *
 * linkNodeModules() bridges that gap without touching the ref's sources: it
 * exposes the current checkout's installed node_modules inside the worktree via
 * a junction (Windows) or symlink (POSIX). Node resolves imports through the
 * link, while the scripts themselves stay the ref's own compatible copies.
 * Parent and worktree share one install; nothing is duplicated or installed
 * anew. unlinkNodeModules() removes the link before the worktree is deleted, so
 * the removal can never traverse into the real store.
 */

import fs from 'fs';
import path from 'path';

/**
 * Point <worktree>/node_modules at <parent>/node_modules. Returns the link
 * path, or null when the parent has no install to share (callers may fall back
 * to running the package manager inside the worktree).
 */
export function linkNodeModules(parentRoot, worktreeRoot) {
  // Resolve up front: fs.symlinkSync interprets a relative target against the
  // link's directory, not the caller's cwd, which would silently mislink.
  const from = path.resolve(parentRoot, 'node_modules');
  const to = path.resolve(worktreeRoot, 'node_modules');
  if (!fs.existsSync(from)) return null;
  fs.rmSync(to, {recursive: true, force: true});
  if (process.platform === 'win32') {
    // Junction: no admin rights, no developer mode, and removal never
    // traverses into the target.
    fs.symlinkSync(from, to, 'junction');
  } else {
    fs.symlinkSync(from, to, 'dir');
  }
  return to;
}

/** Remove the worktree's node_modules link (no-op when absent). */
export function unlinkNodeModules(worktreeRoot) {
  const to = path.resolve(worktreeRoot, 'node_modules');
  try {
    const st = fs.lstatSync(to);
    if (st.isSymbolicLink() || st.isDirectory()) fs.rmSync(to, {recursive: true, force: true});
  } catch {
    /* already gone */
  }
}
