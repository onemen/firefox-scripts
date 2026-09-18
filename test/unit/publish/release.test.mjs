// test/unit/publish/release.test.mjs — the pnpm release dispatch alias.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const {buildDispatchArgs, parseReleaseArgs} = await import('../../../tools/publish/release.mjs');

test('parseReleaseArgs: --force passthrough, pnpm -- separator ignored', () => {
  assert.equal(parseReleaseArgs(['--include=all', '--force']).force, true);
  assert.equal(parseReleaseArgs(['--include=all', '--', '--force']).force, true);
  assert.equal(parseReleaseArgs(['--include=all']).force, false);
});

test('parseReleaseArgs: --include is required — bare invocation fails loud', () => {
  assert.throws(() => parseReleaseArgs([]), /Missing --include=<roles>/);
  assert.throws(() => parseReleaseArgs(['--force', '--mode=dev']), /Missing --include=<roles>/);
  assert.match(parseReleaseArgs(['--include=all']).include.join(','), /all/);
});

test('parseReleaseArgs rejects unknown flags', () => {
  assert.throws(() => parseReleaseArgs(['--include=all', '--watch']), /Unknown flag/);
});

test('parseReleaseArgs: the removed --skip flag is rejected, not silently honored', () => {
  assert.throws(() => parseReleaseArgs(['--skip=installer']), /Unknown flag: --skip=installer/);
});

test('parseReleaseArgs: mode defaults to prod and validates', () => {
  assert.equal(parseReleaseArgs(['--include=all']).mode, 'prod');
  assert.equal(parseReleaseArgs(['--include=all', '--mode=dev']).mode, 'dev');
  assert.throws(
    () => parseReleaseArgs(['--include=all', '--mode=staging']),
    /--mode must be prod\|dev/
  );
});

test('parseReleaseArgs: --include validates roles against the publish scope', () => {
  assert.deepEqual(parseReleaseArgs(['--include=installer']).include, ['installer']);
  assert.deepEqual(parseReleaseArgs(['--include=installer,helper', '--include=helper']).include, [
    'installer',
    'helper',
  ]);
  assert.throws(
    () => parseReleaseArgs(['--include=binaries']),
    /Unknown --include role 'binaries'/
  );
  assert.throws(() => parseReleaseArgs(['--include=']), /--include= needs at least one role/);
});

test('parseReleaseArgs: --include=all is the full-publish spelling and passes through', () => {
  assert.deepEqual(parseReleaseArgs(['--include=all']).include, ['all']);
  // `all` mixed with roles stays the explicit all marker (buildDispatchArgs
  // passes it verbatim; the workflow-side upload.mjs expands it).
  assert.deepEqual(parseReleaseArgs(['--include=all,installer']).include, ['all', 'installer']);
});

test('parseReleaseArgs: --ref and -f key=value passthrough', () => {
  const opts = parseReleaseArgs([
    '--include=all',
    '--ref=feature',
    '-f',
    'publish=true',
    '-fcolor=blue',
  ]);
  assert.equal(opts.ref, 'feature');
  assert.deepEqual(opts.passthrough, ['-f', 'publish=true', '-f', 'color=blue']);
  assert.throws(
    () => parseReleaseArgs(['--include=all', '--ref=']),
    /--ref= needs a branch or tag/
  );
  assert.throws(() => parseReleaseArgs(['--include=all', '-f']), /-f needs a key=value pair/);
  assert.throws(
    () => parseReleaseArgs(['--include=all', '-fnovalue']),
    /-f needs a key=value pair/
  );
});

test('buildDispatchArgs: full set maps onto the pages.yml dispatch', () => {
  assert.deepEqual(buildDispatchArgs({include: ['all']}), [
    'workflow',
    'run',
    'pages.yml',
    '-f',
    'mode=prod',
    '-f',
    'include=all',
  ]);
  assert.deepEqual(buildDispatchArgs({include: ['all'], force: true}), [
    'workflow',
    'run',
    'pages.yml',
    '-f',
    'mode=prod',
    '-f',
    'force=true',
    '-f',
    'include=all',
  ]);
  // A dev publish from another branch needs --ref, or gh dispatches main.
  assert.deepEqual(
    buildDispatchArgs({
      mode: 'dev',
      include: ['packages', 'helper'],
      ref: 'pr-branch',
    }),
    [
      'workflow',
      'run',
      'pages.yml',
      '--ref',
      'pr-branch',
      '-f',
      'mode=dev',
      '-f',
      'include=packages,helper',
    ]
  );
  assert.deepEqual(
    buildDispatchArgs({
      include: ['all'],
      passthrough: ['-f', 'publish=true'],
    }),
    ['workflow', 'run', 'pages.yml', '-f', 'mode=prod', '-f', 'include=all', '-f', 'publish=true']
  );
});

test('the release: presets pin the documented --include role lists', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts['release:all'], 'node tools/publish/release.mjs --include=all');
  assert.equal(
    pkg.scripts['release:packages'],
    'node tools/publish/release.mjs --include=packages'
  );
  assert.equal(
    pkg.scripts['release:installer'],
    'node tools/publish/release.mjs --include=installer'
  );
  // The offline rehearsal keeps its implicit full scope via the script itself.
  assert.match(pkg.scripts['upload:local'], /--include=all$/);
});
