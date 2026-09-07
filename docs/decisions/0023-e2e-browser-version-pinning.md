# 0023: E2E browser versions track latest at run time — explicit pin escape hatch

- **Status:** accepted
- **Date:** 2026-09-07

Related: [0021](./0021-tiered-publish-gating-shared-resolver.md) (tiered gating + shared resolver +
`ci-downloads`), issue #131 (Part of #3).

## Context

`test/e2e/shared/downloads.mjs` resolves the _latest_ browser release at run time, so a runner-side
vendor update can flip a green E2E matrix red with no repo change. The alternative — pinning exact
browser versions in the repo and bumping them deliberately — would make runs deterministic, but the
repository's whole release machinery (URL watchdog → per-release E2E dispatch → validated-versions
record → publish drift gate, #131's siblings) exists to track and validate each new vendor release.
Pinning by default would fight that machinery and add a stale-pin failure mode (CI validating a
years-old release while users run the current one).

## Decision

**Latest-at-run-time stays the default for every browser.** A vendor update flipping CI is signal —
the thing the E2E matrix exists to catch — and the advisory-leg + validated-versions machinery
already reconciles noise (flaky legs, download outages) without hiding real regressions.

Reproducibility is served by explicit escape hatches instead of repo-pinned versions:

- **Pin a single run**: dispatch `e2e.yml` with a `version` input (or
  `pnpm ci:download -- <file> --version <v>`, which pins as part of the manual escape) —
  `BROWSER_PIN_VERSION` short-circuits the version chain.
- **Pin semantics are strict**: a pinned run may only be served by sources that can actually express
  the pinned version — version-embedded mirror URLs and the `ci-downloads` asset keyed by exact
  version. Version-agnostic sources (floorp/zen's `/releases/latest/download/` URLs) are skipped
  under a pin; a pinned browser without any version-embedded source is served by `ci-downloads`
  alone (upload the exact installer with `pnpm ci:download`).
- **Ground truth is recorded per run**: `downloads.mjs --installed-version` reads the version from
  the installed binary — what a leg validated is never inferred from a redirect.

Firefox stable / Dev Edition are deliberately _not_ pinnable: their official `download.mozilla.org`
endpoints are version-agnostic redirects, and tracking Firefox releases is the primary job of the
hard-gated legs.

## Consequences

- No pinned-version rot: no file in the repo claims a browser version that ages.
- A pinned run of floorp/zen fails loudly ("upload the exact installer with `pnpm ci:download`")
  when the escape release is absent, instead of silently downloading the latest installer while
  labeling it the pinned version (the pre-#131 behavior).
- Reproducing a historical run means re-deriving its versions from the run logs
  (`--installed-version` output) and pinning a dispatch if needed — accepted, rare.
