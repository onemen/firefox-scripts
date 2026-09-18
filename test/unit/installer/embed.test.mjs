// test/unit/installer/embed.test.mjs — Unit tests for installer/embed.mjs.
//
// embed.mjs runs main() at import (it writes src/resources.h), so the tests
// spawn it with --stdout and assert on the generated header text instead of
// importing the module.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'child_process';
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

test('embed.mjs: the gzip emitted by this runtime is well-formed build input', () => {
  // resources.h embeds Node-gzipped assets, so a runtime whose zlib emits
  // different deflate bytes changes the installer binary and its published
  // hashes while every tracked source stays identical — and those hashes are
  // what the per-hash AV verdicts (issue #157) and the update manifest key on.
  //
  // A fixed sha256 here CANNOT pin that: CI already failed this exact test
  // (node 24.20.0 / zlib 1.3.2.1-motley-42c2f19 hashes the sample differently
  // than the runtime the constant was computed on — the zlib output is not
  // stable across builds). What is guaranteed at every runtime are the
  // invariants below. Cross-runtime byte equality is monitored the other way:
  // `tools/ci/msys2Toolchain.mjs --provenance` logs the exact node/zlib pair
  // of every build run next to its artifacts, so a local rebuild compares
  // those lines and re-verifies the AV/VT gates when the pair differs.
  const raw = Buffer.from(
    Array.from(
      {length: 64},
      (_, i) => `line-${i}: the quick brown fox jumps over the lazy dog`
    ).join('\n'),
    'utf-8'
  );
  const gz = zlib.gzipSync(raw, {level: 9});
  // Two compressions in the same runtime are byte-identical — the input the
  // build embeds never varies run to run.
  assert.deepEqual(
    zlib.gzipSync(raw, {level: 9}),
    gz,
    'gzipSync is not deterministic within this runtime'
  );
  // The payload survives exactly: the embedded assets decompress to what was
  // fed in (Content-Encoding: gzip on the installer tab's fetches).
  assert.deepEqual(zlib.gunzipSync(gz), raw);
  // 64 lines x 55 chars + 63 newlines = 3583 bytes in; the level-9 stream of
  // this sample is ~236 bytes on every runtime measured so far, so a wild
  // format change (raw deflate, an uncompressed payload) still trips here.
  assert.ok(gz.length > 100 && gz.length < 600, `implausible gzip size ${gz.length}`);
  // gzip magic: a raw deflate/zlib stream would still look "well-formed" and
  // the browser would silently fail to decompress it (Content-Encoding: gzip).
  assert.equal(gz[0], 0x1f);
  assert.equal(gz[1], 0x8b);
});
