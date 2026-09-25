// test/unit/installer/buildEpoch.test.mjs — regression guard for the 2026-09-25
// CI determinism failure (build-and-upload run 36177261598).
//
// What broke: `SOURCE_DATE_EPOCH` — the value that pins the PE TimeDateStamp
// (#162) — was resolved by an inline `$(shell git log --format=%ct -- <paths>)`
// in installer/Makefile. A path-limited `git log` resolves its pathspec against
// GIT'S working directory and, when nothing matches, prints NOTHING and still
// exits 0: the trailing `|| echo <fallback>` never fired, SOURCE_DATE_EPOCH
// became the empty string, binutils read that as "unset", and every PE was
// stamped with the LINK TIME. Two runs of the same commit therefore differed
// (installer cfe00a28… vs c6374896…, helper d2eee31d… vs 31c6cc87…), the zips
// matched because they carry no binaries, and the release hashes stopped
// identifying a commit — which is the whole basis of the AV/VT/WDSI workflow.
//
// Invariants pinned here:
//   1. the epoch is the last commit touching BOTH binaries' input sets;
//   2. it does not depend on the shell's working directory;
//   3. it does not depend on an INHERITED git environment either (a pre-push
//      hook exports GIT_DIR/GIT_INDEX_FILE at the repository, which once
//      redirected this very suite's throwaway repos at the real one);
//   4. "no commits matched" is loud, and "no git at all" is a FIXED epoch —
//      never an empty value and never the current time;
//   5. the CLI prints exactly one integer line (the Makefile captures stdout);
//   6. installer/Makefile routes the epoch through that script and refuses an
//      empty result instead of linking a wall-clock PE — using only make
//      constructs that an old (3.81) make can parse.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const SCRIPT = path.join(REPO_ROOT, 'tools', 'publish', 'buildEpoch.mjs');
const {FALLBACK_EPOCH, buildEpoch, epochPathspecs} =
  await import('../../../tools/publish/buildEpoch.mjs');
// A local working-tree copy can linger as CRLF (AGENTS.md → Conventions).
const makefile = fs
  .readFileSync(path.join(REPO_ROOT, 'installer', 'Makefile'), 'utf-8')
  .replace(/\r\n/g, '\n');

/**
 * The ambient git overlays git exports into hooks. Left in place they redirect
 * every command below at the repository a pre-push hook was pushing from — the
 * way this suite's throwaway repos once staged a temp file into the real
 * worktree's index and committed it onto the branch.
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

function git(args, cwd) {
  return execFileSync('git', args, {cwd, encoding: 'utf-8', env: cleanGitEnv()});
}

/** A throwaway repo with history that touches nothing the epoch asks about. */
function tempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-epoch-repo-'));
  git(['init', '-q'], dir);
  fs.writeFileSync(path.join(dir, 'unrelated.txt'), 'x\n');
  git(['add', '.'], dir);
  git(
    ['-c', 'user.email=t@example.invalid', '-c', 'user.name=T', 'commit', '-q', '-m', 'init'],
    dir
  );
  return dir;
}

test('the epoch is the last commit touching BOTH binaries input sets', () => {
  const {epoch, source} = buildEpoch();
  assert.equal(source, 'git');
  // Independent cross-check, written as repo-root-anchored pathspecs (`:/`
  // magic is cwd-independent): installer/src (helper/ included) + web + conf +
  // the toolchain pin — i.e. every input either PE is built from.
  const expected = Number(
    git(
      [
        'log',
        '-1',
        '--format=%ct',
        '--',
        ':/installer/src',
        ':/installer/web',
        ':/config/installer.conf',
        ':/config/msys2-toolchain.json',
      ],
      REPO_ROOT
    ).trim()
  );
  assert.ok(Number.isInteger(expected) && expected > 0, `git epoch looks wrong: ${expected}`);
  assert.equal(epoch, expected);
});

test('the epoch pathspecs cover the helper tree and exclude nothing', () => {
  const specs = epochPathspecs().map(p => p.split(path.sep).join('/'));
  assert.ok(
    specs.some(p => p.endsWith('installer/src/helper')),
    'helper/ must be covered: a helper-only commit has to move the epoch (union of both input sets)'
  );
  assert.ok(
    specs.some(p => p.endsWith('installer/src')),
    'installer/src must be covered'
  );
  assert.ok(
    specs.every(p => !p.includes(':(exclude)')),
    'the :(exclude) magic of the installer date list must not leak into the epoch list — it would drop helper/'
  );
  assert.equal(
    new Set(specs).size,
    specs.length,
    'de-duplicated (installer.ico + msys2-toolchain.json are inputs of both binaries)'
  );
});

test('the epoch does not depend on the working directory', () => {
  const fromRoot = buildEpoch().epoch;
  // Run the CLI — what installer/Makefile invokes — from a nested cwd and from
  // outside the repo entirely. Deliberately a child process: process.chdir()
  // would leak into sibling test files.
  for (const cwd of [path.join(REPO_ROOT, 'installer', 'src'), os.tmpdir()]) {
    const out = execFileSync(process.execPath, [SCRIPT], {
      cwd,
      encoding: 'utf-8',
      env: cleanGitEnv(),
    });
    assert.equal(Number(out.trim()), fromRoot, `the epoch changed when run from ${cwd}`);
  }
  // Negative control — the exact failure shape this replaced: a RELATIVE
  // path-limited log read from a cwd that is not the repo root matches nothing,
  // prints nothing and still exits 0. That is why the guard has to live in
  // code: a shell-level `|| echo <fallback>` cannot see this case.
  const trap = git(
    ['log', '-1', '--format=%ct', '--', 'installer/src'],
    path.join(REPO_ROOT, 'installer')
  );
  assert.equal(trap, '', 'expected the silent empty result the empty-epoch guard exists for');
});

