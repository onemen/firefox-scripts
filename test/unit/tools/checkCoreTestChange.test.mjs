// test/unit/tools/checkCoreTestChange.test.mjs — unit tests for the pure logic
// of tools/check-core-test-change.mjs (issue #30, the mechanical gate).
//
// A gate whose own logic is untested eventually blocks the wrong PR — and a
// gate that blocks the wrong PR gets deleted, which loses the coverage the
// whole thing exists for. So the classifier and the decision are tested
// directly, including the cases that must NOT fire.

import {test} from 'node:test';
import assert from 'node:assert/strict';

import {
  classify,
  partition,
  evaluate,
  changedFiles,
  WAIVER_MARKER,
} from '../../../tools/check-core-test-change.mjs';

// ── Classification ─────────────────────────────────────────────────────────

test('classify: core/** is core', () => {
  for (const f of [
    'core/chrome/utils/userChrome.js',
    'core/chrome/utils/BootstrapLoader.js',
    'core/fx-folder/config.js',
    'core/chrome/utils/updater/scriptsUpdater.sys.mjs',
  ]) {
    assert.equal(classify(f), 'core', f);
  }
});

test('classify: test/** is a test, at any depth', () => {
  for (const f of [
    'test/unit/core/bootstrapLoader.test.mjs',
    'test/unit/core/scriptsUpdater-install.test.mjs',
    'test/e2e/core/manifest-lifecycle-e2e.mjs',
    'test/shared/sandboxServices.mjs',
  ]) {
    assert.equal(classify(f), 'test', f);
  }
});

test('classify: everything else is other', () => {
  // A file that merely MENTIONS core in its name is not core. Getting this
  // backwards would gate docs PRs that touch nothing.
  for (const f of [
    'docs/DEVELOPING.md',
    'README.md',
    'installer/src/main.c',
    'tools/publish/upload.mjs',
    '.github/workflows/ci.yml',
    'package.json',
    'core-notes.md', // leading 'core' but not 'core/'
    'test/unit/core-notes.md', // 'test/' prefix wins
  ]) {
    assert.notEqual(classify(f), 'core', f);
  }
});

test('classify: the gate and its own test never require a core test change', () => {
  // Otherwise the gate could not be fixed in place: editing the gate would
  // demand a core test change, which is exactly what the gate is asking for.
  assert.equal(classify('tools/check-core-test-change.mjs'), 'tooling');
  assert.equal(classify('test/unit/tools/checkCoreTestChange.test.mjs'), 'tooling');
});

test('classify: Windows separators and ./ prefixes normalize', () => {
  // git can emit either depending on core.autocrlf / the checkout.
  assert.equal(classify('core\\chrome\\utils\\userChrome.js'), 'core');
  assert.equal(classify('./core/fx-folder/config.js'), 'core');
});

// ── Decision ───────────────────────────────────────────────────────────────

test('a docs-only PR is not gated', () => {
  const v = evaluate(['docs/DEVELOPING.md', 'README.md']);
  assert.equal(v.satisfied, true);
  assert.match(v.reason, /not applicable/);
});

test('a tooling-only PR is not gated', () => {
  const v = evaluate(['tools/publish/upload.mjs', 'package.json']);
  assert.equal(v.satisfied, true);
});

test('core changed with NO test change is a violation', () => {
  const v = evaluate(['core/chrome/utils/userChrome.js']);
  assert.equal(v.satisfied, false);
  assert.match(v.reason, /no test change/);
  // Literal, not a RegExp built from WAIVER_MARKER: the waiver instruction is
  // the actionable part of the message, so assert on the text itself rather
  // than re-deriving the constant (which would also trip the security lint).
  assert.ok(v.reason.includes(WAIVER_MARKER), 'names the waiver marker');
});

test('core changed WITH any test change passes', () => {
  // Deliberately permissive: the gate requires SOME test change, never a
  // specific one. Naming the right test is a reviewer's judgement, and a wrong
  // guess would block a correct PR.
  const v = evaluate(['core/chrome/utils/userChrome.js', 'test/unit/core/userChrome.test.mjs']);
  assert.equal(v.satisfied, true);
  assert.deepEqual(v.tests, ['test/unit/core/userChrome.test.mjs']);
});

test('a test change on its own does not need core', () => {
  const v = evaluate(['test/unit/core/userChrome.test.mjs']);
  assert.equal(v.satisfied, true);
});

