// test/unit/publish/createZip.test.mjs — Unit tests for tools/publish/createZip.mjs
//
// createZip.mjs imports paths.js, which calls requireMode() at import time, so
// the test pushes --mode=prod into process.argv before the dynamic import.
//
// Importing createZip.mjs also regenerates the gitignored generated files
// (updater-config.sys.mjs, updater.css) — a no-op write when they are already
// in sync, and they are gitignored either way.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.argv.push('--mode=prod');

const {createZip, loadAllGitignorePatterns, zipPrefixFor} =
  await import('../../../tools/publish/createZip.mjs');
import {listZipEntries, readZipEntry} from '../../shared/zipReader.mjs';

/** Make a temp source tree with a fixed set of files. */
function makeSourceTree(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'createzip-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), {recursive: true});
    fs.writeFileSync(p, content);
  }
  return dir;
}

test('zipPrefixFor: fx-folder is nested, utils/updater-ui are flat', () => {
  assert.equal(zipPrefixFor('fx-folder'), 'fx-folder');
  assert.equal(zipPrefixFor('utils'), null);
  assert.equal(zipPrefixFor('updater-ui'), null);
});

test('createZip: flat layout for utils-style packages', async () => {
  const src = makeSourceTree({
    'foo.js': 'console.log(1);',
    'sub/bar.js': 'console.log(2);',
    'README.md': '# readme',
  });
  const out = path.join(os.tmpdir(), `out-${Date.now()}.zip`);
  try {
    const patterns = loadAllGitignorePatterns(src);
    await createZip(src, out, patterns);
    const buf = fs.readFileSync(out);
    const names = listZipEntries(buf)
      .map(e => e.name)
      .sort();
    assert.deepEqual(names, ['README.md', 'foo.js', 'sub/bar.js']);
    const foo = listZipEntries(buf).find(e => e.name === 'foo.js');
    assert.equal(readZipEntry(buf, foo).toString(), 'console.log(1);');
  } finally {
    fs.rmSync(src, {recursive: true, force: true});
    fs.rmSync(out, {force: true});
  }
});

test('createZip: fx-folder package wraps entries under a top-level folder', async () => {
  const src = makeSourceTree({
    'user.js': '// user',
    'chrome/fx.js': '// chrome',
  });
  const out = path.join(os.tmpdir(), `out-${Date.now()}.zip`);
  try {
    const patterns = loadAllGitignorePatterns(src);
    await createZip(src, out, patterns, 'fx-folder');
    const names = listZipEntries(fs.readFileSync(out))
      .map(e => e.name)
      .sort();
    assert.deepEqual(names, ['fx-folder/chrome/fx.js', 'fx-folder/user.js']);
  } finally {
    fs.rmSync(src, {recursive: true, force: true});
    fs.rmSync(out, {force: true});
  }
});

test('createZip: extraFiles are added back after gitignore filtering', async () => {
  const src = makeSourceTree({
    'keep.js': '// keep',
    'skip.tmp': '// should be ignored',
  });
  const out = path.join(os.tmpdir(), `out-${Date.now()}.zip`);
  try {
    // Ignore *.tmp, then re-add the file via extraFiles (like the generated
    // updater-config.sys.mjs in the real utils package).
    const patterns = loadAllGitignorePatterns(src, [], ['*.tmp']);
    await createZip(src, out, patterns, null, ['skip.tmp']);
    const names = listZipEntries(fs.readFileSync(out))
      .map(e => e.name)
      .sort();
    assert.deepEqual(names, ['keep.js', 'skip.tmp']);
  } finally {
    fs.rmSync(src, {recursive: true, force: true});
    fs.rmSync(out, {force: true});
  }
});
