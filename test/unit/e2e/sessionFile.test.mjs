// test/unit/e2e/sessionFile.test.mjs — Unit tests for
// test/e2e/shared/sessionFile.mjs, the GENERATED sessionstore.jsonlz4 the
// session-restore scenario (11) seeds into the profile.
//
// Why this file exists: the fixture was originally a hand-authored
// Firefox-159 profile dump, and its 159-era tab fields (isAIWindow,
// splitViews, zIndex, …) wedged ESR 140's SessionStore at startup — the launch
// never completed, twice (esr-140 Windows, 2026-10-01). The generated payload
// replaced it, but until now only had a self-test when run as a script. These
// tests pin the contract that makes it work on every watched engine (the ESR
// 140 floor through Nightly): only long-stable session fields, inert filler
// pages, and a container the LZ4 decoder really accepts.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const {buildSession, lz4LiteralBlock, mozLz4, writeSessionFile, SERIALIZED_SYSTEM_PRINCIPAL} =
  await import(
    pathToFileURL(path.join(REPO_ROOT, 'test', 'e2e', 'shared', 'sessionFile.mjs')).href
  );

const MAGIC = Buffer.from('mozLz40\0', 'latin1');
const UPDATER_URL = 'chrome://firefox-scripts/content/ui/updater.html';

// ── Container: the mozLz4 wrapper + its single-literal LZ4 block ───────────

/**
 * Decode the one-literal-sequence LZ4 block lz4LiteralBlock() writes: token
 * high nibble = literal length (15 → 255-continued extension bytes), low nibble
 * = 0 (no match). Mirrors the decoder in Firefox's liblz4 caller.
 */
function decodeLiteralBlock(block) {
  let p = 0;
  const token = block[p++];
  assert.equal(token & 0x0f, 0, 'the block must carry no match sequence (low nibble 0)');
  let literalLength = token >> 4;
  if (literalLength === 15) {
    let extra;
    do {
      extra = block[p++];
      literalLength += extra;
    } while (extra === 255);
  }
  const literals = block.subarray(p, p + literalLength);
  assert.equal(literals.length, literalLength, 'the literal run must not be truncated');
  return literals;
}

/** Full container → payload JSON. */
function decodeMozLz4(buf) {
  assert.deepEqual(buf.subarray(0, 8), MAGIC, 'mozLz4 magic');
  const declared = buf.readUInt32LE(8);
  const literals = decodeLiteralBlock(buf.subarray(12));
  assert.equal(literals.length, declared, 'declared uncompressed size must match the run');
  return JSON.parse(literals.toString('utf8'));
}

test('lz4LiteralBlock: every length decodes byte-identically, incl. the extension run', () => {
  // The extension-byte run ALWAYS ends with its terminating byte — including
  // when the remainder is 0 (length = 15 + 255·k). Dropping that terminator
  // made the decoder read into the payload (the corrupt 14/269/524 cases found
  // by review), so the boundary lengths are pinned explicitly.
  const lengths = [0, 1, 14, 15, 16, 254, 255, 256, 269, 270, 271, 524, 525, 526, 1000];
  for (const n of lengths) {
    const input = Buffer.alloc(n, 0x61); // 'a' × n
    assert.deepEqual(
      decodeLiteralBlock(lz4LiteralBlock(input)),
      input,
      `length ${n} must round-trip`
    );
  }
});

test('mozLz4: the container declares the JSON length and decodes back', () => {
  const session = buildSession({
    windows: 2,
    updaterInWindow: 1,
    updaterUrl: UPDATER_URL,
  });
  const buf = mozLz4(session);
  assert.deepEqual(buf.subarray(0, 8), MAGIC);
  assert.ok(buf.readUInt32LE(8) > 0, 'declared size is written little-endian');
  assert.deepEqual(decodeMozLz4(buf), session);
  // A string payload (not just an object) goes down the same path.
  assert.equal(decodeMozLz4(mozLz4('{"a":1}')).a, 1);
});

