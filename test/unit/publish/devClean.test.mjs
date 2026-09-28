// test/unit/publish/devClean.test.mjs — unit tests for tools/publish/devClean.mjs
//
// #358 regression: the devClean MODULE must load without a --mode flag — the
// tool imports paths.js for repo constants only, and an import-time
// requireMode() there crashed every invocation ("Missing required
// --mode=prod|dev."). Importing the module here with no argv prep IS the
// regression test; the pin below makes it explicit.

import {test} from 'node:test';
import assert from 'node:assert/strict';

const devClean = await import('../../../tools/publish/devClean.mjs');
const {normalizeId, parseArgs, selectTargets} = devClean;

test('#358: the devClean module loads without a --mode flag (paths.js is import-tolerant)', () => {
  // Reaching this point proves the dynamic import above did not throw.
  assert.equal(typeof normalizeId, 'function');
  assert.equal(typeof devClean.run, 'function', 'run stays exported for the CLI');
});

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
