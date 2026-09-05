# 0021: Tiered publish gating + shared browser resolver + ci-downloads escape

- **Status:** accepted
- **Date:** 2026-09-05

## Context

The Sep 2026 publish of the #102 fix was blocked repeatedly by vendor flakiness: LibreWolf's
Codeberg packages API stalled four times that day (one stall silently left a _stale_ entry in an
otherwise green watchdog baseline — the drift gate lied), and the single-attempt version lookup also
failed twice inside the publish pre-flight. The same session proved the resolver story is
fragmented: `downloads.mjs` knew install recipes, `check-browser-downloads.mjs` knew version APIs,
each with different retry behavior. Separately, the maintainer's usage split (firefox+waterfox ≈ 93%
of users) made waterfox's "manual only, no automated install" status untenable for a browser that
must gate a publish.

## Decision

One shared resolver (`test/e2e/shared/browserResolver.mjs`) owns version + installer resolution for
every consumer: E2E downloads, the URL watchdog, and the publish pre-flight. Version chains carry
retries with backoff and mirrors (LibreWolf: Codeberg bsys6 releases API first — sampled ~20× faster
than the packages registry — then the packages API; waterfox: GitHub tag, then its CDN releases
index). The watchdog is **fail-closed**: an unresolved browser fails the run and saves no baseline
(no more silent stale entries). The publish pre-flight is **tiered**: firefox/firefox-dev lookups
and all resolved-but-drifted versions block; fork lookups that fail after the full chain degrade to
`::warning::` + a deduped notification issue and the publish continues. Waterfox gains an automated
install (its CDN versioned setup URL) and an advisory E2E leg — it joins `VALIDATED_BROWSERS` (hard
gate) only after a soak period of green runs. The manual escape is a **temporary** `ci-downloads`
release: `pnpm ci:download <installer>` creates it, uploads the asset, and dispatches a
single-browser E2E run (version pinned, `record-validation` skipped for partial runs); CI deletes
the consumed asset and the release once empty. Auto-retry automation was deliberately **not** built
— the notification issues are the trigger metric (~2×/month per fork or a materially delayed publish
reopens it).

## Consequences

A vendor stall can no longer block shipping fixes to users, and no code path can save a partial
watchdog baseline. The cost: fork releases may ship unvalidated while their lookup is down (accepted
— forks are advisory everywhere, and the next healthy watchdog/E2E cycle closes the gap); LibreWolf
_version_ resolution remains Codeberg-only (both sources share the host — a full outage lands on
warn-and-continue); `ci-downloads` assets are accepted without vendor hash verification (maintainer
trust boundary, exposure bounded by auto-delete). The download map (`downloads.mjs`) stays the
recipes' home but delegates resolution; ADR 0017's "download map as source of truth" now means
"recipes here, chains in the resolver". Revisit-if: the fork notification issues fire often enough
to justify auto-retry, a full Codeberg outage actually blocks a publish, or waterfox's soak surfaces
updater bugs that change its gate trajectory.
