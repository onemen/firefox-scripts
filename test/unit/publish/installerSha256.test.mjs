// test/unit/publish/installerSha256.test.mjs — unit tests for the #324
// installer checksum sidecar: naming (platforms.mjs), render (hashUtils.mjs —
// shared sha256sum-compatible format with the helper's #33 sidecar).
//
// hashUtils.mjs imports paths.js/publishMode.mjs (argv-coupled), so --mode=prod
// is pushed before import — the same pattern the other publish unit tests use.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';

process.argv.push('--mode=prod');

const platformsUrl = pathToFileURL(
  fileURLToPath(new URL('../../../tools/publish/platforms.mjs', import.meta.url))
).href;
const {PLATFORM, installerAssetName, installerShaAssetName} = await import(platformsUrl);

const hashUtilsUrl = pathToFileURL(
  fileURLToPath(new URL('../../../tools/publish/hashUtils.mjs', import.meta.url))
).href;
const {installerSha256Sidecar, helperSha256Sidecar, parseHelperSha256} = await import(hashUtilsUrl);

test('installerShaAssetName: mirrors installerAssetName with a .sha256 extension', () => {
  for (const p of Object.keys(PLATFORM)) {
    const installer = installerAssetName(p);
    const sidecar = installerShaAssetName(p);
    assert.match(sidecar, /^installer_/);
    assert.match(sidecar, /\.sha256$/);
    // Same derivation rule as the helper's: full binary name + .sha256
    // (installer_win.exe → installer_win.exe.sha256).
    assert.equal(sidecar, `${installer}.sha256`);
  }
});

test('installerShaAssetName: aarch64 twin keeps its assetPlatform', () => {
  assert.equal(installerShaAssetName('aarch64'), 'installer_linux_aarch64.sha256');
});

test('installerSha256Sidecar: same format as the helper sidecar, digest round-trips', () => {
  const bytes = Buffer.from('pretend this is an installer binary');
  const text = installerSha256Sidecar(bytes, 'installer_win.exe').toString('utf-8');
  // Two-space separator (sha256sum -c format), name column, trailing newline —
  // byte-identical scheme to the helper's sidecar (issue #324 vs #33).
  assert.match(text, /^[0-9a-f]{64} {2}installer_win\.exe\n$/);
  const helperText = helperSha256Sidecar(bytes, 'installer_win.exe').toString('utf-8');
  assert.equal(text, helperText, 'renderer must be shared with the helper sidecar');
  assert.equal(parseHelperSha256(text), crypto.createHash('sha256').update(bytes).digest('hex'));
});

test('sidecar name is NOT a self-update map candidate: the C parser substring-shadows', () => {
  // The C self-update resolves its download URL by a plain substring search for
  // the asset name (self_update.c); `installer_win.exe` is a prefix of
  // `installer_win.exe.sha256`, so a sidecar entry in the managed download map
  // would shadow the binary's URL. componentAssets keys therefore must keep the
  // sidecar distinguishable by the `.sha256` suffix the sync loop filters on.
  for (const p of Object.keys(PLATFORM)) {
    const binary = installerAssetName(p);
    const sidecar = installerShaAssetName(p);
    assert.ok(sidecar.startsWith(binary), 'sidecar must name its binary');
    assert.notEqual(sidecar, binary);
    assert.ok(binary.endsWith('.sha256') === false);
  }
});
