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
const {defaultPortableDir, parseArgs} = await import(
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
  assert.deepEqual(parseArgs([]), {browser: '', dir: ''});
  assert.deepEqual(parseArgs(['nightly']), {browser: 'nightly', dir: ''});
  assert.deepEqual(parseArgs(['nightly', '--dir', '/c/tmp/x']), {
    browser: 'nightly',
    dir: '/c/tmp/x',
  });
  assert.deepEqual(parseArgs(['-h']), {help: true});
  assert.throws(() => parseArgs(['--dir']), /--dir needs a path/);
  assert.throws(() => parseArgs(['--nope']), /unknown option: --nope/);
  assert.throws(() => parseArgs(['a', 'b']), /unexpected extra argument: b/);
});
