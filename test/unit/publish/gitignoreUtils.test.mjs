// test/unit/publish/gitignoreUtils.test.mjs — unit tests for the gitignore walk
// that decides zip contents AND the publish hash input set (2026-09-15 audit:
// the module had no tests; a bug here silently changes what users install).
//
// Two behavioral subtleties these tests pin deliberately:
// - shouldIgnore is FIRST-match-wins: the first pattern that matches decides,
//   unlike real gitignore where the last matching pattern wins. Callers sort
//   their patterns accordingly.
// - shouldIgnore matches a bare pattern against BOTH the baseDir-relative path
//   and the basename, so "dist" ignores a directory named dist at any depth;
//   directory patterns prune the walk in getAllFiles (ignored dirs are never
//   descended into).

import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseGitignore,
  loadAllGitignorePatterns,
  shouldIgnore,
  getAllFiles,
} from '../../../tools/publish/gitignoreUtils.mjs';

// ── parseGitignore ───────────────────────────────────────────────────────────

test('parseGitignore: missing file yields no patterns', () => {
  assert.deepEqual(parseGitignore(path.join(os.tmpdir(), 'definitely-missing-fxs-gitignore')), []);
});

test('parseGitignore: skips blank lines and comments, flags negations', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fxs-gi-parse-'));
  after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const file = path.join(dir, '.gitignore');
  fs.writeFileSync(file, '# comment\n\n*.log\n!keep.log\n   dist/   \n');
  assert.deepEqual(parseGitignore(file), [
    {pattern: '*.log', isNegation: false},
    {pattern: 'keep.log', isNegation: true},
    {pattern: 'dist/', isNegation: false},
  ]);
});

// ── loadAllGitignorePatterns ─────────────────────────────────────────────────

test('loadAllGitignorePatterns: combines files, custom patterns, and the .git suffix', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fxs-gi-load-'));
  after(() => fs.rmSync(dir, {recursive: true, force: true}));
  fs.writeFileSync(path.join(dir, 'a.gitignore'), 'one\n');
  fs.writeFileSync(path.join(dir, 'b.gitignore'), '!two\n');
  const patterns = loadAllGitignorePatterns(
    dir,
    [
      path.join(dir, 'a.gitignore'),
      path.join(dir, 'missing.gitignore'),
      path.join(dir, 'b.gitignore'),
    ],
    ['three']
  );
  assert.deepEqual(patterns, [
    {pattern: 'one', isNegation: false},
    {pattern: 'two', isNegation: true},
    {pattern: 'three', isNegation: false},
    {pattern: '.git', isNegation: false},
  ]);
});

// ── shouldIgnore ─────────────────────────────────────────────────────────────

const P = specs => specs.map(([pattern, isNegation = false]) => ({pattern, isNegation}));

test('shouldIgnore: bare pattern matches the basename at any depth', () => {
  const patterns = P([['secret.c']]);
  assert.equal(shouldIgnore('C:/base/a/b/secret.c', patterns, 'C:/base'), true);
  assert.equal(shouldIgnore('C:/base/secret.c', patterns, 'C:/base'), true);
  assert.equal(shouldIgnore('C:/base/other.c', patterns, 'C:/base'), false);
});

test('shouldIgnore: path pattern matches only the relative path', () => {
  const patterns = P([['installer/src/private.c']]);
  assert.equal(shouldIgnore('C:/base/installer/src/private.c', patterns, 'C:/base'), true);
  assert.equal(shouldIgnore('C:/base/other/private.c', patterns, 'C:/base'), false);
});

test('shouldIgnore: trailing-slash directory pattern', () => {
  const patterns = P([['updater/']]);
  assert.equal(shouldIgnore('C:/base/updater', patterns, 'C:/base'), true);
  assert.equal(shouldIgnore('C:/base/updater/x.sys.mjs', patterns, 'C:/base'), true);
  assert.equal(shouldIgnore('C:/base/updaterish.c', patterns, 'C:/base'), false);
});

test('shouldIgnore: ** patterns reach nested paths', () => {
  const patterns = P([['**/*.tmp']]);
  assert.equal(shouldIgnore('C:/base/a/b/c/deep.tmp', patterns, 'C:/base'), true);
  assert.equal(shouldIgnore('C:/base/deep.c', patterns, 'C:/base'), false);
});

