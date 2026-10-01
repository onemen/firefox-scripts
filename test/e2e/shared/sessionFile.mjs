// test/e2e/shared/sessionFile.mjs — mock sessionstore.jsonlz4 builder (#384
// follow-up). Lets the updater E2E restore a multi-window previous session
// whose updater tab lives in a NON-active window — the shape the twin-tab
// guard's all-windows scan must handle.
//
// Format: Firefox's session files are "mozLz40" containers — 8-byte magic
// "mozLz40\0", 4-byte little-endian uncompressed size, then an LZ4 *block*.
// We emit ONE literal-only LZ4 sequence (token 0xF0 + extended length + all
// literals, no match) — the exact shape liblz4 and Firefox's decompressor
// accept for arbitrary sizes. Dependency-free and deterministic.
//
// The payload mirrors what SessionStore reads at startup: windows[] with
// selected (1-based tab index), tabs[] → entries[] (index points at the
// current page), plus the top-level selectedWindow. The updater tab is placed
// in a NON-active window and is NOT that window's selected tab — the user's
// reported restore shape.

import fs from 'node:fs';
import path from 'node:path';

const MAGIC = Buffer.from('mozLz40\0', 'latin1');

/**
 * Compress a Buffer as a valid single-sequence LZ4 block of pure literals
 * (token 0xF0, extended length bytes, then the input verbatim).
 *
 * @param {Buffer} input
 * @returns {Buffer}
 */
export function lz4LiteralBlock(input) {
  const parts = [];
  if (input.length < 15) {
    parts.push(Buffer.from([input.length << 4]), input);
    return Buffer.concat(parts);
  }
  parts.push(Buffer.from([0xf0])); // 15 literals + extended length bytes
  let l = input.length - 15;
  while (l >= 255) {
    parts.push(Buffer.from([255]));
    l -= 255;
  }
  // The extension-byte run ALWAYS ends with its terminating byte — including
  // when the remainder is 0 (len = 15 + 255·k). A decoder reads extension
  // bytes until one is < 255; without the 0x00 terminator it would read into
  // the payload (the lengths 14/269/524… were corrupt; found by review).
  parts.push(Buffer.from([l]));
  parts.push(input);
  return Buffer.concat(parts);
}

/**
 * Wrap a JSON payload in the mozLz4 container sessionstore reads.
 *
 * @param {object | string} payload
 * @returns {Buffer}
 */
export function mozLz4(payload) {
  const json = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const raw = Buffer.from(json, 'utf8');
  const header = Buffer.alloc(12);
  MAGIC.copy(header, 0);
  header.writeUInt32LE(raw.length, 8);
  return Buffer.concat([header, lz4LiteralBlock(raw)]);
}

/**
 * A minimal but structurally-real multi-window session. `updaterInWindow`
 * (1-based) holds the updater tab; the LAST window is the one selected at
 * "shutdown", and the updater tab is never its window's selected tab — the
 * restore shape the all-windows guard must survive.
 *
 * @param {object} opts
 * @param {number} [opts.windows=2] Default is `2`
 * @param {number} [opts.updaterInWindow=1] 1-based window holding the updater
 *   tab. Default is `1`
 * @param {string} opts.updaterUrl the chrome:// updater URL to restore
 * @param {string[]} [opts.fillerUrls] ordinary tabs padding each window
 * @returns {object} JSON-ready session object
 */
export function buildSession({
  windows = 2,
  updaterInWindow = 1,
  updaterUrl,
  fillerUrls = ['https://example.com/', 'https://www.mozilla.org/'],
}) {
  if (!updaterUrl) {
    throw new Error('buildSession: updaterUrl is required');
  }
  if (updaterInWindow > windows) {
    throw new Error('buildSession: updaterInWindow exceeds the window count');
  }
  const session = {
    version: 'sessionrestore',
    windows: [],
    selectedWindow: windows,
  };
  for (let w = 1; w <= windows; w++) {
    const tabs = [];
    if (w === updaterInWindow) {
      tabs.push({
        entries: [{url: updaterUrl, title: 'Firefox Scripts updater'}],
        index: 1,
        hidden: false,
        attributes: {},
        extData: {},
      });
    }
    for (let t = 0; t < 2; t++) {
      tabs.push({
        entries: [{url: fillerUrls[t % fillerUrls.length], title: `window ${w} tab ${t}`}],
        index: 1,
        hidden: false,
        attributes: {},
        extData: {},
      });
    }
    session.windows.push({
      tabs,
      // window 1: updater tab (index 1) is NOT selected — tab 2 is.
      // other windows: first filler selected.
      selected: w === updaterInWindow ? 2 : 1,
      _closedTabs: [],
    });
  }
  return session;
}

/**
 * Write the mock session into a profile as sessionstore.jsonlz4.
 *
 * @param {string} profileDir
 * @param {object} session the object from buildSession()
 * @returns {string} the file written
 */
export function writeSessionFile(profileDir, session) {
  fs.mkdirSync(profileDir, {recursive: true});
  const file = path.join(profileDir, 'sessionstore.jsonlz4');
  fs.writeFileSync(file, mozLz4(session));
  return file;
}

// Self-test when run directly: node sessionFile.mjs
if (process.argv[1] && process.argv[1].endsWith('sessionFile.mjs')) {
  const s = buildSession({
    windows: 2,
    updaterInWindow: 1,
    updaterUrl: 'chrome://firefox-scripts/content/ui/updater.html',
  });
  const buf = mozLz4(s);
  // Container sanity: magic + declared size match the JSON we packed, and the
  // embedded JSON reparses to the same window/tab structure.
  if (!buf.subarray(0, 8).equals(MAGIC)) {
    throw new Error('mozLz4 magic mismatch');
  }
  const declared = buf.readUInt32LE(8);
  // Walk the LZ4 token: byte 12 is the token; its low nibble is 0 and its
  // high nibble is 15, so extended-length bytes follow (255-continuation).
  // The literals (our JSON) start after them and run exactly `declared` bytes.
  let p = 13;
  let extra;
  do {
    extra = buf[p++];
  } while (extra === 255);
  const json = JSON.parse(buf.subarray(p, p + declared).toString('utf8'));
  if (
    json.windows.length !== 2 ||
    json.windows[0].tabs[0].entries[0].url !== s.windows[0].tabs[0].entries[0].url ||
    json.windows[1].selected !== 1
  ) {
    throw new Error('mozLz4 round-trip mismatch');
  }
  console.log('sessionFile self-test OK:', buf.length, 'bytes container,', declared, 'bytes json');
}
