// test/unit/publish/release.test.mjs — the pnpm release dispatch alias.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const {buildDispatchArgs, parseReleaseArgs} = await import('../../../tools/publish/release.mjs');

test('parseReleaseArgs: --force passthrough, pnpm -- separator ignored', () => {
  assert.equal(parseReleaseArgs(['--force']).force, true);
  assert.equal(parseReleaseArgs(['--', '--force']).force, true);
  assert.equal(parseReleaseArgs([]).force, false);
});

test('parseReleaseArgs rejects unknown flags', () => {
  assert.throws(() => parseReleaseArgs(['--watch']), /Unknown flag/);
});

test('parseReleaseArgs: mode defaults to prod and validates', () => {
  assert.equal(parseReleaseArgs([]).mode, 'prod');
  assert.equal(parseReleaseArgs(['--mode=dev']).mode, 'dev');
  assert.throws(() => parseReleaseArgs(['--mode=staging']), /--mode must be prod\|dev/);
});

test('parseReleaseArgs: --skip validates roles against the publish scope', () => {
  assert.deepEqual(parseReleaseArgs(['--skip=installer']).skip, ['installer']);
  assert.deepEqual(parseReleaseArgs(['--skip=installer,helper', '--skip=helper']).skip, [
    'installer',
    'helper',
  ]);
  assert.throws(() => parseReleaseArgs(['--skip=binaries']), /Unknown --skip role 'binaries'/);
  assert.throws(() => parseReleaseArgs(['--skip=']), /--skip= needs at least one role/);
});

test('parseReleaseArgs: --ref and -f key=value passthrough', () => {
  const opts = parseReleaseArgs(['--ref=feature', '-f', 'publish=true', '-fcolor=blue']);
  assert.equal(opts.ref, 'feature');
  assert.deepEqual(opts.passthrough, ['-f', 'publish=true', '-f', 'color=blue']);
  assert.throws(() => parseReleaseArgs(['--ref=']), /--ref= needs a branch or tag/);
  assert.throws(() => parseReleaseArgs(['-f']), /-f needs a key=value pair/);
  assert.throws(() => parseReleaseArgs(['-fnovalue']), /-f needs a key=value pair/);
});

test('buildDispatchArgs: full set maps onto the pages.yml dispatch', () => {
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
  // A dev publish from another branch needs --ref, or gh dispatches main.
  assert.deepEqual(buildDispatchArgs({mode: 'dev', skip: ['installer'], ref: 'pr-branch'}), [
    'workflow',
    'run',
    'pages.yml',
    '--ref',
    'pr-branch',
    '-f',
    'mode=dev',
    '-f',
    'skip=installer',
  ]);
  assert.deepEqual(buildDispatchArgs({passthrough: ['-f', 'publish=true']}), [
    'workflow',
    'run',
    'pages.yml',
    '-f',
    'mode=prod',
    '-f',
    'publish=true',
  ]);
});

test('the release: presets pin the documented role lists', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));
  assert.match(pkg.scripts['release:packages'], /--skip=installer,helper$/);
  assert.match(pkg.scripts['release:installer'], /--skip=packages$/);
});
