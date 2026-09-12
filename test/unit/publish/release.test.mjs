// test/unit/publish/release.test.mjs — the pnpm release dispatch alias.

import {test} from 'node:test';
import assert from 'node:assert/strict';

const {buildDispatchArgs, parseReleaseArgs} = await import('../../../tools/publish/release.mjs');

test('parseReleaseArgs: --force passthrough, pnpm -- separator ignored', () => {
  assert.deepEqual(parseReleaseArgs(['--force']), {force: true});
  assert.deepEqual(parseReleaseArgs(['--', '--force']), {force: true});
  assert.deepEqual(parseReleaseArgs([]), {force: false});
});

test('parseReleaseArgs rejects unknown flags', () => {
  assert.throws(() => parseReleaseArgs(['--watch']), /Unknown flag/);
});

test('buildDispatchArgs: mode=prod, force optional', () => {
  assert.deepEqual(buildDispatchArgs({}), ['workflow', 'run', 'pages.yml', '-f', 'mode=prod']);
  assert.deepEqual(buildDispatchArgs({force: true}), [
    'workflow',
    'run',
    'pages.yml',
    '-f',
    'mode=prod',
    '-f',
    'force=true',
  ]);
});
