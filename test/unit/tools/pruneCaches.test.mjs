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

const {stem, layout, groupOf, keepFor, planDeletes} = await import(pruneUrl);

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

// ── The keep policy: one entry per release-keyed family/layout ────────────
//
// A vendor bump mints a brand-new key, so the superseded entry is dead weight
// no leg can ever restore — measured 2026-10-08 at 9.94 GB against the 10 GB
// cap, 2.44 GB of it superseded browser entries. The installer and its
// extracted dir are separate layouts precisely because one leg restores both.

test('layout separates an installer from its extracted dir', () => {
  assert.equal(layout('firefox-portable-Windows-ca6cc4d5e2db5f9a'), 'plain');
  assert.equal(layout('firefox-portable-Windows-ca6cc4d5e2db5f9a-x'), 'x');
  assert.equal(layout('firefox-dl-Windows-ca6cc4d5e2db5f9a'), 'plain');
  assert.equal(layout('browser-dl-Windows-zen-portable-dir-v1.23b'), 'dir');
  assert.equal(layout('browser-dl-Windows-floorp-portable-dir'), 'dir');
  assert.equal(layout('browser-dl-Windows-zen-v1.23b'), 'plain');
});

test('release-keyed browser families keep exactly one entry per layout', () => {
  for (const key of [
    'firefox-dl-Windows-ca6cc4d5e2db5f9a',
    'firefox-portable-macOS-7d497ffee63f5925-x',
    'browser-dl-Windows-zen-portable-v1.23b',
    'browser-dl-Windows-librewolf-v157.0',
    'esr-portable-Windows-8769a05370997233',
    'snap-firefox-8996',
  ]) {
    assert.equal(keepFor(groupOf(key), 3), 1, key);
  }
});

test('toolchain and state families keep the operator-supplied count', () => {
  for (const key of [
    'browser-validated-37359307092',
    'browser-fork-validated-37359307092',
    'url-watchdog-baseline-2026-10-05',
    'node-cache-macOS-arm64-pnpm-56ec8155b91741b1a6a9d9371adcd546f0eb97c8c62bd35d9468602d8387c9f8',
    'pnpm-cache-Windows-x64-2fb24468351ea046bd9d0a57c23be5fd23e78f50a36bfdb56f46901df1ea7ef9',
  ]) {
    assert.equal(keepFor(groupOf(key), 3), 3, key);
  }
});

/** A cache entry as the API returns it. */
const entry = (key, created_at, ref = 'refs/heads/main') => ({key, created_at, ref});

test('planDeletes: superseded browser versions go, the current pair stays', () => {
  const caches = [
    // Three Firefox downloads, oldest first.
    entry('firefox-dl-Windows-1111111111111111', '2026-10-06T01:00:00Z'),
    entry('firefox-dl-Windows-2222222222222222', '2026-10-07T01:00:00Z'),
    entry('firefox-dl-Windows-3333333333333333', '2026-10-08T01:00:00Z'),
    // Two portable releases, each saved as installer + extracted dir.
    entry('firefox-portable-Linux-4444444444444444', '2026-10-06T01:00:00Z'),
    entry('firefox-portable-Linux-4444444444444444-x', '2026-10-06T01:00:01Z'),
    entry('firefox-portable-Linux-5555555555555555', '2026-10-08T01:00:00Z'),
    entry('firefox-portable-Linux-5555555555555555-x', '2026-10-08T01:00:01Z'),
  ];
  const deleted = new Set(planDeletes(caches, 3).map(c => c.key));
  assert.deepEqual([...deleted].sort(), [
    'firefox-dl-Windows-1111111111111111',
    'firefox-dl-Windows-2222222222222222',
    'firefox-portable-Linux-4444444444444444',
    'firefox-portable-Linux-4444444444444444-x',
  ]);
});

test('planDeletes: the main copy of a key survives a PR-scoped twin', () => {
  const caches = [
    entry('firefox-dl-macOS-7d497ffee63f5925', '2026-10-06T01:00:00Z', 'refs/heads/main'),
    entry('firefox-dl-macOS-7d497ffee63f5925', '2026-10-08T01:00:00Z', 'refs/pull/462/head'),
  ];
  const deleted = planDeletes(caches, 3);
  assert.equal(deleted.length, 1, 'the duplicate goes');
  assert.equal(
    deleted[0].ref,
    'refs/pull/462/head',
    'never the branch every other ref restores from'
  );
});

test('planDeletes: state and toolchain groups keep the requested count', () => {
  const validated = [1, 2, 3, 4].map(n =>
    entry(`browser-validated-373593070${n}`, `2026-10-0${n}T01:00:00Z`)
  );
  assert.equal(planDeletes(validated, 3).length, 1, 'three of four validated records survive');
  assert.equal(planDeletes(validated, 5).length, 0, 'a higher --keep never deletes');
});
