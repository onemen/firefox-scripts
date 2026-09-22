// SPDX-License-Identifier: MIT
//
// tools/check-main-clean.mjs — fail loudly when the SHARED main checkout gained
// changes while a task was supposed to work only in its own worktree.
//
// Why this exists: task work happens in `<workspace>/worktrees/<slug>/`, and the
// main worktree is read-only for it (see the `change-workflow` skill). The one
// way that rule breaks is a path that resolves a level up — a bare `docs/...`
// instead of `../worktrees/<slug>/docs/...` — and then the edit lands in the
// shared checkout, where it is invisible until someone notices a stray diff
// card. Both checkouts usually sit on the same commit, so reading or grepping
// the file back proves nothing: the text looks right in either tree. This guard
// makes the mistake detectable the moment it happens instead of at review time.
//
// Usage (from the task worktree):
//   node tools/check-main-clean.mjs --record   # task start: snapshot the shared checkout
//   node tools/check-main-clean.mjs            # before finishing: fail if it gained anything
//   node tools/check-main-clean.mjs --status   # print the shared checkout's state, never fails
//
// Baselines are per-repo, not per-branch: they live in the shared git dir
// (`<common-dir>/main-clean-baseline.json`), so every worktree of this clone
// reads the same one. `--record` is for the case where the human has deliberate
// work in progress in the shared checkout — without a baseline, ANY dirty path
// there fails the check, which is the strict behaviour the workflow wants.
//
// Exit codes: 0 clean (or --status), 1 the shared checkout gained changes,
// 2 usage.

import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

const BASELINE_NAME = 'main-clean-baseline.json';

/**
 * Parse `git worktree list --porcelain`: blocks of `key value` lines separated
 * by blank lines (`bare`/`detached`/`locked`/`prunable` are flag lines).
 *
 * @param {string} text
 * @returns {{
 *   path: string;
 *   head: string;
 *   branch: string;
 *   bare: boolean;
 *   detached: boolean;
 * }[]}
 */
export function parseWorktrees(text) {
  const entries = [];
  let current = null;
  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      if (current) entries.push(current);
      current = null;
      continue;
    }
    const [key, ...rest] = line.split(' ');
    const value = rest.join(' ');
    if (key === 'worktree') {
      if (current) entries.push(current);
      current = {path: value, head: '', branch: '', bare: false, detached: false};
    } else if (current) {
      if (key === 'HEAD') current.head = value;
      else if (key === 'branch') current.branch = value;
      else if (key === 'bare') current.bare = true;
      else if (key === 'detached') current.detached = true;
    }
  }
  if (current) entries.push(current);
  return entries;
}

/**
 * The shared main checkout. `git worktree list` lists the main worktree first
 * (git's documented order), and a bare clone has none to guard.
 *
 * @param {{path: string; bare: boolean}[]} worktrees
 * @returns {{path: string; head: string; branch: string} | null}
 */
export function mainWorktree(worktrees) {
  const first = worktrees.find(w => !w.bare);
  return first ? {path: first.path, head: first.head, branch: first.branch} : null;
}

/**
 * Parse `git status --porcelain`: one `XY <path>` line per entry, renames as
 * `XY <old> -> <new>`. Keys are the current path (what a reviewer looks for).
 *
 * @param {string} text
 * @returns {{code: string; path: string}[]}
 */
export function parseStatus(text) {
  const entries = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const code = line.slice(0, 2);
    const rest = line.slice(3);
    const arrow = rest.indexOf(' -> ');
    entries.push({code, path: arrow === -1 ? rest : rest.slice(arrow + 4)});
  }
  return entries;
}

/**
 * Compare the shared checkout now against its recorded baseline.
 *
 * @param {{head?: string; entries?: {code: string; path: string}[]} | null} baseline
 * @param {{head: string; entries: {code: string; path: string}[]}} current
 * @returns {{
 *   newlyDirty: {code: string; path: string}[];
 *   cleaned: string[];
 *   headMoved: boolean;
 *   recorded: boolean;
 * }}
 */
export function compareToBaseline(baseline, current) {
  if (!baseline) {
    // No baseline: the workflow's default expectation is a clean shared
    // checkout, so every dirty path is treated as a finding.
    return {newlyDirty: current.entries, cleaned: [], headMoved: false, recorded: false};
  }
  const before = new Map((baseline.entries ?? []).map(e => [e.path, e.code]));
  const now = new Map(current.entries.map(e => [e.path, e.code]));
  const newlyDirty = current.entries.filter(e => before.get(e.path) !== e.code);
  const cleaned = [...before.keys()].filter(p => !now.has(p));
  return {
    newlyDirty,
    cleaned,
    headMoved: Boolean(baseline.head) && baseline.head !== current.head,
    recorded: true,
  };
}

