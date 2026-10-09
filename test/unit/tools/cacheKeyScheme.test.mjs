// test/unit/tools/cacheKeyScheme.test.mjs — the cache-key contract (ADR 0045).
//
// One key shape everywhere: `<name>-<type>-<os>-<hash>-<layout>`. The name is the
// browser, taken from its downloads.mjs registry entry; no leg chooses a
// namespace any more. Before this, the prefix was a namespace the job picked
// (`firefox-dl`, `esr-portable`, `browser-dl`, `core-smoke-<browser>`,
// `snap-firefox`), so one family held four browsers — measured 2026-10-09, the
// prune then kept one of them and re-downloaded the other three nightly (~1.2
// GB/night across the three OSes) — and the same waterfox installer was cached
// twice under two prefixes.
//
// The two halves below are the whole contract: the key shape (and its sources of
// truth), and the restore prefixes that make a browser-scoped cache-first path
// possible. Comments are stripped before matching so prose can never satisfy a
// check.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {cacheKey, cacheName} from '../../../test/e2e/shared/downloads.mjs';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const ACTION = '.github/actions/setup-browser/action.yml';
const WORKFLOWS = ['.github/workflows/e2e.yml', '.github/workflows/core-smoke-nightly.yml'];

/** Read a tracked text file with LF normalized (a local copy can linger CRLF). */
function read(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');
}

/** Drop whole-line YAML/shell comments. */
function stripComments(text) {
  return text
    .split('\n')
    .filter(line => !/^[ \t]*#/.test(line))
    .join('\n');
}

const action = stripComments(read(ACTION));

test('cacheKey: five fields, lowercase os, one browser per name', () => {
  assert.equal(
    cacheKey({
      browser: 'firefox',
      type: 'dl',
      os: 'Windows',
      hash: '1adb2936297da1fe',
      layout: 'plain',
    }),
    'firefox-dl-windows-1adb2936297da1fe-plain'
  );
  assert.equal(
    cacheKey({
      browser: 'firefox',
      type: 'portable',
      os: 'macOS',
      hash: '7d497ffee63f5925',
      layout: 'dir',
    }),
    'firefox-portable-macos-7d497ffee63f5925-dir'
  );
  // A sticky fork leg keys on the version; snap is its own os token.
  assert.equal(
    cacheKey({
      browser: 'zen',
      type: 'dl',
      os: 'windows',
      hash: 'v1.23.1b',
      layout: 'plain',
    }),
    'zen-dl-windows-v1.23.1b-plain'
  );
  assert.equal(
    cacheKey({
      browser: 'firefox-snap',
      type: 'dl',
      os: 'snap',
      hash: '9036',
      layout: 'plain',
    }),
    'firefox-dl-snap-9036-plain'
  );
  // The four browsers that used to share `firefox-dl-<os>` now have four names,
  // and waterfox's two namespaces are one.
  const names = ['firefox', 'firefox-dev', 'nightly', 'waterfox', 'librewolf', 'floorp', 'zen'].map(
    b => cacheName(b, '')
  );
  assert.equal(new Set(names).size, names.length);
});

test('cacheName: the ESR name is positional, and falls back intact', () => {
  // The matrix hands the leg its name (watchdog-report.mjs owns the order).
  assert.equal(cacheName('firefox-esr-153', 'esr'), 'esr');
  assert.equal(cacheName('firefox-esr-140', 'esr-prev'), 'esr-prev');
  // No window to hand (a local run): the generic serving key is the esr line by
  // definition, and a concrete major names itself.
  assert.equal(cacheName('firefox-esr', ''), 'esr');
  assert.equal(cacheName('firefox-esr-153', ''), 'esr-153');
});

test('setup-browser builds every key from the registry name', () => {
  assert.ok(
    action.includes('--cache-name'),
    'the composite must take the name from downloads.mjs, not from an input'
  );
  assert.ok(action.includes('$NAME-dl-$OS-$HASH-plain'), 'URL-keyed installer key');
  assert.ok(action.includes('$NAME-portable-$OS-$HASH-dir'), 'URL-keyed extracted-dir key');
  assert.ok(action.includes('$NAME-dl-$OS-v$VER-plain'), 'sticky fork installer key');
  assert.ok(action.includes('$NAME-portable-$OS-v$VER-dir'), 'sticky fork dir key');
  // No key may carry a namespace picked by the leg: the input is gone.
  assert.ok(!action.includes('cache-key-prefix'));
  for (const workflow of WORKFLOWS) {
    assert.ok(
      !stripComments(read(workflow)).includes('cache-key-prefix'),
      `${workflow} must not pass a cache namespace`
    );
  }
});

test('the fork restore prefix is browser-scoped, never the bare name', () => {
  // A short prefix would let one browser restore another's payload; the
  // `<name>-<type>-<os>-` prefix keeps the cache-first path offline AND local.
  assert.ok(
    action.includes('restore-keys: ${{ steps.mode.outputs.name }}-dl-${{ steps.mode.outputs.os }}-')
  );
  assert.ok(
    action.includes(
      'restore-keys: ${{ steps.mode.outputs.name }}-portable-${{ steps.mode.outputs.os }}-'
    )
  );
});

test('the snap and ESR legs use the same shape as everything else', () => {
  const e2e = stripComments(read(WORKFLOWS[0]));
  assert.ok(
    e2e.includes("key: firefox-dl-snap-${{ steps.rev.outputs.revision || 'store-down' }}-plain")
  );
  assert.ok(e2e.includes('restore-keys: firefox-dl-snap-'));
  assert.ok(
    e2e.includes(
      'BROWSER_CACHE_NAME: ${{ fromJSON(needs.esr-matrix.outputs.cacheNames)[matrix.browser] }}'
    ),
    'the ESR leg looks its positional name up by the browser it installs'
  );
});

test('the ESR matrix job publishes the name map its legs look up', () => {
  const e2e = stripComments(read(WORKFLOWS[0]));
  // The name travels BESIDE the matrix, never inside it: the dimension is
  // `matrix.browser`, so an object element there makes the leg's browser a
  // mapping and the job fails to dispatch before any step runs (2026-10-09 —
  // CI caught it, no unit test did). The lookup above is only wired if the map
  // exists under exactly the output name the leg reads.
  assert.ok(
    e2e.includes('cacheNames: ${{ steps.names.outputs.names }}'),
    'esr-matrix must publish the cache-name map'
  );
  assert.ok(
    e2e.includes('tools/ci/esrMatrix.mjs .watchdog/baseline.json --names'),
    'the map comes from the same builder as the matrix'
  );
  assert.ok(
    !e2e.includes('matrix.cacheName'),
    'no leg may read a field the matrix dimension does not carry'
  );
});
