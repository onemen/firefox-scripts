// test/unit/publish/release.test.mjs — the pnpm release dispatch wrapper's
// pure parts: arg parsing and repo-slug extraction (the dispatch/watch paths
// are thin `gh`/`git` shells exercised in CI).

import {test} from 'node:test';
import assert from 'node:assert/strict';

const {parseReleaseArgs, repoSlug} = await import('../../../tools/publish/release.mjs');

test('parseReleaseArgs: defaults, --force, --watch, unknown flag rejected', () => {
  assert.deepEqual(parseReleaseArgs([]), {force: false, watch: false});
  assert.deepEqual(parseReleaseArgs(['--force']), {force: true, watch: false});
  assert.deepEqual(parseReleaseArgs(['--watch', '--force']), {force: true, watch: true});
  assert.deepEqual(parseReleaseArgs(['--']), {force: false, watch: false});
  assert.throws(() => parseReleaseArgs(['--mode=prod']), /Unknown flag/);
});

test('repoSlug: https and ssh remotes; empty for non-GitHub', () => {
  assert.equal(repoSlug('https://github.com/onemen/firefox-scripts.git'), 'onemen/firefox-scripts');
  assert.equal(repoSlug('git@github.com:onemen/firefox-scripts.git'), 'onemen/firefox-scripts');
  assert.equal(repoSlug('https://github.com/onemen/firefox-scripts'), 'onemen/firefox-scripts');
  assert.equal(repoSlug('https://gitlab.com/onemen/firefox-scripts.git'), '');
  assert.equal(repoSlug(''), '');
});
