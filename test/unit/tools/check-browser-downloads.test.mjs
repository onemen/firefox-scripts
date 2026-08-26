// test/unit/tools/check-browser-downloads.test.mjs — Unit tests for the pure
// helpers in tools/check-browser-downloads.mjs (the version/endpoint checks
// and issue creation hit the network and the GitHub API — not unit-tested).

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath, pathToFileURL} from 'node:url';
import path from 'node:path';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const scriptUrl = pathToFileURL(path.join(REPO_ROOT, 'tools', 'check-browser-downloads.mjs')).href;
const {compareBaseline, issueTitle, parseContentRange} = await import(scriptUrl);

test('compareBaseline: first run, new version, unchanged', () => {
  assert.equal(compareBaseline(null, {version: '154.0.1'}), 'first-run');
  assert.equal(compareBaseline({version: '153.0'}, {version: '154.0.1'}), 'new-version');
  assert.equal(compareBaseline({version: '154.0.1'}, {version: '154.0.1'}), 'ok');
});

test('issueTitle: rot and new-version titles are dedup keys', () => {
  assert.equal(
    issueTitle('rot', 'librewolf', {reason: 'HTTP 404'}),
    '[url-watchdog] librewolf download check failed: HTTP 404'
  );
  assert.equal(
    issueTitle('new-version', 'floorp', {prevVersion: '12.16.2', newVersion: '12.17.0'}),
    '[url-watchdog] floorp 12.16.2 → 12.17.0'
  );
});

test('parseContentRange: total size or null', () => {
  assert.equal(parseContentRange('bytes 0-1023/104857600'), 104857600);
  assert.equal(parseContentRange(null), null);
  assert.equal(parseContentRange(''), null);
  assert.equal(parseContentRange('bytes */0'), 0);
});
