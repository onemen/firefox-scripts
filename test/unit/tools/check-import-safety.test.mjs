// test/unit/tools/check-import-safety.test.mjs — check tools must be import-safe.
//
// Convention: every tools/check-*.mjs guards its main behind the argv check
// (`process.argv[1]` matching its own module URL), so importing it — as unit
// tests do — runs nothing: no scans, no network, no process.exit. Two new
// tools broke this before their own suites caught it, so this test pins it
// for the whole family: each non-exempt check tool is imported in a child
// process that must exit 0. Mains-by-design that are never imported belong in
// EXEMPT with a reason.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const TOOLS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../tools');

const EXEMPT = new Map([
  [
    'check-published-av.mjs',
    'scheduled watchdog main: top-level network scan by design, never imported',
  ],
]);

test('check tools import without side effects', () => {
  const tools = fs
    .readdirSync(TOOLS_DIR)
    .filter(f => f.startsWith('check-') && f.endsWith('.mjs') && !EXEMPT.has(f))
    .map(f => pathToFileURL(path.join(TOOLS_DIR, f)).href)
    .sort();
  assert.ok(tools.length > 0, 'expected check tools to exist');
  const prog = [
    'let failed = 0;',
    `for (const t of ${JSON.stringify(tools)}) {`,
    '  try { await import(t); }',
    "  catch (err) { console.error('IMPORT-FAIL ' + t + ': ' + (err && err.message)); failed = 1; }",
    '}',
    'process.exit(failed);',
  ].join('\n');
  try {
    execFileSync(process.execPath, ['--input-type=module', '-e', prog], {
      encoding: 'utf8',
      timeout: 120000,
      cwd: path.resolve(TOOLS_DIR, '..'),
    });
  } catch (err) {
    assert.fail(
      `check tool import failed (exit ${err.status}):\n${err.stdout || ''}${err.stderr || ''}\n` +
        'Every tools/check-*.mjs must guard its main behind the argv check; ' +
        'mains-by-design belong in EXEMPT with a reason.'
    );
  }
});
