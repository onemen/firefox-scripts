// test/unit/publish/releaseStage.test.mjs — the release:stage dispatch
// (--stage → build-and-upload.yml publish=false) and the new pnpm script pins.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const {buildDispatchArgs, parseReleaseArgs} = await import('../../../tools/publish/release.mjs');

test('buildDispatchArgs: --stage targets build-and-upload.yml with publish=false', () => {
  assert.deepEqual(buildDispatchArgs({stage: true, include: ['all']}), [
    'workflow',
    'run',
    'build-and-upload.yml',
    '-f',
    'mode=prod',
    '-f',
    'publish=false',
    '-f',
    'include=all',
  ]);
});

test('buildDispatchArgs: --stage honors --ref and --force like a publish dispatch', () => {
  assert.deepEqual(
    buildDispatchArgs({stage: true, ref: '16c37a0', force: true, include: ['all']}),
    [
      'workflow',
      'run',
      'build-and-upload.yml',
      '--ref',
      '16c37a0',
      '-f',
      'mode=prod',
      '-f',
      'publish=false',
      '-f',
      'force=true',
      '-f',
      'include=all',
    ]
  );
});

test('buildDispatchArgs: without --stage the dispatch is unchanged (pages.yml)', () => {
  assert.deepEqual(buildDispatchArgs({include: ['all']}), [
    'workflow',
    'run',
    'pages.yml',
    '-f',
    'mode=prod',
    '-f',
    'include=all',
  ]);
});

test('parseReleaseArgs: --stage parses and passes through to the dispatch opts', () => {
  const opts = parseReleaseArgs(['--stage', '--ref=abc123', '--include=all']);
  assert.equal(opts.stage, true);
  assert.equal(opts.ref, 'abc123');
  assert.equal(opts.mode, 'prod');
  // The scope flag stays required — a staging run without a scope is a guess.
  assert.throws(() => parseReleaseArgs(['--stage', '--ref=abc123']), /Missing --include=<roles>/);
  assert.equal(parseReleaseArgs(['--include=all']).stage, false);
});

test('parseReleaseArgs: --stage rejects unknown extra flags', () => {
  assert.throws(() => parseReleaseArgs(['--stage', '--watch']), /Unknown flag/);
});

test('the release:stage / release:verify / fetch:release scripts are pinned in package.json', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));
  assert.equal(
    pkg.scripts['release:stage'],
    'node tools/publish/release.mjs --stage --include=all'
  );
  assert.equal(pkg.scripts['release:verify'], 'node tools/publish/releaseVerify.mjs');
  assert.equal(pkg.scripts['fetch:release'], 'node tools/publish/fetchRelease.mjs');
});
