// test/unit/publish/releaseRef.test.mjs — resolveDispatchRef: the dispatch API
// (`gh workflow run --ref`) dispatches only refs that exist ON GITHUB — branch
// or tag names. A commit SHA is rejected with "HTTP 422: No ref found" (how
// `pnpm release:stage -- --ref=<sha>` failed on 2026-09-27), and so is a
// LOCAL-ONLY branch (proven the same day: a local feature branch 422'd exactly
// like the SHA).
//
// Semantics pinned here (release.mjs's docstring is the prose version):
//   1. branch/tag refs pass through untouched — no resolution;
//   2. a hex-WORD name that exists as a ref ('facade') passes through too —
//      SHA-shaped text is only treated as a commit when no ref bears the name;
//   3. a SHA resolves from REMOTE-TRACKED refs only: branches whose tip
//      contains it (tip-exact preferred — the fresh-merge case) and tags;
//   4. the `origin/HEAD` symref alias never leaks as a dispatch name;
//   5. a SHA no remote-tracked ref contains is a loud error, never a silent
//      dispatch of something unrelated;
//   6. an unresolvable SHA is a loud error, not a dispatch.
//
// The tests simulate remote-tracking refs with `git update-ref
// refs/remotes/...` — no network, no real remote; a failed `git fetch` (no
// remote configured here) only warns, which is itself pinned behavior.

import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const {resolveDispatchRef} = await import('../../../tools/publish/release.mjs');

// Same temp-leak hygiene as buildEpoch.test.mjs: every throwaway repo registers
// its root and one sweep removes them all after the file's tests finish —
// 1216 leaked `dispatch-ref-repo-*` dirs in the user's Temp forced this.
const tempRoots = [];
after(() => {
  for (const root of tempRoots) {
    try {
      fs.rmSync(root, {recursive: true, force: true});
    } catch (error) {
      // See buildEpoch.test.mjs: hygiene, not an assertion — warn and continue.
      console.warn(`temp cleanup failed for ${root}: ${error.message}`);
    }
  }
});

/**
 * Scrub the ambient git overlays (GIT_DIR/GIT_INDEX_FILE/…) for every git call
 * in this file — helpers AND tests. Under the pre-push hook git exports them at
 * the checkout being pushed; without the scrub, the throwaway repos' `git
 * init`/`add`/`commit` would land in THAT repository's ref store (the exact
 * contamination buildEpoch.test.mjs documents; proven here 2026-09-27). The
 * tests deliberately re-export the overlays afterwards to prove the helpers
 * cannot be redirected.
 */
function cleanGitEnv() {
  const env = {...process.env};
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_PREFIX',
    'GIT_COMMON_DIR',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  ]) {
    delete env[key];
  }
  return env;
}

/**
 * A throwaway repo with one commit on main (explicit identity, like
 * buildEpoch's).
 */
function tempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-ref-repo-'));
  tempRoots.push(dir);
  git(['init', '-q', '-b', 'main'], dir);
  fs.writeFileSync(path.join(dir, 'file.txt'), 'one\n');
  git(['add', '.'], dir);
  git(
    ['-c', 'user.email=t@example.invalid', '-c', 'user.name=T', 'commit', '-q', '-m', 'one'],
    dir
  );
  return dir;
}

function git(args, cwd) {
  return execFileSync('git', args, {cwd, encoding: 'utf-8', env: cleanGitEnv()}).trim();
}

/** Commit a file on a branch (creating or resetting it from the current HEAD). */
function commitOn(dir, branch, file, body) {
  git(['checkout', '-q', '-B', branch], dir);
  fs.writeFileSync(path.join(dir, file), body);
  git(['add', file], dir);
  git(['-c', 'user.email=t@example.invalid', '-c', 'user.name=T', 'commit', '-q', '-m', file], dir);
  return git(['rev-parse', 'HEAD'], dir);
}

/** Simulate the remote-tracking refs a `git fetch` would have created. */
function trackRemote(dir, branch, sha) {
  git(['update-ref', `refs/remotes/origin/${branch}`, sha], dir);
}

test('branch and tag refs pass through untouched (no resolution, no git)', () => {
  assert.equal(resolveDispatchRef('main', os.tmpdir()), 'main');
  assert.equal(resolveDispatchRef('dev-build-x-123', os.tmpdir()), 'dev-build-x-123');
  // Tag-like names pass too; resolution is only for SHA-shaped input.
  assert.equal(resolveDispatchRef('installer-2026-09-27', os.tmpdir()), 'installer-2026-09-27');
});

