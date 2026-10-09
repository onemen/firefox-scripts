# 0037: Snap Firefox E2E leg — cross-revision cache seed, single track

## Status

- **Status:** accepted
- **Date:** 2026-09-30
- **Amended:** [0045](./0045-cache-key-names-the-browser.md) — the revision-pinned key is now
  `firefox-dl-snap-<rev>-plain` (`os=snap`); the cross-revision `restore-keys` seed below is
  unchanged
- **Amends:** [0025](./0025-waterfox-hard-gate.md) — the E2E matrix's snap leg gets a cross-revision
  cache seed and a single install track (additive; recorded per the #291 investigation, 2026-09-30)

## Context

The snap Firefox E2E leg (#55) depends on the snap store (API revision probe + `snap download`),
with the Actions cache as its only fallback. When the store is down **and** the cache is cold, the
leg hard-fails and the watchdog files #291 (opened 2026-09-22, still open). The leg is
scheduled-only and advisory-skipping (snapd unavailable on the 2026-09-28 scheduled run), so the
exposure is intermittent but recurring — every store outage coinciding with a cold cache files the
issue again.

## Decision

1. **No store channel fallback (rejected).** The leg pins `latest/stable` by revision;
   cross-channel/cross-distro tracks change the system under test (different confinement, different
   GreD, sometimes a different engine).
2. **Single install track.** The offline-from-cache install (`snap ack` + `snap install --classic`)
   is the only install path; the `downloads.mjs firefox-snap` direct-store install step is removed
   from the leg. One code path = one set of invariants (FIREFOX_BINARY export, cache-hit parity —
   the exact class of bug #313 fixed).
3. **Cross-revision cache seed.** The revision-pinned cache (`firefox-dl-snap-<rev>-plain` since ADR
   0045 named it; `snap-firefox-<rev>` before) keeps its exact-revision fast path, but a cold cache
   may restore the most recent _older_ revision as a seed via a `firefox-dl-snap-` prefix restore
   key. An older revision still validates the snap GreD mapping (#55's purpose — a structural
   property, not revision-specific) and the updater/installer flows; version drift vs the store
   revision is tolerated because the leg is advisory and the harness records the installed version.
4. **Failure = signal, not a skip.** With no store and no seed the leg still fails and the watchdog
   still files #291 (no silent green); the seed makes that combination rare because any prior
   successful download seeds it.

## Consequences

- Store outages degrade the leg to "older revision" instead of "no Firefox".
- #291 auto-closes on the next green scheduled run per its standing rule; the seed makes recurring
  outages self-healing where they were self-filing.
- `docs/ci-inventory.md` unchanged (job graph, names, gates untouched); workflow-contract tests
  updated in the same change (single install track).
