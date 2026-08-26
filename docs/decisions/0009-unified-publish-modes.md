# 0009: Unified publish pipeline with required --mode=prod|dev

- **Status:** accepted
- **Date:** 2026-08-09

## Context

Publishing grew several scripts and flags (`check:dry`, `--branch`, separate upload helpers) that
could reach the live release by accident. Dev testing needed a way to publish a build that can never
touch the `latest` release or the live `gh-pages` site.

## Decision

One pipeline, `node tools/publish/upload.mjs`, run as `upload` / `upload:local` with a **required**
`--mode=prod|dev`. Prod publishes the `latest` release + `gh-pages` and is gated to branch `main`;
dev publishes to a disposable `dev-build-<id>` branch and pre-release with `-dev` artifact names,
served via jsDelivr. `upload:local` writes a full offline snapshot to `dist/<mode>-<branch>-<hash>/`
and never touches the token. Token validation applies to real uploads only: a missing/empty token
fails `upload` fast before building anything (`46ad7c3`, 2026-08-09; consolidated `21a3304` /
`ca54de6` / `51a5d1e`).

## Consequences

Dev builds are safe by construction — different branch, different tag, different artifact names —
and CI/dev runs share one code path with prod. All publish runs require a clean worktree and, for
real uploads, the token. Revisit-if: fully automated cross-OS publishing (a build matrix that stages
binaries then uploads once) replaces the manual per-OS runs.
