// test/unit/installer/buildEpoch.test.mjs — regression guard for the 2026-09-25
// CI determinism failure (build-and-upload run 36177261598) and for ADR 0036's
// 2026-09-26 per-binary epoch amendment.
//
// What broke first: `SOURCE_DATE_EPOCH` — the value that pins the PE
// TimeDateStamp (#162) — was resolved by an inline
// `$(shell git log --format=%ct -- <paths>)` in installer/Makefile. A
// path-limited `git log` resolves its pathspec against GIT'S working directory
// and, when nothing matches, prints NOTHING and still exits 0: the trailing
// `|| echo <fallback>` never fired, SOURCE_DATE_EPOCH became the empty string,
// binutils read that as "unset", and every PE was stamped with the LINK TIME.
// Two runs of the same commit therefore differed (installer cfe00a28… vs
// c6374896…, helper d2eee31d… vs 31c6cc87…), the zips matched because they
// carry no binaries, and the release hashes stopped identifying a commit —
// which is the whole basis of the AV/VT/WDSI workflow.
//
// What broke second (2026-09-26, run 36265954107): the Makefile exported ONE
// UNION epoch for both PEs, so `helper_win.exe` re-rolled across #335 although
// not a single helper input changed — the helper's WDSI submission was
// invalidated for nothing. The epoch is now resolved PER BINARY: each PE is
// stamped with the last commit touching its OWN input set, the same list its
// inner build date and publish hash derive from.
//
// Invariants pinned here:
//   1. each binary's epoch is the last commit touching ITS input set, and a
//      commit scoped to one binary never moves the other's epoch;
//   2. it does not depend on the shell's working directory;
//   3. it does not depend on an INHERITED git environment either (a pre-push
//      hook exports GIT_DIR/GIT_INDEX_FILE at the repository, which once
//      redirected this very suite's throwaway repos at the real one);
//   4. "no commits matched" is loud, and "no git at all" is a FIXED epoch —
//      never an empty value and never the current time;
//   5. the CLI prints exactly one integer line (the Makefile captures stdout),
//      per binary and for the union;
//   6. installer/Makefile routes the epochs through that script, assigns the
//      per-binary value to the PE targets, and refuses an empty result instead
//      of linking a wall-clock PE — using only make constructs that an old
//      (3.81) make can parse;
//   7. the recipe shell the Makefile pins comes from make's OWN MSYS2 tree —
//      a cross-tree make→sh pair drops make's exported environment (and with
//      it SOURCE_DATE_EPOCH) at the recipe boundary, run 36222271581;
//   8. linked dist PEs (when present — Windows-only artifacts) already carry
//      their own binary's epoch, the assertion the CI determinism job
//      re-checks on fresh builds.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const SCRIPT = path.join(REPO_ROOT, 'tools', 'publish', 'buildEpoch.mjs');
const {FALLBACK_EPOCH, buildEpoch, buildEpochUnion, epochPathspecs} =
  await import('../../../tools/publish/buildEpoch.mjs');
const {datePathspecs} = await import('../../../tools/publish/generateBuildDates.mjs');
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
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: cleanGitEnv(),
  });
}

/**
 * A throwaway repo with history that touches nothing either epoch asks about.
 * `withInstaller` seeds installer/src (and the helper/ subdir) so the
 * per-binary tests can commit into each binary's own pathspec scope.
 */
function tempRepo(withInstaller = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-epoch-repo-'));
  git(['init', '-q'], dir);
  fs.writeFileSync(path.join(dir, 'unrelated.txt'), 'x\n');
  if (withInstaller) {
    fs.mkdirSync(path.join(dir, 'installer', 'src', 'helper'), {
      recursive: true,
    });
    fs.writeFileSync(path.join(dir, 'installer', 'src', 'seed.c'), 'x\n');
  }
  git(['add', '.'], dir);
  git(
    ['-c', 'user.email=t@example.invalid', '-c', 'user.name=T', 'commit', '-q', '-m', 'init'],
    dir
  );
  return dir;
}

