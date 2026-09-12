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
const {zipEntryDate} = await import('../../../tools/publish/publishCommon.mjs');
import {dosDateTimeToUtc, listZipEntries, readZipEntry} from '../../shared/zipReader.mjs';

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

test('zipEntryDate: YYYY-MM-DD → 12:00 UTC, invalid → now', () => {
  assert.equal(zipEntryDate('2026-09-12').toISOString(), '2026-09-12T12:00:00.000Z');
  const nowish = zipEntryDate(undefined);
  assert.ok(Math.abs(nowish.getTime() - Date.now()) < 60_000);
  assert.ok(Math.abs(zipEntryDate('garbage').getTime() - Date.now()) < 60_000);
});

test('createZip: entryDate stamps every entry with the release date (12:00 UTC)', async () => {
  const src = makeSourceTree({
    'a.js': '// a',
    'b.js': '// b',
  });
  const out = path.join(os.tmpdir(), `out-${Date.now()}.zip`);
  try {
    const patterns = loadAllGitignorePatterns(src, [], []);
    await createZip(src, out, patterns, null, [], zipEntryDate('2026-09-12'));
    const entries = listZipEntries(fs.readFileSync(out));
    assert.equal(entries.length, 2);
    for (const e of entries) {
      // Every entry reads as the package's release date, regardless of each
      // source file's own mtime.
      assert.equal(dosDateTimeToUtc(e).toISOString(), '2026-09-12T12:00:00.000Z', e.name);
    }
  } finally {
    fs.rmSync(src, {recursive: true, force: true});
    fs.rmSync(out, {force: true});
  }
});

test('createZip: no entryDate → source mtimes (previous behavior)', async () => {
  const src = makeSourceTree({'a.js': '// a'});
  const out = path.join(os.tmpdir(), `out-${Date.now()}.zip`);
  try {
    const patterns = loadAllGitignorePatterns(src, [], []);
    await createZip(src, out, patterns, null, []);
    const [e] = listZipEntries(fs.readFileSync(out));
    const decoded = dosDateTimeToUtc(e);
    // Not pinned to a fixed date — just sanity: decodes near now (± 1 day).
    assert.ok(Math.abs(decoded.getTime() - Date.now()) < 24 * 3600_000, String(decoded));
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
