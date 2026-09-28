// test/unit/publish/releaseVerify.test.mjs — pure checks behind release:verify:
// asset-set diff, tag-ref resolution, and the platform helpers in fetchRelease.

import {test} from 'node:test';
import assert from 'node:assert/strict';

const verify = await import('../../../tools/publish/releaseVerify.mjs');
const {
  evaluateAssets,
  resolveTagCommit,
  EXPECTED_RELEASE_ASSETS,
  INSTALLER_TAG_JQ_FILTER,
  avCheckArgs,
  isBlobSha,
} = verify;
const {installerForMyOs, stagedArtifactForMyOs} =
  await import('../../../tools/publish/fetchRelease.mjs');

test('evaluateAssets: missing expected assets are the failure', () => {
  const full = [...EXPECTED_RELEASE_ASSETS];
  assert.deepEqual(evaluateAssets(full).missing, []);
  const {missing} = evaluateAssets(['utils.zip', 'installer_win.exe']);
  assert.deepEqual(missing, [
    'fx-folder.zip',
    'installer_linux',
    'installer_linux_aarch64',
    'installer_mac',
  ]);
});

test('evaluateAssets: extra assets (sidecars) are tolerated, not a failure', () => {
  const {missing} = evaluateAssets([
    ...EXPECTED_RELEASE_ASSETS,
    'installer_win.exe.sha256',
    'helper_win.exe',
  ]);
  assert.deepEqual(missing, []);
});

test('resolveTagCommit: lightweight tag points at the commit directly', () => {
  assert.equal(resolveTagCommit({object: {type: 'commit', sha: 'abc1234'}}), 'abc1234');
});

test('resolveTagCommit: annotated tag is marked for dereferencing', () => {
  assert.equal(resolveTagCommit({object: {type: 'tag', sha: 'dead000'}}), 'annotated:dead000');
});

test('resolveTagCommit: missing ref object resolves to null', () => {
  assert.equal(resolveTagCommit({object: null}), null);
  assert.equal(resolveTagCommit(null), null);
});

test('#359: the installer-tag jq filter uses [0-9] classes — gh ships gojq, which rejects \\d', () => {
  assert.ok(INSTALLER_TAG_JQ_FILTER.includes('test("^installer-[0-9]{4}-[0-9]{2}-[0-9]{2}$")'));
  assert.ok(
    !INSTALLER_TAG_JQ_FILTER.includes('\\d'),
    'a bare \\d crashes gojq with an invalid escape'
  );
  // The filter is a count expression: the script compares it against > 0.
  assert.ok(INSTALLER_TAG_JQ_FILTER.trimEnd().endsWith('| length'));
});

test('#359: the AV check is spawned with its required --repo/--ref arguments', () => {
  assert.deepEqual(avCheckArgs('onemen/firefox-scripts'), [
    '--env-file-if-exists=.env',
    'tools/check-published-av.mjs',
    '--repo',
    'onemen/firefox-scripts',
    '--ref',
    'gh-pages',
  ]);
  assert.deepEqual(avCheckArgs('o/r', 'main'), [
    '--env-file-if-exists=.env',
    'tools/check-published-av.mjs',
    '--repo',
    'o/r',
    '--ref',
    'main',
  ]);
});

test('#359: isBlobSha validates the contents-API .sha output (a bare string, not JSON)', () => {
  assert.ok(isBlobSha('0123456789abcdef0123456789abcdef01234567'));
  assert.ok(isBlobSha('0123456789abcdef0123456789abcdef01234567\n'));
  assert.ok(!isBlobSha('0123456789ABCDEF0123456789abcdef01234567'), 'uppercase is not a git sha');
  assert.ok(!isBlobSha('0123456789abcdef'), 'too short');
  assert.ok(!isBlobSha('zzzz456789abcdef0123456789abcdef01234567'), 'non-hex');
  assert.ok(!isBlobSha(''), 'empty');
  assert.ok(!isBlobSha(undefined), 'missing');
});

test('installerForMyOs: platform naming matches the publish asset names', () => {
  assert.equal(installerForMyOs('win32'), 'installer_win.exe');
  assert.equal(installerForMyOs('darwin'), 'installer_mac');
  assert.equal(installerForMyOs('linux'), 'installer_linux');
  assert.equal(installerForMyOs('sunos'), null);
});

test('stagedArtifactForMyOs: staging artifact names match build-and-upload.yml', () => {
  assert.equal(stagedArtifactForMyOs('win32'), 'staged-win');
  assert.equal(stagedArtifactForMyOs('darwin'), 'staged-mac');
  assert.equal(stagedArtifactForMyOs('linux'), 'staged-linux');
  assert.equal(stagedArtifactForMyOs('sunos'), null);
});