test('an inherited GIT_DIR cannot redirect the epoch at another repository', () => {
  // A pre-push hook exports GIT_DIR/GIT_INDEX_FILE pointing at the repository
  // being pushed. The epoch must still describe the repository it was asked
  // about — and the throwaway repo below must stay a throwaway repo (that is
  // the self-check: with the overlays left in place, its `git add`/`commit`
  // would land in THIS repository's index).
  const fromRoot = buildEpoch().epoch;
  const saved = {...process.env};
  try {
    process.env.GIT_DIR = git(['rev-parse', '--absolute-git-dir'], REPO_ROOT).trim();
    process.env.GIT_PREFIX = 'installer/';
    const repo = tempRepo();
    assert.equal(git(['rev-parse', '--is-inside-work-tree'], repo).trim(), 'true');
    assert.throws(
      () => buildEpoch(repo),
      /git log printed ''/,
      'the temp repo has no history for these paths — the answer must come from IT, not from the inherited GIT_DIR repo'
    );
    assert.equal(buildEpoch().epoch, fromRoot);
  } finally {
    for (const key of ['GIT_DIR', 'GIT_PREFIX']) {
      if (key in saved) process.env[key] = saved[key];
      else delete process.env[key];
    }
  }
});

test('an unmatched pathspec is a hard error, never an empty epoch', () => {
  const repo = tempRepo();
  // `git log` succeeds here and prints nothing — the silent case. It must throw
  // (the Makefile's $(error) guard then stops the build) rather than return ''.
  assert.throws(() => buildEpoch(repo), /git log printed ''/);
});

test('without git history the epoch is a FIXED fallback, not the current time', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-epoch-nogit-'));
  const {epoch, source} = buildEpoch(dir);
  assert.equal(source, 'no-git');
  assert.equal(epoch, FALLBACK_EPOCH);
  assert.ok(Number.isInteger(epoch) && epoch > 0);
  assert.notEqual(epoch, Math.floor(Date.now() / 1000));
});

test('the CLI prints exactly one integer line (the Makefile captures stdout)', () => {
  const out = execFileSync(process.execPath, [SCRIPT], {encoding: 'utf-8', env: cleanGitEnv()});
  assert.match(
    out,
    /^\d+\n$/,
    `expected a single integer line — extra output would land inside SOURCE_DATE_EPOCH and make it non-numeric (binutils then falls back to the link time): ${JSON.stringify(out)}`
  );
  assert.equal(Number(out.trim()), buildEpoch().epoch);
  // --verbose explains itself on stderr only, so it stays capturable as well.
  const verbose = execFileSync(process.execPath, [SCRIPT, '--verbose'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: cleanGitEnv(),
  });
  assert.match(verbose, /^\d+\n$/);
});

test('Makefile: the epoch comes from the script, with an empty-value guard', () => {
  assert.match(makefile, /^EPOCH_GENERATOR \?= .*buildEpoch\.mjs\)$/m, 'EPOCH_GENERATOR missing');
  assert.match(
    makefile,
    /^BUILD_EPOCH = \$\(shell node /m,
    'the epoch must be produced by the script'
  );
  assert.doesNotMatch(
    makefile,
    /BUILD_EPOCH *= \$\(shell git/,
    'the epoch must not come from an inline git command — a path-limited log that matches nothing prints nothing and exits 0, which is how the epoch went empty (2026-09-25)'
  );
  assert.match(
    makefile,
    /^SOURCE_DATE_EPOCH = \$\(BUILD_EPOCH\)$/m,
    'the epoch must be a plain assignment (see the footgun test below)'
  );
  assert.match(
    makefile,
    /^ifeq \(\$\(strip \$\(SOURCE_DATE_EPOCH\)\),\)\n {2}\$\(error /m,
    'an empty epoch must fail the build instead of linking a PE stamped with the link time'
  );
  assert.match(makefile, /^export SOURCE_DATE_EPOCH$/m);
});

test('Makefile: the epoch block stays free of inline-function footguns', () => {
  // Caught by the macOS legs only (2026-09-25): the guard was a one-liner
  // `$(if $(strip $(BUILD_EPOCH)),$(BUILD_EPOCH),$(error … (#162/#322)))`.
  // Make starts a COMMENT at an unescaped # even inside a function call, so the
  // message swallowed the closing parens and the build died with
  // "unterminated call to function `if': missing `)'". GNU make 4.x on
  // Linux/Windows tolerated it; macOS ships 3.81 and refused the whole file.
  const lines = makefile.split('\n');
  const start = lines.findIndex(line => line.startsWith('EPOCH_GENERATOR ?='));
  const end = lines.findIndex((line, i) => i > start && line === 'endif');
  assert.ok(start !== -1 && end > start, 'EPOCH_GENERATOR…endif block not found');
  const code = lines.slice(start, end + 1).filter(line => !line.trimStart().startsWith('#'));
  assert.ok(code.length >= 4, `epoch block looks empty: ${JSON.stringify(code)}`);
  for (const line of code) {
    assert.doesNotMatch(
      line,
      /#/,
      `an unescaped # inside a function call truncates the rest of the line (only older makes refuse it): ${line}`
    );
    const opens = (line.match(/\(/g) ?? []).length;
    const closes = (line.match(/\)/g) ?? []).length;
    assert.equal(
      opens,
      closes,
      `unbalanced parentheses — a truncated line reads as "unterminated call to function": ${line}`
    );
  }
});
