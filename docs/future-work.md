# Firefox Scripts — Future Work & Testing Automation

Status: **Roadmap** — items below are the remaining hardening tasks for the installer and the
in-browser auto-updater. The updater is implemented (see `docs/auto-updater.md` for the design); the
hash-based status logic is in `docs/status-logic.md`.

Each section links to its tracking issue under the
[Post-v1.0 umbrella (#38)](https://github.com/onemen/firefox-scripts/issues/38).

## 1. Updater end-to-end test list

The updater UI is now a shipped package (ADR
[0007](./decisions/0007-updater-ui-ships-as-package.md): `updater-ui.zip` →
`chrome/utils/updater/ui`), updated by `scriptsUpdater.sys.mjs` (`ensureUpdaterUi`) before the tab
opens. The E2E suite in `test/e2e/` (`pnpm test:e2e`) automates the installer and updater flows on
CI.

> **Note:** §1.1–§1.4 describe the desired test coverage. Many are already implemented in the E2E
> suite on `main`; the remaining gaps are tracked as individual checklist items. §1.5 (Firefox 155
> chrome-frame probes) was moved to the
> [Historical appendix](#historical-firefox-155-chrome-frame-probes-obsolete) — the updater no
> longer uses iframes.

### 1.1 Detection & notification

- [x] **Hash parity:** the JS hash (`computeFilesHash`) equals the C installer's `--test-hash`
      output and the publish scripts' hash for the same directory (see
      `installer/test/test_hash.mjs`).
- [x] **Clean install → detection:** a fresh profile reports **Not Installed**; after installing
      utils/fx-folder/updater-ui → **Up To Date**; after touching one file → **Update Available**.
- [x] **Daily gate:** the tab opens at most once per day (`lastUpdateTabShown`); it does NOT open
      when everything is current, and does NOT open when only `updater-ui` changed (self-update is
      silent).
- [ ] **Decision pref:** `lastScriptsCheckDate` is set only on install / skip / "Remind me Tomorrow"
      / restart — closing the tab without acting records nothing.
- [ ] **Skip prefs:** `skippedHash.fx-folder` / `skippedHash.utils` suppress the pending update for
      that exact hash and are cleared when the remote hash changes or local files match.
- [ ] **Session restore:** a tab restored from a session (manual restart with the tab left open)
      re-runs the real hash check and renders the truth, never a stale "All packages are up to
      date.".
- [x] **Single instance:** the scheduler and the engine both guard against a second updater tab.

### 1.2 updater-ui self-update

- [x] **Missing UI + utils/config update:** `ensureUpdaterUi` downloads, hash-verifies and extracts
      `updater-ui.zip` into `chrome/utils/updater/ui`, then opens the tab.
- [x] **Stale UI:** an installed `updater-ui` whose hash no longer matches the manifest is
      re-downloaded before the tab opens.
- [x] **Missing remote package:** when `updater-ui.zip` cannot be fetched (404 / offline), the check
      exits silently — no tab, no error UI — and the daily check retries later.
- [x] **Hash mismatch:** a downloaded `updater-ui.zip` that fails verification is discarded; the old
      UI (if any) is kept.
- [ ] **Old manifest:** a manifest without an `updater-ui` entry keeps the installed UI as-is.

### 1.3 Install flows (from the tab)

- [x] **Utils install:** download → extract → verify → copy into `ProfD/chrome/utils`; restart loads
      the new files.
- [x] **Config install, portable install** (user-owned `GreD`): direct `IOUtils` copy, no elevation.
- [x] **Config install, admin install** (Windows Program Files): elevated-copy helper, exactly one
      UAC prompt, files land in `GreD`.
- [x] **Elevation cancelled:** helper exit `2` → "elevation cancelled", nothing written.
- [x] **Zip hash mismatch:** a zip whose extracted hash differs from the manifest is rejected before
      any copy.
- [x] **Failure paths:** manifest unreachable, zip download failure, helper download failure — each
      produces a visible in-tab message, not a silent hang.
- [x] **Manual download:** the "configuration files" / "utils" links fetch the zip and serve it via
      a blob URL without navigating the tab.

### 1.4 Installer (updater-ui rides along with utils)

- [x] **utils selected:** the installer fetches + POSTs `updater-ui.zip` alongside `utils.zip` and
      extracts it into `chrome/utils/updater/ui` — with no updater-ui checkbox or status text in the
      UI.
- [x] **updater-ui fetch failed:** the installer still installs utils/config (updater-ui is
      optional; the updater self-heals later).
- [x] **utils up to date / not selected:** updater-ui is not installed (it is not a separate
      selectable component).

## 2. Admin-rights (UAC) flow

> Tracked in [#32](https://github.com/onemen/firefox-scripts/issues/32).

The config-install path (`config.js` / `config-prefs.js` → browser install dir) is the riskiest
part: on Windows it requires elevation into `C:\Program Files\...`. Today it is only exercised
manually.

### 2.1 Manual matrix (current)

| Scenario                      | Browser dir                        | Expectation                                                                                                                                                                                                                                      |
| ----------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Portable / user-owned install | e.g. `D:\firefox`                  | Direct `IOUtils.copy` — no helper, no UAC. (automation tracked in #56)                                                                                                                                                                           |
| Standard Windows install      | `C:\Program Files\Mozilla Firefox` | Direct copy fails → elevated-copy helper → exactly one UAC prompt → files land.                                                                                                                                                                  |
| Elevation cancelled           | —                                  | Helper exits `2` → tab shows "elevation cancelled", nothing written.                                                                                                                                                                             |
| Linux (deb/rpm)               | `/usr/lib/firefox`                 | `pkexec` prompt once (fallback `sudo`).                                                                                                                                                                                                          |
| Linux snap                    | `/etc/firefox`                     | Verified by the snap E2E leg (#55): the CI job installs the snap build, reports `findGreDir()` (`/etc/firefox`) vs the actual snap layout in the step summary, and hard-fails when they diverge. Elevation into the snap GreD stays manual (§2). |
| macOS                         | `Firefox.app/Contents/Resources`   | `osascript` prompt once.                                                                                                                                                                                                                         |

### 2.2 Automated (planned, tool undecided)

The matrix above should run against real published `latest` zips on Windows / Ubuntu / macOS ×
(Firefox stable, Firefox ESR, Waterfox) × (protected dir, portable dir). Windows elevation cannot be
automated on hosted runners (the UAC prompt is an OS-level UI) — it needs a self-hosted runner, a
VM, or a non-elevated user running against an admin-owned install dir. The automation tool
(Puppeteer / Playwright / Firefox CDP) is deliberately not decided here.

- **Helper binary trust — shipped (#174):** `upload.mjs` publishes a `helper_<platform>.sha256`
  sidecar next to each helper (`hashUtils.mjs::helperSha256Sidecar`), and the updater fetches and
  verifies it before executing the helper, refusing to run a mismatch
  (`tools/publish/remote-ui/updater.js`; `docs/auto-updater.md` §6).
- **Trigger:** the elevation matrix above still has no automation. The browser legs that do exist
  run from `.github/workflows/e2e.yml` — every PR, every `main` push, the merge queue, plus manual
  dispatch — path-filtered on the subsystems each leg exercises. There is no nightly job.

## 3. Publish pipeline tasks

> Tracked in [#33](https://github.com/onemen/firefox-scripts/issues/33).

- [x] Re-add a `.github/workflows/build-and-upload.yml` action: a Windows/Linux/macOS build matrix
      (each OS runs `upload` for its platform and stages the binaries) + one upload job that
      publishes the staged set, for fully automated cross-platform publishing. (Landed as a
      manual-dispatch workflow alongside pages.yml: parallel stage-only build matrix via
      `upload.mjs --build-only` + native AV per platform, then a single-writer publish job via
      `--skip-build`; stage-only is the default — publishing needs `publish=true` at dispatch. The
      deterministic-output check ships in the same workflow, advisory.)
- [x] Publish a `helper_<platform>.sha256` asset alongside the helper binaries and assert the
      downloaded binary matches it (see §2.2 helper-binary trust). Shipped in #174.

Staging publish target — mostly shipped, remainder folded here: `paths.js` already reads env
variables over `installer.conf` (`cfg()` precedence) and `--mode=dev` provides the safe dev-build
channel. Still open from the original plan: a **STAGING banner + guard** when env overrides redirect
publish targets away from prod (fail or warn loudly), and **`.env-example` documentation of the
staging keys** (`REPO_OWNER`, `ZIP_PAGES_BRANCH`, `RELEASE_NAME`, `HASHES_URL`, …). Tracked under
#33 with the pipeline work.

Items below shipped in v1.0 and are kept for reference:

- ~~Compile + upload the installer and helper binaries~~ (shipped: `upload.mjs` builds + uploads all
  three platforms).
- ~~The updater tab UI is published as a third package, `updater-ui.zip`~~ (shipped; ADR
  [0007](./decisions/0007-updater-ui-ships-as-package.md)).
- ~~`versionInfo.json` stopped shipping~~ (shipped; `obsolete_files.h` cleans existing copies — ADR
  [0001](./decisions/0001-versioninfo-and-gist.md)).
- ~~Zips published to the `firefox-scripts` repo~~ (shipped: `ZIP_DOWNLOAD_REPO=firefox-scripts`).

### Generated-file consistency (resolved — nothing tracked to drift)

The generated files (`updater-config.sys.mjs`, `updater.css`, `_config.h`, `resources.h`) are
**untracked** and regenerated on demand by the Makefile / `createZip.mjs`, so the old commit-time
sync problem is gone — there is nothing tracked that can drift (see ADR
[0008](./decisions/0008-generated-files-untracked.md)). What a future CI job should verify instead:

- **Deterministic publish output:** run `upload:local --mode=prod` (or the generators) and fail if
  the produced snapshot (hashes, zips, manifest `files` lists) differs between runs.
- **Build matrix:** the §3 multi-platform binary build (each OS compiles its own installer/helper).

## 4. Installer UI polish

> Tracked in [#34](https://github.com/onemen/firefox-scripts/issues/34).

- [ ] Expand/collapse all controls in the browser cards.
- [ ] Scan all profiles and binaries using cityhash for faster status (currently one SHA-256 per
      package per profile).
- [ ] Test on Linux with and without snap (snap covered by the E2E snap leg, #55); test on macOS
      (both Intel and arm64).

## 5. Updater UX follow-ups

> Tracked in [#34](https://github.com/onemen/firefox-scripts/issues/34).

- [ ] Manual-verification fallback when the elevated-copy helper download/elevation fails (show
      copy-paste instructions with the exact source/destination paths).
- [ ] Verify the tab's per-file progress reporting and the "Restart to apply" flow in a real profile
      (currently requires a live browser).
- [ ] Re-verify the `skippedHash.*` clearing logic when the remote hash changes or local files
      match.

## 6. Test infrastructure

Test-infrastructure gaps verified **not implemented on `main`** and **not covered** by #3 / #4 / #38
as of 2026-09-15. The proposed tracking home is listed per item.

- **`msys2/setup-msys2` release caching** — every Windows leg now pins `update: false` (`ci.yml`,
  `pages.yml`, `build-and-upload.yml`): a mid-cycle toolchain upgrade moved gcc 16.1.0 → 16.2.0 and
  the rebuilt `installer_win.exe` was falsely flagged by Defender's ML the next day, so the AV scan
  gate — not `pacman -Syu` — is the enforcement. `cache: true` would trade freshness for minutes per
  job (same trade the cached `-fanalyzer` leg already made, PRs #105/#106). Home: #33 (pipeline
  automation) or as CI polish under #4.

### Resolved since the 2026-09-05 pass (kept for reference)

- ~~**Installer `--port 0` / `--server-only` test flags** and the **`env.json` deployment
  manifest**~~ — shipped together in #141: `installer/src/main.c` gained `--smoke-test`,
  `--server-only`, `--port` and `--env-file`, and `write_env_manifest()` writes the manifest when
  `--env-file` is passed (after the session token exists). Installer API-contract coverage rides on
  them — `test/e2e/installer/smoke-security.mjs` spawns the binary with `--smoke-test`, and
  `test/unit/e2e/apiRouteContract.test.mjs` diffs the registered `/api` routes against the gated
  sets.
- ~~**E2E profile/process hygiene**~~ — shipped in #155 (`test/e2e/shared/processHygiene.mjs`:
  `killStrayProcesses()`, `removeProfileCompatibilityIni()`, `closeBrowser()`; unit tests in
  `test/unit/e2e/processHygiene.test.mjs`) — deterministic repeat runs on all three OSes.
- ~~**`FIREFOX_BINARY` pinning**~~ — resolved by decision rather than by a pin: E2E keeps tracking
  the newest vendor release at run time, with `BROWSER_PIN_VERSION` as the manual escape hatch (ADR
  [0023](./decisions/0023-e2e-browser-version-pinning.md), #154).
- ~~**Test runner + layout decision** (`node:test`, type-first `test/`)~~ — settled: PR #52.

## Historical: Firefox 155 chrome-frame probes (obsolete)

> The updater no longer uses iframes — the UI is a shipped chrome-privileged package
> (`updater-ui.zip`). This section is kept for architectural context on _why_ the switch was made.
> Periodic re-validation of the chrome-document embedding model belongs under the core-test Nightly
> leg ([#30](https://github.com/onemen/firefox-scripts/issues/30)).

Firefox 155 hardened frame-principal inheritance in system-principal chrome documents, which broke
the previous hosted-iframe updater UI (see ADRs [0006](./decisions/0006-hosted-remote-updater-ui.md)
and [0007](./decisions/0007-updater-ui-ships-as-package.md)). The following probes all failed in
155:

1. `iframe` + `srcdoc` (attribute before/after append, and the `.srcdoc` property) → stays
   `about:blank`.
2. `iframe` + `document.write` → `SecurityError: The operation is insecure`.
3. `iframe` + `data:` / `blob:` URL → stays `about:blank`.
4. `iframe` + `sandbox="allow-scripts"` with srcdoc/data: → stays `about:blank`.
5. XUL `<browser type="content">` / `<iframe type="content">` via `document.createXULElement` →
   stays `about:blank`.
6. No `load` event, no `securitypolicyviolation` event; `contentDocument` readable but empty.
