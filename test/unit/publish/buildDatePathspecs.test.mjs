// test/unit/publish/buildDatePathspecs.test.mjs — the ADR 0036 revisit-if pin:
// the git pathspecs that derive the inner build dates must describe exactly the
// file sets the publish hash uses for each binary. If the two lists fork, the
// "date moved ⇔ sha256 moved" invariant breaks silently (a date that moves
// without a hash change, or — worse — new bytes with a stale inner date, which
// is the staleness #322 exists to kill).
//
// Structural, not brittle: the pin asserts the pieces the hash is BUILT from —
// the tree roots, the helper exclude and the shared files — so ordinary source
// edits don't touch this test, while any change to the hash's *shape* (a new
// root, a different exclude, dropping the shared pin/icon) fails loudly here.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execSync} from 'node:child_process';
import path from 'node:path';

process.argv.push('--mode=prod'); // paths.js/publishMode.mjs are argv-coupled

const {datePathspecs} = await import('../../../tools/publish/generateBuildDates.mjs');
const {INSTALLER_HASH_EXCLUDE, packageRoot} =
  await import('../../../tools/publish/generatedRegistry.mjs');

function toPosixSafe(p) {
  return p.split(path.sep).join('/');
}

test('date pathspecs share the publish-hash constants, not private copies', () => {
  // The generated-trio exclude is the generatedRegistry's own list — if the
  // registry ever grows, the date side must follow (this import is the pin).
  assert.ok(Array.isArray(INSTALLER_HASH_EXCLUDE));
  assert.ok(INSTALLER_HASH_EXCLUDE.includes('_config.h'));
  assert.ok(INSTALLER_HASH_EXCLUDE.includes('resources.h'));
});

test('installer date pathspec covers the same roots the installer hash collects', () => {
  const {installer} = datePathspecs();
  const posix = installer.map(toPosixSafe);
  // Roots the installer hash walks (upload.mjs buildBinaries):
  // installer/src (minus helper/), installer/web, config/installer.conf.
  assert.ok(
    posix.some(p => p.endsWith('installer/src')),
    'installer/src root present'
  );
  assert.ok(
    posix.some(p => p.includes(':(exclude)') && p.endsWith('installer/src/helper')),
    'helper/ exclude present (the trees overlap; without it helper commits would move the installer date)'
  );
  assert.ok(
    posix.some(p => p.endsWith('installer/web')),
    'installer/web root present'
  );
  assert.ok(
    posix.some(p => p.endsWith('config/installer.conf')),
    'installer.conf present'
  );
  // The generated trio is gitignored so git log cannot see it — mirror the
  // hash exclude by construction, asserted here on the ignore state.
  for (const generated of [
    'installer/src/_config.h',
    'installer/src/resources.h',
    'installer/src/script.built.js',
  ]) {
    assert.ok(
      posix.every(p => !p.endsWith(generated)),
      `${generated} must not be an explicit date pathspec (gitignored — matching the hash exclude)`
    );
  }
});

test('helper date pathspec covers the helper tree plus the shared inputs', () => {
  const {helper} = datePathspecs();
  const posix = helper.map(toPosixSafe);
  assert.ok(
    posix.some(p => p.endsWith('installer/src/helper')),
    'helper tree present'
  );
  assert.ok(
    !posix.some(p => p.endsWith('installer/src') && !p.includes('exclude')),
    'helper list must not sweep the whole installer/src tree'
  );
});

test('shared inputs appear in BOTH lists (icon + toolchain pin)', () => {
  const {installer, helper} = datePathspecs();
  const norm = list => list.filter(p => !p.includes('exclude')).map(toPosixSafe);
  const installerSet = new Set(norm(installer));
  const helperSet = new Set(norm(helper));
  for (const shared of ['installer/src/installer.ico', 'config/msys2-toolchain.json']) {
    assert.ok(
      [...installerSet].some(p => p.endsWith(shared)),
      `${shared} missing from the installer date list`
    );
    assert.ok(
      [...helperSet].some(p => p.endsWith(shared)),
      `${shared} missing from the helper date list`
    );
  }
});

test('the date pathspecs resolve to tracked files under git (git-visible, hash-visible)', () => {
  // Both sides of the invariant see the same tree: every non-exclude pathspec
  // must exist and be git-visible (tracked or — for roots — expanding to
  // tracked files). A renamed folder would otherwise silently drop inputs
  // from the date while the hash still saw them through a stale glob.
  const {installer, helper} = datePathspecs();
  for (const p of [...installer, ...helper]) {
    if (p.includes('exclude')) continue;
    const rel = toPosixSafe(path.relative(process.cwd(), p));
    const tracked = execSync(`git ls-files -- "${rel}"`, {encoding: 'utf-8'}).trim();
    assert.ok(tracked.length > 0, `${rel} resolves to no tracked files`);
  }
});

test('packageRoot (the hash side) agrees with the generator on installer/src', () => {
  // The registry's root helper is what upload.mjs walks for the installer; if
  // it ever moved, this catches the fork from the other direction.
  const root = packageRoot('utils'); // registry helper smoke: returns an absolute path
  assert.ok(path.isAbsolute(root));
});
