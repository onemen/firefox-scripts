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

const {stem, layout, groupOf, keepFor, parseKey, planDeletes} = await import(pruneUrl);

/** A cache entry as the API returns it. */
const entry = (key, created_at, ref = 'refs/heads/main') => ({key, created_at, ref});

// ── The current key scheme (ADR 0045) ───────────────────────────────────────
//
// `<name>-<type>-<os>-<hash>-<layout>`: one browser per name, so the release is
// the only varying half of a key and a group is the key minus it.

test('parseKey: the current scheme, and only it', () => {
  assert.deepEqual(parseKey('firefox-dl-windows-1adb2936297da1fe-plain'), {
    name: 'firefox',
    type: 'dl',
    os: 'windows',
    hash: '1adb2936297da1fe',
    layout: 'plain',
  });
  // A dashed name parses because the three fields after it come from closed sets.
  assert.deepEqual(parseKey('esr-prev-portable-windows-8769a05370997233-dir'), {
    name: 'esr-prev',
    type: 'portable',
    os: 'windows',
    hash: '8769a05370997233',
    layout: 'dir',
  });
  // A sticky fork leg keys on the version, and snap is its own os token.
  assert.equal(parseKey('zen-dl-windows-v1.23.1b-plain')?.hash, 'v1.23.1b');
  assert.equal(parseKey('firefox-dl-snap-9036-plain')?.os, 'snap');
  // Legacy shapes and every other cache in the repo are NOT current-scheme keys:
  // their grouping must not change just because the parser exists.
  for (const other of [
    'firefox-dl-Windows-ca6cc4d5e2db5f9a',
    'firefox-portable-macOS-7d497ffee63f5925-x',
    'browser-dl-Windows-zen-v1.23.1b',
    'esr-portable-Windows-8769a05370997233',
    'core-smoke-firefox-Linux-abc123def456789a',
    'snap-firefox-9036',
    'pnpm-cache-linux-x64',
    'msys2-pkgs-upd:false-conf:69844c46-files:677ff28000e32b52',
    'url-watchdog-baseline-2026-10-05',
  ]) {
    assert.equal(parseKey(other), null, other);
  }
});

test('a current-scheme key groups on everything but its release', () => {
  const group = k => groupOf(k);
  // One group per browser payload, however many releases it has held...
  assert.equal(group('firefox-dl-windows-1adb2936297da1fe-plain'), 'firefox-dl-windows-plain');
  assert.equal(group('firefox-dl-windows-9b52a0224930ca58-plain'), 'firefox-dl-windows-plain');
  // ...so a vendor bump retires its predecessor inside that group.
  assert.equal(keepFor(group('firefox-dl-windows-1adb2936297da1fe-plain'), 3), 1);
  // The installer and its extracted tree keep separate slots.
  assert.notEqual(
    group('firefox-dl-windows-1adb2936297da1fe-plain'),
    group('firefox-portable-windows-1adb2936297da1fe-dir')
  );
  // And no browser shares a slot with another any more — the point of the scheme.
  for (const other of ['firefox-dev', 'nightly', 'waterfox', 'esr']) {
    assert.notEqual(
      group(`${other}-dl-windows-1adb2936297da1fe-plain`),
      group('firefox-dl-windows-1adb2936297da1fe-plain')
    );
  }
});

test('planDeletes: a superseded release of the current scheme goes, the newest stays', () => {
  const caches = [
    entry('firefox-dl-windows-1111111111111111-plain', '2026-10-06T01:00:00Z'),
    entry('firefox-dl-windows-2222222222222222-plain', '2026-10-08T01:00:00Z'),
    // Four browsers, four names: none of these competes for another's slot, so
    // every one of them survives a prune that keeps a single release each.
    entry('firefox-dev-dl-windows-3333333333333333-plain', '2026-10-06T01:00:00Z'),
    entry('nightly-dl-windows-4444444444444444-plain', '2026-10-06T01:00:00Z'),
    entry('waterfox-dl-windows-5555555555555555-plain', '2026-10-06T01:00:00Z'),
    entry('esr-dl-windows-6666666666666666-plain', '2026-10-06T01:00:00Z'),
    entry('esr-prev-dl-windows-7777777777777777-plain', '2026-10-06T01:00:00Z'),
    // Non-payload families keep the operator's count.
    entry('url-watchdog-baseline-2026-10-05', '2026-10-05T01:00:00Z'),
  ];
  assert.deepEqual(
    planDeletes(caches, 3).map(c => c.key),
    ['firefox-dl-windows-1111111111111111-plain'],
    'only the superseded firefox release goes'
  );
});

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

  // pnpm/setup's per-run tail: `<hashes>-<run_id>-1-<uuid v4>` — a unique key
  // per run that must collapse into one family per OS/arch. Real key observed
  // 2026-10-08 (81 live entries / 5.26 GB, all byte-identical content).
  [
    'pnpm-cache-Linux-x64-2fb24468351ea046bd9d0a57c23be5fd23e78f50a36bfdb56f46901df1ea7ef9' +
      '-20ce8d7dfd024210b082badb4895e0eff9757973f4f86766f181feab1ab50903' +
      '-7f65e6ff5560bd1ba9949fedde9bd25dbd561949309510e80e89ee0bc0415cae' +
      '-37739280981-1-1f11f359-398b-4756-b7a7-183ba9805381',
    'pnpm-cache-linux-x64',
  ],
  [
    'pnpm-cache-Windows-x64-2fb24468351ea046bd9d0a57c23be5fd23e78f50a36bfdb56f46901df1ea7ef9' +
      '-20ce8d7dfd024210b082badb4895e0eff9757973f4f86766f181feab1ab50903' +
      '-7f65e6ff5560bd1ba9949fedde9bd25dbd561949309510e80e89ee0bc0415cae' +
      '-37712948603-1-d3e9dfad-9049-4fa1-a5ea-78d7086453e3',
    'pnpm-cache-windows-x64',
  ],
  [
    'pnpm-lockfile-verified-Linux-x64-20ce8d7dfd024210b082badb4895e0eff9757973f4f86766f181feab1ab50903',
    'pnpm-lockfile-verified-Linux-x64',
  ],
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
  // The one folded family: `pnpm-cache` is case-insensitive (see the legacy-tail
  // test below), everything else keeps its case — `pnpm-lockfile-verified` is a
  // different family and must NOT be folded with it.
  assert.equal(stem('pnpm-cache-Linux-x64'), 'pnpm-cache-linux-x64');
  assert.equal(stem('pnpm-lockfile-verified-Linux-x64'), 'pnpm-lockfile-verified-Linux-x64');
  assert.equal(stem('pnpm-bin-Windows-X64-11'), 'pnpm-bin-Windows-X64');
});

