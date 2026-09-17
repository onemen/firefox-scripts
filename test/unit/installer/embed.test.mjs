// test/unit/installer/embed.test.mjs — Unit tests for installer/embed.mjs.
//
// embed.mjs runs main() at import (it writes src/resources.h), so the tests
// spawn it with --stdout and assert on the generated header text instead of
// importing the module.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'child_process';
import {createHash} from 'crypto';
import path from 'path';
import {fileURLToPath} from 'url';
import zlib from 'zlib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EMBED = path.join(__dirname, '..', '..', '..', 'installer', 'embed.mjs');

/** Run embed.mjs --stdout and return the generated header text. */
function generate() {
  const r = spawnSync(process.execPath, [EMBED, '--stdout'], {encoding: 'utf-8'});
  assert.equal(r.status, 0, `embed.mjs failed: ${r.stderr}`);
  return r.stdout;
}

test('embed.mjs: emits a guarded C header', () => {
  const out = generate();
  assert.match(out, /#ifndef RESOURCES_H/);
  assert.match(out, /#define RESOURCES_H/);
  assert.match(out, /#endif \/\* RESOURCES_H \*\//);
});

test('embed.mjs: embeds every expected symbol', () => {
  const out = generate();
  for (const name of [
    'RES_FAVICON_SVG',
    'RES_INDEX_HTML_GZ',
    'RES_STYLE_CSS_GZ',
    'RES_SCRIPT_JS_GZ',
    'RES_LOGO_FIREFOX_GZ',
    'RES_LOGO_WATERFOX_GZ',
    'RES_LOGO_ZEN_GZ',
    'RES_LOGO_LIBREWOLF_GZ',
    'RES_LOGO_FLOORP_GZ',
  ]) {
    // eslint-disable-next-line security/detect-non-literal-regexp -- names are a fixed test list
    const re = new RegExp(`static const (char \\*|unsigned char )${name}`);
    assert.match(out, re);
  }
});

test('embed.mjs: text assets are escaped C strings', () => {
  const out = generate();
  // favicon.svg is a text asset embedded as a C string literal.
  const m = out.match(/static const char \*RES_FAVICON_SVG =\n[ ]{4}"([\s\S]*?)";/);
  assert.ok(m, 'RES_FAVICON_SVG string literal not found');
  // The literal must not contain a raw newline (would break the C string).
  assert.ok(!m[1].includes('\n'), 'raw newline inside C string literal');
});

test('embed.mjs: gzip byte arrays are non-empty and well-formed', () => {
  const out = generate();
  const m = out.match(/static const unsigned char RES_INDEX_HTML_GZ\[\] = \{([\s\S]*?)\};/);
  assert.ok(m, 'RES_INDEX_HTML_GZ array not found');
  const bytes = m[1].match(/0x[0-9a-f]{2}/g) || [];
  assert.ok(bytes.length > 0, 'gzip array is empty');
  for (const b of bytes) assert.match(b, /^0x[0-9a-f]{2}$/);
  // gzip magic: a raw deflate/zlib stream would still look "well-formed" and
  // the browser would silently fail to decompress it (Content-Encoding: gzip).
  assert.equal(bytes[0], '0x1f');
  assert.equal(bytes[1], '0x8b');
});

test('embed.mjs: deterministic output', () => {
  assert.equal(generate(), generate());
});

test('embed.mjs: the gzip emitted by this runtime is a pinned build input', () => {
  // resources.h embeds Node-gzipped assets, so a runtime whose zlib emits
  // different deflate bytes changes the installer binary and its published
  // hashes while every tracked source stays identical — and those hashes are
  // what the per-hash AV verdicts (issue #157) and the update manifest key on.
  // Measured identical on node 24.20.0 (CI) and 26.8.2 (local) on 2026-09-17;
  // this assertion is what notices when a future runtime diverges.
  const raw = Buffer.from(
    Array.from(
      {length: 64},
      (_, i) => `line-${i}: the quick brown fox jumps over the lazy dog`
    ).join('\n'),
    'utf-8'
  );
  const gz = zlib.gzipSync(raw, {level: 9});
  assert.equal(gz.length, 236, 'gzip output length changed for the pinned sample');
  assert.equal(
    createHash('sha256').update(gz).digest('hex'),
    '269ae9225f30a8af7303a7208c62d237426c29adfc6161c0b30029adc943f76a',
    `this runtime (node ${process.version}, zlib ${process.versions.zlib}) compresses ` +
      'differently than the runtime the published bytes were built with — the embedded ' +
      'assets, the installer bytes and the published hashes all change; check the CI run ' +
      'log for its node/zlib pair (tools/ci/msys2Toolchain.mjs --provenance) and re-verify ' +
      'the AV/VT gates before publishing'
  );
});
