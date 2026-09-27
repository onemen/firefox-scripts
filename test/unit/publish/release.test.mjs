// test/unit/publish/release.test.mjs — the pnpm publish:* dispatch aliases.

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
    /--ref= needs a branch, tag or commit SHA/
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

test('release:stage --save-branch routes to the stage-installer save, never dispatches', () => {
  // The operator decision (2026-09-27): no second pnpm script — the staging
  // flow keeps ONE front door (release:stage) and the orphan-branch save is a
  // mode of it. Pin both halves of the routing.
  const src = readFileSync(new URL('../../../tools/publish/release.mjs', import.meta.url), 'utf8');
  assert.match(src, /import \{runStageInstaller\} from '\.\/stageInstaller\.mjs'/);
  assert.match(src, /opts\.stage && opts\.saveBranch/);
  assert.match(src, /runStageInstaller\(\{[\s\S]*?push: opts\.push/);
  // --save-branch outside --stage fails loudly; --include is not required for it.
  assert.throws(
    () => parseReleaseArgs(['--include=all', '--save-branch']),
    /--save-branch is a --stage option/
  );
  // --run/--expect/--no-push mean nothing outside --save-branch routing.
  assert.throws(
    () => parseReleaseArgs(['--stage', '--include=all', '--run=1']),
    /--run\/--expect\/--no-push are --save-branch options/
  );
  // A valid combination: explicit run + branch name + preview.
  const explicit = parseReleaseArgs([
    '--stage',
    '--save-branch=stage-x',
    '--run=42',
    '--expect=' + 'a'.repeat(64),
    '--no-push',
  ]);
  assert.equal(explicit.run, '42');
  assert.equal(explicit.saveBranchName, 'stage-x');
  assert.equal(explicit.push, false);
  const opts = parseReleaseArgs(['--stage', '--save-branch']);
  assert.equal(opts.saveBranch, true);
  assert.equal(opts.stage, true);
  assert.equal(opts.saveBranchName, '');
  assert.equal(parseReleaseArgs(['--stage', '--save-branch=stage-x']).saveBranchName, 'stage-x');
  assert.equal(parseReleaseArgs(['--stage', '--save-branch', '--run=42']).run, '42');
  assert.equal(parseReleaseArgs(['--stage', '--save-branch', '--no-push']).push, false);
  assert.throws(
    () => parseReleaseArgs(['--stage', '--save-branch', '--expect=']),
    /--expect= needs a sha256/
  );
});

test('the publish: presets pin the documented --include role lists', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts['publish:all'], 'node tools/publish/release.mjs --include=all');
  assert.equal(
    pkg.scripts['publish:packages'],
    'node tools/publish/release.mjs --include=packages'
  );
  assert.equal(
    pkg.scripts['publish:installer'],
    'node tools/publish/release.mjs --include=installer'
  );
  // The dev dispatch names its channel in the script itself.
  assert.equal(
    pkg.scripts['publish:dev'],
    'node tools/publish/release.mjs --mode=dev --include=all'
  );
  // The offline snapshots keep the full scope baked into the script.
  assert.match(pkg.scripts['snapshot:prod'], /--local --mode=prod --include=all$/);
  assert.match(pkg.scripts['snapshot:dev'], /--local --mode=dev --include=all$/);
});
