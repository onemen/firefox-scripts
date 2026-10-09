# 0044: Cache writes stay on the default branch

- **Status:** accepted
- **Date:** 2026-10-09
- **Part of:** #462 (the cap-sitting that let LRU eviction eat the watchdog's state caches)
- **Related:** [0034](./0034-fork-e2e-legs-pin-to-validated-release.md) (the key scheme this leaves
  intact), [0043](./0043-e2e-wallclock-decisions.md) (cache cleanup under the family policy)

## Context

GitHub scopes every Actions cache entry to the ref of the run that wrote it, and the dependency
caching reference is explicit about a `pull_request` run: its entry is created for the merge ref
(`refs/pull/…/merge`) and "can only be restored by re-runs of the pull request. It cannot be
restored by the base branch or other pull requests." Reads run the other way — a run searches its
own ref first, then falls through to the default branch.

`setup-browser` saved both browser payloads (the installer and the extracted portable dir) with a
bare `if: success()`, so every PR run minted a private pair that died with its PR. Measured
2026-10-09: 34 of the repo's 58 entries / 4.27 GB of 6.57 GB were PR-scoped across three PR refs.
Since sitting near the 10 GB cap is what invites the LRU eviction that ate the URL watchdog's state
caches, that quota was not merely wasted — it was the eviction pressure (#462).

One save site had no `if:` to widen: the snap leg's `actions/cache@` restores **and** saves, the
save in a post-job step of its own that the step's condition never reaches. It kept minting an entry
per PR ref while the explicit saves above were being fixed — measured 2026-10-09, 236 MB of
`snap-firefox-9036` on `refs/pull/489/merge`.

## Decision

A cache **save** runs on the default branch only; a cache **restore** is never ref-guarded.

- The two `setup-browser` saves carry `github.ref == 'refs/heads/main'`, the same guard the pnpm
  store uses in `setup-repo` (#487). Pinned by `test/unit/tools/browserCacheSaveScope.test.mjs`,
  which also proves it fails on the old shape.
- Restores stay unguarded on purpose: the PR-time warm path _is_ the default-branch fallback, so
  guarding a restore would leave every PR leg cold even with main warm.
- The e2e.yml recorders (`browser-validated-*`, `browser-fork-validated-*`) keep saving their
  per-run keys, because their jobs already cannot run on a PR ref (both are dispatch-only). The same
  test holds that invariant, so a third payload cache added to either file has to declare where it
  writes.
- The snap payload (`snap-firefox-*`) is the third site and splits like `setup-browser`: an
  unguarded restore, then an explicit main-only save placed **after** the download that populates
  `~/snap-pkg` (a save before it would store an empty directory, and a post-job save cannot see the
  step's `if:`). The test therefore counts plain `actions/cache@` as a save site, not only
  `actions/cache/save@`: a job passes on a job-level guard, or on a main-only `if:` on **every**
  save step it contains — one unguarded sibling is enough to write on a PR ref, so a guarded save
  beside it must not launder the job.
- `cache-mode: read` on PR runs would enforce the same boundary structurally, but it reports a
  warning per skipped save. The explicit guard is warning-free and visible at the step.

## Consequences

The quota carries only entries every ref can restore, and an open PR stops multiplying it. PR legs
still find main's copies, and the pinned hard-gate browsers are version-stable, so the everyday warm
path survives; the price is a cold leg whenever a PR installs a release main has never cached — a
fork release validated only on that PR, or a Nightly newer than the last nightly dispatch. That cost
is one download per leg per version, paid by the run that introduced the version, where the
alternative billed every open PR forever.

Revisit-if: PR legs start cold-downloading routine versions (the nightly dispatch drifting away from
what PRs install), or a fork release becomes common in PRs before the watchdog's dispatch has cached
it on main.
