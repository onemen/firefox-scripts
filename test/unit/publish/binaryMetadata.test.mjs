// test/unit/publish/binaryMetadata.test.mjs — drift guard for the Windows PE
// metadata that the AV hardening rests on (docs/DEVELOPING.md → AV false
// positives): the .rc version resources are hand-written while the installer's
// build date is config/installer.conf's BUILD_DATE, and the self-update date
// compare (ADR 0019 amendment) reads the SAME string the binaries bake.  A bump
// of one without the other ships binaries whose version resource lies — both an
// AV-legitimacy smell and a self-update hazard — so pin them against each other
// here instead of trusting two files to stay in sync by hand.
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

/** The `VALUE "Name", "value\0"` pairs of a VERSIONINFO StringFileInfo block. */
function stringValues(rc) {
  const values = {};
  for (const m of rc.matchAll(/VALUE\s+"(\w+)",\s*"([^"]*)"/g)) {
    values[m[1]] = m[2].replace(/\\0$/, '');
  }
  return values;
}

/** `FILEVERSION a,b,c,d` as a number array. */
function fileVersionTuple(rc) {
  const m = rc.match(/FILEVERSION\s+(\d+),(\d+),(\d+),(\d+)/);
  assert.ok(m, 'expected a FILEVERSION line');
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

const BUILD_DATE = readText('config/installer.conf')
  .split('\n')
  .find(l => l.startsWith('BUILD_DATE='))
  ?.slice('BUILD_DATE='.length)
  .trim();

test('installer.conf BUILD_DATE is a real YYYY-MM-DD date', () => {
  assert.match(BUILD_DATE, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(!Number.isNaN(Date.parse(BUILD_DATE)), `${BUILD_DATE} is not a parseable date`);
});

for (const binary of BINARY_RESOURCES) {
  test(`${binary.name}: version resource matches installer.conf BUILD_DATE`, () => {
    const rc = readText(binary.rc);
    const values = stringValues(rc);
    assert.equal(values.FileVersion, BUILD_DATE);
    assert.equal(values.ProductVersion, BUILD_DATE);
    const [major, minor, year, monthDay] = fileVersionTuple(rc);
    assert.equal(`${major}.${minor}`, '1.0');
    const [y, m, d] = BUILD_DATE.split('-').map(Number);
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
