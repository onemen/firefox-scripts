# 0025: Waterfox joins the hard gate after its soak

- **Status:** accepted
- **Date:** 2026-09-10
- **Extends:** [0021](./0021-tiered-publish-gating-shared-resolver.md)

## Context

ADR 0021 admitted waterfox with an automated install and an **advisory** E2E leg, explicitly
deferring the hard-gate flip until "a soak period of green runs". Waterfox is ≈40% of the user base
(the ADR's own motivation), and the soak criterion has been met: four consecutive green advisory
runs (2026-09-05 ×2, 2026-09-09 ×2 — the latter two validated the freshly released 6.7.2). The
independent BrowserWorks/waterfox#4453 bug affects only Waterfox's own legacy-add-on loader, which
our leg never exercises, so the soak metric is unaffected.

## Decision

Waterfox graduates from advisory to **required** (the flip ADR 0021 promised):

1. A required `updater-waterfox` E2E leg (windows-only — its download recipe is the Windows NSIS
   installer) runs beside the `updater` matrix instead of inside it, so one fork recipe's failure
   cannot take down the firefox/firefox-dev/nightly legs wholesale. It keeps its own URL-keyed
   installer cache and `BROWSER_PIN_VERSION` escape.
2. `'waterfox'` joins `VALIDATED_BROWSERS`: the publish pre-flight requires the current waterfox
   release to be covered by the validated-versions record, exactly like firefox/firefox-dev. It
   leaves `FORK_BROWSERS` — its version lookup no longer degrades to warn-and-continue; a lookup
   failure blocks a publish.
3. The watchdog's post-baseline dispatch plan promotes waterfox new-version findings to the **full**
   dispatch (which runs the required leg and record-validation); a single-browser fork escape could
   not re-record. `browser=waterfox` stays a valid dispatch input for the pinned break-glass run
   below.
4. The advisory `browser-matrix` default list drops to librewolf/floorp/zen.

### Pin-first break-glass runbook (the flip's flip-back)

A vendor update can flip the required leg red with no repo change (ADR 0023's failure mode). The
break-glass procedure, in order:

1. **Pin:** dispatch `gh workflow run e2e.yml -f browser=waterfox -f version=<last-validated>` — if
   green, the leg's code is fine and only the new vendor build is broken.
2. If the vendor CDN is broken too (`ci-downloads` fallback insufficient), pin the **publish**
   pre-flight instead: the validated record still covers the old version, so prod publishes stay
   blocked — that is correct behavior; do not bypass it.
3. Merges stay unblocked throughout: branch protection gates on the E2E aggregate, and a red leg on
   a PR whose filter includes updater paths blocks only that PR — if it must merge regardless, the
   pin in step 1 revalidates the record without repo changes.
4. **Unpin** on the first green run against a fixed vendor version. No repo state to clean: the pin
   is a dispatch input, never a commit.

## Consequences

A waterfox updater regression now blocks PRs and publishes instead of warning — the point of the
flip, paid for with a new vendor-flake surface on windows-latest (the same exposure
firefox/firefox-dev already carry; the resolver's retry + mirror chains apply identically). The
record-validation contract now has a per-browser expected-OS set (`BROWSER_LEG_OSES`):
firefox/firefox-dev on 3 OSes, waterfox on Windows only. Waterfox lookup outages block publishes
(accepted — the same tiering firefox already has; the vendor has been reliable, and the runbook
above keeps merges unblocked while publishes wait for a healthy lookup). Revisit-if: Waterfox ships
a Linux/macOS build we want to validate, or its lookup becomes chronically unreliable — then it
returns to a degraded tier deliberately, via a new record.
