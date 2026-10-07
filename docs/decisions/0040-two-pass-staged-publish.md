# 0040: Two-pass staged publish with a single writer

- **Status:** accepted
- **Date:** 2026-10-07

## Context

0009 unified publishing behind one pipeline with a required `--mode`, and its Consequences carried a
revisit-if: "fully automated cross-OS publishing (a build matrix that stages binaries then uploads
once) replaces the manual per-OS runs". That happened and went unrecorded — `docs/ci-inventory.md`
and the workflows now implement it in full, while 0009 still describes the manual era and its index
line only says "prod gated to `main`". The two-pass shape is load-bearing for every release
(2026-10-06 audit, P2-12 / #446), and its determinism claims are proven rather than asserted: two
forced snapshots on one runner must be byte-identical, each PE's `TimeDateStamp` must equal its own
commit epoch ([0036](./0036-git-derived-build-dates.md)), and a pinned-prefix rebuild must `cmp`
equal the environment build.

## Decision

A prod publish runs as two passes. **Pass 1** (parallel per-platform matrix): hash-diff the platform
against a shared pre-run baseline, rebuild only what changed, stage binaries plus a per-platform
`build-manifest.<platform>.json`, and upload staging artifacts — no publish target is touched.
**Pass 2** (exactly one job): download every staged set, verify it (`verifyStagedBinaries` plus a
contract test that the staged set equals the published set), re-run the AV/VT gates, build the
packages, and perform the entire release + Pages publish in one `--skip-build` run. One writer per
publish, serialized by the shared `pages-publish` concurrency group; `pnpm release:stage` is the
local one-command staging handoff. Both passes go through the same `publish-upload` composite action
— inlining it is forbidden by test.

## Consequences

No two jobs ever write the release, `gh-pages` or `hashes.json` concurrently, and "the branch
matches the commit" is checked, not assumed: an unchanged platform skips its rebuild and stages
exactly what already shipped. The cost: a publish pays a staging matrix even when nothing changed,
and pass 2 is a serialization point — a pass-2 failure reruns the writer, not the matrix. Staged
bytes are plain artifacts until the writer publishes them, so a signing step can slot into the
handoff (a code-signing step slots in here later — #157). Revisit-if: a publish surface appears that
cannot be staged as an artifact, or pass 2's single job becomes the throughput bottleneck.