/**
 * @param {object} args
 * @param {string} args.mainPath
 * @param {string} args.currentPath
 * @param {{head: string; entries: {code: string; path: string}[]}} args.current
 * @param {ReturnType<typeof compareToBaseline>} args.result
 * @param {string} [args.recordedAt]
 * @returns {string} the human report (multi-line)
 */
export function formatReport({mainPath, currentPath, current, result, recordedAt}) {
  const lines = [];
  const inMain = path.resolve(currentPath) === path.resolve(mainPath);
  lines.push(`shared checkout: ${mainPath} (HEAD ${current.head.slice(0, 12)})`);
  if (inMain) {
    lines.push(
      'note: you are running inside the shared checkout itself — the guard is meant to be'
    );
    lines.push('      run from a task worktree, where it detects edits that leaked a level up.');
  }
  if (result.newlyDirty.length > 0) {
    lines.push('');
    lines.push(
      result.recorded ?
        `✗ the shared checkout gained ${result.newlyDirty.length} change(s) since the baseline` +
          (recordedAt ? ` (recorded ${recordedAt})` : '') +
          ':'
      : `✗ the shared checkout is dirty (no baseline recorded — every path counts):`
    );
    for (const e of result.newlyDirty) lines.push(`    ${e.code} ${e.path}`);
    lines.push('');
    lines.push('  Move these edits into the task worktree, then restore the shared checkout:');
    lines.push(
      `    git -C ${mainPath} checkout -- <paths>      # only after checking the diff is yours`
    );
    return lines.join('\n');
  }
  if (result.recorded) {
    lines.push(
      result.cleaned.length > 0 ?
        `✓ no new changes (${result.cleaned.length} path(s) dirty at baseline are clean again)`
      : '✓ unchanged since the baseline'
    );
  } else {
    lines.push('✓ clean');
  }
  if (result.headMoved) {
    lines.push(
      'note: its HEAD moved since the baseline — another thread committed there. Fine, but'
    );
    lines.push('      if that was not expected, look at what landed.');
  }
  return lines.join('\n');
}

const isCli =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isCli) {
  const argv = process.argv.slice(2);
  const record = argv.includes('--record');
  const statusOnly = argv.includes('--status');
  const unknown = argv.filter(a => !['--record', '--status'].includes(a));
  if (unknown.length > 0) {
    console.error(`unknown argument: ${unknown[0]} (see --help)`);
    process.exit(2);
  }
  if (argv.includes('--help')) {
    console.log(
      'usage: node tools/check-main-clean.mjs [--record | --status]\n' +
        "  --record  snapshot the shared checkout as this task's baseline\n" +
        '  --status  print its current state (never fails)'
    );
    process.exit(0);
  }

  const git = (args, cwd) =>
    execFileSync('git', args, {cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe']});

  const currentPath = git(['rev-parse', '--show-toplevel'], process.cwd()).trim();
  const worktrees = parseWorktrees(git(['worktree', 'list', '--porcelain'], currentPath));
  const main = mainWorktree(worktrees);
  if (!main) {
    console.error('no non-bare worktree found — nothing to guard');
    process.exit(2);
  }

  const current = {
    head: git(['-C', main.path, 'rev-parse', 'HEAD'], currentPath).trim(),
    entries: parseStatus(
      git(['-C', main.path, 'status', '--porcelain', '--untracked-files=all'], currentPath)
    ),
  };

  const commonDir = git(
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    currentPath
  ).trim();
  const baselineFile = path.join(commonDir, BASELINE_NAME);

  if (record) {
    fs.writeFileSync(
      baselineFile,
      JSON.stringify(
        {
          recordedAt: new Date().toISOString(),
          mainPath: main.path,
          head: current.head,
          entries: current.entries,
        },
        null,
        2
      ) + '\n'
    );
    console.log(
      `recorded baseline: ${current.entries.length} pre-existing change(s) in ${main.path}`
    );
    console.log(`  ${baselineFile}`);
    process.exit(0);
  }

  const baseline =
    fs.existsSync(baselineFile) ? JSON.parse(fs.readFileSync(baselineFile, 'utf-8')) : null;
  const result = compareToBaseline(baseline, current);
  if (statusOnly) {
    console.log(`shared checkout: ${main.path} (HEAD ${current.head.slice(0, 12)})`);
    for (const e of current.entries) console.log(`  ${e.code} ${e.path}`);
    if (current.entries.length === 0) console.log('  (clean)');
    if (!baseline) console.log('  (no baseline recorded)');
    process.exit(0);
  }
  console.log(
    formatReport({
      mainPath: main.path,
      currentPath,
      current,
      result,
      recordedAt: baseline?.recordedAt,
    })
  );
  if (result.newlyDirty.length > 0) process.exit(1);
}
