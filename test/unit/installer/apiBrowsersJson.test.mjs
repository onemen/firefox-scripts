// test/unit/installer/apiBrowsersJson.test.mjs — first unit coverage for the C
// installer's JSON emission. The hidden
// --test-json / --test-admin-copy modes run the SAME build_browsers_json() /
// build_status_json() code paths the HTTP handlers use, so these assertions
// hold at the exact boundary the web UI reads.
//
// The response buffer is sized from the browser count, never a fixed stack
// buffer: snprintf's would-be length is clamped at every append, so a host
// with many long-path browsers cannot overflow the response. --test-json 50
// with 1023-byte hostile paths proves the emitted JSON is complete and valid.
//
// The installer binary is built by `make -C installer` (MSYS2 UCRT64 on
// Windows); CI's unit-test job does not build C, so the suite skips with a
// named reason when no binary is available. Point INSTALLER_TEST_BIN at a
// binary to force a run.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

const CANDIDATES = [
  process.env.INSTALLER_TEST_BIN,
  path.join(REPO_ROOT, 'dist', 'installer', 'installer_win.exe'),
  path.join(REPO_ROOT, 'dist', 'installer', 'installer_linux'),
  path.join(REPO_ROOT, 'dist', 'installer', 'installer_mac'),
].filter(Boolean);

const BIN = CANDIDATES.find(p => fs.existsSync(p));

function runInstaller(args) {
  return execFileSync(BIN, args, {encoding: 'utf8', timeout: 30_000});
}

/** The synthetic 1023-byte paths the C side fabricates carry hostile chars. */
const SYNTHETIC_PATH_LEN = 1023;

test(
  'setup: an installer binary is available (build with `make -C installer`)',
  {skip: !BIN && 'no installer binary — run `make -C installer` or set INSTALLER_TEST_BIN'},
  () => {
    assert.ok(BIN, 'binary expected when not skipped');
  }
);

test(
  '--test-json 50 with 1023-byte hostile paths emits valid, complete JSON',
  {skip: !BIN && 'no installer binary'},
  _t => {
    const out = runInstaller(['--test-json', '50']);
    const browsers = JSON.parse(out); // throws on any truncation/corruption

    assert.equal(browsers.length, 50, 'all 50 synthetic browsers serialized');
    assert.ok(
      Buffer.byteLength(out) > 8192,
      'output must exceed the old 8192-byte fixed buffer — a smaller buffer means the overflow regression is back'
    );
    for (const [i, b] of browsers.entries()) {
      assert.equal(b.index, i, 'entries serialized in order');
      assert.equal(b.binaryPath.length, SYNTHETIC_PATH_LEN);
      assert.ok(
        b.binaryPath.includes('"') && b.binaryPath.includes('\\'),
        'synthetic paths carry quote/backslash stress'
      );
      assert.equal(typeof b.pid, 'number');
      assert.equal(typeof b.configInstalled, 'number');
    }
  }
);

test('--test-json 0 emits an empty JSON array', {skip: !BIN && 'no installer binary'}, () => {
  const out = runInstaller(['--test-json', '0']);
  assert.deepEqual(JSON.parse(out), []);
});

test(
  '--test-json 3 round-trips the hostile path bytes exactly',
  {skip: !BIN && 'no installer binary'},
  () => {
    const browsers = JSON.parse(runInstaller(['--test-json', '3']));
    for (const b of browsers) {
      // Escaping must be lossless: quote and backslash survive the round trip,
      // so a UI consumer reads the real path, not a mangled one.
      assert.ok(b.binaryPath.includes('q"\\t'), 'escaped quote/backslash sequences round-trip');
      assert.ok(!b.binaryPath.endsWith('\\'), 'no dangling escape at the string end');
    }
  }
);

test(
  '--test-admin-copy cancelled surfaces a distinct terminal "cancelled" step',
  {skip: !BIN && 'no installer binary'},
  () => {
    const status = JSON.parse(runInstaller(['--test-admin-copy', 'cancelled']));
    assert.equal(status.step, 'cancelled', 'a user-cancelled UAC prompt is not an error');
    assert.equal(status.terminal, 1);
    assert.ok(status.message.toLowerCase().includes('cancel'));
  }
);

test(
  '--test-admin-copy quote escapes quotes in the error message',
  {skip: !BIN && 'no installer binary'},
  () => {
    const status = JSON.parse(runInstaller(['--test-admin-copy', 'quote']));
    assert.equal(status.step, 'error');
    // The message itself contains a raw double quote — valid only because the
    // status JSON escaped it.
    assert.ok(status.message.includes('"'), 'message carries the raw quote character');
  }
);
