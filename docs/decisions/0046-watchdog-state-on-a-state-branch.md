# 0046: The watchdog's load-bearing state lives on a state branch

- **Status:** accepted
- **Date:** 2026-10-09
- **Supersedes:** [0044](./0044-cache-writes-default-branch-only.md) — one clause only: its "the
  e2e.yml recorders (`browser-validated-*`, `browser-fork-validated-*`) keep saving their per-run
  keys" no longer holds for `browser-validated-*`. What survives: a cache **save** runs on the
  default branch and a **restore** is never ref-guarded, `browser-fork-validated-*` remains a save
  site with the same reasoning, and the snap payload split stands.
- **Part of:** #462

## Context

Two sub-kilobyte files decided a lot: the URL watchdog's version baseline (`.watchdog/baseline.json`
— the SHA-256 ledger, the ESR window and the version history) and the E2E validated-versions record
(`.watchdog-validated/validated.json` — what the publish pre-flight compares against the current
releases). Both lived only in `actions/cache` entries keyed `<family>-<run_id>` with a
`restore-keys` prefix.

Actions caches are best-effort storage: a 7-day idle TTL, the 10 GB per-repo cap, and this repo's
own `prune-caches.mjs --keep=3`. On 2026-10-06 the repo crossed the cap and GitHub's LRU eviction
took both entries. The failure was not "stale data" — it was indistinguishable-from-nothing:

- every browser rendered `⏳ first run`, because no baseline reads as "no baseline at all" (#136);
- the E2E-validated column said `none` while the meta issue's own rolling comment still carried the
  versions, so the table contradicted the repo's durable copy of the same fact;
- the nightly re-paid the baseline's entire purpose — a full download + hash pass, ~900 MB;
- the prod publish pre-flight failed closed: `collectValidatedDrift` treats an absent record as
  "never validated", so an _evicted_ record blocked a release until the next successful E2E run.

ADR 0036 had already refused a CI-cache mapping for build dates ("Actions caches are evicted"), and
ADR 0034 gave the fork pins their own record for the same class of reason. These two files were
never given that home.

## Decision

Load-bearing CI state is not stored in a surface with an eviction policy. `baseline.json` and
`validated.json` live on one small **orphan branch**, `watchdog-state`, and that branch is their
only home — the cache families are removed rather than kept as an accelerator.

- Artifact-only, in the shape of [0031](./0031-gh-pages-orphan-artifact-branch.md): the branch is
  created from the files being pushed (a parentless root commit) and never seeded from `main`.
- One writer per file: the watchdog publishes the baseline, E2E's record job publishes the record. A
  writer fetches the branch tip and builds its commit **on** that tree, replacing only its own file,
  so a push never drops the other writer's file; a rejected push (the other writer landed first)
  re-reads the tip and rebuilds. Pushes are fast-forward only — state is never force-written.
- Unchanged state is not committed: a quiet night adds no commit.
- Readers — the watchdog itself, the E2E ESR-matrix job, the prod publish pre-flight — fetch by the
  same names, and a missing branch or file stays the existing "no state yet" path. Nothing
  fabricates an empty file: an empty record parses as a passing gate, which is worse than absence.
- The fork record (`browser-fork-validated-*`) stays on the cache: its reader is the per-leg
  `setup-browser` composite, where a branch fetch on every PR leg buys a failure surface for a pin
  that already degrades safely (a missing record warns and resolves `latest`). These two files fail
  the other way — a blocked publish or a table that lies — which is what earns them the durable
  home.

## Consequences

The state survives eviction, quota pressure and prune policies, and its history becomes auditable:
the branch's commit log is the state's own timeline, which no cache entry ever recorded. The two
write jobs need `contents: write`; readers need only the checkout's own read scope. Deleting every
Actions cache no longer changes the table or the drift gate's verdict — the reproduction in #462 is
now structurally impossible rather than merely unlikely. The failure modes narrow honestly: a fetch
that genuinely fails is a hard error (never a silent "first run"), while an absent branch still
means "nothing has been validated yet", which is the same verdict the gate already had.

Revisit-if: the state grows to the size a branch should not carry, a third or fourth writer makes
concurrent pushes common rather than nightly-rare, or the fork pin's degradation stops being safe
enough to justify its place in the cache.
