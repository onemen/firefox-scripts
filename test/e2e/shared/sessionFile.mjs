// test/e2e/shared/sessionFile.mjs — mock sessionstore.jsonlz4 builder.
// Lets the updater E2E restore a multi-window previous session
// whose updater tab lives in a NON-active window — the shape the attach block's
// all-windows scan must handle.
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
// reported restore shape. Only long-stable session fields are emitted, and the
// filler tabs point at one inert static page, so the file parses on every
// watched engine (ESR 140 floor → Nightly) without loading real-world content
// or any third-party script.
//
// The updater entry also carries the entry's saved principal
// (`triggeringPrincipal_base64`), because WITHOUT one the restored chrome://
// tab is unloadable and the fixture lies about the shape it claims to replay:
// SessionStore's history restore reads that field through
// `E10SUtils.deserializePrincipal(entry.triggeringPrincipal_base64, fallback)`
// and the fallback is a freshly created NullPrincipal (ESR 140,
// `modules/sessionstore/SessionHistory.sys.mjs:556` — "Every load must have a
// triggeringPrincipal to load otherwise we prevent it"), which then cannot
// load the privileged URL
// (`Security Error: Content at moz-nullprincipal:{…} may not load or link to
// chrome://firefox-scripts/content/ui/updater.html`). See
// SERIALIZED_SYSTEM_PRINCIPAL below.

import fs from 'node:fs';
import path from 'node:path';

const MAGIC = Buffer.from('mozLz40\0', 'latin1');

/**
 * The serialized SYSTEM principal, byte-for-byte as Firefox writes it.
 *
 * `E10SUtils.serializePrincipal()` is `Services.scriptSecurityManager
 * .principalToJSON(principal)` — a RAW JSON string, not base64, despite the
 * `_base64` field suffix (`deserializePrincipal` branches on `startsWith("{")`
 * before it tries the legacy base64/nsISerializable formats). `{"3":{}}` is the
 * system principal's JSON: the `"3"` discriminator is the system kind, and the
 * empty object stands for its (nonexistent) origin attributes.
 *
 * This is the principal a REAL updater entry carries: the module opens its tab
 * with `addTrustedTab`/`openTrustedTab`, i.e. with the system principal as the
 * triggering principal, and that is what SessionStore serializes back into the
 * entry. Verified against a dump a Firefox 159 profile wrote (`git show
 * 1bd1ca3^:test/e2e/fixtures/session-2win.jsonlz4`), whose chrome:// updater
 * entry stores exactly this value.
 */
export const SERIALIZED_SYSTEM_PRINCIPAL = '{"3":{}}';

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
 * @param {string} [opts.updaterPrincipal] the serialized principal the updater
 *   entry was saved with. Defaults to SERIALIZED_SYSTEM_PRINCIPAL — the value
 *   the module's own system-principal tab produces and the only thing that
 *   makes the restored chrome:// entry loadable. Pass `''` for a principal-less
 *   entry (the pre-fix fixture: a blocked moz-nullprincipal load).
 * @param {string[]} [opts.fillerUrls] ordinary tabs padding each window.
 *   Defaults to a single inert http(s) page, and it MUST stay http(s): these
 *   entries carry no saved principal (unlike the updater entry), so a restored
 *   `about:`/`chrome://` filler is loaded from `moz-nullprincipal` and BLOCKED
 *   — `Security Error: Content at moz-nullprincipal:{…} may not load or link to
 *   about:config` — which breaks the restore itself: the blocked tabs never
 *   finish, so SessionStore's per-restored-tab notice lands during teardown and
 *   the scenario's SS-NOTIFY assertion reads 0 (reproduced on ESR 140,
 *   2026-10-02, by "simplifying" these to about: pages). example.com is inert
 *   (static HTML, no scripts), unlike a real content site, so the restore does
 *   no third-party JS work.
 * @returns {object} JSON-ready session object
 */
export function buildSession({
  windows = 2,
  updaterInWindow = 1,
  updaterUrl,
  updaterPrincipal = SERIALIZED_SYSTEM_PRINCIPAL,
  fillerUrls = ['https://example.com/', 'https://example.com/?tab=2'],
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
      const entry = {url: updaterUrl, title: 'Firefox Scripts updater'};
      // Omit the key entirely when the caller asks for a principal-less entry:
      // an empty string deserializes to the same fallback, but leaving the key
      // out is what the pre-fix fixture actually looked like.
      if (updaterPrincipal) {
        entry.triggeringPrincipal_base64 = updaterPrincipal;
      }
      tabs.push({
        entries: [entry],
        index: 1,
        hidden: false,
        attributes: {},
        extData: {},
      });
    }
    for (let t = 0; t < 2; t++) {
      tabs.push({
        entries: [
          {
            url: fillerUrls[t % fillerUrls.length],
            title: `window ${w} tab ${t}`,
          },
        ],
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
  // The privileged entry must keep its saved system principal: without it
  // SessionStore's restore falls back to a null principal and the chrome://
  // tab is blocked instead of loaded (see SERIALIZED_SYSTEM_PRINCIPAL).
  if (
    json.windows[0].tabs[0].entries[0].triggeringPrincipal_base64 !== SERIALIZED_SYSTEM_PRINCIPAL
  ) {
    throw new Error('the updater entry lost its serialized principal');
  }
  console.log('sessionFile self-test OK:', buf.length, 'bytes container,', declared, 'bytes json');
}