test('every run-tail pnpm key collapses into one keep-one group per OS/arch', () => {
  const runKey = (os, run, uuid) =>
    `pnpm-cache-${os}-2fb24468351ea046bd9d0a57c23be5fd23e78f50a36bfdb56f46901df1ea7ef9` +
    `-20ce8d7dfd024210b082badb4895e0eff9757973f4f86766f181feab1ab50903` +
    `-7f65e6ff5560bd1ba9949fedde9bd25dbd561949309510e80e89ee0bc0415cae` +
    `-${run}-1-${uuid}`;
  // Every run of one OS lands in the same group...
  const g1 = groupOf(runKey('Linux-x64', 37739280981, '1f11f359-398b-4756-b7a7-183ba9805381'));
  const g2 = groupOf(runKey('Linux-x64', 37712948603, '6f4d447c-27a8-43fa-84fb-b1153fac2b39'));
  assert.equal(g1, 'pnpm-cache-linux-x64 :: plain');
  assert.equal(g2, g1);
  // ...but a different OS does not (its store is a different ~65 MB payload).
  assert.notEqual(
    groupOf(runKey('Windows-x64', 37712948603, 'd3e9dfad-9049-4fa1-a5ea-78d7086453e3')),
    g1
  );
  // And keep-one applies: only the newest run's entry survives.
  const caches = [
    {
      key: runKey('Linux-x64', 37739280981, '1f11f359-398b-4756-b7a7-183ba9805381'),
      created_at: '2026-10-08T02:00:00Z',
      ref: 'refs/heads/main',
    },
    {
      key: runKey('Linux-x64', 37712948603, '6f4d447c-27a8-43fa-84fb-b1153fac2b39'),
      created_at: '2026-10-07T02:00:00Z',
      ref: 'refs/heads/main',
    },
    {
      key: runKey('Linux-x64', 37600000000, '8a30e83f-dd59-474a-96ac-a67c9d7b561a'),
      created_at: '2026-10-06T02:00:00Z',
      ref: 'refs/pull/464/merge',
    },
  ];
  const deletes = planDeletes(caches, 3);
  assert.equal(deletes.length, 2);
  assert.ok(deletes.every(c => c.created_at !== '2026-10-08T02:00:00Z'));
});

test('pnpm entries across a lockfile bump keep the newest state only', () => {
  // The hash-combo is deliberately peeled: old-lockfile entries are the old
  // store's duplicates, and only the newest entry (new state) is worth
  // keeping — a cold re-download after a bump costs a minute, not gigabytes.
  const a =
    'pnpm-cache-Linux-x64-1111111111111111111111111111111111111111111111111111111111111111-37739280981-1-1f11f359-398b-4756-b7a7-183ba9805381';
  const b =
    'pnpm-cache-Linux-x64-2222222222222222222222222222222222222222222222222222222222222222-37739280981-1-1f11f359-398b-4756-b7a7-183ba9805381';
  assert.equal(stem(a), stem(b));
  const deletes = planDeletes(
    [
      {key: a, created_at: '2026-10-06T02:00:00Z', ref: 'refs/heads/main'},
      {key: b, created_at: '2026-10-08T02:00:00Z', ref: 'refs/heads/main'},
    ],
    3
  );
  assert.deepEqual(
    deletes.map(c => c.key),
    [a]
  );
});

