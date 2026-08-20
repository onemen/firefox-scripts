#!/usr/bin/env node
/**
 * embed.mjs — Read files from web/ directory and generate src/resources.h with
 * embedded constants for the C installer. Node.js port of embed.py
 * (byte-identical output).
 *
 * Text assets (html/css/js/favicon) are embedded as C strings; the web UI text
 * and brand logos are gzip-compressed at build time and embedded as byte
 * arrays, because raw they would add ~150 KB of read-only data to the installer
 * binary on every platform. The local HTTP server serves them with
 * Content-Encoding: gzip, which browsers decompress transparently.
 */

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import {fileURLToPath} from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WEB_DIR = path.join(__dirname, 'web');
const OUTPUT_FILE = path.join(__dirname, 'src', 'resources.h');

const FILES = {
  RES_FAVICON_SVG: 'favicon.svg',
};

// Text assets and brand logos are embedded gzip-compressed (see header
// comment) — raw, they would add ~150 KB of read-only data to the installer
// binary on every platform.  The local HTTP server serves them with
// Content-Encoding: gzip, which browsers decompress transparently.
const GZ_FILES = {
  RES_INDEX_HTML_GZ: 'index.html',
  RES_STYLE_CSS_GZ: 'style.css',
  RES_SCRIPT_JS_GZ: 'script.js',
  RES_LOGO_FIREFOX_GZ: path.join('logos', 'firefox.png'),
  RES_LOGO_WATERFOX_GZ: path.join('logos', 'waterfox.png'),
  RES_LOGO_ZEN_GZ: path.join('logos', 'zen.png'),
  RES_LOGO_LIBREWOLF_GZ: path.join('logos', 'librewolf.png'),
  RES_LOGO_FLOORP_GZ: path.join('logos', 'floorp.png'),
};

function escapeCString(text) {
  let result = '';
  for (const ch of text) {
    switch (ch) {
      case '"':
        result += '\\"';
        break;
      case '\\':
        result += '\\\\';
        break;
      case '\n':
        result += '\\n';
        break;
      case '\r':
        result += '\\r';
        break;
      case '\t':
        result += '\\t';
        break;
      default:
        if (ch.charCodeAt(0) < 32) {
          result += `\\x${ch.charCodeAt(0).toString(16).padStart(2, '0')}`;
        } else {
          result += ch;
        }
    }
  }
  return result;
}

// Emit a C byte array (for gzip-compressed data, which contains NUL bytes and
// cannot be a C string).
function emitByteArray(varName, bytes) {
  const lines = [`static const unsigned char ${varName}[] = {`];
  let line = '    ';
  for (let i = 0; i < bytes.length; i++) {
    const part = `0x${bytes[i].toString(16).padStart(2, '0')}`;
    if (line.length + part.length + 2 > 92) {
      lines.push(line);
      line = '    ';
    }
    line += part + (i < bytes.length - 1 ? ',' : '');
  }
  lines.push(line);
  lines.push('};');
  lines.push('');
  return lines.join('\n');
}

function generateOutput() {
  const lines = ['#ifndef RESOURCES_H', '#define RESOURCES_H', ''];

  for (const [varName, filename] of Object.entries(FILES)) {
    const filepath = path.join(WEB_DIR, filename);
    if (!fs.existsSync(filepath)) {
      console.error(`Warning: ${filepath} not found, embedding empty string`);
      lines.push(`static const char *${varName} = "";`);
      lines.push('');
      continue;
    }

    const content = fs.readFileSync(filepath, 'utf-8');
    const escaped = escapeCString(content);
    lines.push(`static const char *${varName} =`);
    lines.push(`    "${escaped}";`);
    lines.push('');
  }

  for (const [varName, filename] of Object.entries(GZ_FILES)) {
    const filepath = path.join(WEB_DIR, filename);
    if (!fs.existsSync(filepath)) {
      console.error(`Warning: ${filepath} not found, embedding empty array`);
      lines.push(`static const unsigned char ${varName}[] = {0};`);
      lines.push('');
      continue;
    }

    const raw = fs.readFileSync(filepath);
    const gz = zlib.gzipSync(raw, {level: 9});
    lines.push(emitByteArray(varName, gz));
  }

  lines.push('#endif /* RESOURCES_H */');
  lines.push('');
  return lines.join('\n');
}

function main() {
  if (process.argv.includes('--stdout')) {
    process.stdout.write(Buffer.from(generateOutput(), 'utf-8'));
    return;
  }

  const output = generateOutput();

  fs.mkdirSync(path.dirname(OUTPUT_FILE), {recursive: true});
  fs.writeFileSync(OUTPUT_FILE, output, {encoding: 'utf-8'});

  const lines = output.split('\n');
  const arrSize = name => {
    const i = lines.findIndex(l => l.startsWith(`static const unsigned char ${name}[] =`));
    // Count the 0xNN, entries across the array lines.
    let total = 0;
    for (let j = i + 1; j < lines.length && !lines[j].startsWith('};'); j++) {
      total += (lines[j].match(/0x[0-9a-f]{2}/g) || []).length;
    }
    return total;
  };
  console.log(`Generated ${OUTPUT_FILE}`);
  console.log(`  RES_INDEX_HTML_GZ:  ${arrSize('RES_INDEX_HTML_GZ')} bytes (gzip)`);
  console.log(`  RES_STYLE_CSS_GZ:   ${arrSize('RES_STYLE_CSS_GZ')} bytes (gzip)`);
  console.log(`  RES_SCRIPT_JS_GZ:   ${arrSize('RES_SCRIPT_JS_GZ')} bytes (gzip)`);
}

main();