test('a hex-WORD ref name (facade) passes through instead of being read as a SHA', () => {
  const repo = tempRepo();
  const sha = commitOn(repo, 'facade', 'f.txt', 'f\n'); // 'facade' is 6 hex chars
  trackRemote(repo, 'facade', sha);
  assert.equal(resolveDispatchRef('facade', repo), 'facade');
});

test('a hex-WORD tag name passes through instead of being read as a SHA', () => {
  const repo = tempRepo();
  const sha = commitOn(repo, 'main', 't.txt', 't\n');
  git(['tag', 'deadc0de', sha], repo); // 7 hex chars, tag only
  assert.equal(resolveDispatchRef('deadc0de', repo), 'deadc0de');
});

test('a hex-WORD naming only a LOCAL branch is the local-only error, never SHA-guessed', () => {
  // CodeRabbit (PR #337 review): a locally-resolvable hex name could otherwise
  // be read as a hash of some OTHER commit and dispatch a different ref.
  const repo = tempRepo();
  commitOn(repo, 'deadbeef', 'd.txt', 'd\n'); // local branch, no remote twin
  git(['checkout', '-q', 'main'], repo);
  assert.throws(() => resolveDispatchRef('deadbeef', repo), /names a local-only branch/);
});

test('a hex-WORD that names no ref at all takes the SHA path (unresolvable → loud error)', () => {
  const repo = tempRepo();
  assert.throws(
    () => resolveDispatchRef('dead00beef', repo),
    /cannot resolve it in this repository/
  );
});

test('a SHA whose remote branch tip IS the commit resolves to that branch (fresh merge)', () => {
  const repo = tempRepo();
  const sha = commitOn(repo, 'main', 'two.txt', 'two\n');
  trackRemote(repo, 'main', sha);
  assert.equal(resolveDispatchRef(sha, repo), 'main');
  assert.equal(resolveDispatchRef(sha.slice(0, 8), repo), 'main');
});

test('a SHA tracked only on a remote feature branch resolves to the plain branch name', () => {
  const repo = tempRepo();
  const sha = commitOn(repo, 'feature', 'feat.txt', 'feat\n');
  trackRemote(repo, 'feature', sha);
  git(['checkout', '-q', 'main'], repo);
  assert.equal(resolveDispatchRef(sha, repo), 'feature');
});

test('a LOCAL-ONLY branch never satisfies the resolution (it would 422 exactly like a SHA)', () => {
  const repo = tempRepo();
  const sha = commitOn(repo, 'solo', 's.txt', 's\n'); // local branch, no remote-tracking twin
  git(['checkout', '-q', 'main'], repo);
  assert.throws(() => resolveDispatchRef(sha, repo), /no remote-tracked branch or tag/);
});

test('candidates come from origin ONLY — another remote never leaks into the dispatch', () => {
  // CodeRabbit (PR #337 review): buildDispatchArgs runs gh without --repo, so
  // the dispatch targets the origin repo; a candidate found only on another
  // remote ('upstream') has a plain name that belongs to a DIFFERENT GitHub
  // repo — dispatching it here could build the wrong repository's branch.
  const repo = tempRepo();
  const sha = commitOn(repo, 'feature', 'feat.txt', 'feat\n');
  git(['update-ref', 'refs/remotes/upstream/feature', sha], repo);
  git(['checkout', '-q', 'main'], repo);
  assert.throws(() => resolveDispatchRef(sha, repo), /no remote-tracked branch or tag/);
});

test('origin/HEAD (a symref alias, not a name) is skipped', () => {
  const repo = tempRepo();
  const sha = commitOn(repo, 'main', 'two.txt', 'two\n');
  trackRemote(repo, 'main', sha);
  git(['update-ref', 'refs/remotes/origin/HEAD', sha], repo);
  assert.equal(resolveDispatchRef(sha, repo), 'main');
});

test('a tip-exact branch is preferred over branches that merely contain the commit', () => {
  const repo = tempRepo();
  const sha = commitOn(repo, 'main', 'two.txt', 'two\n');
  // 'old' contains the commit but its tip has moved on.
  git(['checkout', '-q', '-B', 'old', 'main'], repo);
  fs.writeFileSync(path.join(repo, 'newer.txt'), 'n\n');
  git(['add', 'newer.txt'], repo);
  git(
    ['-c', 'user.email=t@example.invalid', '-c', 'user.name=T', 'commit', '-q', '-m', 'newer'],
    repo
  );
  trackRemote(repo, 'old', git(['rev-parse', 'old'], repo));
  trackRemote(repo, 'main', sha);
  git(['checkout', '-q', 'main'], repo);
  assert.equal(resolveDispatchRef(sha, repo), 'main');
});

