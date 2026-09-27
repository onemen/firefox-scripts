# E2E tests

Part of the [Developer guide](./DEVELOPING.md). This file was split out of the guide to keep it a
checklist that points; the content is authoritative here.

## Running the E2E suite (`pnpm test:e2e`)

End-to-end tests verify the installer HTTP API, the elevated-copy helper, and the in-browser updater
tab across multiple scenarios. They require a `snapshot:dev` snapshot first.

### Quick start

```bash
# Build a dev snapshot (needed once)
pnpm snapshot:dev

# Run all E2E tests (installer HTTP + updater scenarios)
pnpm test:e2e

# Installer only (HTTP layer — fast, no browser needed)
pnpm test:e2e:installer

# Updater only (opens Firefox — see config below)
pnpm test:e2e:updater

# Legacy chrome lifecycle (runs in CI: the `core lifecycle E2E` job on every
# core/updater PR — all 3 OSes, portable Firefox). Local run needs a Firefox
# with a writable GreD (PORTABLE_BROWSER_DIR or a portable copy).
pnpm test:e2e:legacy
```

### Pre-push local gate (`pnpm test:e2e:prepush`)

Convention (2026-09-22): **before pushing changes that need an E2E test to a PR, run one updater leg
locally** — the embarrassing failures surface in ~1-2 minutes instead of a ~6-minute CI round-trip.
The gate is a convenience, not the CI gate: the full matrix still runs (and stays authoritative) in
CI.

```bash
pnpm test:e2e:prepush                 # snapshot (reuse or build) → one updater leg on Nightly
pnpm test:e2e:prepush -- --firefox "C:/path/to/firefox.exe"   # explicit browser override
```

