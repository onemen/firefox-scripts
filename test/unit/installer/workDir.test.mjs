// test/unit/installer/workDir.test.mjs — contract for the installer's temp
// scratch root.
//
// handle_api_install() (installer/src/main.c) staged the uploaded package zips
// and the extracted config tree in %TEMP%\firefox-scripts-install — a fixed,
// machine-global name with no fxs- prefix.  Every run therefore left an empty
// directory behind that nothing could reclaim, and a run killed between
// save_buf_to_file() and remove() left the zip itself there with no reaper in
// reach (the age prune and the hygiene gate both match on the fxs- prefixes).
//
// Why a source contract and not a behaviour test: the install path needs a
// built installer binary plus a real browser install, which `pnpm test` must
// never require (same reasoning as installerLog.test.mjs).  What is pinned
// here is the naming contract itself, so a well-meaning "simplify this path"
// cannot silently restore a fixed name that no reaper can see.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';

const MAIN_C = fileURLToPath(new URL('../../../installer/src/main.c', import.meta.url));
const HELPERS = fileURLToPath(new URL('../../e2e/shared/helpers.mjs', import.meta.url));

const source = fs.readFileSync(MAIN_C, 'utf-8').replace(/\r\n/g, '\n');
const helpers = fs.readFileSync(HELPERS, 'utf-8').replace(/\r\n/g, '\n');

test('the work dir carries the fxs- prefix and the installer pid', () => {
  assert.match(
    source,
    /snprintf\(g_work_dir,[^;]*"%s%cfxs-installer-%ld"/,
    'g_work_dir must be built as %s%cfxs-installer-<pid>'
  );
  // Both platforms need a pid source, or the name is not per-process at all.
  assert.match(source, /_getpid\(\)/, 'Windows pid');
  assert.match(source, /\(long\)getpid\(\)/, 'POSIX pid');
});

test('the fixed firefox-scripts-install name is gone', () => {
  assert.ok(
    !source.includes('firefox-scripts-install'),
    'the un-prefixed fixed name would be invisible to the prune and the gate'
  );
});

test('the harness prune is registered for the installer prefix', () => {
  const list = helpers.match(/export const E2E_TEMP_PREFIXES = \[([^\]]*)\]/);
  assert.ok(list, 'E2E_TEMP_PREFIXES must be declared');
  const prefixes = [...list[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
  assert.ok(
    prefixes.includes('fxs-installer'),
    `E2E_TEMP_PREFIXES must list fxs-installer, got ${JSON.stringify(prefixes)}`
  );
});
