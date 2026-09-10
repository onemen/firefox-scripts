// test/unit/publish/helperSha256.test.mjs — unit tests for the #33 helper
// checksum sidecar: naming (platforms.mjs), render/parse round-trip
// (hashUtils.mjs).
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
const {PLATFORM, helperAssetName, helperShaAssetName} = await import(platformsUrl);

const hashUtilsUrl = pathToFileURL(
  fileURLToPath(new URL('../../../tools/publish/hashUtils.mjs', import.meta.url))
).href;
const {helperSha256Sidecar, parseHelperSha256} = await import(hashUtilsUrl);

test('helperShaAssetName: mirrors helperAssetName with a .sha256 extension', () => {
  for (const p of Object.keys(PLATFORM)) {
    const helper = helperAssetName(p);
    const sidecar = helperShaAssetName(p);
    assert.match(sidecar, /^helper_/);
    assert.match(sidecar, /\.sha256$/);
    // The sidecar is exactly the helper name with .sha256 appended
    // (helper_win.exe → helper_win.exe.sha256; helper_linux → helper_linux.sha256).
    assert.equal(sidecar, `${helper}.sha256`);
  }
});

test('helperShaAssetName: aarch64 twin keeps its assetPlatform', () => {
  assert.equal(helperShaAssetName('aarch64'), 'helper_linux_aarch64.sha256');
});

test('helperSha256Sidecar: sha256sum-compatible render, digest round-trips', () => {
  const bytes = Buffer.from('pretend this is a helper binary');
  const text = helperSha256Sidecar(bytes, 'helper_win.exe').toString('utf-8');
  // Two-space separator (sha256sum -c format), name column, trailing newline.
  assert.match(text, /^[0-9a-f]{64} {2}helper_win\.exe\n$/);
  assert.equal(parseHelperSha256(text), crypto.createHash('sha256').update(bytes).digest('hex'));
});

test('parseHelperSha256: tolerates CRLF, missing name column, case; rejects junk', () => {
  const hex = 'a'.repeat(64);
  assert.equal(parseHelperSha256(`${hex}  helper_linux\n`), hex);
  assert.equal(parseHelperSha256(`${hex.toUpperCase()}\r\n`), hex);
  assert.equal(parseHelperSha256(hex), hex);
  assert.equal(parseHelperSha256('<html>404</html>'), null);
  assert.equal(parseHelperSha256(''), null);
});
