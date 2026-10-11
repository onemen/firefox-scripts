#!/usr/bin/env node

/**
 * tools/check-main-guard.mjs — refuse commits made in the main checkout.
 *
 * Task work happens in worktrees (`change-workflow`); the shared checkout is
 * read-only for task work. In the main checkout `.git` is a directory, while
 * linked worktrees carry a `.git` file — that is the whole detector, so no path
 * registry or config can drift. Paths in the tracked allowlist
 * (`githooks/main-allowlist.txt`, empty by default) may still commit there.
 *
 * Run as the `pre-commit` hook via `pnpm hooks:install` (core.hooksPath). Exit
 * code 0 = commit may proceed.
 */

import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWLIST_REL = path.join('githooks', 'main-allowlist.txt');

/**
 * Whether a `git rev-parse --git-dir` value denotes the main checkout: a bare
 * `.git` (directory) as opposed to a linked worktree's `.git/worktrees/<name>`
 * path.
 *
 * @param {string} gitDir the `--git-dir` output
 * @returns {boolean}
 */
export function isMainWorktreeDir(gitDir) {
  return path.basename(gitDir.trim()) === '.git' && !gitDir.includes('worktrees');
}

/**
 * Allowlist entries: one pathspec per line, `#` comments and blanks dropped. A
 * trailing-slash entry covers the whole tree.
 *
 * @param {string} text allowlist file content
 * @returns {string[]}
 */
export function parseAllowlist(text) {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '' && !line.startsWith('#'));
}

/**
 * Staged files the guard refuses: everything not covered by the allowlist. An
 * entry ending in `/` is a tree prefix; anything else is an exact file.
 *
 * @param {string[]} files repo-relative staged paths
 * @param {string[]} allowlist parsed entries
 * @returns {string[]}
 */
export function refusedFiles(files, allowlist) {
  return files.filter(
    file =>
      !allowlist.some(entry => (entry.endsWith('/') ? file.startsWith(entry) : file === entry))
  );
}

function stagedFiles() {
  const out = execFileSync('git', ['diff', '--cached', '--name-only', '-z'], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
  });
  return out
    .split('\0')
    .map(s => s.trim())
    .filter(Boolean);
}

function readAllowlist() {
  const abs = path.join(REPO_ROOT, ALLOWLIST_REL);
  if (!fs.existsSync(abs)) return [];
  return parseAllowlist(fs.readFileSync(abs, 'utf8'));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const gitDir = execFileSync('git', ['rev-parse', '--git-dir'], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
  }).trim();
  if (!isMainWorktreeDir(gitDir)) process.exit(0);

  const refused = refusedFiles(stagedFiles(), readAllowlist());
  if (refused.length > 0) {
    console.error(
      'Refusing to commit in the main checkout — task work belongs in a worktree ' +
        '(`change-workflow`). Move the change there, or add an allowlist entry to ' +
        `${ALLOWLIST_REL}.\nRefused:\n` +
        refused.map(f => `  ${f}`).join('\n')
    );
    process.exit(1);
  }
}
