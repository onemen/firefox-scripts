# Phase 4 — E2E Test Matrix

> **Historical context** — this is the original E2E plan from the `feat/e2e-orig` branch, ported
> verbatim when the branch was retired. The live state of the E2E matrix is tracked in issue #3 and
> `.github/workflows/e2e.yml`; the harness details below (URLs, runner setup, profile strategy) may
> not match what CI does today.

## Decision: Puppeteer-core + WebDriver BiDi

> The tooling decision is recorded as ADR [0015](./decisions/0015-e2e-puppeteer-bidi.md); this
> section keeps the original rationale verbatim.

**Why not Playwright?** Playwright doesn't ship Firefox nightly/dev-edition builds — it pins
specific revisions. We need to test against the user's actual Firefox, Waterfox, Zen, LibreWolf, and
Floorp installs. Puppeteer-core with WebDriver BiDi connects to whatever Firefox-family build is on
the machine, which is exactly what our users run.

**Why WebDriver BiDi?** Marionette (the older protocol) is deprecated in Firefox 135+ and will be
removed. BiDi is the forward-looking protocol, already supported since Firefox 117, and it's what
geckodriver uses by default for recent builds.

## Matrix

| Browser                   | OS      | Runner                 | Status                            |
| ------------------------- | ------- | ---------------------- | --------------------------------- |
| Firefox stable            | Windows | `windows-latest`       | Hard gate                         |
| Firefox stable            | macOS   | `macos-latest`         | Hard gate                         |
| Firefox stable            | Linux   | `ubuntu-latest` (xvfb) | Hard gate                         |
| Firefox Developer Edition | Windows | `windows-latest`       | Advisory (browser-matrix leg)     |
| Firefox Developer Edition | macOS   | `macos-latest`         | Advisory (no brew cask)           |
| Firefox Developer Edition | Linux   | `ubuntu-latest` (xvfb) | Advisory                          |
| Waterfox                  | Windows | `windows-latest`       | Advisory (no direct URL — manual) |
| Waterfox                  | macOS   | `macos-latest`         | Advisory                          |
| Zen Browser               | Windows | `windows-latest`       | Advisory (browser-matrix leg)     |
| LibreWolf                 | Windows | `windows-latest`       | Advisory (browser-matrix leg)     |
| Floorp                    | Windows | `windows-latest`       | Advisory (browser-matrix leg)     |

**Advisory** = the E2E gate reports a warning instead of failing the PR. The `browser-matrix` legs
(Firefox Dev Edition, LibreWolf, Floorp, Zen) download official installers directly from third-party
hosts — Mozilla's devedition redirect, librewolf.dev's package registry, GitHub release assets —
which can hiccup. The legs are path-filtered like the 3-OS jobs (same updater E2E test, so they skip
on docs-only PRs) and remain advisory when they run. LibreWolf's newest version is resolved from the
Codeberg package registry; Floorp and Zen use stable `/releases/latest/download/` asset URLs.
Waterfox has no direct URL (no GitHub release assets), so its leg stays manual and the URL watchdog
tracks its version only. The hard gate is Firefox stable across all three OSes.

## What each test asserts

### Installer E2E

1. **Binary starts** — `installer_win-dev.exe` / `installer_linux` / `installer_mac` launches and
   the HTTP server binds to a port.
2. **Browser detection** — at least one browser card appears with correct name + version (from
   `application.ini`, not the path).
3. **Install flow** — clicking Install downloads both packages, extracts them, and writes the
   expected files (`config.js`, `config-prefs.js`, `chrome/utils/`).
4. **Token gate** — every `/api/*` route without a valid token returns 401.
5. **Self-update check** — `/api/self_update` with a valid token returns the expected response for
   the current version.
6. **Rescan** — `/api/rescan` triggers a re-detection and returns updated browser cards.

### Updater E2E

1. **UI loads** — `chrome://firefox-scripts/content/scriptsUpdater.xhtml` renders without spinning
   forever (the Firefox 155 regression).
2. **Browser name + version** — the card shows the correct name (from `application.ini` `CodeName`,
   not the folder path) and version (including beta suffix like `154.0b10`).
3. **Update check** — the updater contacts the remote server and shows either "Up to Date" or
   "Update Available" with the correct package URLs.
4. **Install update** — clicking Install downloads the new packages and copies them into the
   profile's `chrome/utils/` directory.
5. **Collapse/expand** — card collapse animation works, status reflects actual state.

## Runner setup

### Windows (`windows-latest`)

- Pre-installed: Firefox stable (via `windows-firefox@latest` action or manual download).
- Dev Edition: downloaded from
  `https://download.mozilla.org/?product=firefox-developer-latest&os=win64`.
- Puppeteer-core + geckodriver: installed via `pnpm install`.
- xvfb: not needed (Windows has a display).

### macOS (`macos-latest`)

- Firefox stable: `brew install --cask firefox`.
- Dev Edition: downloaded from Mozilla's DMG.
- Puppeteer-core + geckodriver: installed via `pnpm install`.
- Display: macOS runners have a display by default.

### Linux (`ubuntu-latest`)

- Firefox stable: pre-installed on the runner.
- Dev Edition: downloaded from Mozilla's tarball.
- Puppeteer-core + geckodriver: installed via `pnpm install`.
- Display: `xvfb-run` wraps the Firefox launch.

## Profile strategy

Each test run uses a **fresh temporary profile** (created via `mktemp -d`). This avoids:

- Locking the user's real profile.
- Leftover state between runs.
- Contamination from prior test failures.

The test script:

1. Copies a minimal `prefs.js` + `user.js` into the temp profile.
2. Copies the `chrome/` tree (utils + fx-folder) that `upload:local --mode=dev` produced.
3. Launches Firefox with `-profile <temp>`.
4. Connects puppeteer-core via WebDriver BiDi.
5. Navigates to the updater xhtml page.
6. Asserts the expected behavior.
7. Kills Firefox and cleans up.

## Timeline

1. **PR**: implement the hard-gate subset (Firefox stable × 3 OSes).
2. **Follow-up PRs**: add advisory entries for Dev Edition, Waterfox, Zen, LibreWolf, Floorp as
   CI-friendly download URLs become available.
3. **Release gate**: all hard-gate entries must be green before v1.0 tag.
