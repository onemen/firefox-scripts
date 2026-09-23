// SPDX-License-Identifier: MIT

// Guards the committed Windows icon resource: the .ico bytes are only ever
// produced by tools/make-installer-icon.mjs (which needs a local Chrome), so a
// broken or blank file could otherwise land in a commit unnoticed, and the two
// .rc files plus the Makefile are what actually put it into the PEs.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ICO = path.join(REPO_ROOT, 'installer', 'src', 'installer.ico');
const EXPECTED_SIZES = [16, 24, 32, 48, 128, 256];

/** Parse the ICONDIR + entries of an .ico file. */
function readIco(buf) {
  assert.equal(buf.readUInt16LE(0), 0, 'reserved field must be 0');
  assert.equal(buf.readUInt16LE(2), 1, 'type must be 1 (icon)');
  const count = buf.readUInt16LE(4);
  const entries = [];
  for (let i = 0; i < count; i++) {
    const e = 6 + i * 16;
    entries.push({
      size: buf[e] === 0 ? 256 : buf[e],
      bpp: buf.readUInt16LE(e + 6),
      bytes: buf.readUInt32LE(e + 8),
      offset: buf.readUInt32LE(e + 12),
    });
  }
  return entries;
}

test('installer.ico: a real multi-size icon container', () => {
  assert.ok(fs.existsSync(ICO), `${ICO} is missing — run node tools/make-installer-icon.mjs`);
  const buf = fs.readFileSync(ICO);
  const entries = readIco(buf);
  assert.deepEqual(
    entries.map(e => e.size),
    EXPECTED_SIZES
  );
  for (const e of entries) {
    assert.equal(e.bpp, 32);
    assert.ok(e.offset + e.bytes <= buf.length, `entry ${e.size} runs past the file end`);
  }
  assert.ok(buf.length < 64 * 1024, 'the icon is embedded in both PEs — keep it small');
});

test('installer.ico: 32px entry actually renders the tile and the glyph', () => {
  const buf = fs.readFileSync(ICO);
  const entry = readIco(buf).find(e => e.size === 32);
  // A BMP entry: BITMAPINFOHEADER (40 bytes) + bottom-up BGRA + AND mask.
  const bmp = buf.subarray(entry.offset);
  assert.equal(bmp.readUInt32LE(0), 40, 'expected an uncompressed BMP entry');
  const pixels = bmp.subarray(40, 40 + 32 * 32 * 4);

  let opaque = 0;
  let brand = 0;
  let white = 0;
  for (let i = 0; i < 32 * 32; i++) {
    const b = pixels[i * 4];
    const g = pixels[i * 4 + 1];
    const r = pixels[i * 4 + 2];
    const a = pixels[i * 4 + 3];
    if (a > 200) opaque += 1;
    // #2563eb tile (bilinear-free fills keep the exact color in the interior).
    if (Math.abs(b - 0xeb) < 12 && Math.abs(g - 0x63) < 12 && Math.abs(r - 0x25) < 12) brand += 1;
    if (r > 240 && g > 240 && b > 240) white += 1;
  }
  assert.ok(opaque > 32 * 32 * 0.5, `icon is mostly transparent (${opaque} opaque px)`);
  assert.ok(brand > 32 * 32 * 0.3, `brand-blue tile missing (${brand} px)`);
  assert.ok(white > 20, `glyph stroke missing (${white} white px)`);
});

test('both PEs wire the icon resource, and the Makefile rebuilds on a change', () => {
  const installerRc = fs.readFileSync(
    path.join(REPO_ROOT, 'installer', 'src', 'installer.rc'),
    'utf-8'
  );
  const helperRc = fs.readFileSync(
    path.join(REPO_ROOT, 'installer', 'src', 'helper', 'version.rc'),
    'utf-8'
  );
  const makefile = fs.readFileSync(path.join(REPO_ROOT, 'installer', 'Makefile'), 'utf-8');

  assert.match(installerRc, /^\s*1 ICON "installer\.ico"/m);
  assert.match(helperRc, /^\s*1 ICON "\.\.\/installer\.ico"/m);
  // The icon is a prerequisite of both resource builds — otherwise a changed
  // icon would silently keep linking the stale .res.
  assert.match(
    makefile,
    /^\$\(SRC_DIR\)\/installer\.res:.*\$\(SRC_DIR\)\/installer\.ico/m,
    'installer.res must depend on installer.ico'
  );
  assert.match(
    makefile,
    /^helper_win:.*\$\(SRC_DIR\)\/installer\.ico/m,
    'helper_win must depend on installer.ico'
  );
});
