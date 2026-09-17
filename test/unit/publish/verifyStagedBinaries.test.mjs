// test/unit/publish/verifyStagedBinaries.test.mjs — unit tests for the staged
// artifact magic-byte check (tools/publish/platforms.mjs).
//
// Issue #233: Defender real-time protection on a local Windows host
// intermittently leaves a truncated or empty artifact behind a link that
// reported success — a later pass would then hash and publish the partial
// bytes. verifyStagedBinaries is the fail-fast guard: every staged binary must
// start with its platform's executable magic.

import {test} from 'node:test';
import assert from 'node:assert/strict';

const {verifyStagedBinaries} = await import('../../../tools/publish/platforms.mjs');

const buf = (...bytes) => Buffer.from(bytes);

test('accepts valid magics for every platform', () => {
  const files = {
    'installer_win.exe': 'win',
    'installer_linux': 'linux',
    'installer_linux_aarch64': 'aarch64',
    'installer_mac': 'mac',
  };
  const access = name => {
    switch (files[name]) {
      case 'win':
        return buf(0x4d, 0x5a, 0x90, 0x00); // MZ + DOS header bytes
      case 'linux':
      case 'aarch64':
        return buf(0x7f, 0x45, 0x4c, 0x46, 0x02); // ELF
      case 'mac':
        return buf(0xcf, 0xfa, 0xed, 0xfe, 0x00); // MH_MAGIC_64
      default:
        return null;
    }
  };
  assert.deepEqual(verifyStagedBinaries(files, access), []);
});

test('accepts all Mach-O header magics for mac (cctools loader.h + fat.h)', () => {
  const variants = [
    [0xcf, 0xfa, 0xed, 0xfe], // MH_MAGIC_64 (x86_64/arm64 file bytes)
    [0xce, 0xfa, 0xed, 0xfe], // MH_MAGIC / MH_CIGAM (32-bit arch)
    [0xca, 0xfe, 0xba, 0xbe], // FAT_MAGIC / FAT_CIGAM (universal wrapper)
    [0xca, 0xfe, 0xba, 0xbf], // FAT_MAGIC_64 / FAT_CIGAM_64
  ];
  for (const magic of variants) {
    const bad = verifyStagedBinaries({installer_mac: 'mac'}, () => buf(...magic, 0x00));
    assert.deepEqual(bad, [], `variant ${magic.map(b => b.toString(16)).join(' ')} must pass`);
  }
});

test('rejects truncated artifacts (the #233 failure mode: first bytes 00 00)', () => {
  const bad = verifyStagedBinaries({'installer_win.exe': 'win'}, () => buf(0x00, 0x00, 0x01, 0x02));
  assert.deepEqual(bad, ['installer_win.exe']);
});

test('rejects empty and missing (null) artifacts', () => {
  const empty = verifyStagedBinaries({'installer_win.exe': 'win'}, () => Buffer.alloc(0));
  assert.deepEqual(empty, ['installer_win.exe']);
  const gone = verifyStagedBinaries({'helper_win.exe': 'win'}, () => null);
  assert.deepEqual(gone, ['helper_win.exe']);
});

test('rejects a right-length file with the wrong magic (mixed-up binaries)', () => {
  // A Mach-O magic in a file staged as the Windows installer must fail.
  const bad = verifyStagedBinaries({'installer_win.exe': 'win'}, () => buf(0xcf, 0xfa, 0xed, 0xfe));
  assert.deepEqual(bad, ['installer_win.exe']);
});

test('checks every staged file and reports all bad names together', () => {
  const access = name => (name === 'installer_linux' ? buf(0x7f, 0x45, 0x4c, 0x46) : null);
  // helper_mac null -> bad; installer_win.exe null -> bad too (null reads are
  // uniform); keep one honest case per call:
  assert.deepEqual(verifyStagedBinaries({installer_linux: 'linux'}, access), []);
  const both = verifyStagedBinaries({'installer_win.exe': 'win', 'helper_mac': 'mac'}, () => null);
  assert.deepEqual(both.sort(), ['helper_mac', 'installer_win.exe']);
});

test('shorter-than-magic buffers are rejected (no partial-prefix pass)', () => {
  const bad = verifyStagedBinaries(
    {installer_linux: 'linux'},
    () => buf(0x7f, 0x45) // ELF cut off after 2 bytes
  );
  assert.deepEqual(bad, ['installer_linux']);
});
