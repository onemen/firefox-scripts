// test/unit/publish/stagingGuard.test.mjs — unit tests for the #33
// staging-target guard (tools/publish/stagingGuard.mjs).
//
// stagingGuard.mjs itself never calls requireMode(), but log.mjs (imported by
// the guard) and the tested code paths are argv-tolerant; --mode=prod is pushed
// before import to mirror the other publish unit tests.

import {test} from 'node:test';
import assert from 'node:assert/strict';

process.argv.push('--mode=prod');

const {collectOverrides, readInstallerConf, runStagingGuard, stagingBanner} =
  await import('../../../tools/publish/stagingGuard.mjs');

test('readInstallerConf parses KEY=value lines and skips comments', () => {
  const conf = readInstallerConf('config/installer.conf');
  assert.equal(conf.RELEASE_NAME, 'latest');
  assert.equal(conf.REPO_OWNER, 'onemen');
});

test('readInstallerConf tolerates a missing file', () => {
  assert.deepEqual(readInstallerConf('no/such/file.conf'), {});
});

test('collectOverrides: prod mode reports every set target key', () => {
  const overrides = collectOverrides(
    {REPO_OWNER: 'someone', HASHES_URL: 'https://evil.test/hashes.json'},
    'prod',
    {REPO_OWNER: 'onemen'}
  );
  assert.deepEqual(overrides, [
    {key: 'REPO_OWNER', value: 'someone', conf: 'onemen'},
    {key: 'HASHES_URL', value: 'https://evil.test/hashes.json', conf: undefined},
  ]);
});

test('collectOverrides: dev mode only checks repo-identity keys', () => {
  const overrides = collectOverrides(
    {RELEASE_NAME: 'x', ZIP_PAGES_BRANCH: 'y', REPO_NAME: 'other'},
    'dev',
    {}
  );
  assert.deepEqual(overrides, [{key: 'REPO_NAME', value: 'other', conf: undefined}]);
});

test('collectOverrides: unset and empty values are ignored', () => {
  assert.deepEqual(collectOverrides({REPO_OWNER: '', RELEASE_NAME: undefined}, 'prod', {}), []);
});

test('collectOverrides: a value equal to the conf baseline is still an override', () => {
  const overrides = collectOverrides({REPO_OWNER: 'onemen'}, 'prod', {REPO_OWNER: 'onemen'});
  assert.deepEqual(overrides, [{key: 'REPO_OWNER', value: 'onemen', conf: 'onemen'}]);
});

test('stagingBanner lists every override with its baseline', () => {
  const banner = stagingBanner([{key: 'REPO_OWNER', value: 'someone', conf: 'onemen'}], {
    mode: 'prod',
  });
  assert.match(banner, /STAGING PUBLISH TARGET/);
  assert.match(banner, /REPO_OWNER\s+= someone\s+\[installer\.conf: onemen\]/);
  assert.match(banner, /FIREFOX_SCRIPTS_ALLOW_STAGING=1/);
});

test('runStagingGuard: prod + override throws and prints the banner', () => {
  assert.throws(
    () =>
      runStagingGuard({
        mode: 'prod',
        env: {REPO_OWNER: 'someone'},
      }),
    /Prod publish aborted/
  );
});

test('runStagingGuard: prod + FIREFOX_SCRIPTS_ALLOW_STAGING=1 continues', () => {
  const result = runStagingGuard({
    mode: 'prod',
    env: {REPO_OWNER: 'someone', FIREFOX_SCRIPTS_ALLOW_STAGING: '1'},
  });
  assert.equal(result.allowed, true);
  assert.equal(result.overrides.length, 1);
});

test('runStagingGuard: dev + override warns but does not throw', () => {
  const result = runStagingGuard({mode: 'dev', env: {REPO_NAME: 'other'}});
  assert.equal(result.allowed, true);
  assert.equal(result.overrides.length, 1);
});

test('runStagingGuard: --local snapshots are exempt', () => {
  const result = runStagingGuard({mode: 'prod', local: true, env: {REPO_OWNER: 'someone'}});
  assert.deepEqual(result, {overrides: [], allowed: false});
});

test('runStagingGuard: no overrides → no-op in every mode', () => {
  for (const mode of ['prod', 'dev']) {
    assert.deepEqual(runStagingGuard({mode, env: {}}), {overrides: [], allowed: false});
  }
});
