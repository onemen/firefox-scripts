// tools/test/unit/embed.test.mjs — Unit tests for installer/embed.mjs.
//
// embed.mjs runs main() at import (it writes src/resources.h), so the tests
// spawn it with --stdout and assert on the generated header text instead of
// importing the module.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'child_process';
import path from 'path';
import {fileURLToPath} from 'url';

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
});

test('embed.mjs: deterministic output', () => {
  assert.equal(generate(), generate());
});