/**
 * A repo-anchored commit with explicit identity, so hooks' identity can't leak
 * in.
 */
function commitFile(dir, relFile, body = 'x\n') {
  fs.mkdirSync(path.dirname(path.join(dir, relFile)), {recursive: true});
  fs.writeFileSync(path.join(dir, relFile), body);
  git(['add', relFile], dir);
  git(
    ['-c', 'user.email=t@example.invalid', '-c', 'user.name=T', 'commit', '-q', '-m', relFile],
    dir
  );
}

test('each binary epoch is the last commit touching ITS input set', () => {
  const installer = buildEpoch('installer');
  const helper = buildEpoch('helper');
  assert.equal(installer.source, 'git');
  assert.equal(helper.source, 'git');
  // Independent cross-checks, written as repo-root-anchored pathspecs (`:/`
  // magic is cwd-independent): the installer's set is src minus helper/ plus
  // web + conf, the helper's is helper/ — each plus the shared inputs
  // (installer.ico, the toolchain pin) both binaries are built from.
  const installerExpected = Number(
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
  const helperExpected = Number(
    git(
      [
        'log',
        '-1',
        '--format=%ct',
        '--',
        ':/installer/src/helper',
        ':/installer/src/installer.ico',
        ':/config/msys2-toolchain.json',
      ],
      REPO_ROOT
    ).trim()
  );
  assert.ok(
    Number.isInteger(installerExpected) && installerExpected > 0,
    `git epoch looks wrong: ${installerExpected}`
  );
  assert.equal(installer.epoch, installerExpected, 'installer epoch != its input set');
  assert.equal(helper.epoch, helperExpected, 'helper epoch != its input set');
});

test('a commit scoped to one binary never re-rolls the other epoch (the #335 helper re-roll)', () => {
  // The 2026-09-26 amendment's core property, reproduced in miniature: an
  // installer-scoped commit after a helper-scoped one must move ONLY the
  // installer epoch (the union leaked into the helper's stamp and re-rolled
  // byte-identical helper inputs, run 36265954107).
  const repo = tempRepo(true);
  commitFile(repo, path.join('installer', 'src', 'helper', 'helper_win.c'));
  const helperBefore = buildEpoch('helper', repo).epoch;
  const installerBefore = buildEpoch('installer', repo).epoch;
  // Distinct epochs need distinct commit seconds; sleep past the boundary.
  execFileSync(process.execPath, ['-e', 'setTimeout(() => {}, 1100)']);
  commitFile(repo, path.join('installer', 'src', 'server.c'));
  assert.notStrictEqual(
    buildEpoch('installer', repo).epoch,
    installerBefore,
    'an installer-scoped commit must move the installer epoch'
  );
  assert.equal(
    buildEpoch('helper', repo).epoch,
    helperBefore,
    'an installer-scoped commit must NOT move the helper epoch (run 36265954107)'
  );
  // ...and the union (both input sets merged) is the LATER of the two.
  assert.equal(buildEpochUnion(repo).epoch, buildEpoch('installer', repo).epoch);
});

test('the pathspec lists: per-binary scopes, a positive de-duplicated union', () => {
  // The union (kept for tree-wide consumers; the PE stamps no longer use it)
  // must stay positive-only and de-duplicated...
  const union = epochPathspecs().map(p => p.split(path.sep).join('/'));
  assert.ok(
    union.every(p => !p.includes(':(exclude)')),
    'the :(exclude) magic of the installer date list must not leak into the union — it would drop helper/'
  );
  assert.equal(
    new Set(union).size,
    union.length,
    'de-duplicated (installer.ico + msys2-toolchain.json are inputs of both binaries)'
  );
  for (const must of [
    'installer/src/helper',
    'installer/src',
    'installer/web',
    'installer.ico',
    'msys2-toolchain.json',
    'installer.conf',
  ]) {
    assert.ok(
      union.some(p => p.replaceAll('\\', '/').endsWith(must)),
      `the union must cover ${must}`
    );
  }
  // The per-binary lists come straight from the shared source of truth — the
  // same datePathspecs() the inner build dates and the publish hash use.
  const specs = datePathspecs(REPO_ROOT);
  const norm = list => list.map(p => p.split(path.sep).join('/'));
  assert.ok(
    norm(specs.installer).some(p => p.includes(':(exclude)') && p.includes('helper')),
    'the installer list must exclude helper/ — a helper-only commit must not move the installer epoch'
  );
  assert.ok(
    norm(specs.helper).every(p => !p.includes(':(exclude)')),
    'the helper list is all-positive'
  );
});

test('the epochs do not depend on the working directory', () => {
  const atRoot = {
    installer: buildEpoch('installer').epoch,
    helper: buildEpoch('helper').epoch,
    union: buildEpochUnion().epoch,
  };
  // Run the CLI — what installer/Makefile invokes — from a nested cwd and from
  // outside the repo entirely. Deliberately a child process: process.chdir()
  // would leak into sibling test files.
  for (const cwd of [path.join(REPO_ROOT, 'installer', 'src'), os.tmpdir()]) {
    for (const [args, expected] of [
      [['installer'], atRoot.installer],
      [['helper'], atRoot.helper],
      [[], atRoot.union],
    ]) {
      const out = execFileSync(process.execPath, [SCRIPT, ...args], {
        cwd,
        encoding: 'utf-8',
        env: cleanGitEnv(),
      });
      assert.equal(
        Number(out.trim()),
        expected,
        `the ${args[0] ?? 'union'} epoch changed when run from ${cwd}`
      );
    }
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

for (const binary of ['installer', 'helper']) {
  test(`an inherited GIT_DIR cannot redirect the ${binary} epoch at another repository`, () => {
    // A pre-push hook exports GIT_DIR/GIT_INDEX_FILE pointing at the repository
    // being pushed. The epoch must still describe the repository it was asked
    // about — and the throwaway repo below must stay a throwaway repo (that is
    // the self-check: with the overlays left in place, its `git add`/`commit`
    // would land in THIS repository's index).
    const atRoot = buildEpoch(binary).epoch;
    const saved = {...process.env};
    try {
      process.env.GIT_DIR = git(['rev-parse', '--absolute-git-dir'], REPO_ROOT).trim();
      process.env.GIT_PREFIX = 'installer/';
      const repo = tempRepo();
      assert.equal(git(['rev-parse', '--is-inside-work-tree'], repo).trim(), 'true');
      assert.throws(
        () => buildEpoch(binary, repo),
        /git log printed ''/,
        'the temp repo has no history for these paths — the answer must come from IT, not from the inherited GIT_DIR repo'
      );
      assert.equal(buildEpoch(binary).epoch, atRoot);
    } finally {
      for (const key of ['GIT_DIR', 'GIT_PREFIX']) {
        if (key in saved) process.env[key] = saved[key];
        else delete process.env[key];
      }
    }
  });
}

test('an unmatched pathspec is a hard error, never an empty epoch', () => {
  const repo = tempRepo();
  // `git log` succeeds here and prints nothing — the silent case. It must throw
  // (the Makefile's $(error) guard then stops the build) rather than return ''.
  assert.throws(() => buildEpoch('installer', repo), /git log printed ''/);
  assert.throws(() => buildEpoch('helper', repo), /git log printed ''/);
});

test('without git history the epoch is a FIXED fallback, not the current time', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-epoch-nogit-'));
  const {epoch, source} = buildEpoch('helper', dir);
  assert.equal(source, 'no-git');
  assert.equal(epoch, FALLBACK_EPOCH);
  assert.ok(Number.isInteger(epoch) && epoch > 0);
  assert.notEqual(epoch, Math.floor(Date.now() / 1000));
});

test('the CLI prints exactly one integer line (the Makefile captures stdout)', () => {
  const atRoot = {
    installer: buildEpoch('installer').epoch,
    helper: buildEpoch('helper').epoch,
    union: buildEpochUnion().epoch,
  };
  for (const [args, expected] of [
    [['installer'], atRoot.installer],
    [['helper'], atRoot.helper],
    [[], atRoot.union],
  ]) {
    const out = execFileSync(process.execPath, [SCRIPT, ...args], {
      encoding: 'utf-8',
      env: cleanGitEnv(),
    });
    assert.match(
      out,
      /^\d+\n$/,
      `expected a single integer line for [${args}] — extra output would land inside SOURCE_DATE_EPOCH and make it non-numeric (binutils then falls back to the link time): ${JSON.stringify(out)}`
    );
    assert.equal(Number(out.trim()), expected, `CLI epoch mismatch for [${args}]`);
  }
  // --verbose explains itself on stderr only, so it stays capturable as well.
  const verbose = execFileSync(process.execPath, [SCRIPT, 'helper', '--verbose'], {
    encoding: 'utf-8',
    env: cleanGitEnv(),
  });
  assert.match(verbose, /^\d+\n$/);
});

test('Makefile: the epochs come from the script, with per-binary empty-value guards', () => {
  assert.match(makefile, /^EPOCH_GENERATOR \?= .*buildEpoch\.mjs\)$/m, 'EPOCH_GENERATOR missing');
  assert.match(
    makefile,
    /^BUILD_EPOCH_INSTALLER := \$\(shell node /m,
    'the installer epoch must be produced by the script (per-binary argument)'
  );
  assert.match(
    makefile,
    /^BUILD_EPOCH_HELPER := \$\(shell node /m,
    'the helper epoch must be produced by the script (per-binary argument)'
  );
  assert.doesNotMatch(
    makefile,
    /BUILD_EPOCH[A-Z_]* *= *\$\(shell git/,
    'the epochs must not come from an inline git command — a path-limited log that matches nothing prints nothing and exits 0, which is how the epoch went empty (2026-09-25)'
  );
  // The ambient export (binutils' spelling) defaults to the installer epoch;
  // the helper targets override the value per target below.
  assert.match(
    makefile,
    /^SOURCE_DATE_EPOCH := \$\(BUILD_EPOCH_INSTALLER\)$/m,
    'the ambient epoch must be a plain assignment (see the footgun test below)'
  );
  assert.match(makefile, /^export SOURCE_DATE_EPOCH$/m);
  // One empty-value guard per binary.
  assert.match(
    makefile,
    /^ifeq \(\$\(strip \$\(BUILD_EPOCH_INSTALLER\)\),\)\n {2}\$\(error /m,
    'an empty installer epoch must fail the build instead of linking a PE stamped with the link time'
  );
  assert.match(
    makefile,
    /^ifeq \(\$\(strip \$\(BUILD_EPOCH_HELPER\)\),\)\n {2}\$\(error /m,
    'an empty helper epoch must fail the build instead of linking a PE stamped with the link time'
  );
});

test('Makefile: every PE target stamps with its OWN binary epoch, in 3.81-portable syntax', () => {
  // The `target: export VAR = value` spelling is GNU make 3.82+ and the macOS
  // legs run 3.81 — there `export` would parse as a nonexistent prerequisite
  // and kill every mac build. The portable form is the classic target-specific
  // VALUE assignment next to a global `export` (make exports the target-
  // specific value into that recipe's environment on every make version).
  // Exact-match pins: each group names ALL of its binary's PE targets and none
  // of the other's.
  assert.match(
    makefile,
    /^dist_win dist_linux dist_linux_aarch64 dist_mac: SOURCE_DATE_EPOCH = \$\(BUILD_EPOCH_INSTALLER\)$/m,
    'the installer PE targets must be stamped with the installer epoch (group line)'
  );
  assert.match(
    makefile,
    /^helper_win helper_linux helper_linux_aarch64 helper_mac: SOURCE_DATE_EPOCH = \$\(BUILD_EPOCH_HELPER\)$/m,
    'the helper PE targets must be stamped with the helper epoch (group line)'
  );
  const installerLine = makefile.match(/^dist_win[^\n]*BUILD_EPOCH_INSTALLER\)$/m);
  const helperLine = makefile.match(/^helper_win[^\n]*BUILD_EPOCH_HELPER\)$/m);
  assert.ok(installerLine && helperLine, 'per-target epoch lines not found');
  assert.ok(
    !/helper_win|helper_linux|helper_mac/.test(installerLine[0]),
    'an installer target must never be stamped with the helper epoch'
  );
  assert.ok(
    !/dist_win|dist_linux|dist_mac/.test(helperLine[0]),
    'a helper target must never be stamped with the installer epoch'
  );
  assert.doesNotMatch(
    makefile,
    /^(dist|helper)_\w+: export SOURCE_DATE_EPOCH/m,
    'the `target: export` spelling is make 3.82+ — the macOS legs run 3.81, where export parses as a prerequisite'
  );
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
  const code = lines
    .slice(start, end + 1)
    // Comment lines are prose, not make syntax; recipe lines run under the
    // recipe shell, not make's parser. Both may carry a #.
    .filter(line => !line.startsWith('#') && !line.startsWith('\t'));
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

test('Makefile: the recipe-shell pin probes the MSYS2 tree make lives in first', () => {
  // 2026-09-26, run 36222271581 (the day after #331): the determinism job
  // failed again with link-time stamps even though the epoch variable held the
  // right value inside make. CI's pinned make is the bootstrap tree's msys
  // make (D:/a/_temp/msys64/usr/bin), but the pin handed it the runner image's
  // preinstalled C:/msys64 sh — and a cross-tree make→sh pair silently drops
  // make's exported environment at the recipe boundary, so SOURCE_DATE_EPOCH
  // never reached the linker. Every local build is single-tree, which is why
  // the local double-build passed while CI failed.
  const start = makefile.indexOf('ifeq ($(OS),Windows_NT)');
  const end = makefile.indexOf('SHELL := $(PINNED_SH)');
  assert.ok(start !== -1 && end > start, 'PINNED_SH probe block not found');
  const block = makefile.slice(start, end);
  const pinnedTree = block.indexOf('$(wildcard $(MSYS2_LOCATION)');
  const imageTree = block.indexOf('$(wildcard C:/msys64');
  assert.ok(pinnedTree !== -1, 'the MSYS2_LOCATION probe is missing');
  assert.ok(imageTree !== -1, 'the C:/msys64 fallback is missing');
  assert.ok(
    pinnedTree < imageTree,
    "C:/msys64 must be only the fallback: on CI the pinned make lives in the MSYS2_LOCATION tree, and handing it another tree's sh drops the exported SOURCE_DATE_EPOCH (run 36222271581)"
  );
});

test('linked dist PEs (when present) already carry their own binary epoch', () => {
  // Mirrors the CI determinism assertion locally: whenever a PE exists in
  // dist/installer (a local `make dist_win`/`helper_win` happened), its
  // TimeDateStamp must equal ITS binary's epoch — the stamp the Makefile now
  // assigns per target. A stale helper (built before the amendment) shows up
  // here instead of failing the CI job hours later. Both PEs are Windows
  // artifacts, so on other hosts this test is vacuously true.
  const distDir = path.join(REPO_ROOT, 'dist', 'installer');
  const targets = [
    ['installer_win.exe', 'installer', buildEpoch('installer').epoch],
    ['helper_win.exe', 'helper', buildEpoch('helper').epoch],
  ];
  for (const [file, label, expected] of targets) {
    const pe = path.join(distDir, file);
    if (!fs.existsSync(pe)) continue;
    const b = fs.readFileSync(pe);
    const stamp = b.readUInt32LE(b.readUInt32LE(0x3c) + 8);
    assert.equal(
      stamp,
      expected,
      `${file}: TimeDateStamp ${stamp} != ${label} epoch ${expected} — the Makefile per-target stamping is not reaching the linker`
    );
  }
});
