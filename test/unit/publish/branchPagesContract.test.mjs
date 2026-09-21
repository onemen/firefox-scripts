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

test('updater.js: helper magic gate accepts every supported platform executable', () => {
  const src = readFileSync(`${ROOT}tools/publish/remote-ui/updater.js`, 'utf8');

  const gate = src.match(/const isExecutable = \[[\s\S]*?\]\.includes\(hex\);/);
  assert.ok(gate, 'magic-gate block not found');

  // Every magic the publish side accepts (tools/publish/platforms.mjs) must be
  // accepted here: PE, ELF, Mach-O 64 (both endiannesses), fat/universal.
  for (const magic of ['4d5a', '7f454c46', 'cffaedfe', 'cefaedfe', 'cafebabe', 'cafebabf']) {
    assert.ok(gate[0].includes(`'${magic}'`), `magic gate is missing '${magic}'`);
  }
  // And the read must cover 4 bytes (all Mach-O magics are 4 bytes).
  assert.match(src, /IOUtils\.read\(helperPath, \{maxBytes: 4\}\)/, 'must read 4 bytes');
});

test('updater.js: helper magic gate rejects text payloads (HTML error page)', () => {
  const src = readFileSync(`${ROOT}tools/publish/remote-ui/updater.js`, 'utf8');
  const gate = src.match(/const isExecutable = \[[\s\S]*?\]\.includes\(hex\);/);
  assert.ok(gate, 'magic-gate block not found');

  // '3c68746d' = "<htm", '3c21444f' = "<!DO" — no accepted magic starts with
  // these, so the gate's shape (exact 4-byte hex membership) rejects them.
  const accepted = gate[0].match(/'([0-9a-f]{2,8})'/g).map(s => s.replaceAll("'", ''));
  for (const html of ['3c68746d', '3c21444f', '3c68746d6c']) {
    assert.ok(!accepted.includes(html), `HTML prefix ${html} must not be accepted`);
  }
  assert.ok(
    !accepted.some(m => m.length !== 2 && m.length !== 4 && m.length !== 8),
    'magics are 2 or 4 bytes'
  );
});