test('shouldIgnore: a trailing-slash dir match decides immediately — deep negations cannot rescue', () => {
  // The trailing-slash branch RETURNS on the directory itself, before later
  // (negation) patterns are consulted — and getAllFiles prunes the dir without
  // descending. Unlike real gitignore (!logs/README would re-include), a file
  // under a dir-ignored tree is unreachable by negation. Callers must express
  // such exceptions as earlier sibling patterns, not later negations.
  // Fixtures use the parser-normalized shape: parseGitignore strips the
  // leading '!' into isNegation, so a stored pattern never contains '!' —
  // passing '!logs/README' here would exercise minimatch's own inverted-match
  // semantics instead of shouldIgnore's (batch review, 2026-09-15).
  const patterns = P([['logs/'], ['logs/README', true]]);
  assert.equal(shouldIgnore('C:/base/logs/debug.txt', patterns, 'C:/base'), true);
  assert.equal(shouldIgnore('C:/base/logs/README', patterns, 'C:/base'), true);
  // An EARLIER negation does win (first-match-wins is checked first):
  const rescued = P([['logs/README', true], ['logs/']]);
  assert.equal(shouldIgnore('C:/base/logs/README', rescued, 'C:/base'), false);
});

test('shouldIgnore: FIRST match wins — the opposite of gitignore last-match', () => {
  // Real gitignore would re-include keep.log (last matching pattern wins);
  // this implementation decides on the first match, so the negation after a
  // matching wildcard never applies. Pinned so nobody "fixes" a caller into
  // relying on git semantics.
  const patterns = P([['*.log'], ['keep.log', true]]);
  assert.equal(shouldIgnore('C:/base/keep.log', patterns, 'C:/base'), true);
});

test('shouldIgnore: forward slashes are the canonical separator on every platform', () => {
  const patterns = P([['installer/src/private.c']]);
  assert.equal(shouldIgnore('C:/base/installer/src/private.c', patterns, 'C:/base'), true);
});

test(
  'shouldIgnore: backslash paths normalize only via the Windows path module',
  // The normalization is path.relative's, which splits backslashes on win32
  // only. Production is safe everywhere — getAllFiles builds its paths with
  // the local path module — so only pin the backslash behavior on Windows.
  {skip: process.platform !== 'win32'},
  () => {
    const patterns = P([['installer/src/private.c']]);
    assert.equal(shouldIgnore('C:\\base\\installer\\src\\private.c', patterns, 'C:\\base'), true);
  }
);

// ── getAllFiles ──────────────────────────────────────────────────────────────

/**
 * Build the standard fixture tree; returns {root, relPaths} with relPaths
 * sorted.
 */
function makeTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fxs-gi-walk-'));
  const mk = rel => {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), {recursive: true});
    fs.writeFileSync(full, rel);
  };
  mk('src/main.c');
  mk('src/util.c');
  mk('src/updater/scriptsUpdater.sys.mjs');
  mk('node_modules/pkg/index.js');
  mk('debug.log');
  mk('src/trace.log');
  mk('skipdir/child.c');
  mk('.git/HEAD');
  return root;
}

test('getAllFiles: ignores ignored dirs and files, prunes the walk, auto-excludes .git', () => {
  const root = makeTree();
  after(() => fs.rmSync(root, {recursive: true, force: true}));
  const patterns = loadAllGitignorePatterns(root, [], ['node_modules', '*.log', 'skipdir']);
  const files = getAllFiles(root, patterns, root);
  const rel = files.map(f => path.relative(root, f).replace(/\\/g, '/')).sort();
  assert.deepEqual(rel, ['src/main.c', 'src/updater/scriptsUpdater.sys.mjs', 'src/util.c']);
});

test('getAllFiles: directories matching an ignore pattern are pruned, not descended', () => {
  const root = makeTree();
  after(() => fs.rmSync(root, {recursive: true, force: true}));
  // 'skipdir' ignores the directory by basename; the walk must never visit
  // child.c at all (pruning), which is also why deep negations inside an
  // ignored directory cannot rescue files — pin that cost of pruning.
  const patterns = loadAllGitignorePatterns(root, [], ['skipdir']);
  const files = getAllFiles(root, patterns, root);
  assert.ok(!files.some(f => f.includes('skipdir')), 'ignored dir pruned');
  assert.ok(
    files.some(f => f.endsWith('main.c')),
    'rest of tree walked'
  );
});

test('getAllFiles: includeSubfolders restricts top-level directories', () => {
  const root = makeTree();
  after(() => fs.rmSync(root, {recursive: true, force: true}));
  const patterns = loadAllGitignorePatterns(root, [], ['node_modules', '*.log', 'skipdir']);
  const files = getAllFiles(root, patterns, root, ['src']);
  const rel = files.map(f => path.relative(root, f).replace(/\\/g, '/')).sort();
  assert.deepEqual(rel, ['src/main.c', 'src/updater/scriptsUpdater.sys.mjs', 'src/util.c']);
});

test('getAllFiles: dot-directories other than .git are walked', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fxs-gi-dot-'));
  after(() => fs.rmSync(root, {recursive: true, force: true}));
  fs.mkdirSync(path.join(root, '.github'));
  fs.writeFileSync(path.join(root, '.github', 'ci.yml'), 'x');
  const files = getAllFiles(root, loadAllGitignorePatterns(root, [], []), root);
  assert.equal(files.length, 1);
  assert.ok(files[0].replace(/\\/g, '/').endsWith('.github/ci.yml'));
});
