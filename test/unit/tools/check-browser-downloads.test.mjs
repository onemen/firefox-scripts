// test/unit/tools/check-browser-downloads.test.mjs — Unit tests for the pure
// helpers in tools/check-browser-downloads.mjs (the version/endpoint checks,
// the full-download pass, and issue creation hit the network and the GitHub
// API — not unit-tested).

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const scriptUrl = pathToFileURL(path.join(REPO_ROOT, 'tools', 'check-browser-downloads.mjs')).href;
const {compareBaseline, issueTitle, parseContentRange, sha256File} = await import(scriptUrl);

test('compareBaseline: first run, new version, unchanged', () => {
  assert.equal(compareBaseline(null, {version: '154.0.1'}), 'first-run');
  assert.equal(compareBaseline({version: '153.0'}, {version: '154.0.1'}), 'new-version');
  assert.equal(compareBaseline({version: '154.0.1'}, {version: '154.0.1'}), 'ok');
});

test('issueTitle: rot, new-version and size-change titles are dedup keys', () => {
  assert.equal(
    issueTitle('rot', 'librewolf', {reason: 'HTTP 404'}),
    '[url-watchdog] librewolf download check failed: HTTP 404'
  );
  assert.equal(
    issueTitle('new-version', 'floorp', {prevVersion: '12.16.2', newVersion: '12.17.0'}),
    '[url-watchdog] floorp 12.16.2 → 12.17.0'
  );
  assert.equal(
    issueTitle('size-change', 'zen'),
    '[url-watchdog] zen same version, binary size changed'
  );
});

test('parseContentRange: total size or null', () => {
  assert.equal(parseContentRange('bytes 0-1023/104857600'), 104857600);
  assert.equal(parseContentRange(null), null);
  assert.equal(parseContentRange(''), null);
  assert.equal(parseContentRange('bytes */0'), 0);
});

test('sha256File: streams a file into its SHA-256', async () => {
  const tmp = path.join(os.tmpdir(), `watchdog-hash-${process.pid}.txt`);
  try {
    fs.writeFileSync(tmp, 'abc');
    // Known SHA-256 vector for 'abc'.
    assert.equal(
      await sha256File(tmp),
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
  } finally {
    fs.rmSync(tmp, {force: true});
  }
});