test('mozLz4: emits pure UTF-8, so non-ASCII titles survive the container', () => {
  const session = buildSession({
    windows: 1,
    updaterUrl: UPDATER_URL,
    fillerUrls: ['about:config'],
  });
  session.windows[0].tabs[0].entries[0].title = 'Firefox Scripts — updater ✓';
  assert.deepEqual(decodeMozLz4(mozLz4(session)), session);
});

// ── Payload: the restore shape scenario 11 depends on ─────────────────────

test('buildSession: the updater tab sits in a NON-selected window, unselected there', () => {
  // The whole point of the fixture: the attach block must find the restored
  // updater tab in a window that is not the active one, and not the selected
  // tab of that window — the reported restore shape.
  const session = buildSession({
    windows: 2,
    updaterInWindow: 1,
    updaterUrl: UPDATER_URL,
  });
  assert.equal(session.windows.length, 2);
  assert.equal(session.selectedWindow, 2, 'the LAST window is the one selected at "shutdown"');
  const holder = session.windows[0];
  assert.equal(holder.tabs[0].entries[0].url, UPDATER_URL, 'window 1 holds the updater tab');
  assert.notEqual(holder.selected, 1, 'the updater tab must NOT be its window\u2019s selected tab');
  assert.ok(holder.selected >= 1 && holder.selected <= holder.tabs.length, 'selected is in range');
  for (const w of session.windows) {
    for (const tab of w.tabs) {
      assert.equal(tab.index, 1, 'every tab points its index at its single entry');
      assert.equal(tab.entries.length, 1);
      assert.ok(tab.entries[0].url, 'every entry carries a url');
    }
  }
});

