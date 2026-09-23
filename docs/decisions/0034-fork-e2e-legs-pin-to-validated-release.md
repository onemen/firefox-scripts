# 0034: Fork E2E legs pin to the last validated release; hard gates track latest

- **Status:** accepted (amended 2026-09-23: cache-first sticky installer cache for the fork legs)
- **Supersedes:** [0023](./0023-e2e-browser-version-pinning.md) (latest-at-run-time default for
  every browser; its pin semantics, non-pinnable Firefox rule and per-run ground truth are carried
  forward below)
- **Date:** 2026-09-22

Related: [0023](./0023-e2e-browser-version-pinning.md) (superseded — latest-at-run-time default +
pin escape hatch), [0025](./0025-waterfox-hard-gate.md) (waterfox is a hard gate),
[0021](./0021-tiered-publish-gating-shared-resolver.md) (shared resolver, `ci-downloads`),
[0017](./0017-ci-validation-contract.md) (advisory fork legs).

## Context

0023 made latest-at-run-time the default for every browser: a vendor update flipping CI is signal,
and repo-pinned versions rot. That reasoning holds for the hard gates, whose vendor releases on a
monthly cadence and whose purpose is to track the current release.

It does not hold for the fork legs. The forks release far more often, and the installer cache —
keyed on `sha256(download URL)` — cannot serve across a version bump either way: librewolf's URL is
version-embedded, so the key changes; zen and floorp resolve `releases/latest`, so the key matches
while the restored bytes fail `downloadTo`'s size check and the full download happens anyway. The
URL watchdog's version history (issue #136) records ~8 fork releases in 16 days — librewolf ×2, zen
×3, floorp ×1 in the Sep 6 / 14 / 19 runs alone — so a cold ~160 MB download lands on every open
PR's fork legs roughly every other day.

That exposure is not theoretical, and it is not the forks being chronic: across the last 40
`e2e.yml` runs every fork leg but one finished in 2–7 minutes. The exception is the shape the
cadence guarantees will recur — on 2026-09-22 the `updater E2E · librewolf · windows-latest` leg of
PR #294 resolved librewolf `156.0.1-1`, logged
`Cache not found for input keys: browser-dl-Windows-68ef2d7c0700996e`, pulled 51–61 KB/s and was
killed by its 20-minute cap after ~60 MB, against 3–4 minutes on a cache hit. Because the download's
own budget (`DOWNLOAD_TOTAL_BUDGET_MS`, 20 min) equals the leg cap, a crawl still reports as a bare
cancellation. Meanwhile the machinery to meet a fork release deliberately already exists: the
watchdog downloads and hashes each new release and dispatches the browser E2E for it
([0021](./0021-tiered-publish-gating-shared-resolver.md), ADR 0021's single-browser escape). The
PR-time legs do not need to re-encounter every fork bump.

**Amendment context (2026-09-23).** Even with the pin, the URL-hash key remained the load-bearing
defect: PR #300's librewolf leg resolved the same URL pinned or unpinned (`156.0.1-1`), yet logged
`Cache not found` again — the cache _entry_ for the previous release existed, but a key derived from
the resolved URL cannot see across a release bump. The user-visible contract was therefore
sharpened: a fork leg must not download at all when a cached installer exists; only the watchdog
downloads new fork versions.

## Decision

**The fork legs — librewolf, zen, floorp — pin to the last E2E-validated release instead of
resolving latest.** An open PR cannot introduce a new fork version into CI: the watchdog's
per-release dispatch is the only path that validates a new fork release, and only a green run of
that dispatch advances the pin. Zen and floorp gain a version-embedded source (a tagged vendor
release asset) so a pinned run is served by the vendor rather than by a `releases/latest` redirect
or a manual `ci-downloads` upload.

The hard gates keep 0023's rule unchanged: firefox, firefox-dev, waterfox
([0025](./0025-waterfox-hard-gate.md)) track latest at run time; nightly stays rolling. 0023's pin
semantics survive verbatim — pinning may only be served by sources that can express the pinned
version (`ci-downloads` as the fallback), Firefox/Dev/Nightly stay deliberately non-pinnable, and
what a leg validated is recorded per run via `downloads.mjs --installed-version`, never inferred
from a redirect. The dispatch `version` input remains the single-run escape hatch.

**Amendment (2026-09-23): cache-first sticky installer cache for the fork legs.** The fork legs'
cache key namespace is sticky per browser × OS × layout (`<prefix>-<os>-<browser>[-portable]-v`) and
decoupled from the resolved URL. Under it:

- An **unpinned** fork leg is cache-first: when the restore finds any cached installer, it installs
  it with zero network calls — the URL-resolve step is skipped entirely, so neither a vendor API
  stall nor a new release can delay or fail the leg. `BROWSER_PREFER_CACHE` (set by the composite
  only for unpinned fork legs) selects this in `downloads.mjs`; a present cached installer wins over
  any download.
- Only a **pinned dispatch** — the watchdog validating a release — downloads, and its green run
  saves under `<sticky>-v<installed-version>`, the version measured from the binary that actually
  ran (the same ground truth the validated-versions record stores). Same version → same key →
  `actions/cache/save` no-ops, so the quota carries one entry per browser × OS × layout × release,
  never one per run.
- A cold cache bootstraps from the record pin (else latest) and saves; saves happen only after a
  successful install, so a killed download cannot poison the entry. The extracted portable dir is
  cached in the same sticky style under a disjoint `-dir-` namespace so installer and dir entries
  cannot restore into each other's paths via prefix matching.
- The cache materializes the pin: the newest sticky entry _is_ the last validated release, so the
  leg installs it whether or not the record cache was evicted. The validated-record pin stays in
  force for what the leg reports and for the bootstrap path; cache and record are written only by a
  green watchdog dispatch, so nothing self-advances.

The hard gates' URL-hash regime is unchanged — their stable Mozilla URLs embed the version, so the
key invalidates on a bump and the leg tracks latest, exactly as before.

## Consequences

A fork release stops invalidating the PR-time installer cache: it costs the watchdog one validated
download instead of a cold download on every open PR, and vendor throughput variance stops reddening
legs whose diff is unrelated. The price is stated plainly — PR legs validate the last validated fork
build, not the newest, so for the forks the signal "a vendor update flipped CI" moves from the PR
legs to the watchdog dispatch (or to a pinned leg once the pin advances).

New failure mode to guard: a **stale pin**. The validated record must carry when it was validated
and the leg must report the pinned version and its age, so a pin that outlives several releases is
loud; an absent or evicted record (the Actions cache expires) falls back to latest with a warning
rather than failing the leg. Implementation is a separate change — the decision here is the default.

Revisit-if: the watchdog dispatch cannot keep up with fork release frequency, or a specific contract
needs the newest fork build on PR legs. (The original revisit-if clause — immutable
version-addressable vendor URLs enabling a stable key — is now partially realized by the sticky keys
themselves.)
