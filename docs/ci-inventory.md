# CI inventory

This document is the source of truth for the workflow/job names, path filters, and required versus
advisory behavior. Update it when workflow names, triggers, filters, gates, or scheduled jobs
change.

## Pull-request and push CI

| Workflow / job name                              | Description                                                                                  | Triggers                             | Filter / gate behavior                                                                           |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------ |
| CI / detect changed paths                        | Selects publish-relevant changes                                                             | PR, `main` push, merge queue         | Always runs; outputs `publish`                                                                   |
| CI / lint + format                               | Lint, format, unit tests, decisions, gate contract                                           | PR, `main` push, merge queue         | Always runs; unit tests are intentionally unfiltered                                             |
| CI / publish gate — `<os>`                       | Package/native build gate on Windows, Linux, macOS                                           | PR, `main` push, merge queue         | Job always reports a successful no-op when `publish` is false; only expensive steps are gated    |
| CI / CI gate                                     | Aggregate CI status                                                                          | Same CI triggers                     | Always reports; filtered publish work is not applicable, not a failure                           |
| E2E / detect changed paths                       | Selects independent E2E groups                                                               | PR, `main` push, merge queue, manual | Always runs; outputs `installer`, `updater`, and `core`                                          |
| E2E / build dev snapshot                         | Builds shared updater snapshot                                                               | Same E2E triggers                    | Runs when `updater` or `core` is true                                                            |
| E2E / installer E2E — `<os>`                     | Installer API/UI tests                                                                       | Same E2E triggers                    | Runs when `installer` is true                                                                    |
| E2E / helper E2E — ubuntu-latest                 | Elevated helper-copy test                                                                    | Same E2E triggers                    | Runs when `updater` is true; helper source is part of updater-impacting paths                    |
| E2E / updater E2E — `<browser>` — `<os>`         | Updater tests: Firefox stable + Dev Edition (hard gate)                                      | Same E2E triggers                    | Runs when `updater` is true                                                                      |
| E2E / updater E2E — `<browser>` — windows-latest | Advisory fork-browser updater tests                                                          | Same E2E triggers                    | Runs when `core` or `updater` is true; static browser set — targeted dispatch still to implement |
| E2E / E2E gate                                   | Aggregate E2E status                                                                         | Same E2E triggers                    | Always reports; per-job `applicability` decides which jobs must pass vs. must be skipped         |
| AI review (Groq) / Groq AI review                | Advisory AI review — REMOVED 2026-08-29; superseded by the local agent-run review (ADR 0020) | workflow deleted                     | Replaced by `pnpm review:local`; no CI/repo AI secret                                            |

### Filter ownership

| Output              | Intended paths                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `publish`           | `core/**`, `config/installer.conf`, `installer/**`, `tools/publish/**`, packaging dependencies, `.github/actions/**`, and CI workflow files |
| `installer`         | Installer implementation/web/API files and `test/e2e/installer/**`                                                                          |
| `updater`           | `core/chrome/utils/updater/**`, `installer/src/helper/**`, updater shared helpers/tests, and updater workflow/action files                  |
| `core`              | Browser-chrome/core files and core smoke tests; shared E2E infrastructure may conservatively select all affected groups                     |
| `browser-downloads` | `test/e2e/shared/downloads.mjs`, watchdog tooling, and watchdog workflow files                                                              |

`installer/src/helper/**` belongs to the updater group because the helper binary is used by updater
installation flows. Its helper E2E remains a separate job, but shares the updater filter.

Unit tests remain part of the always-running `CI / lint + format` job because they are fast and do
not justify another filter.

## Scheduled and manual workflows

| Workflow / job name                           | Schedule / trigger                         | Purpose                                                                 | Download behavior / filter                                                                            |
| --------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| URL watchdog / check browser download URLs    | Weekly Monday schedule, manual dispatch    | Checks vendor versions, endpoint health, baseline, and issues           | Always checks APIs and a 1 KB range; full download + SHA-256 only on first baseline or a new version  |
| URL watchdog / browser download URLs (PR)     | PRs touching the download map, merge queue | Stateless download-map validation                                       | No baseline, issue creation, or full downloads; always green                                          |
| Cache cleanup / prune                         | Weekly Sunday schedule, manual dispatch    | Removes stale Actions caches                                            | Maintenance only; no PR trigger                                                                       |
| Pages publish / check browser version drift   | Manual dispatch                            | Blocks prod publish when a browser released since the last watchdog run | Restores the watchdog baseline and re-resolves versions; no downloads; prod fails on drift, dev warns |
| Pages publish / capture pre-run hash manifest | Manual dispatch                            | Captures release baseline                                               | Publish workflow only                                                                                 |
| Pages publish / publish — windows binaries    | Manual dispatch                            | Publishes Windows artifacts                                             | Serialized after baseline                                                                             |
| Pages publish / publish — linux binaries      | Manual dispatch                            | Publishes Linux artifacts                                               | Serialized after Windows                                                                              |
| Pages publish / publish — mac binaries        | Manual dispatch                            | Publishes macOS artifacts                                               | Serialized after Linux                                                                                |

When the watchdog detects a new browser version, it should dispatch targeted updater compatibility
E2E for that browser rather than the entire suite. Firefox, Firefox Dev Edition, LibreWolf, Floorp,
and Zen map to their corresponding browser-matrix test; Waterfox remains issue-only until it has an
automated install recipe.

The weekly watchdog is the only scheduled refresh of the browser baseline, so a browser released
between the last watchdog run and a publish would ship unvalidated. The Pages publish workflow runs
`check browser version drift` (`--drift`) before any publish job: it restores the watchdog baseline
from the Actions cache and re-resolves every browser's current version. A **prod** publish is
blocked on drift — the error tells the operator to run the URL watchdog workflow (which refreshes
the baseline and triggers the browser-specific E2E) and then re-dispatch. **Dev** publishes warn
instead of blocking, since dev artifacts are disposable test builds.

## Main observations

| Area                         | Current behavior                                                                   | Remaining follow-up                                             |
| ---------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Watchdog unchanged browser   | Vendor API, URL resolution, and 1 KB range request; no full installer download     | None                                                            |
| Watchdog new browser version | Temporary full download + SHA-256, then removal; issue with the hash ledger        | None                                                            |
| Watchdog baseline cache      | Stores only `.watchdog/baseline.json`                                              | Cache eviction causes a rebaseline download cycle               |
| Watchdog timeout             | No explicit job timeout                                                            | Add `timeout-minutes: 10`                                       |
| E2E browser installer cache  | Cache keys include OS/browser/resolved URL; cached installers are reused           | Keep; installation still runs per job                           |
| CI publish gate              | Three runners allocated even when steps are no-ops                                 | Consider a cheap always-report job instead of all three runners |
| E2E filtering                | Independent `installer` / `updater` / `core` outputs gate the E2E jobs             | None (implemented)                                              |
| Helper E2E                   | Tied to the `updater` filter (helper binary is used by updater flows)              | None (implemented)                                              |
| Browser matrix               | Runs on `core`/`updater` changes; advisory in the gate                             | Watchdog-targeted browser dispatch still to implement           |
| Unit tests                   | Included in the fast static job                                                    | Do not filter                                                   |
| Aggregate gates              | Always-running gates; per-job `applicability` requires non-applicable jobs skipped | None (implemented)                                              |
| AI review                    | Run locally by the opening agent (ADR 0020); CI workflow removed                   | None — replaced by `pnpm review:local`                          |
| Publish workflow             | Three platform jobs serialized; `pre-publish` blocks prod on browser-version drift | Keep serialized unless publishing becomes conflict-safe         |