test('buildSession: filler tabs stay plain http(s) and land on an inert page', () => {
  // Two constraints, both learned the hard way.
  // 1) http(s) ONLY. These entries carry no saved principal (only the updater
  //    entry does — see the principal test below), so a restored
  //    about:/chrome:// filler loads from moz-nullprincipal and is BLOCKED
  //    ("may not load or link to …"): the tabs never finish restoring, the
  //    per-restored-tab notice lands during teardown, and scenario 11's
  //    SS-NOTIFY assertion reads 0 (reproduced on ESR 140, 2026-10-02).
  // 2) An INERT target. With restore_on_demand=false every filler loads at
  //    startup; a real content site runs its own scripts mid-restore and fills
  //    the mirror with JS-timeout noise (mozilla.org's sentry bundle).
  const session = buildSession({
    windows: 2,
    updaterInWindow: 1,
    updaterUrl: UPDATER_URL,
  });
  const filler = session.windows
    .flatMap(w => w.tabs)
    .map(t => t.entries[0].url)
    .filter(url => url !== UPDATER_URL);
  assert.ok(filler.length > 0, 'the fixture must pad windows with filler tabs');
  for (const url of filler) {
    assert.match(url, /^https:\/\//, `${url} must stay http(s) — privileged schemes are blocked`);
    assert.doesNotMatch(url, /^(about|chrome):/, `${url} must not use a privileged scheme`);
    assert.ok(
      !/mozilla\.org/.test(url),
      `${url} must not be a real content site — its scripts run during restore`
    );
  }
});

test('buildSession: the updater entry carries the SYSTEM principal; fillers carry none', () => {
  // SessionStore's history restore deserializes the entry's
  // triggeringPrincipal_base64 with a NULL-principal fallback (ESR 140,
  // modules/sessionstore/SessionHistory.sys.mjs:556). A chrome:// entry restored
  // from moz-nullprincipal is BLOCKED ("Security Error: Content at
  // moz-nullprincipal:{…} may not load or link to chrome://…"), so the fixture
  // replayed a restore shape it could never actually load: the privileged tab
  // was always dead. {"3":{}} is what Firefox serializes for the system
  // principal the module's own addTrustedTab entry was saved with — verified
  // against a Firefox-159 dump.
  const session = buildSession({
    windows: 2,
    updaterInWindow: 1,
    updaterUrl: UPDATER_URL,
  });
  const updaterEntry = session.windows[0].tabs[0].entries[0];
  assert.equal(updaterEntry.triggeringPrincipal_base64, SERIALIZED_SYSTEM_PRINCIPAL);
  assert.equal(SERIALIZED_SYSTEM_PRINCIPAL, '{"3":{}}');
  // Raw JSON, NOT base64: deserializePrincipal() branches on startsWith("{")
  // and only the legacy formats go through atob(). A base64 blob here would be
  // decoded twice and fail back to the null principal — silently, because the
  // fixture would still "restore" (just into an unloadable tab).
  assert.match(
    updaterEntry.triggeringPrincipal_base64,
    /^\{/,
    'the serialized principal must be the raw JSON form'
  );
  assert.equal(Object.keys(JSON.parse(updaterEntry.triggeringPrincipal_base64))[0], '3');
  // The fillers stay principal-less on purpose: they must keep exercising the
  // null-principal fallback path, and http(s) loads fine from a null principal.
  const fillers = session.windows
    .flatMap(w => w.tabs)
    .map(t => t.entries[0])
    .filter(e => e.url !== UPDATER_URL);
  assert.ok(fillers.length > 0);
  for (const filler of fillers) {
    assert.ok(
      !('triggeringPrincipal_base64' in filler),
      `${filler.url} must not carry a saved principal`
    );
  }
  // updaterPrincipal: '' reproduces the pre-fix fixture (key absent, not empty).
  const bare = buildSession({updaterUrl: UPDATER_URL, updaterPrincipal: ''});
  assert.ok(!('triggeringPrincipal_base64' in bare.windows[0].tabs[0].entries[0]));
});

test('buildSession: only long-stable session fields (the cross-version contract)', () => {
  // The ESR 140 floor is the constraint: a field a newer engine writes and an
  // older one does not understand is what wedged the original 159 fixture.
  // Allowlist rather than denylist so a NEW field fails loudly with its path.
  const ALLOWED = {
    session: new Set(['version', 'windows', 'selectedWindow']),
    window: new Set(['tabs', 'selected', '_closedTabs']),
    tab: new Set(['entries', 'index', 'hidden', 'attributes', 'extData']),
    entry: new Set(['url', 'title', 'triggeringPrincipal_base64']),
  };
  const session = buildSession({
    windows: 2,
    updaterInWindow: 1,
    updaterUrl: UPDATER_URL,
  });
  const offenders = [];
  const walk = (obj, allowed, where) => {
    for (const key of Object.keys(obj)) {
      if (!allowed.has(key)) offenders.push(`${where}.${key}`);
    }
  };
  walk(session, ALLOWED.session, 'session');
  session.windows.forEach((w, i) => {
    walk(w, ALLOWED.window, `windows[${i}]`);
    w.tabs.forEach((tab, t) => {
      walk(tab, ALLOWED.tab, `windows[${i}].tabs[${t}]`);
      for (const entry of tab.entries) {
        walk(entry, ALLOWED.entry, `windows[${i}].tabs[${t}].entries[0]`);
      }
    });
  });
  assert.deepEqual(
    offenders,
    [],
    'the fixture must carry only fields every watched engine (ESR 140 → Nightly) parses'
  );
});

test('buildSession: rejects a missing updaterUrl and an out-of-range window', () => {
  assert.throws(() => buildSession({updaterUrl: ''}), /updaterUrl is required/);
  assert.throws(
    () => buildSession({windows: 1, updaterInWindow: 2, updaterUrl: UPDATER_URL}),
    /updaterInWindow exceeds the window count/
  );
});

// ── writeSessionFile ──────────────────────────────────────────────────────

test('writeSessionFile: writes the mozLz4 container the scenario seeds', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fxs-sessionfile-'));
  try {
    const session = buildSession({
      windows: 2,
      updaterInWindow: 1,
      updaterUrl: UPDATER_URL,
    });
    const file = writeSessionFile(dir, session);
    assert.equal(path.basename(file), 'sessionstore.jsonlz4');
    assert.deepEqual(decodeMozLz4(fs.readFileSync(file)), session);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
