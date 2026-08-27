# CI inventory

This document is the source of truth for the workflow/job names, path filters, and required versus advisory behavior. Update it when workflow names, triggers, filters, gates, or scheduled jobs change.

## Pull-request and push CI

| Workflow / job name | Description | Triggers | Filter / gate behavior |
|---|---|---|---|
| CI / detect changed paths | Selects publish-relevant changes | PR, `main` push, merge queue | Always runs; outputs `publish` |
| CI / lint + format | Lint, format, unit tests, decisions, gate contract | PR, `main` push, merge queue | Always runs; unit tests are intentionally unfiltered |
| CI / publish gate — `<os>` | Package/native build gate on Windows, Linux, macOS | PR, `main` push, merge queue | Runs only when `publish` is true; aggregate status is reported by CI gate |
| CI / CI gate | Aggregate CI status | Same CI triggers | Always reports; filtered publish work is not applicable, not a failure |
| E2E / detect changed paths | Selects independent E2E groups | PR, `main` push, merge queue, manual | Always runs; outputs `installer`, `updater`, and `core` |
| E2E / build dev snapshot | Builds shared updater snapshot | Same E2E triggers | Runs when `updater` or `core` is true |
| E2E / installer E2E — `<os>` | Installer API/UI tests | Same E2E triggers | Runs when `installer` is true |
| E2E / helper E2E — ubuntu-latest | Elevated helper-copy test | Same E2E triggers | Runs when `updater` is true; helper source is part of updater-impacting paths |
| E2E / updater E2E — `<os>` | Updater tests on supported OSes | Same E2E triggers | Runs when `updater` is true |
| E2E / updater E2E — `<browser>` — windows-latest | Advisory fork-browser updater tests | Same E2E triggers | Runs when `core` or `updater` is true; browser-specific dispatch can select one browser |
| E2E / E2E gate | Aggregate E2E status | Same E2E triggers | Always reports; installer, updater, and core groups are independently classified |
| AI review (Groq) / Groq AI review | Advisory AI review | PR opened, synchronized, reopened | No path filter currently; API-key absence skips work |

### Filter ownership

| Output | Intended paths |
|---|---|
| `publish` | `core/**`, `config/installer.conf`, `installer/**`, `tools/publish/**`, packaging dependencies, `.github/actions/**`, and CI workflow files |
| `installer` | Installer implementation/web/API files and `test/e2e/installer/**` |
| `updater` | `core/chrome/utils/updater/**`, `installer/src/helper/**`, updater shared helpers/tests, and updater workflow/action files |
| `core` | Browser-chrome/core files and core smoke tests; shared E2E infrastructure may conservatively select all affected groups |
| `browser-downloads` | `test/e2e/shared/downloads.mjs`, watchdog tooling, and watchdog workflow files |

`installer/src/helper/**` belongs to the updater group because the helper binary is used by updater installation flows. Its helper E2E remains a separate job, but shares the updater filter.

Unit tests remain part of the always-running `CI / lint + format` job because they are fast and do not justify another filter.

## Scheduled and manual workflows

| Workflow / job name | Schedule / trigger | Purpose | Download behavior / filter |
|---|---|---|---|
| URL watchdog / check browser download URLs | Weekly Monday schedule, manual dispatch | Checks vendor versions, endpoint health, baseline, and issues | Always checks APIs and a 1 KB range; full download + SHA-256 only on first baseline or a new version |
| URL watchdog / browser download URLs (PR) | PRs touching the download map, merge queue | Stateless download-map validation | No baseline, issue creation, or full downloads; always green |
| Cache cleanup / prune | Weekly Sunday schedule, manual dispatch | Removes stale Actions caches | Maintenance only; no PR trigger |
| Pages publish / capture pre-run hash manifest | Manual dispatch | Captures release baseline | Publish workflow only |
| Pages publish / publish — windows binaries | Manual dispatch | Publishes Windows artifacts | Serialized after baseline |
| Pages publish / publish — linux binaries | Manual dispatch | Publishes Linux artifacts | Serialized after Windows |
| Pages publish / publish — mac binaries | Manual dispatch | Publishes macOS artifacts | Serialized after Linux |

When the watchdog detects a new browser version, it should dispatch targeted updater compatibility E2E for that browser rather than the entire suite. Firefox, Firefox Dev Edition, LibreWolf, Floorp, and Zen map to their corresponding browser-matrix test; Waterfox remains issue-only until it has an automated install recipe.

## Main observations

| Area | Current behavior | Recommendation |
|---|---|---|
| Watchdog unchanged browser | Vendor API, URL resolution, and 1 KB range request; no full installer download | Keep; checks are inexpensive |
| Watchdog new browser version | Temporary full installer download and SHA-256, then deletion | Keep for the integrity ledger |
| Watchdog baseline cache | Stores only `.watchdog/baseline.json` | Keep, but recognize cache eviction causes rebaseline downloads |
| Watchdog timeout | No explicit job timeout | Add `timeout-minutes: 10` |
| E2E browser installer cache | Cache keys include OS/browser/resolved URL; cached installers are reused | Keep; installation still runs per job |
| CI publish gate | Current matrix allocates three runners even when steps become no-ops | Use independent `publish` selection with an always-report aggregate |
| E2E filtering | One broad boolean selects all E2E jobs | Use independent installer, updater, and core outputs |
| Helper E2E | Helper job currently follows the broad E2E filter | Tie it to `updater`, since updater uses the helper binary |
| Browser matrix | Four advisory Windows jobs follow the broad E2E filter | Restrict to core/updater changes or a targeted watchdog dispatch |
| Unit tests | Included in the fast static job | Do not filter |
| Aggregate gates | Required status needs stable reporting when work is filtered | Keep always-running gate jobs and classify filtered groups as not applicable |
| AI review | Runs on every PR synchronization | Consider a path filter later if review latency/cost matters |
| Publish workflow | Three platform jobs are serialized | Keep serialization unless publishing becomes conflict-safe |
