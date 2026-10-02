// test/unit/tools/e2e-portable.test.mjs — Unit tests for tools/e2e-portable.mjs.
//
// Pure helpers only: the destination default and the argv grammar. Importing
// the module must not install anything — that is what the isMain guard is for,
// so these tests double as the regression guard against moving work back to
// module scope.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const {defaultPortableDir, isInsideTempDir, parseArgs} = await import(
  pathToFileURL(path.join(REPO_ROOT, 'tools', 'e2e-portable.mjs')).href
);

test('defaultPortableDir: Windows keeps the maintainer layout', () => {
  assert.equal(
    defaultPortableDir('nightly', 'win32', 'C:\\Users\\Hadar'),
    path.join('C:\\Users\\Hadar', 'Documents', 'FireFox', 'portable', 'nightly')
  );
});

test('defaultPortableDir: other platforms get an XDG-ish cache dir', () => {
  assert.equal(
    defaultPortableDir('firefox-dev', 'linux', '/home/dev'),
    path.join('/home/dev', '.cache', 'firefox-scripts-e2e', 'firefox-dev')
  );
});

test('parseArgs: positional browser, --dir override, --help, bad input', () => {
  assert.deepEqual(parseArgs([]), {browser: '', dir: '', allowTempDir: false});
  assert.deepEqual(parseArgs(['nightly']), {
    browser: 'nightly',
    dir: '',
    allowTempDir: false,
  });
  assert.deepEqual(parseArgs(['nightly', '--dir', '/c/tmp/x']), {
    browser: 'nightly',
    dir: '/c/tmp/x',
    allowTempDir: false,
  });
  assert.deepEqual(parseArgs(['-h']), {help: true});
  assert.throws(() => parseArgs(['--dir']), /--dir needs a path/);
  assert.throws(() => parseArgs(['--nope']), /unknown option: --nope/);
  assert.throws(() => parseArgs(['a', 'b']), /unexpected extra argument: b/);
});

test('parseArgs: --allow-temp-dir is its own opt-in flag', () => {
  assert.equal(parseArgs(['nightly', '--allow-temp-dir']).allowTempDir, true);
  assert.equal(parseArgs(['--allow-temp-dir', 'zen']).browser, 'zen');
});

const WIN_TMP = path.join('C:\\Users\\x', 'AppData', 'Local', 'Temp');

test('isInsideTempDir: a browser dir in the OS temp dir is refused', () => {
  // The 2026-10-02 case: PORTABLE_BROWSER_DIR pointed at %TEMP%\fxs-portable,
  // leaving 365 MB of browser that nothing reclaims.
  assert.equal(isInsideTempDir(path.join(WIN_TMP, 'fxs-portable'), WIN_TMP), true);
  assert.equal(isInsideTempDir(WIN_TMP, WIN_TMP), true, 'the temp root itself');
  assert.equal(isInsideTempDir(path.join(WIN_TMP, 'sub', 'dir'), WIN_TMP), true, 'nested');
  assert.equal(isInsideTempDir(path.join('/tmp', 'fxs-portable'), '/tmp'), true, 'POSIX shape');
});

test('isInsideTempDir: a persistent location is fine', () => {
  assert.equal(
    isInsideTempDir(
      path.join('C:\\Users\\x', 'Documents', 'FireFox', 'portable', 'nightly'),
      WIN_TMP
    ),
    false
  );
  // A sibling dir sharing a name prefix is NOT inside (relative() starts with ..).
  assert.equal(isInsideTempDir(path.join(`${WIN_TMP}2`, 'fxs-portable'), WIN_TMP), false);
  assert.equal(isInsideTempDir('/repo/dist/portable/nightly', '/tmp'), false);
});
