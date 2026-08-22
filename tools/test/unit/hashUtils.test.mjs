// tools/test/unit/hashUtils.test.mjs — Unit tests for tools/publish/hashUtils.mjs
//
// hashUtils.mjs imports paths.js, which calls requireMode() at import time, so
// the test pushes --mode=prod into process.argv before the dynamic import.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.argv.push('--mode=prod');

const {collectDirEntries, computeDirectoryHash, computeFileSetHash, getStoredHashes} =
  await import('../../../tools/publish/hashUtils.mjs');

function makeTree(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hashutils-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), {recursive: true});
    fs.writeFileSync(p, content);
  }
  return dir;
}

test('computeDirectoryHash: deterministic and content-sensitive', () => {
  const dir = makeTree({'a.js': '1', 'b.js': '2'});
  try {
    const h1 = computeDirectoryHash(dir, []);
    const h2 = computeDirectoryHash(dir, []);
    assert.equal(h1.hash, h2.hash);
    assert.deepEqual(h1.files, ['a.js', 'b.js']); // sorted

    // Toggle file order on disk — hash must not change (files are sorted).
    fs.rmSync(path.join(dir, 'a.js'));
    fs.writeFileSync(path.join(dir, 'a.js'), '1');
    assert.equal(computeDirectoryHash(dir, []).hash, h1.hash);

    // Content change must change the hash.
    fs.writeFileSync(path.join(dir, 'a.js'), '1 changed');
    assert.notEqual(computeDirectoryHash(dir, []).hash, h1.hash);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('computeDirectoryHash: matches the reference algorithm exactly', () => {
  const dir = makeTree({
    'z.js': 'zzz',
    'a/nested.txt': 'hello\nworld',
    'b.txt': 'bbb',
  });
  try {
    const {hash, files} = computeDirectoryHash(dir, []);
    assert.deepEqual(files, ['a/nested.txt', 'b.txt', 'z.js']);
    // Reimplement the documented algorithm independently.
    const ref = crypto.createHash('sha256');
    for (const rel of ['a/nested.txt', 'b.txt', 'z.js']) {
      ref.update(rel + '\n');
      ref.update(fs.readFileSync(path.join(dir, rel)));
    }
    assert.equal(hash, ref.digest('hex'));
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('computeDirectoryHash: gitignore patterns filter files, extraFiles re-add', () => {
  const dir = makeTree({
    'keep.js': 'keep',
    'gen.tmp': 'generated',
  });
  try {
    // Pattern '*.tmp' ignores the generated file, then extraFiles re-adds it
    // (mirroring how the generated updater-config.sys.mjs ships in utils.zip).
    const {hash, files} = computeDirectoryHash(
      dir,
      [{pattern: '*.tmp', isNegation: false}],
      [{rel: 'gen.tmp', absPath: path.join(dir, 'gen.tmp')}]
    );
    assert.deepEqual(files, ['gen.tmp', 'keep.js']);

    const without = computeDirectoryHash(dir, [{pattern: '*.tmp', isNegation: false}]);
    assert.deepEqual(without.files, ['keep.js']);
    assert.notEqual(hash, without.hash);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('collectDirEntries: prefixes labels and honors excludes', () => {
  const dir = makeTree({
    'main.c': 'int main',
    'web/script.js': 'js',
    'src/resources.h': 'generated header',
  });
  try {
    const entries = collectDirEntries(dir, [], 'installer', dir, ['src/resources.h']);
    const labels = entries.map(e => e.rel).sort();
    assert.deepEqual(labels, ['installer/main.c', 'installer/web/script.js']);
    for (const e of entries) assert.ok(fs.existsSync(e.absPath));
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('computeFileSetHash: labeled set, order-independent', () => {
  const dir = makeTree({'x.js': 'x', 'y.js': 'y'});
  try {
    const a = {rel: 'a/x.js', absPath: path.join(dir, 'x.js')};
    const b = {rel: 'b/y.js', absPath: path.join(dir, 'y.js')};
    const h1 = computeFileSetHash([a, b]);
    const h2 = computeFileSetHash([b, a]); // order must not matter
    assert.equal(h1.hash, h2.hash);
    assert.deepEqual(h1.files, ['a/x.js', 'b/y.js']);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('getStoredHashes: env override reads a local manifest instead of the network', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hashutils-override-'));
  const file = path.join(dir, 'hashes.json');
  try {
    fs.writeFileSync(
      file,
      JSON.stringify({utils: {hash: 'abc', files: ['a.js']}, installer: {hash: 'def'}})
    );
    process.env.FIREFOX_SCRIPTS_STORED_HASHES_FILE = file;
    try {
      // localOnly=false would hit the network without the override; with it
      // the file wins and no fetch happens.
      assert.deepEqual(await getStoredHashes({localOnly: false}), {
        utils: {hash: 'abc', files: ['a.js']},
        installer: {hash: 'def'},
      });
    } finally {
      delete process.env.FIREFOX_SCRIPTS_STORED_HASHES_FILE;
    }
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('getStoredHashes: unreadable env override starts fresh', async () => {
  process.env.FIREFOX_SCRIPTS_STORED_HASHES_FILE = path.join(os.tmpdir(), 'does-not-exist.json');
  try {
    assert.deepEqual(await getStoredHashes({localOnly: false}), {});
  } finally {
    delete process.env.FIREFOX_SCRIPTS_STORED_HASHES_FILE;
  }
});
