# 0045: Every CI cache key names the browser it caches

- **Status:** accepted
- **Date:** 2026-10-09
- **Amends:** [0034](./0034-fork-e2e-legs-pin-to-validated-release.md) (its sticky key namespace),
  [0037](./0037-snap-e2e-cross-revision-cache-seed.md) (its revision-pinned snap key)
- **Related:** [0044](./0044-cache-writes-default-branch-only.md) (where those keys are written),
  #462 (the cap-sitting these key shapes fed)

## Context

A key used to be `<prefix>-<os>-…`, where the prefix was a **namespace the calling job chose**
(`firefox-dl`, `firefox-portable`, `esr-portable`, `browser-dl`, `core-smoke-<browser>`,
`snap-firefox`). Nothing in it named the browser: `firefox-dl-<os>` held firefox, firefox-dev,
nightly and waterfox — four different download URLs, indistinguishable offline — `esr-portable-<os>`
held both watched ESR majors, and the same waterfox installer was cached twice under two prefixes.

The prune keeps one entry per release-keyed family, so a family shared by four browsers meant three
of them lost their cache at every prune and re-downloaded nightly (measured ~1.2 GB/night across the
three OSes). The watchdog's Fallback column could not attribute a key to a browser either; it said
`cached (namespace shared)` because the keys genuinely could not prove which browser they served.

## Decision

One key shape everywhere: `<name>-<type>-<os>-<hash>-<layout>`.

- `name` is the browser, from its `downloads.mjs` registry entry (`firefox`, `firefox-dev`,
  `nightly`, `waterfox`, `librewolf`, `floorp`, `zen`) — the one place a browser is defined. The
  `cache-key-prefix` input is **deleted**: a leg no longer chooses a namespace.
- `type` is the payload (`dl` installer, `portable` extracted tree) and `layout` its spelling
  (`plain` / `dir`), which retires the `-x` / `-dir` key suffixes and the separate portable
  namespaces.
- `os` is `runner.os` lowercased, plus `snap` — the snap payload, the one browser-shaped cache that
  is not a browser installer, becomes `firefox-dl-snap-<revision>-plain` (`snap-firefox-<revision>`,
  and its `snap-firefox-` prefix, before).
- `hash` is the download URL's sha256 prefix, so a vendor bump mints a new key; a sticky fork leg
  keys on `v<version>` instead, because its restore must work with no vendor call (0034's
  cache-first rule).
- ESR is the one positional name: the serving watched line is `esr`, the line it replaced `esr-prev`
  — resolved in `watchdog-report.mjs`, which owns the watched window, and handed to the leg by the
  ESR matrix. With no window to hand (a local run) the major names itself as `esr-<major>`: unique
  and stable, just not canonical.
- The pruner parses a key right-to-left — the three fields after `name` come from closed sets, so a
  dashed name (`firefox-dev`, `esr-prev`) is unambiguous — and keeps one entry per
  `name-type-os-layout`. Legacy keys keep the family peel they had, so a transition cannot ungroup
  them.

## Consequences

Attribution is exact: a key names its browser, so the watchdog's inventory is per browser
(`<name>-dl-`, `<name>-portable-`) instead of a shared namespace, and keep-one is the right count
for every browser-payload group. Growth is bounded by releases rather than by runs or by how many
browsers share a name.

The rename invalidates every existing key. The first run after it is cold on every leg (one
re-download per payload per OS), and the old entries are restorable by nothing but the code that
wrote them — they age out under GitHub's 7-day idle rule, and the prune's legacy peel still retires
them in the meantime, so the transition needs no manual deletion.

Revisit if a browser ever needs two independent caches of one payload kind on one OS: that wants a
sixth field, never a second namespace.
