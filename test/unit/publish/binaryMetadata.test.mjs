// test/unit/publish/binaryMetadata.test.mjs — drift guard for the Windows PE
// metadata that the AV hardening rests on (docs/DEVELOPING.md → AV false
// positives).  Since issue #322 the build dates are DERIVED from git per binary
// (tools/publish/generateBuildDates.mjs → installer/src/_builddate.h); the .rc
// resources consume the generated macros.  The remaining drift risk is the
// FILEVERSION tuple and the macro wiring itself, so this test regenerates the
// header and pins both .rc files against the derived dates.
//
// Also pins the "every exe declares a manifest" invariant: an unmanifested
// unsigned exe is the profile Windows applies installer-detection and UAC
// virtualization heuristics to (see helper.manifest / installer.manifest).

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Read a repo file with LF normalization (a Windows checkout can be CRLF). */
function readText(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf-8').replace(/\r\n/g, '\n');
}

/**
 * The `VALUE "Name", "value\0"` pairs of a VERSIONINFO StringFileInfo block.
 * Since #322 the value side may be a generated macro (CFG_BUILD_DATE_*_STR);
 * expand the _builddate.h macros before parsing so the derived dates are what
 * gets asserted, exactly as windres would compile them.
 */
function stringValues(rc) {
  const macros = {};
  for (const m of readText('installer/src/_builddate.h').matchAll(
    /^#define (CFG_BUILD_DATE_\w+_STR) "(.*)"$/gm
  )) {
    macros[m[1]] = m[2];
  }
  const values = {};
  for (const m of rc.matchAll(/VALUE\s+"(\w+)",\s*(?:"([^"]*)"|(\w+))/g)) {
    // Quoted literal, or a bare generated-macro reference (CFG_BUILD_DATE_*_STR).
    const raw = (m[2] ?? macros[m[3]] ?? m[3] ?? '').replace(/\\0$/, '');
    values[m[1]] = raw;
  }
  return values;
}

/**
 * `FILEVERSION a,b,c,d` as a number array. Since #322 the tuple may be a
 * generated macro (CFG_BUILD_DATE_*_V = 1,0,<YYYY>,<MMDD>) — expand the numeric
 * macros from _builddate.h first, exactly as windres would.
 */
function fileVersionTuple(rc) {
  const macros = {};
  for (const m of readText('installer/src/_builddate.h').matchAll(
    /^#define (CFG_BUILD_DATE_\w+_V) ([\d,]+)$/gm
  )) {
    macros[m[1]] = m[2];
  }
  const line = rc.match(/FILEVERSION\s+(\S+)/);
  assert.ok(line, 'expected a FILEVERSION line');
  const tuple = macros[line[1]] ?? line[1];
  const m = tuple.match(/^(\d+),(\d+),(\d+),(\d+)$/);
  assert.ok(m, `FILEVERSION tuple must be numeric, got '${tuple}'`);
  return m.slice(1, 5).map(Number);
}

const BINARY_RESOURCES = [
  {
    name: 'installer_win.exe',
    rc: 'installer/src/installer.rc',
    manifest: 'installer/src/installer.manifest',
  },
  {
    name: 'helper_win.exe',
    rc: 'installer/src/helper/version.rc',
    manifest: 'installer/src/helper/helper.manifest',
  },
];

const {buildDateHeader, buildDates} = await import('../../../tools/publish/generateBuildDates.mjs');
const DATES = buildDates();

test('derived build dates are real YYYY-MM-DD dates (regenerated header matches)', () => {
  for (const [k, v] of Object.entries(DATES)) {
    assert.match(v, /^\d{4}-\d{2}-\d{2}$/, `${k} date`);
    assert.ok(!Number.isNaN(Date.parse(v)), `${k}=${v} is not a parseable date`);
  }
  // The generated header is what the .rc files include — regenerate it and
  // require it to match the freshly derived dates (no stale header on disk).
  assert.equal(readText('installer/src/_builddate.h'), buildDateHeader(DATES));
});

const BINARY_DATES = {installer_win: DATES.installer, helper_win: DATES.helper};

for (const binary of BINARY_RESOURCES) {
  const short = BINARY_DATES[binary.name.replace(/\.exe$/, '')];
  test(`${binary.name}: version resource matches its derived git build date`, () => {
    const rc = readText(binary.rc);
    const values = stringValues(rc);
    assert.equal(values.FileVersion, short);
    assert.equal(values.ProductVersion, short);
    const [major, minor, year, monthDay] = fileVersionTuple(rc);
    assert.equal(`${major}.${minor}`, '1.0');
    const [y, m, d] = short.split('-').map(Number);
    assert.equal(year, y);
    // The numeric tuple has no room for zero-padded fields: MMDD is a number.
    assert.equal(monthDay, m * 100 + d);
  });

  test(`${binary.name}: AV-legitimacy metadata fields are populated`, () => {
    // The ML false-positive profile this guards: a stripped PE whose metadata
    // fields are blank (docs/DEVELOPING.md → AV false positives).
    const values = stringValues(readText(binary.rc));
    for (const field of ['CompanyName', 'FileDescription', 'FileVersion', 'ProductName']) {
      assert.ok(values[field], `${field} must be populated in ${binary.rc}`);
    }
  });

  test(`${binary.name}: declares its application manifest`, () => {
    const rc = readText(binary.rc);
    assert.match(rc, /^1 RT_MANIFEST "[\w.-]+"$/m, `${binary.rc} must embed a manifest`);
    assert.ok(fs.existsSync(path.join(ROOT, binary.manifest)), `${binary.manifest} must exist`);
  });
}
