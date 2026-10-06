// test/unit/tools/pruneCaches.test.mjs — the cache prune's family grouping.
//
// GitHub's "10 versions per key" only rotates when the key itself rotates. The
// setup-browser keys embed the content they cache, so every vendor bump and
// every extracted-dir save produces a key GitHub has never seen before: a
// content-hash stem leaves those entries ungrouped, `--keep N` counts them
// one-per-family, and nothing is ever pruned. Measured 2026-10-05 against the
// live repo: 10.7 GB against a 10 GB cap, ~2.6 GB of it in portable-dir
// entries spanning four releases, none of them grouped by the old stem.
//
// Every key below is a real key observed in onemen/firefox-scripts' cache list
// (2026-10-05), so a regression here is visible against production shapes —
// including the legacy unhashed `firefox-portable-<os>` entries that must land
// in the same family as their hashed successors.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const pruneUrl = pathToFileURL(path.join(REPO_ROOT, 'tools', 'ci', 'prune-caches.mjs')).href;

const {stem} = await import(pruneUrl);

/** The families every observed key must collapse into. */
const EXPECTED = [
  // Hard gates: installer + extracted dir, one family per prefix/OS.
  ['firefox-dl-Windows-ca6cc4d5e2db5f9a', 'firefox-dl-Windows'],
  ['firefox-dl-Windows-1b2c3d4e5f607182', 'firefox-dl-Windows'],
  ['firefox-dl-Linux-1adb2936297da1fe', 'firefox-dl-Linux'],
  ['firefox-dl-macOS-7d497ffee63f5925', 'firefox-dl-macOS'],

  // Portable legs: the extracted dir carries `-x` and must group with its
  // installer, so a vendor bump retires both together.
  ['firefox-portable-Windows-ca6cc4d5e2db5f9a', 'firefox-portable-Windows'],
  ['firefox-portable-Windows-ca6cc4d5e2db5f9a-x', 'firefox-portable-Windows'],
  ['firefox-portable-macOS-7d497ffee63f5925-x', 'firefox-portable-macOS'],
  ['firefox-portable-Linux-1adb2936297da1fe-x', 'firefox-portable-Linux'],
  // Legacy unhashed entries (saved before the composite keyed on the URL).
  ['firefox-portable-Windows', 'firefox-portable-Windows'],
  ['firefox-portable-macOS', 'firefox-portable-macOS'],

  // Fork sticky namespace: installer, portable installer and extracted dir all
  // rotate per validated release.
  ['browser-dl-Windows-zen-v1.23b', 'browser-dl-Windows-zen'],
  ['browser-dl-Windows-zen-portable-v1.23b', 'browser-dl-Windows-zen-portable'],
  ['browser-dl-Windows-zen-portable-dir-v1.23b', 'browser-dl-Windows-zen-portable'],
  ['browser-dl-Windows-floorp-portable-dir', 'browser-dl-Windows-floorp-portable'],
  ['browser-dl-Windows-librewolf-v157.0', 'browser-dl-Windows-librewolf'],

  // ESR legs: same URL-keyed shape, own prefix.
  ['esr-portable-Windows-8769a05370997233', 'esr-portable-Windows'],
  ['esr-portable-Windows-8769a05370997233-x', 'esr-portable-Windows'],

  // Rotating numeric suffixes: snap revision, run id, baseline date.
  ['snap-firefox-8995', 'snap-firefox'],
  ['snap-firefox-9012', 'snap-firefox'],
  ['browser-validated-37359307092', 'browser-validated'],
  ['browser-fork-validated-37359307092', 'browser-fork-validated'],
  ['url-watchdog-baseline-2026-10-05', 'url-watchdog-baseline'],

  // Toolchain caches: a trailing content hash, not a family of their own.
  [
    'node-cache-macOS-arm64-pnpm-56ec8155b91741b1a6a9d9371adcd546f0eb97c8c62bd35d9468602d8387c9f8',
    'node-cache-macOS-arm64-pnpm',
  ],
  [
    'msys2-pkgs-upd:false-conf:69844c46-files:677ff28000e32b5257192bedc8db6c06fe0ed884ff06137f2643f08f8334b918',
    'msys2-pkgs-upd:false-conf:69844c46-files',
  ],
  ['pnpm-bin-Windows-X64-11', 'pnpm-bin-Windows-X64'],
];

test('every observed cache key collapses into its family', () => {
  for (const [key, expected] of EXPECTED) {
    assert.equal(stem(key), expected, key);
  }
});

test('the family stem is stable across a vendor bump', () => {
  // What actually prunes: three Firefox bumps in a row share one family, so
  // --keep 2 keeps the two newest installers (and their extracted dirs).
  const old = stem('firefox-dl-Windows-1111111111111111');
  const mid = stem('firefox-dl-Windows-2222222222222222');
  const fresh = stem('firefox-dl-Windows-3333333333333333');
  assert.equal(old, mid);
  assert.equal(mid, fresh);
});

test('a key that is only its family is left alone', () => {
  assert.equal(stem('url-watchdog-baseline'), 'url-watchdog-baseline');
  assert.equal(stem('firefox-dl-Windows'), 'firefox-dl-Windows');
});
