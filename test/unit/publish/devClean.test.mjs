// test/unit/publish/devClean.test.mjs — unit tests for tools/publish/devClean.mjs
//
// devClean.mjs imports paths.js, which calls requireMode() at import time, so
// the test pushes --mode=prod into process.argv before the dynamic import
// (same pattern as hashUtils.test.mjs).

import {test} from 'node:test';
import assert from 'node:assert/strict';

process.argv.push('--mode=prod');

const {normalizeId, parseArgs, selectTargets} = await import('../../../tools/publish/devClean.mjs');

test('normalizeId: accepts full and partial ids', () => {
  assert.equal(normalizeId('main-abc1234'), 'dev-build-main-abc1234');
  assert.equal(normalizeId('dev-build-main-abc1234'), 'dev-build-main-abc1234');
  assert.equal(normalizeId(' dev-build-x '), 'dev-build-x');
});

test('parseArgs: exactly one of --id / --all is required', () => {
  assert.throws(() => parseArgs([]), /--id <id>/);
});

test('parseArgs: --id and --all are mutually exclusive', () => {
  assert.throws(() => parseArgs(['--id', 'x', '--all']), /mutually exclusive/);
});

test('parseArgs: scope flags are mutually exclusive', () => {
  assert.throws(() => parseArgs(['--all', '--local-only', '--remote-only']), /mutually exclusive/);
});

test('parseArgs: parses the full flag set', () => {
  assert.deepEqual(parseArgs(['--id', 'dev-build-main-abc', '--dry-run', '--local-only']), {
    id: 'dev-build-main-abc',
    all: false,
    dryRun: true,
    localOnly: true,
    remoteOnly: false,
    help: false,
  });
  assert.deepEqual(parseArgs(['--all', '--remote-only']), {
    id: null,
    all: true,
    dryRun: false,
    localOnly: false,
    remoteOnly: true,
    help: false,
  });
});

test('selectTargets: --id matches the exact name only', () => {
  const local = {branches: ['dev-build-main-aaa'], tags: []};
  const remote = {branches: [], tags: ['dev-build-main-aaa']};
  const hit = selectTargets(local, remote, {id: 'dev-build-main-aaa', all: false});
  assert.deepEqual(hit.local.branches, ['dev-build-main-aaa']);
  assert.deepEqual(hit.remote.tags, ['dev-build-main-aaa']);
  assert.deepEqual(hit.remote.branches, []);

  const miss = selectTargets(local, remote, {id: 'dev-build-main-zzz', all: false});
  assert.deepEqual(miss.local.branches, []);
  assert.deepEqual(miss.remote.tags, []);
});

test('selectTargets: --all selects every dev-build ref and nothing else', () => {
  const local = {
    branches: ['dev-build-a', 'dev-build-b', 'main'],
    tags: ['dev-build-a', 'v1.0.0'],
  };
  const remote = {
    branches: ['dev-build-c', 'gh-pages'],
    tags: ['dev-build-a', 'v1.0.0'],
  };
  const all = selectTargets(local, remote, {id: null, all: true});
  assert.deepEqual(all.local.branches, ['dev-build-a', 'dev-build-b']);
  assert.deepEqual(all.local.tags, ['dev-build-a']);
  assert.deepEqual(all.remote.branches, ['dev-build-c']);
  assert.deepEqual(all.remote.tags, ['dev-build-a']);
});