Behavior: reuses the newest `dist/` snapshot matching the current branch; if there is none it builds
one via `pnpm snapshot:dev` — which requires a **clean worktree, so commit your changes first**
(that is the intended flow: you are about to push anyway). The leg runs on **Nightly** — resolution
order: `--firefox`/`E2E_PREPUSH_FIREFOX`, then the portable nightly from
`pnpm e2e:portable nightly`, then the installed Nightly (`C:\Program Files\Firefox Nightly`). Some
scenarios (e.g. scenario 9's GreD-writability caveat) self-skip when the local environment cannot
run them, mirroring CI's PR legs.

The orchestrator (`run.mjs`) passes `--snapshot <dir>` to child scripts automatically; individual
scripts can also be invoked directly:

```bash
node test/e2e/installer/installer-e2e.mjs --snapshot dist/dev-main-abc1234
node test/e2e/updater/updater-e2e.mjs --firefox "/path/to/firefox" --snapshot dist/dev-main-abc1234
```

Repeat runs need no manual cleanup (issue #130): each script sweeps stray browser/installer
processes from a previous run before starting (anything whose command line references the harness's
temp dirs or the built installer binaries), profiles are created fresh per scenario with
`compatibility.ini` removed, and `closeBrowser` waits for the OS process to exit before the next
scenario starts. To prove determinism, run the updater selection twice in a row with one command:

```bash
node test/e2e/updater/updater-e2e.mjs --snapshot dist/dev-main-abc1234 --repeat 2
```

### Installer E2E

Starts the installer in `--smoke-test` mode and exercises every state-changing `/api` route: token
gate (missing, wrong, valid), CORS absence, ping, browsers, rescan, status, self-update, and the
install/close-browser/manifest gated routes. No browser required.

A second layer (on by default; `--no-test-surface` skips it) exercises the #129 installer test
flags: `--port 0` binds an OS-ephemeral port reported through the `--env-file <path>` manifest
(port, session token, run id, UI URL — no port scraping), `--port <fixed>` binds that port, and a
plain second installer defers to the one already serving the default port without opening a tab
(`--server-only` skips the browser scan and never touches a browser, so the layer is hermetic).

The optional `--ui` flag launches a real Firefox instance and verifies the web UI renders browser
cards with correct status badges, but this is slower and requires a display.

### Updater E2E

Each step: fresh temp profile → seed `chrome/utils` from the snapshot → optionally delete files or
modify prefs to force a specific state → launch Firefox via puppeteer-core + WebDriver BiDi → wait
for the updater tab to auto-open → assert the card renders the expected status, all 8 buttons are
present, checkbox wiring works, and no page/console errors appeared.

| Id       | Seed (fixture)                                                                                                                                                                                    | Expected (assertions)                                                                                                                   |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1 (4, 5) | ONE browser, five variants (#309 driver mode): marker on `RDFDataSource.sys.mjs` + GreD probe, then per variant a disk/pref flip — utils stale → config stale → both stale → up-to-date → skipped | each check's own decision (stale: the tab opens; up-to-date/skipped: no tab AND the day recorded, #333) + the full card set per variant |
| 6        | utils marker + GreD probe (both stale)                                                                                                                                                            | `btn-install` copies both packages; installed trees re-hash to the manifest; badges/banner flip                                         |
| 7        | hand-installed pre-updater `utils.zip` (no `updater/`), then the real one                                                                                                                         | no tab with the old utils; tab after the manual replace                                                                                 |
| 8        | hand-installed `utils.zip` + no `ui/` folder                                                                                                                                                      | scheduler self-installs the UI (`ensureUpdaterUi`) and the tab renders                                                                  |
| 9        | fx-folder in an ACL-write-denied GreD (Windows)                                                                                                                                                   | tab-open proof, ACL block, and that nothing was copied without elevation                                                                |
| 10       | stale utils, one launch, timer observed                                                                                                                                                           | the daily in-session re-check timer fires (startup + ≥2 re-fetches)                                                                     |

Step 1 is one browser for five state-only variants (#309 driver mode): after the startup check opens
the tab (the wiring under test), the harness opens a privileged in-browser driver page
(`test/e2e/shared/updaterDriver.mjs`, seeded into the profile's `updater/` dir — never shipped, so
no package hash changes) and drives the production orchestrator from there: clear the daily gate,
mutate the disk fixture / skip pref, call the exported `checkForUpdates()`, and assert the decision
(tab opened or not, the day recorded) plus the card the resulting tab renders. Behind the scenes:
`checkForUpdates()`, the export added for this, and the daily-gate pref (a user pref, writable
in-page — ADR 0012).

Step 1 is wrapped in a retry-once guard with a fresh profile: a browser-internal startup race
(observed on waterfox, run 35460461221) would otherwise fail every variant at once. The retry logs
its own `[retry]` lines; a second failure fails the leg. Card-assertion failures are deterministic
and never retried. Full card assertions additionally require WebDriver BiDi to attach to the trusted
chrome:// tab; on runners where it cannot, the leg verifies the tab-open via the probe mirror /
persisted pref and says so in the check label (the pre-#309 session could not assert a card there
either). Where the tab _is_ attachable but the driver realm never comes up, the stale trio falls
back to the pre-#309 in-tab re-render loop (`assertStaleTrioInTab`) and up-to-date/skipped fall back
to their own launches (`runNoTabScenario`) — driver mode degrades by capability, never by coverage.
Skip individual steps during iteration with `--scenario 1,6,9` (step 1 includes all five variants;
`--scenario 4` / `--scenario 5` select the same session).

### Running the updater E2E locally (e.g. on Nightly, Windows)

The scenarios write fx-folder's `config.js` into the browser's install dir, so the browser under
test needs a **user-owned install dir**. CI's runners are admins and can write Program Files; a
normal account cannot, and the scenarios then fail with `EPERM` — so install a portable copy first
(the run warns when the GreD is not writable). `pnpm e2e:portable` downloads the browser's official
build into `Documents/FireFox/portable/<browser>` (`~/.cache/firefox-scripts-e2e/<browser>` off
Windows), reuses it on later runs, and prints the `FIREFOX_BINARY` line to export. Nothing is
installed system-wide: on Windows the setup exe is **unpacked with 7z** (its `core` folder is the
install dir) — the installer is never executed, so there is no Add/Remove Programs entry and no
`Mozilla` registry keys; Linux uses the tarball and macOS the DMG, copied into the destination:

```bash
pnpm e2e:portable nightly                    # or: firefox, firefox-dev, a fork
#   → ✓ nightly ready: /c/Users/you/Documents/FireFox/portable/nightly/firefox.exe
pnpm e2e:portable nightly --dir /c/tmp/portable-nightly   # explicit destination

export FIREFOX_BINARY="/c/Users/you/Documents/FireFox/portable/nightly/firefox.exe"
pnpm snapshot:dev              # build the snapshot for this branch
pnpm test:e2e:updater -- --no-branch-check   # one updater leg on that browser
pnpm test:e2e                                # installer + updater
```

The snapshot is the newest `dist/` one (`--snapshot <dir>` picks explicitly, `--no-branch-check`
accepts a snapshot from any branch — the direct script never branch-checks).

`--keep-profile` keeps each scenario's profile for inspection, `--repeat 2` runs the whole selection
twice (determinism check), `--scenario 1,6,9` narrows the run, and `--no-fail-fast` runs every
scenario even after a failure.

### Updater E2E scenario 9 (helper-checksum-win, Windows)

Scenario 9 is the helper path: it seeds fx-folder into the GreD, ACL-denies the seeded config files
so the updater's direct copy must fail, and asserts the scheduler decided "update available", that
the write really is blocked, and that nothing was copied without elevation. It runs on every Windows
leg and self-skips elsewhere.

It also needs a **user-owned install dir**, because the fixture has to write `config.js` into the
browser's GreD. GitHub's Windows runners are admins and can write Program Files; a normal account
cannot, so use a portable copy — `pnpm e2e:portable` installs one (see above).

```bash
pnpm e2e:portable nightly
node test/e2e/updater/updater-e2e.mjs --scenario 9 \
  --firefox "$HOME/Documents/FireFox/portable/nightly/firefox.exe"
```

What it can prove headless: the tab-open decision (proven by the probe mirror, or by the
`extensions.firefox-scripts.lastScriptsCheckDate` pref — written by the shown tab, read after the
browser closes, because prefs.js is flushed at shutdown and BiDi cannot enumerate the trusted
`chrome://` tab on many hosts), the ACL block, and that the GreD config stayed byte-identical. The
download → checksum → magic-gate → spawn flow itself only runs where BiDi _can_ attach to the
trusted tab (elsewhere the leg says so in its check labels), and elevation never completes headless.
The gate's byte-level contract is therefore covered deterministically on every OS by
`test/unit/publish/branchPagesContract.test.mjs`, which evaluates the shipped gate expression
against real PE/ELF/Mach-O headers and HTML payloads.

### Configuration

Copy `test/e2e/shared/config.example.mjs` to `e2e.config.mjs` at the repo root (gitignored) and
adjust:

- `browsers`: which browsers to run the updater test against (name + binary path; omit `binary` to
  auto-detect).
- `branchCheck`: `'strict'` (default — snapshot must match the current branch) or `'off'`.
- `headless`: launch Firefox headless (Linux CI uses `xvfb-run` instead).
- `keepProfile`: keep temp profiles after a run for debugging.

CLI flags win over environment variables, which win over the config file.

### CI matrix

The per-job inventory of `.github/workflows/e2e.yml` — descriptions, triggers, path filters, and
advisory-vs-required gate semantics — lives in [docs/ci-inventory.md](./ci-inventory.md), the single
source kept in sync with the workflows (this summary table used to drift every time a leg was
added). In short: the installer, helper, and updater legs are the hard gate (updater runs the
Firefox stable/Dev/Nightly matrix plus the required waterfox leg, ADR 0025), while the fork-portable
and snap legs are advisory.

`docs/e2e-matrix-plan.md` is historical context — the browser × OS expansion it planned has shipped
(#194, #199); the live scope is tracked in issues #3 and #38.

### Manual escape — testing a browser CI cannot fetch (`ci-downloads`, ADR 0021)

When every vendor mirror for a browser's installer is down (or a version must be tested before the
resolver can see it), push the installer file straight to GitHub and let CI test it — the file is
typically the one your local firefox-updater already downloaded:

```bash
pnpm ci:download -- librewolf-155.0-1-windows-x86_64-setup.exe
# inference override when the filename is ambiguous:
pnpm ci:download -- "Waterfox Setup 6.7.1.1.exe" --version 6.7.1.1
```

#### Download timeouts for slow runners (`test/e2e/shared/downloads.mjs`)

`downloadTo` — used by every CI installer fetch and the watchdog's full-download verification — is
**progress-aware** (issue #143): it streams to disk and aborts only when **no bytes advance for the
stall window**, never on a healthy-but-slow transfer (the same 158 MB LibreWolf installer took 13 s
from CI runners and 5.5 min over a home link). Interrupted attempts resume via a Range request
instead of restarting from byte 0, and a 10 MB-interval heartbeat (`MB downloaded (KB/s)`) in the
log shows the transfer is alive.

Three environment variables tune it — the defaults fit every observed runner; override only for an
unusually slow CI link:

| Variable                    | Default          | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DOWNLOAD_STALL_TIMEOUT_MS` | 60000            | Abort the attempt when no bytes arrive for this long. A 0.3 MB/s trickle delivers a chunk every ~2 s and is never killed — only a dead stream trips it.                                                                                                                                                                                                                                                                                                 |
| `DOWNLOAD_TOTAL_BUDGET_MS`  | 1200000 (20 min) | Wall-clock budget across all 5 attempts (retries resume, so slow links still complete). **Must leave room inside the calling job's `timeout-minutes`** — the budget has to fire first, or the runner kills the job and the failure reads as a bare cancellation. `e2e.yml` sets 720000 (12 min) for its 20-minute browser legs; the watchdog's 30-minute `check` job keeps the default. `test/unit/tools/download-budget.test.mjs` enforces the margin. |
| `DOWNLOAD_RETRY_BACKOFF_MS` | 5000             | Wait between attempts.                                                                                                                                                                                                                                                                                                                                                                                                                                  |

Each is read per call, so a workflow step can set one (e.g. `env: DOWNLOAD_TOTAL_BUDGET_MS: 1500000`
— 25 min, still inside the watchdog job's 30-minute timeout — on a known-slow runner) without
touching the others. When the budget does fire, an advisory browser leg does not fail: it logs the
reason and reuses the previously downloaded installer from the cache (`findCachedInstaller`), so the
leg tests the previous release and the gate reports the warning instead of a dead job.

The script creates the fixed-tag **`ci-downloads`** release on demand, uploads the asset under the
resolver's expected name, and dispatches `e2e.yml` with `browser` (+ optional `version`) — a
single-browser updater-E2E run. CI's `cleanup-ci-downloads` job deletes the consumed asset
afterwards and the release + tag once empty, so the steady state is "the release does not exist".
Extra flags: `--no-dispatch` (upload only), `--clean` (delete release + tag now).

### Browser version pinning (ADR 0023)

The E2E matrix resolves the _latest_ browser release at run time — by design (ADR 0023): the URL
watchdog → E2E dispatch → validated-versions → drift-gate chain exists to validate each new vendor
release, so a vendor update flipping CI is signal. To reproduce or test a specific version, pin a
single-browser dispatch with a `version` input (`pnpm ci:download -- <installer> --version <v>` does
it as part of the manual escape; it sets `BROWSER_PIN_VERSION`). Pin semantics are strict: a pinned
run is served only by sources that can express the exact version — version-embedded mirror URLs and
the `ci-downloads` asset. Version-agnostic sources (floorp/zen's `/releases/latest/download/` URLs)
are skipped under a pin, so a pinned floorp/zen leg requires the exact installer uploaded to
`ci-downloads` and fails loudly otherwise. Firefox stable / Dev Edition / Nightly are not pinnable
(their official endpoints are version-agnostic redirects). Whatever a leg installed,
`downloads.mjs --installed-version` reads the version from the binary itself — the recorded ground
truth.

A partial (single-browser) dispatch deliberately skips the validated-versions recorder — it cannot
fabricate E2E coverage for firefox/firefox-dev, so it can never satisfy the publish gate on its own.
A FULL dispatch (browser input unset or `all`) is the post-release re-validation escape: the path
filter sees no commit diff on a dispatch, so the `changes` job forces the firefox/firefox-dev
updater legs to run against `main`, and the recorder then records the EXACT versions those legs
installed — read from each installed binary (`downloads.mjs --installed-version`), never re-resolved
live. The recorder runs only when those legs actually ran and passed: a core-only push records
nothing. `pnpm ci:download -- --clean` removes a release that was created but never consumed.
