# 0017: CI validation contract — path-filtered gates, advisory fork legs

- **Status:** accepted
- **Date:** 2026-08-26

## Context

The E2E matrix (ADR 0015) ran on every PR — including docs-only ones — and its browser-matrix fork
legs (Dev Edition, LibreWolf, Floorp, Zen) were hard gates in `e2e-gate` even though
`docs/e2e-matrix-plan.md` and `docs/DEVELOPING.md` documented them as advisory. The fork legs
install third-party browsers from Mozilla redirects, librewolf.dev's package registry and GitHub
release assets; the winget-based installs failed on upstream mirror hiccups unrelated to the change
under test (PR #63's LibreWolf leg).

## Decision

Installer/updater E2E and the publish gate run **only when changed files can affect them**
(`core/**`, `config/installer.conf`, `installer/**`, `tools/publish/**`, `test/e2e/**`, the package
manifest, and the workflows/actions); the aggregate gates always run, so required checks never go
missing. Fork-browser matrix legs are **advisory** — failures warn in the gate instead of blocking.
The browser download map (`test/e2e/shared/downloads.mjs`) is the single source of truth for install
recipes: direct official downloads, "latest" resolved from vendor version APIs, no package managers.
A scheduled + PR-triggered URL watchdog (`.github/workflows/url-watchdog.yml`) keeps the map
trustworthy between releases.

## Consequences

Docs-only PRs get fast, green CI, and a flaky third-party host can no longer block a merge. Coverage
gaps on docs-only PRs are accepted; any PR touching the download map runs the watchdog's PR check
and the affected legs. One caveat: a PR that branched before a gating change and is later updated
from main (the "Update branch" button, required by strict branch protection) over-runs the full
matrix once — GitHub's changed-files diff counts base-branch changes merged into the head, so the
paths filter over-triggers. Rebase the PR onto main instead of merging it in to avoid the over-run;
when it happens it is harmless (conservative direction). The download map and watchdog are test
harness, not product — they are noted as "Not recorded" in the index, not re-ADRed. Revisit-if: a
fork host becomes reliable enough for hard gates, or a docs-only change needs the full E2E matrix.
