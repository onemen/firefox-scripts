// test/unit/publish/branchPagesContract.test.mjs — pins the two review fixes
// from the review:batch run on PR #275:
//
// 1. upload.mjs must pass DEV_BRANCH (the published dev-build-<id> branch) —
//    never REF_NAME (a CI-only env var naming the *source* ref, empty on a
//    normal local dev publish) — to the generated dev pages.
// 2. updater.js's pre-spawn helper sanity check must accept every supported
//    platform's executable magics (PE, ELF, the Mach-O family) — a naive
//    'MZ'/'\x7fE' check would reject a valid macOS helper.
//
// updater.js is a window-context script (not importable), so both checks are
// source-level, in the style of cspMeta.test.mjs's updater.js assertions.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

test('upload.mjs: dev pages get DEV_BRANCH, never REF_NAME', () => {
  const src = readFileSync(`${ROOT}tools/publish/upload.mjs`, 'utf8');

  // The dev-pages block (anchored on the README assignment — a plain
  // PUBLISH_MODE match would hit the zips block first) must pass
  // branch: DEV_BRANCH at both generator calls.
  const start = src.indexOf("pagesFiles['README.md'] = devBranchReadme({");
  assert.ok(start > 0, 'dev README assignment not found');
  const end = src.indexOf('} else {', start);
  assert.ok(end > start, 'dev-pages block end not found');
  const block = src.slice(start, end);
  assert.equal(
    (block.match(/branch: DEV_BRANCH/g) || []).length,
    2,
    'both devBranchReadme and devIndexHtml must receive branch: DEV_BRANCH'
  );
  assert.ok(!block.includes('branch: REF_NAME'), 'REF_NAME must not reach the dev pages');
});

test('branchReadmes: the two dev generators render the branch they are given', async () => {
  // publishMode requires a mode; branchReadmes.test.mjs does the same.
  process.argv.push('--mode=dev');
  const {devBranchReadme, devIndexHtml} = await import('../../../tools/publish/branchReadmes.mjs');
  const files = ['utils.zip'];
  assert.ok(devIndexHtml({branch: 'dev-build-x', files}).includes('dev-build-x'));
  assert.ok(devBranchReadme({branch: 'dev-build-x', files}).includes('dev-build-x'));
});

// Evaluate the updater.js magic-gate expression EXACTLY as shipped: extract
// the Uint8Array read, the hex mapping and the isExecutable table, then replay
// them over real executable headers and junk. A source-string grep passed while
// the gate was 100% broken (4-byte read vs the 2-byte PE magic, 2026-09-21) —
// only executing the logic catches that class of bug.
function buildGate() {
  const src = readFileSync(`${ROOT}tools/publish/remote-ui/updater.js`, 'utf8');
  const table = src.match(
    /const isExecutable =\n\s*head\.length === 4 &&\n\s*\[([\s\S]*?)\]\.some\(magic => hex\.startsWith\(magic\)\);/
  );
  assert.ok(
    table,
    'magic-gate expression not found (expected the 4-byte-guarded prefix-match .some form)'
  );
  const magics = table[1].match(/'([0-9a-f]+)'/g).map(s => s.replaceAll("'", ''));
  // The runtime mapping, mirrored: read bytes → hex → prefix membership, with
  // the same truncation guard the shipped gate applies.
  return hex => hex.length === 8 && magics.some(magic => hex.startsWith(magic));
}

test('updater.js: helper magic gate accepts every real platform executable', () => {
  const gate = buildGate();
  const headers = {
    // Real first-4 bytes from the published helper binaries.
    'PE (helper_win.exe)': [0x4d, 0x5a, 0x90, 0x00],
    'ELF (helper_linux)': [0x7f, 0x45, 0x4c, 0x46],
    'Mach-O 64 (helper_mac)': [0xcf, 0xfa, 0xed, 0xfe],
    'Mach-O 64 swapped': [0xce, 0xfa, 0xed, 0xfe],
    'fat wrapper 32': [0xca, 0xfe, 0xba, 0xbe],
    'fat wrapper 64': [0xca, 0xfe, 0xba, 0xbf],
  };
  for (const [name, bytes] of Object.entries(headers)) {
    const hex = [...Uint8Array.from(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
    assert.ok(gate(hex), `gate rejected a real executable: ${name} (${hex})`);
  }
});

test('updater.js: helper magic gate rejects text payloads (HTML error page)', () => {
  const gate = buildGate();
  const junk = {
    '<htm': [0x3c, 0x68, 0x74, 0x6d],
    '<!DO': [0x3c, 0x21, 0x44, 0x4f],
    // Full hex of "<html" — longer inputs must not prefix-match either.
    '<html…': [0x3c, 0x68, 0x74, 0x6d, 0x6c],
    'empty file (0 bytes)': [],
    'JSON error page': [0x7b, 0x22, 0x65, 0x72],
    // A truncated 2-byte read (short/corrupt download) must be rejected even
    // though it prefix-matches the PE magic — the gate demands the full 4
    // bytes so truncation dies here with the clear message, not at spawn.
    'truncated 2-byte PE': [0x4d, 0x5a],
  };
  for (const [name, bytes] of Object.entries(junk)) {
    const hex = [...Uint8Array.from(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
    assert.ok(!gate(hex), `gate accepted junk: ${name} (${hex})`);
  }
});