test('the waiver satisfies a core-only change', () => {
  // The legitimate case: a comment fix or rename in core/** that provably
  // cannot be covered by a test.
  const v = evaluate(['core/fx-folder/config.js'], {waived: true});
  assert.equal(v.satisfied, true);
  assert.ok(v.reason.includes(WAIVER_MARKER), 'says which marker waived it');
});

test('the gate lists every offending core file', () => {
  // A violation that names only the first file leaves the author guessing.
  const v = evaluate(['core/fx-folder/config.js', 'core/chrome/utils/userChrome.js', 'docs/x.md']);
  assert.equal(v.satisfied, false);
  assert.deepEqual(v.core, ['core/fx-folder/config.js', 'core/chrome/utils/userChrome.js']);
});

test('partition separates core from tests and ignores the rest', () => {
  const {core, tests} = partition([
    'core/fx-folder/config.js',
    'test/unit/core/x.test.mjs',
    'docs/y.md',
    'core/README.md',
  ]);
  assert.deepEqual(core, ['core/fx-folder/config.js', 'core/README.md']);
  assert.deepEqual(tests, ['test/unit/core/x.test.mjs']);
});

// ── Changed-file resolution ────────────────────────────────────────────────

test('changedFiles: --files short-circuits git entirely', () => {
  // The unit tests must never shell out; this is also the seam that keeps the
  // classifier testable on a machine with no repo.
  let called = false;
  const out = changedFiles({
    files: ['core/a.js', 'test/b.test.mjs'],
    git() {
      called = true;
      return '';
    },
  });
  assert.deepEqual(out, ['core/a.js', 'test/b.test.mjs']);
  assert.equal(called, false, 'git must not be consulted when --files is given');
});

test('changedFiles: diffs against the MERGE BASE, not the branch tip', () => {
  // Diffing two-dot against a moved main would sweep in unrelated main commits
  // — either gating a PR that changed no core, or hiding a real violation
  // behind someone else's core edit.
  const calls = [];
  const out = changedFiles({
    base: 'origin/main',
    git(args) {
      calls.push(args);
      if (args[0] === 'merge-base') return 'abc123\n';
      return 'core/x.js\ntest/y.test.mjs\n';
    },
  });
  assert.deepEqual(out, ['core/x.js', 'test/y.test.mjs']);
  assert.deepEqual(calls[0], ['merge-base', 'HEAD', 'origin/main']);
  assert.deepEqual(calls[1], ['diff', '--name-only', 'abc123...HEAD']);
});

test('changedFiles: an unresolvable merge base falls back, never skips', () => {
  // A shallow clone must not silently DISABLE the gate — it falls back to a
  // diff against the BASE REF TIP, which is coarser (it can include main
  // commits) but still names the changed files.
  //
  // Critically, the fallback still names the base. `git diff HEAD` alone
  // compares HEAD with the WORKING TREE: on a clean CI checkout that lists
  // nothing, the gate reports "no core/** change", and a core-only PR sails
  // through — the precise fail-open this gate exists to prevent.
  const calls = [];
  const out = changedFiles({
    // Pin the base: with no `--base`, changedFiles reads GITHUB_BASE_REF, which
    // CI sets to `main` — so an unpinned test asserts against the RUNNER's
    // environment and fails in CI while passing locally.
    base: 'origin/main',
    git(args) {
      calls.push(args);
      if (args[0] === 'merge-base') throw new Error('unknown revision');
      return 'core/x.js\n';
    },
  });
  assert.deepEqual(out, ['core/x.js']);
  assert.deepEqual(calls[1], ['diff', '--name-only', 'origin/main', 'HEAD']);
});

test('changedFiles: an unresolvable merge base AND base ref throws, never passes empty', () => {
  // Neither diff can run: the gate must stand down LOUDLY from main(), not
  // return an empty list that would read as "no core changed" and pass.
  assert.throws(
    () =>
      changedFiles({
        base: 'origin/main', // pinned — see the test above
        git(args) {
          if (args[0] === 'merge-base') throw new Error('unknown revision');
          throw new Error('unknown revision: origin/main');
        },
      }),
    /cannot diff HEAD against origin\/main/
  );
});

test('changedFiles: blank and CRLF git output is parsed cleanly', () => {
  const out = changedFiles({
    git: args => (args[0] === 'merge-base' ? 'abc\n' : 'core/a.js\r\n\r\ntest/b.test.mjs\r\n'),
  });
  assert.deepEqual(out, ['core/a.js', 'test/b.test.mjs']);
});
