# 0036: Build dates are derived from git per binary — not hand-stamped

- **Status:** accepted
- **Amends:** [0019](./0019-release-versioning.md) (its 2026-09-13 self-update amendment — the date
  that feeds the date-based self-update is now derived, not hand-stamped; declared per the ADR 0029
  convention)
- **Date:** 2026-09-25

Related: [0032](./0032-pinned-build-toolchain.md) (the pinned toolchain is what makes compiler-input
changes deliberate), [0008](./0008-generated-files-untracked.md) (_builddate.h is a generated file),
issue #322.

## Context

0019's self-update amendment bakes `BUILD_DATE` (YYYY-MM-DD) into the binaries from a hand-stamped
`config/installer.conf` key, mirrored by hand into two `.rc` VERSIONINFO resources (pinned together
by `binaryMetadata.test.mjs`). Three hand-maintained copies went stale between releases (2026-09-13
baked until the 09-24 bump, #323), and meanwhile the PE _hash_ re-rolled on every commit (#162 pins
the PE TimeDateStamp to HEAD's epoch) — bytes churned while the inner date stood still. Two churn
sources, decoupled, both wrong: dates that don't move when bytes do, and bytes that move when
nothing in them did (docs-only commits).

A CI-cache mapping (input-hash → date) was considered and rejected: Actions caches are evicted, so
an eviction would silently reset the date and re-roll hashes — a phantom "update available" for
every installed browser — and local builds can't read CI's cache, defeating the deterministic-build
contract of ADR [0032](./0032-pinned-build-toolchain.md). Git history is the same "cache" on every
machine, for free.

## Decision

The inner build date is **derived from git at build time, per binary**:

- Each binary's date is the last commit date (`%cs`) touching **exactly the file set the publish
  hash uses for that binary** (installer: `installer/src` minus `helper/`, plus `installer/web` and
  `config/installer.conf`; helper: `installer/src/helper`). Shared inputs — `installer.ico` (both
  `.res` compilations consume it) and `config/msys2-toolchain.json` (a deliberate toolchain bump
  rebuilds both binaries, and the `installer-<date>` component-tag namespace is date-keyed) — are in
  **both** lists. One definition (the generator) feeds the date, the publish hash and the manifest
  date, making "date moved ⇔ sha256 moved" structural instead of a convention.
- `tools/publish/generateBuildDates.mjs` writes the gitignored `installer/src/_builddate.h`
  (`CFG_BUILD_DATE_INSTALLER`/`_HELPER` plus numeric `FILEVERSION` tuples); the `.rc` resources and
  `platform.h` consume the macros. `config/installer.conf` loses `BUILD_DATE` — no more release-day
  bump commits (#323 was the last).
- **B1 — epoch scoping:** `SOURCE_DATE_EPOCH` (the PE TimeDateStamp pin, #162) is the input set's
  last-commit epoch, not HEAD's — docs-only commits stop re-rolling the binary hashes entirely.
- A compiler-only change therefore moves the date. Correct, not churn: the bytes, their hashes.json
  entry and their AV verdict all changed, so the self-update offer and the `installer-<date>` tag
  must reflect fresh bytes.

## Consequences

Dates can no longer go stale by construction, local == CI bytes (same git history), and the manifest
date, PE metadata and component tags share one source. Costs: every build context needs full git
history (CI `fetch-depth: 0`; shallow clones fail loudly at the generator), the date pathspec lists
must never fork from the hash lists (both live in `generateBuildDates.mjs`, and a fork would break
the date⇔hash invariant silently — revisit-if: a test pinning the two lists against `upload.mjs`'s
collectors is wanted), and history rewrites would move derived dates (main is append-only in
practice). Revisit-if: per-file date granularity is ever needed — split the pathspecs further, never
hand-stamp again.
