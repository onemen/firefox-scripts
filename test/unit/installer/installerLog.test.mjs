// test/unit/installer/installerLog.test.mjs — contract for the installer's
// Windows temp log.
//
// installer_log() (installer/src/platform.h) appends diagnostics to
// %TEMP%\installer_win.log. Nothing ever pruned it, so the copy in the user's
// temp dir grew for as long as the machine kept the file (Windows only prunes
// temp files after ~30 days). It now rotates once past
// INSTALLER_LOG_MAX_BYTES, keeping one previous generation.
//
// Why a source contract and not a behaviour test: installer_log() is a
// `static inline` in a Windows-only header, and the behavioural suites in
// installer/test/ need a built installer binary — which `pnpm test` (this dir
// included) must never require. A behavioural check belongs next to those
// binary-in-the-loop suites; what is pinned here is that the rotation exists at
// all, with the pieces it needs, so a well-meaning "simplify this header"
// cannot silently restore unbounded growth.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';

const PLATFORM_H = fileURLToPath(new URL('../../../installer/src/platform.h', import.meta.url));

const source = fs.readFileSync(PLATFORM_H, 'utf-8').replace(/\r\n/g, '\n');
const body = source.slice(source.indexOf('static inline FILE *installer_log(void)'));

test('the log rotation cap is declared and modest', () => {
  const max = source.match(/#define INSTALLER_LOG_MAX_BYTES \((\d+) \* (\d+)\)/);
  assert.ok(max, 'INSTALLER_LOG_MAX_BYTES must be declared');
  assert.equal(Number(max[1]) * Number(max[2]), 256 * 1024);
});

test('installer_log rotates an oversized log before appending to it', () => {
  assert.match(body, /installer_log_size\(path\) > INSTALLER_LOG_MAX_BYTES/, 'size check');
  assert.match(body, /DeleteFileA\(rotated\)/, 'one generation only');
  assert.match(body, /MoveFileA\(path, rotated\)/, 'the old log becomes .1');
  // The fresh log is opened AFTER the rotation, or the append would recreate
  // the file the move just renamed away.
  assert.ok(
    body.indexOf('MoveFileA') < body.indexOf('fopen(path, "a")'),
    'rotate first, then open for append'
  );
});