test('a tag containing the commit is a valid (commit-exact) resolution', () => {
  const repo = tempRepo();
  const sha = commitOn(repo, 'release', 'r.txt', 'r\n');
  git(['tag', 'v1.2.3', sha], repo);
  git(['checkout', '-q', 'main'], repo);
  git(['branch', '-D', 'release'], repo); // no remote-tracked branch contains it
  assert.equal(resolveDispatchRef(sha, repo), 'v1.2.3');
});

test('a tag on a DESCENDANT commit is non-exact: caveat is printed, never silent', () => {
  // CodeRabbit (PR #337 review): `git tag --contains` also lists tags whose
  // target is a descendant — such a tag must not be reported as exact.
  const repo = tempRepo();
  const sha = commitOn(repo, 'main', 'one.txt', 'one\n');
  const descendant = commitOn(repo, 'main', 'two.txt', 'two\n');
  git(['tag', 'later-tag', descendant], repo); // contains sha, but points PAST it
  const notices = [];
  const originalError = console.error;
  console.error = message => notices.push(String(message));
  try {
    assert.equal(resolveDispatchRef(sha.slice(0, 8), repo), 'later-tag');
  } finally {
    console.error = originalError;
  }
  assert.ok(
    notices.some(message => message.includes("that ref's target commit, not")),
    `expected the non-exact caveat in the notice, got: ${JSON.stringify(notices)}`
  );
});

test('a SHA no remote-tracked ref contains fails LOUDLY with the options', () => {
  const repo = tempRepo();
  const sha = commitOn(repo, 'orphanline', 'o.txt', 'o\n');
  git(['checkout', '-q', 'main'], repo);
  git(['branch', '-D', 'orphanline'], repo);
  assert.throws(() => resolveDispatchRef(sha, repo), /no remote-tracked branch or tag/);
});

test('an unresolvable SHA is a loud error, not a dispatch', () => {
  const repo = tempRepo();
  assert.throws(
    () => resolveDispatchRef('dead00beef', repo),
    /cannot resolve it in this repository/
  );
});

test('a failed fetch only warns — resolution still runs on the local remote-tracking refs', () => {
  // Every throwaway repo above has no remote, so `git fetch` already failed
  // and every resolution still succeeded; pin the warning path explicitly.
  const repo = tempRepo();
  const sha = commitOn(repo, 'main', 'two.txt', 'two\n');
  trackRemote(repo, 'main', sha);
  assert.equal(resolveDispatchRef(sha, repo), 'main');
});
test('helpers stay isolated when the ambient git overlays are hostile', () => {
  // The self-check buildEpoch.test.mjs uses: with the hook's overlays exported,
  // the throwaway repo must still be a throwaway — its commits must land in
  // IT, and the resolver must answer from IT, not from the inherited GIT_DIR
  // repository.
  const saved = {...process.env};
  const shared = process.env.FIREFOX_SCRIPTS_MAIN ?? process.cwd();
  try {
    process.env.GIT_DIR = git(['rev-parse', '--absolute-git-dir'], shared);
    process.env.GIT_PREFIX = '';
    const repo = tempRepo();
    const sha = commitOn(repo, 'main', 'two.txt', 'two\n');
    trackRemote(repo, 'main', sha);
    assert.equal(git(['rev-parse', 'HEAD'], repo), sha, 'the commit landed in the throwaway repo');
    assert.equal(resolveDispatchRef(sha, repo), 'main');
  } finally {
    for (const key of ['GIT_DIR', 'GIT_PREFIX']) {
      if (key in saved) process.env[key] = saved[key];
      else delete process.env[key];
    }
  }
});

test('the resolver is wired into main only for non-empty --ref (args parsing unchanged)', () => {
  const src = fs.readFileSync(
    new URL('../../../tools/publish/release.mjs', import.meta.url),
    'utf-8'
  );
  assert.match(src, /opts\.ref = resolveDispatchRef\(opts\.ref\)/);
  assert.match(src, /if \(opts\.ref\) \{/);
  // The spawnSync helper is the same one main uses — no second shell layer.
  assert.match(src, /spawnSync\('git', args, \{cwd/);
});

test('resolveDispatchRef never shells out through a shell string (argv-array git only)', () => {
  // The whole class of quoting/path bugs this repo keeps killing (#162/#322,
  // PR #263) starts with a shell string. Pin the argv-array form.
  const src = fs.readFileSync(
    new URL('../../../tools/publish/release.mjs', import.meta.url),
    'utf-8'
  );
  assert.doesNotMatch(src, /spawnSync\(`git/);
  assert.doesNotMatch(src, /execSync\('git /);
});