// ── The keep policy: one entry per release-keyed family/layout ────────────
//
// A vendor bump mints a brand-new key, so the superseded entry is dead weight
// no leg can ever restore — measured 2026-10-08 at 9.94 GB against the 10 GB
// cap, 2.44 GB of it superseded browser entries. The installer and its
// extracted dir are separate layouts precisely because one leg restores both.

test('layout separates an installer from its extracted dir', () => {
  assert.equal(layout('firefox-portable-Windows-ca6cc4d5e2db5f9a'), 'plain');
  assert.equal(layout('firefox-dl-Windows-ca6cc4d5e2db5f9a'), 'plain');
  assert.equal(layout('browser-dl-Windows-zen-v1.23b'), 'plain');
  // The extracted dir is one payload however its key spells it: `-x` from the
  // URL-keyed legs, `-dir` from the sticky fork namespace. One marker, so a
  // family carrying both never keeps a superseded entry (see the fold test).
  assert.equal(layout('firefox-portable-Windows-ca6cc4d5e2db5f9a-x'), 'dir');
  assert.equal(layout('browser-dl-Windows-zen-portable-dir-v1.23b'), 'dir');
  assert.equal(layout('browser-dl-Windows-floorp-portable-dir'), 'dir');
});

test('the two extracted-dir spellings share one keep slot', () => {
  // Observed live 2026-10-09: the URL-keyed portable families key their dir
  // entry `…-x`, the sticky fork families `…-dir-v<version>`. A prefix that ever
  // migrated between the two regimes would leave the old spelling as its own
  // layout, where keep-one protects it forever — the legacy pnpm shape's bug in
  // a second coat. Folding the markers means the dir half is one slot whatever
  // wrote it.
  const caches = [
    entry('firefox-portable-Windows-ca6cc4d5e2db5f9a', '2026-10-06T01:00:00Z'),
    entry('firefox-portable-Windows-ca6cc4d5e2db5f9a-x', '2026-10-06T01:00:01Z'),
    entry('firefox-portable-Windows-ca6cc4d5e2db5f9a-dir', '2026-10-08T01:00:01Z'),
  ];
  assert.equal(layout(caches[1].key), layout(caches[2].key));
  assert.deepEqual(
    planDeletes(caches, 3).map(c => c.key),
    ['firefox-portable-Windows-ca6cc4d5e2db5f9a-x'],
    'the superseded spelling goes, the installer and the current dir stay'
  );
});

test('release-keyed browser families keep exactly one entry per layout', () => {
  for (const key of [
    'firefox-dl-Windows-ca6cc4d5e2db5f9a',
    'firefox-portable-macOS-7d497ffee63f5925-x',
    'browser-dl-Windows-zen-portable-v1.23b',
    'browser-dl-Windows-librewolf-v157.0',
    'esr-portable-Windows-8769a05370997233',
    'snap-firefox-8996',
    'firefox-portable-macOS-7d497ffee63f5925-dir',
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
  ]) {
    assert.equal(keepFor(groupOf(key), 3), 3, key);
  }
  // pnpm-cache is keep-one now — see the run-tail test above.
  assert.equal(keepFor(groupOf('pnpm-cache-Windows-x64-2fb24468351ea046'), 3), 1);
});

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

test('planDeletes: the legacy pnpm store family is folded into its successor', () => {
  // pnpm/setup keyed the store on a lowercase platform (`Linux-x64`); the
  // composite keys it on `runner.arch` (`Linux-X64`). Two families differing
  // only in case keep one entry EACH, so the legacy per-run entries would
  // outlive their successor forever — and nothing can restore them: the
  // composite's restore-keys prefix is `pnpm-cache-Linux-X64-`. Observed live
  // 2026-10-09: 3 such entries / 179 MB (issue #462 family).
  const legacy =
    'pnpm-cache-Linux-x64-2fb24468351ea046bd9d0a57c23be5fd23e78f50a36bfdb56f46901df1ea7ef9' +
    '-20ce8d7dfd024210b082badb4895e0eff9757973f4f86766f181feab1ab50903' +
    '-7f65e6ff5560bd1ba9949fedde9bd25dbd561949309510e80e89ee0bc0415cae' +
    '-37739280981-1-1f11f359-398b-4756-b7a7-183ba9805381';
  const current =
    'pnpm-cache-Linux-X64-20ce8d7dfd024210b082badb4895e0eff9757973f4f86766f181feab1ab50903';
  assert.equal(stem(legacy), stem(current), 'one family, so keep-one can choose');
  const deletes = planDeletes(
    [entry(legacy, '2026-10-09T11:55:41Z'), entry(current, '2026-10-09T13:26:20Z')],
    3
  );
  assert.deepEqual(
    deletes.map(c => c.key),
    [legacy],
    'the newest state survives, the legacy shape goes'
  );
});

test('planDeletes: state and toolchain groups keep the requested count', () => {
  const validated = [1, 2, 3, 4].map(n =>
    entry(`browser-validated-373593070${n}`, `2026-10-0${n}T01:00:00Z`)
  );
  assert.equal(planDeletes(validated, 3).length, 1, 'three of four validated records survive');
  assert.equal(planDeletes(validated, 5).length, 0, 'a higher --keep never deletes');
});
