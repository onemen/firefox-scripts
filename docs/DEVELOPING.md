# Developer Guide

This project is not a monorepo — it is a single-project repo with several components (installer,
publish scripts, chrome scripts, web UI) that are versioned and released together. All of them serve
one goal: installing and updating Firefox scripts for legacy extension support.

## Repository structure

```
├── core/
│   ├── chrome/utils/       Chrome scripts loaded by Firefox
│   │   ├── updater/        In-browser updater scheduler (scriptsUpdater.sys.mjs,
│   │   │                   updater-config.sys.mjs; the tab UI lives in tools/publish/remote-ui/)
│   │   └── BootstrapLoader.js     Bootstraps the chrome set; inits scriptsUpdater
│   ├── fx-folder/          Config files (config.js, config-prefs.js)
│   └── chrome.manifest     Chrome registration
├── installer/              C installer application (cross-platform)
│   ├── src/                C source files & headers (+ helper/ elevated-copy binary)
│   ├── web/                Web UI served by the installer
│   ├── Makefile            Build targets (win, linux, mac)
│   └── embed.mjs           Embeds web assets into C resources.h
├── tools/publish/          Release-publishing scripts (Node.js)
│   ├── upload.mjs          upload / upload:local: hash diff → rebuild changed zips +
│   │                       binaries → upload release assets + Pages → update hash
│   │                       manifest (--mode=prod|dev, --local/--force, --ci/--platform=)
│   ├── createZip.mjs       Zip creation helpers (fx-folder.zip, utils.zip, updater-ui.zip)
│   ├── generateUpdaterConfig.mjs  Regenerates updater-config.sys.mjs from installer.conf
│   ├── syncGeneratedFiles.mjs     Regenerates the generated files (untracked, on demand)
│   ├── gitignoreUtils.mjs  File-listing with gitignore support
│   ├── hashUtils.mjs     Directory hashing & gh-pages hash manifest
│   ├── publishMode.mjs   --mode=prod|dev gate, dev-build-<id> identity, -dev suffix
│   ├── publishCommon.mjs  Shared token/branch-gate/date/gitignore helpers
│   ├── uploadUtilsZip.mjs  GitHub release-asset helpers (library)
│   ├── uploadToPages.mjs   Pushes zips/helpers/manifest to the gh-pages branch (library)
│   ├── remote-ui/          Updater tab UI source (updater.html, updater.js, updater-ui.js, logos/)
│   └── paths.js          Configurable constants (read from config/installer.conf)
├── config/
│   ├── installer.conf      Single source of truth for URLs/repos (→ _config.h, paths.js,
│   │                       updater-config.sys.mjs)
│   └── eslint.config.js, prettier.config.js
├── package.json            Root config (lint/format + upload/upload:local)
└── pnpm-workspace.yaml     Root-only workspace settings
```

## Prerequisites

| Component       | Requirement                           | Install                                                    |
| --------------- | ------------------------------------- | ---------------------------------------------------------- |
| C installer     | GCC or clang; Node.js for `embed.mjs` | (see per-OS below)                                         |
| Publish scripts | Node.js 20+, pnpm                     | `apt install nodejs pnpm` / `winget install OpenJS.NodeJS` |
| Chrome scripts  | A Firefox-family browser              | —                                                          |

### Windows

Install MSYS2 (use the **UCRT64** environment — `C:\msys64\ucrt64.exe`), then in its shell:

```bash
pacman -Syu                                   # update package DB
pacman -S mingw-w64-ucrt-x86_64-gcc           # gcc
pacman -S mingw-w64-ucrt-x86_64-binutils      # windres + objdump (helper_win, verify)
pacman -S mingw-w64-ucrt-x86_64-make          # mingw32-make.exe (cmd / PowerShell)
pacman -S make                                # MSYS make.exe (runs recipes via sh)
```

Node.js is required for the `resources` step (`node embed.mjs`). Install it inside MSYS2
(`pacman -S mingw-w64-ucrt-x86_64-nodejs`) or use an existing Windows Node.js install — MSYS2 shells
keep the Windows PATH, so either works.

`installer/src/_config.h` (like `resources.h` and `updater-config.sys.mjs`) is **not committed** —
it is gitignored and regenerated on demand: the `config` target of the Makefile regenerates it from
`config/installer.conf` on every build (see the Generated files section below).

Build from the `installer/` directory in any of the three shells:

**MSYS2 UCRT64 shell:**

```bash
cd installer
make all          # → dist/installer/installer_win.exe
```

**cmd.exe** — add both MSYS2 binary directories to PATH (the `config` step regenerates `_config.h`
via `node tools/publish/syncGeneratedFiles.mjs`), then use `mingw32-make`:

```cmd
set PATH=C:\msys64\ucrt64\bin;C:\msys64\usr\bin;%PATH%
cd installer
mingw32-make dist_win
```

**PowerShell — same idea:**

```powershell
$env:PATH = "C:\msys64\ucrt64\bin;C:\msys64\usr\bin;$env:PATH"
cd installer
mingw32-make dist_win
```

With `sh.exe` on PATH (as above), `mingw32-make` runs recipes via `sh`; without it, it falls back to
`cmd.exe`, whose builtin `mkdir` has no `-p`. The Makefile probes the recipe shell at parse time and
uses a compatible `mkdir` either way, so the same targets work from cmd.exe, PowerShell, and MSYS2.

**Note:** `-mwindows` links the executable as a GUI-subsystem app so double-clicking from File
Explorer does not open a terminal. Verify with:
`objdump -p dist\installer\installer_win.exe | grep Subsystem` should show `2` (GUI).

### Linux (native or WSL)

```bash
sudo apt install gcc
make all                      # builds dist/installer/installer_linux

# Windows cross-compile from Linux/WSL
sudo apt install gcc-mingw-w64-x86-64-posix
make dist_win CC=x86_64-w64-mingw32-gcc   # builds dist/installer/installer_win.exe
```

### macOS

```bash
xcode-select --install
make dist_mac   # builds dist/installer/installer_mac
```

## Making changes

1. **Chrome scripts** (`core/chrome/utils/`): edit JS files.
2. **Installer** (`installer/src/`): edit C files, then run `make resources` if web assets changed
   (regenerates `resources.h`).
3. **Web UI** (`installer/web/`): the single design-system source — `index.html`, `style.css`,
   `script.js`. Edit here, then run `node embed.mjs` to update the embedded assets. The remote
   updater UI reuses the same CSS: at publish time `uploadToPages.mjs` builds the updater stylesheet
   in-memory from `installer/web/style.css` plus the updater-only `tools/publish/updater.css` tail,
   so the remote updater page and the installer UI always render from one CSS source.

### Generated files

Three files are generated from sources. They are **gitignored and regenerated on demand** — never
committed, never hand-edited (rationale and the hash-input consequences: ADR
[0008](./decisions/0008-generated-files-untracked.md)):

| Generated file                                     | Source                                        | Regenerated by                                       |
| -------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------- |
| `core/chrome/utils/updater/updater-config.sys.mjs` | `config/installer.conf`                       | `createZip.mjs` at publish time (ships in utils.zip) |
| `installer/src/_config.h`                          | `config/installer.conf`                       | installer Makefile `config` target                   |
| `installer/src/resources.h`                        | `installer/web/*` (via `installer/embed.mjs`) | installer Makefile `resources` target                |

The remote updater stylesheet (`tools/publish/remote-ui/updater.css`) is **not tracked** either: it
is derived from `installer/web/style.css` + `tools/publish/updater.css`, built in-memory at publish
time (`uploadToPages.mjs`) and written to disk only as a gitignored `?demo=1` preview
convenience.`tools/publish/syncGeneratedFiles.mjs` performs the regeneration by hand
(`node installer/embed.mjs` for `resources.h`); the installer Makefile runs it automatically on
every build (`--touch` stamps `_config.h`'s mtime so the binary always relinks with the current
MODE). There are no git hooks. `upload.mjs` regenerates `updater-config.sys.mjs` at publish time
(via `createZip.mjs`), hashes the generated files' **sources** (see the publish flow below), and
deletes the generated files from disk when the run finishes (`cleanGenerated`), so the working tree
always matches a fresh clone — a fresh clone builds and publishes without any pre-existing generated
files, and no localhost/dev-baked copies are left behind after a local/dev run.

## Test: unit tests (`pnpm test`)

Fast, pure-Node unit tests (no build, no network) live in `test/unit/` and run identically locally
and in CI:

```bash
pnpm test
```

Coverage: `createZip.mjs` (flat vs fx-folder layout, extraFiles), `generateUpdaterConfig.mjs` (URLs
per mode, LOCAL flag, dev/local overrides), `hashUtils.mjs` (directory/file-set hashing, gitignore
filtering, sorting), `embed.mjs` (generated C header via `--stdout`), and `browsers.mjs` (GreD path
derivation, snapshot discovery, Firefox binary detection).

## Test: E2E tests (`pnpm test:e2e`)

End-to-end tests verify the installer HTTP API, the elevated-copy helper, and the in-browser updater
tab across multiple scenarios. They require a `upload:local` snapshot first.

### Quick start

```bash
# Build a dev snapshot (needed once)
pnpm upload:local --mode=dev

# Run all E2E tests (installer HTTP + updater scenarios)
pnpm test:e2e

# Installer only (HTTP layer — fast, no browser needed)
pnpm test:e2e:installer

# Updater only (opens Firefox — see config below)
pnpm test:e2e:updater
```

The orchestrator (`run.mjs`) passes `--snapshot <dir>` to child scripts automatically; individual
scripts can also be invoked directly:

```bash
node test/e2e/installer/installer-e2e.mjs --snapshot dist/dev-main-abc1234
node test/e2e/updater/updater-e2e.mjs --firefox "/path/to/firefox" --snapshot dist/dev-main-abc1234
```

### Installer E2E (29 assertions)

Starts the installer in `--smoke-test` mode and exercises every state-changing `/api` route: token
gate (missing, wrong, valid), CORS absence, ping, browsers, rescan, status, self-update, and the
install/close-browser/manifest gated routes. No browser required.

The optional `--ui` flag launches a real Firefox instance and verifies the web UI renders browser
cards with correct status badges, but this is slower and requires a display.

### Updater E2E (5 scenarios)

Each scenario: fresh temp profile → seed `chrome/utils` from the snapshot → optionally delete files
or modify prefs to force a specific state → launch Firefox via puppeteer-core + WebDriver BiDi →
wait for the updater tab to auto-open → assert the card renders the expected status, all 8 buttons
are present, checkbox wiring works, and no page/console errors appeared.

| Scenario | Seed                                   | Expected                                  |
| -------- | -------------------------------------- | ----------------------------------------- |
| 1        | Delete `RDFDataSource.sys.mjs`         | utils Update Available, config Up To Date |
| 2        | Append comment to `config.js` + delete | config Update Available, utils Up To Date |
| 3        | Delete + modify both                   | Both Update Available                     |
| 4        | Unmodified utils + fx-folder           | Tab does NOT open (nothing to surface)    |
| 5        | Set skip-pref to utils remote hash     | Tab does NOT open (skip suppresses)       |

Skip individual scenarios during iteration with `--scenario 1,2,3`.

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

`.github/workflows/e2e.yml`:

| Job       | OS matrix                                | Gate                |
| --------- | ---------------------------------------- | ------------------- |
| installer | ubuntu, macos, windows                   | Hard (blocks merge) |
| helper    | ubuntu (sudo test)                       | Hard                |
| updater   | ubuntu (Mozilla tarball), macos, windows | Hard                |

See `docs/e2e-matrix-plan.md` for the planned browser × OS expansion (Waterfox, Zen, Firefox
Nightly, LibreWolf, and Floorp). The post-v1.0 browser expansion is tracked in issue #38.

### Manual escape — testing a browser CI cannot fetch (`ci-downloads`, ADR 0021)

When every vendor mirror for a browser's installer is down (or a version must be tested before the
resolver can see it), push the installer file straight to GitHub and let CI test it — the file is
typically the one your local firefox-updater already downloaded:

```bash
pnpm ci:download -- librewolf-155.0-1-windows-x86_64-setup.exe
# inference override when the filename is ambiguous:
pnpm ci:download -- "Waterfox Setup 6.7.1.1.exe" --version 6.7.1.1
```

The script creates the fixed-tag **`ci-downloads`** release on demand, uploads the asset under the
resolver's expected name, and dispatches `e2e.yml` with `browser` (+ optional `version`) — a
single-browser updater-E2E run. CI's `cleanup-ci-downloads` job deletes the consumed asset
afterwards and the release + tag once empty, so the steady state is "the release does not exist".
Extra flags: `--no-dispatch` (upload only), `--clean` (delete release + tag now).

A partial (single-browser) dispatch deliberately skips the validated-versions recorder — it cannot
fabricate E2E coverage for firefox/firefox-dev, so it can never satisfy the publish gate on its own.
A FULL dispatch (browser input unset or `all`) is the post-release re-validation escape: the path
filter sees no commit diff on a dispatch, so the `changes` job forces the firefox/firefox-dev
updater legs to run against `main`, and the recorder then records the EXACT versions those legs
installed — read from each installed binary (`downloads.mjs --installed-version`), never re-resolved
live. The recorder runs only when those legs actually ran and passed: a core-only push records
nothing. `pnpm ci:download -- --clean` removes a release that was created but never consumed.

## Test: installer hash verification

A cross-platform Node.js test verifies that the C installer's hash computation matches the
JavaScript reference in `tools/publish/hashUtils.mjs`. It uses the newest `prod-` or `dev-` snapshot
under `dist/` (generating a prod one via `upload:local --mode=prod` when none exists), so it can run
right after a `--mode=dev` build without a second compile:

```bash
pnpm upload:local --mode=dev
pnpm test:hash
```

Exit code 0 means every package's JS hash matches the C binary's (computed with `--test-hash`).

## Continuous integration

`.github/workflows/ci.yml` runs on every PR and on `main` pushes:

- **checks** (Linux) — `pnpm lint` (ESLint incl. `eslint-plugin-security`, clang-format,
  `gcc -fanalyzer`), `pnpm format`, and `pnpm test` (unit tests).
- **publish gate** (Windows / Linux / macOS) — `pnpm upload:local --mode=dev` rebuilds every package
  zip and the native binaries for the runner's OS, so regressions in generated files, hashes or the
  Makefile fail the PR before they reach a release.
- **Security smoke test** (Windows) — `test/e2e/installer/smoke-security.mjs` launches the built
  installer headless and verifies every state-changing `/api` route rejects a missing/wrong session
  token, valid tokens pass the gate, and no response carries `Access-Control-Allow-Origin`.
- **Hash parity** (Windows) — `pnpm test:hash` verifies the JS and C installer hashes match, using
  the dev snapshot built by the publish gate (no second build).
- **URL watchdog** (`.github/workflows/url-watchdog.yml`, weekly + on PRs touching the download map)
  — re-resolves the latest version of every browser the E2E map installs (Firefox, Dev Edition,
  LibreWolf, Floorp, Zen; Waterfox tracked by version only) from its vendor API and verifies the
  download endpoint with a 1 KB ranged GET. Each new release is downloaded once, SHA-256'd and
  folded into the `[url-watchdog] status` meta issue (per-browser status table + version history —
  the dashboard and the SHA-256 ledger in one place). Opens issues on rot (404, HTML error page,
  changed API shape) and same-version binary size changes. Each run logs the baseline's cache-hit
  status and age, so a silently evicted Actions cache is visible instead of masquerading as a first
  run. The PR mode (`--pr`) is stateless, always green, and surfaces findings as annotations. Run
  manually via `workflow_dispatch`, or locally with
  `node tools/check-browser-downloads.mjs --dry-run`.
- **Skills watchdog** (`.github/workflows/skills-watchdog.yml`, weekly + on PRs touching the
  watchdog) — detects drift in the five third-party skills in `.agents/skills/` (ADR 0022): the
  gh-injected frontmatter metadata is the baseline (no cache, stateless in every mode), and each
  skill's recorded tree SHA is compared against its upstream via the GitHub API — both at the
  recorded ref (`content-drift`, what `gh skill update` applies) and on the default branch
  (`ref-behind`: a static tag left behind; fixed by a forced reinstall). Opens ONE rolling tracking
  issue (`label:skills-watchdog`) with the exact update command per skill, closed automatically when
  a later run finds everything current. Updates land as human-reviewed PRs — never pushed: upstream
  skill text is a prompt-injection surface. PR mode (`--pr`) is stateless, always green, and
  surfaces findings as annotations. Local run: `node tools/skills-watchdog.mjs --dry-run`.

**PR path filtering** — every E2E job (`.github/workflows/e2e.yml`: the `snapshot` build, the
installer/updater matrices, the `helper` elevated-copy test, and the `browser-matrix` fork legs) and
the publish gate (`build` in `.github/workflows/ci.yml`) run only when a changed file can affect
them (`core/**`, `config/installer.conf`, `installer/**`, `tools/publish/**`, `test/e2e/**`,
`package.json`, `pnpm-lock.yaml`, the workflows/actions). Docs-only / tooling-only PRs skip all of
them; `changes`, `checks`, `ci-gate` and `e2e-gate` always run, so the required checks keep
reporting. The aggregate gates share one engine — `.github/actions/verify-gate` (required / advisory
/ skip-guard / always-report checks) — and `pnpm check:gates` statically enforces the contract:
every workflow job is listed in its gate's `needs:`, path-filter `if:`s stay in place, and
always-report jobs carry no job-level `if:`. The `browser-matrix` fork legs (LibreWolf, Floorp, Zen
— downloaded from third-party hosts: librewolf.dev's package registry and GitHub release assets) are
advisory when they run: failures warn in the gate instead of failing the PR. Firefox Developer
Edition is first-party Mozilla, so it runs as a required leg of the `updater` job (#35), not in the
advisory matrix. Waterfox has no direct download URL and stays manual (tracked by version only in
the URL watchdog).

**Agent file-change hooks (recommended, per-workstation)** — agent clients (Codebuff, Claude Code,
…) can run a command after each file edit and feed the output back to the agent in the same turn.
They are client config, not repo config — nothing runs for plain git users, and CI stays the
enforcement layer. Keep the set minimal and **read-only** (checks, not mutations); the repo's own
generation/build steps are deliberately _not_ hook material — generated files are produced on demand
by the Makefile and publish scripts (ADR 0008), never per-edit. A mapping that matches the Testing &
QA matrix:

| Changed file                   | Hook                      | Cost  |
| ------------------------------ | ------------------------- | ----- |
| `**/*.md`, `**/*.{js,mjs,cjs}` | `prettier --check <file>` | ~0.5s |
| `docs/decisions/**`            | `pnpm check:decisions`    | <1s   |

Skip in hooks: `pnpm test:hash` (may build a full snapshot), full `pnpm lint` (needs a C toolchain
for `make analyze`), `syncGeneratedFiles.mjs` (on-demand only), anything that writes. Formatting
drift in agent-edited files is the failure this catches: editor on-save tooling only helps when the
editor is open — agents edit files on disk directly.

**LF, CRLF and `pnpm check:gates`** — the tree is normalized to LF (`.gitattributes` has
`* text=auto eol=lf`), so a CRLF file saved by a Windows editor is committed as LF and CI always
checks an LF checkout. But git will not rewrite an already-CRLF working-tree copy (it deems it
"equal after normalization" — `git checkout -- <file>` will not restore it either), so a local file
can linger as CRLF and break the line-sensitive gates: `pnpm check:gates` reports 20+ false
gate-contract violations and `pnpm format` flags the file. Detect with
`file .github/workflows/*.yml` (look for "CRLF line terminators"); fix by physically rewriting the
bytes to LF (e.g.
`node -e "const fs=require('fs');const p='.github/workflows/e2e.yml';fs.writeFileSync(p,fs.readFileSync(p,'utf8').replace(/\r\n/g,'\n'))"`).
The parsers `tools/check-gate-coverage.mjs`, `tools/check-decisions.mjs` and
`tools/publish/syncGeneratedFiles.mjs` normalize `\r\n` → `\n` at read so this never false-fails;
new tools that parse tracked text files should do the same.

**Merge queue** — the workflows trigger on `merge_group` in addition to `pull_request`, so the
required checks also run on the merge queue's temporary merge-group branch. Enabling the queue
(Settings → General → merge queue, with branch protection requiring it) makes the queue keep each PR
up to date with main and validate it before landing (the final merge uses the repo's configured
merge method). Because the "Update branch" step is never used, the ADR 0017 over-trigger caveat —
main changes merged into a PR counting as PR changes for the path filters — does not arise for
queued PRs.

Run the smoke test locally (Windows, from the repo root):

```bash
pnpm upload:local --mode=dev
node test/e2e/installer/smoke-security.mjs
```

The installer's `--smoke-test` flag makes the headless run possible: it skips the
no-browser-detected abort and the browser-tab open, and prints the session token to stdout.

## Pre-push hook (opt-in)

The repo ships one optional git hook: `githooks/pre-push` runs the CI-equivalent gates
(`pnpm lint && pnpm format && pnpm test`, ~3–5s with caches) before a push leaves the machine, so a
red CI run is predictable. It is **opt-in** — ADR 0008 removed required hooks, so nothing changes
for plain clones:

```bash
pnpm hooks:install     # sets core.hooksPath=githooks (self-heals a stale value)
git config --unset core.hooksPath   # uninstall
git push --no-verify   # bypass a single push
```

The gates are repo-wide (like CI), not scoped to the pushed range. Docs-only contributors without a
C toolchain should push with `--no-verify` (the `make analyze` leg of `pnpm lint` hard-fails without
gcc) — CI still runs the full gate. Do **not** add generation steps here: generated files are
produced on demand by the Makefile and publish tooling (ADR 0008).

## Test the auto-updater

1. Open `about:config` and set `xpinstall.signatures.required` to `false` (Firefox
   Nightly/DevEdition may still work with signed profiles).
2. Load `about:debugging#/runtime/this-firefox` → click **Manifest** to verify the chrome manifest
   is loaded.
3. `scriptsUpdater.sys.mjs` runs on every browser startup (initialized by `BootstrapLoader.js`) and
   checks for updates daily.
4. To trigger manually, open the Browser Console (`Ctrl+Shift+J`) and run:
   ```js
   /* global checkForUpdates -- exposed by scriptsUpdater.sys.mjs */
   checkForUpdates(window);
   ```

## How the installer works (architecture)

The installer is a native C application that:

1. **Detects running browsers** by scanning processes and inspecting their lock files for profile
   paths.
2. **Starts a local HTTP server** on the fixed port `8777` (or attaches to an already-running
   installer serving that port — a second instance opens the existing tab and exits).
3. **Opens a browser tab** at `http://localhost:8777/?t=<token>` with the install UI. The URL
   carries a per-run session token so stale tabs from earlier runs can be told apart.
4. **Waits for the tab to fetch the packages**: the web UI fetches `fx-folder.zip` and `utils.zip`
   from the configured Pages host, the hash manifest, and the Waterfox release list / installer
   latest-release JSON from the GitHub API (all CORS-enabled hosts), then POSTs the raw bytes to the
   local server. If a fetch fails, the tab shows a network-error banner and refuses to install until
   the data is available. The host is the `gh-pages` branch in prod; in dev mode it is the
   `dev-build-<id>` branch served via `cdn.jsdelivr.net`.
5. **Extracts** the uploaded zips in-process (vendored miniz on every platform — no PowerShell,
   `tar`, or external `unzip`) and **copies** config files to the browser installation directory
   (requires admin elevation on some platforms).
6. **Copies** utils to the user's profile `chrome/utils/` directory.

The install UI (and the in-browser updater tab) shows each browser's **official brand logo**
(`installer/web/logos/`; the updater ships its own copies in `updater-ui.zip` from
`tools/publish/remote-ui/logos/`) and its **app version**, e.g. `Firefox Nightly 155.0a1`. The
version comes from `<binary_dir>/application.ini` (`[App] Version=`). Waterfox is the exception: its
`application.ini` reports a Firefox-derived version rather than its marketing version, so the
installer looks the build's `SourceStamp` up in the Waterfox GitHub releases, falling back to
`application.ini` when the lookup fails. The updater reads the display name from
`<GreD>/ application.ini` (`[App] CodeName`/`Name`) and the version from
`AppConstants.MOZ_APP_VERSION_DISPLAY`, falling back to `Services.appinfo.version`. Both pages set a
tab favicon.

Platform-specific install APIs:

- **Windows**: Win32 sockets, Shell API, admin elevation via manifest, vendored miniz
- **Linux**: POSIX sockets, vendored miniz, `cp`
- **macOS**: POSIX sockets, vendored miniz, `ditto`

The C binary performs **zero network I/O** (ADR
[0005](./decisions/0005-installer-zero-network-io.md)) — every external payload (package zips,
manifest, Waterfox releases, latest-release JSON) is fetched by the browser tab from CORS-enabled
hosts and POSTed to the local server. `miniz` (vendored) extracts the uploaded zips in-process on
all platforms, using wide-char APIs on Windows for non-ASCII paths. No external library dependencies
— pure C with POSIX and Win32 APIs.

## Publishing a release

### Prepare

Set the required environment variables (or put them in a root `.env` file — copied from
`.env-example`; `upload` reads it automatically):

```bash
export GITHUB_TOKEN_VAR=ghp_...          # GitHub token with repo scope (contents:write)
export DEV_BUILD_ID=my-feature-1         # dev-mode only: dev-build-<id> branch id (optional)
```

### AI review configuration

AI review is a **local, agent-run step** ([ADR 0020](./decisions/0020-local-agent-ai-review.md)),
not a CI bot. The agent that opens a PR runs `pnpm review:local` (`tools/ai-review.mjs`) and posts
the assessed findings via `gh`. The old `.github/workflows/ai-review.yml` CI bot was **removed** —
add no CI/repo AI key secret.

Put the **`GEMINI_API_KEY`** (default provider, Gemini 3.6 Flash) in the root `.env` (untracked) or
export it in the shell. Providers are an array of objects at the top of `tools/ai-review.mjs`; each
entry is `{id, label, model, keyEnv, endpoint}` and the **first entry whose key is set** is used,
with per-file fallback (OpenRouter stays as an optional backup). `--provider <id>` and
`--model <name>` override the default. Optional `GEMINI_MODEL`, `OPENROUTER_MODEL`,
`OPENROUTER_API_KEY` variables are supported. Keep real keys only in `.env`; never commit them or
add them to `.env-example` with real values.

### Modes — `--mode=prod|dev` (REQUIRED for any real publish)

See ADR [0009](./decisions/0009-unified-publish-modes.md) for the decision behind the modes.

| Mode | Release tag      | Pages branch                                                  | Artifact names                           | Branch gate    |
| ---- | ---------------- | ------------------------------------------------------------- | ---------------------------------------- | -------------- |
| prod | `latest`         | `gh-pages` (live site)                                        | `utils.zip`, `installer_win.exe`         | must be `main` |
| dev  | `dev-build-<id>` | `dev-build-<id>` (disposable; served via jsDelivr, not Pages) | `utils-dev.zip`, `installer_win-dev.exe` | any branch     |

`dev` publishes to a per-run branch and release tag (`dev-build-<id>`, where `<id>` defaults to
`<current-branch>-<short-sha>` or `DEV_BUILD_ID`), so a test build never touches the live `latest`
release or the `gh-pages` site. The release is marked **pre-release**, its body links the branch,
and it carries the manual-download artifacts: the `utils` + `fx-folder` zips and the installer
binary (the `updater-ui` zip and helper binaries stay branch-only — the updater fetches `updater-ui`
itself and helpers are installer-side). Dev URLs are baked into the built artifacts and served from
`cdn.jsdelivr.net` for the browser-facing pieces (installer web UI, remote updater UI) and
`raw.githubusercontent.com` for the privileged engine fetches (chrome:// context has no CORS).
Delete the dev branch after testing: `git push origin --delete dev-build-<id>` (CI test runs delete
it automatically in a `finally`).

### Run

```bash
npm run upload -- --mode=prod            # hashes → rebuild changed zips + binaries → upload → Pages + manifest + UI
npm run upload -- --mode=dev             # same, but always rebuild + upload, to the dev-build-<id> branch + release
npm run upload:local -- --mode=prod      # same, but write a snapshot to dist/prod-<branch>-<hash>/ (no token)
npm run upload:local -- --mode=dev       # dev snapshot (-dev artifact names), no token
```

Both commands accept `--ref=<branch|commit>` to build a specific branch or commit without touching
the current checkout: the tool creates a temporary detached worktree at that ref, re-runs the same
upload command inside it (so the ref's own publish scripts build its source), then removes the
worktree. The snapshot directory, dev-build branch and release are named after the ref. Useful for
building an older commit for testing while keeping local work in place.

The unified flow (`upload`):

1. Loads the last published hashes from the hash manifest on the publish branch (`gh-pages` in prod,
   `dev-build-<id>` in dev; the newest `dist/<mode>-*/` snapshot in `--local` mode).
2. Computes SHA-256 hashes for each package source tree and each binary source tree, and rebuilds
   only what changed (everything in `--mode=dev`/`--force`).
3. Uploads the changed artifacts as release assets (`utils.zip`, `installer_win.exe`, …) in prod.
4. Pushes the **changed** artifacts to the publish branch — the installer UI fetches them from there
   because GitHub Pages sends `Access-Control-Allow-Origin: *` (in dev mode the same branch is read
   through jsDelivr, which is also CORS-enabled). The branch is created automatically on first run.
   Only the artifacts rebuilt this run are pushed, so an unchanged package keeps its live artifact.
5. Publishes the hash manifest (`hashes.json`) to the same branch.

Prod mode refuses to publish unless the current git branch is `main`; dev mode works from any branch
(dev URLs are baked into the regenerated generated files on purpose). `upload:local` runs on any
branch with no token. A missing manifest on the publish branch (first run) is treated as "publish
everything", so the first run creates it; `--force` also refreshes the manifest even when hashes are
unchanged.

The same run compiles the installer and helper binaries when their source (`installer/src/`,
`installer/src/helper/`) changes:

- `installer_win.exe` / `installer_linux` / `installer_mac` — uploaded as assets of the release
  tagged by `RELEASE_NAME` (`installer_win-dev.exe` etc. in dev mode).
- `helper_win.exe` / `helper_linux` / `helper_mac` — pushed to the publish branch (the in-browser
  updater fetches them from there).
- By default it builds only the current OS. Use `--ci` to cover all three platforms, or
  `--platform=win|linux|mac` for an explicit set (each platform needs its own build machine).

### Run from CI

`.github/workflows/pages.yml` publishes via GitHub Actions: a manual `workflow_dispatch` (Actions →
Pages publish → Run workflow) with a `mode` (prod/dev) and an optional `force` input. It runs the
**same** `node tools/publish/upload.mjs` as the local commands above — no separate publish logic —
once per OS (`--platform=win|linux|mac`) in three sequential jobs, so all three installer/helper
platforms get built on their native toolchains. The jobs are serial so gh-pages commits and
release-asset uploads can never interleave; change detection is anchored to a shared **pre-run
baseline**: a first job captures the current `hashes.json` and every publish job diffs against it
(via `FIREFOX_SCRIPTS_STORED_HASHES_FILE`) instead of the manifest an earlier sibling just pushed —
the package hashes in the manifest are platform-independent, so without the baseline only the first
platform would rebuild after a source change. Prod dispatches must target `main` (enforced inside
`upload.mjs`); dev dispatches work from any branch. Pages serving stays "Deploy from branch:
`gh-pages`" — the workflow pushes to that branch, it does not switch Pages to the actions deployment
method.

Every publish also pushes an `index.html` to the branch root: the repository's own `README.md`,
rendered server-side by GitHub (`pagesIndex()` in `tools/publish/uploadToPages.mjs`) and wrapped in
a minimal shell with `github-markdown-css`. Static HTML because the branch ships `.nojekyll` (the
legacy Jekyll build errored on this repo); fetched fresh each run, so the landing page can never
drift from the README.

### Build outputs

All build artifacts land in a single gitignored `dist/` tree at the repo root:

| Directory                         | Contents                                                                                                                          |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `dist/.build/`                    | Transient staging (zips + binaries) written and deleted by every `upload`/`upload:local` run                                      |
| `dist/prod-<branch>-<hash>/`      | Complete local snapshot — `upload:local --mode=prod` (zips, binaries, `hashes.json`)                                              |
| `dist/dev-<branch>-<hash>/`       | Same, `--mode=dev` (`-dev` artifact names)                                                                                        |
| `dist/prod-copy-<branch>-<hash>/` | Copy kept by `upload --mode=prod --keep-copy`                                                                                     |
| `dist/dev-copy-<branch>-<hash>/`  | Copy kept by `upload --mode=dev --keep-copy`                                                                                      |
| `dist/installer/`                 | Manual `make dist_win`/`dist_linux`/`dist_mac` output (Makefile default; `upload.mjs` redirects it into `dist/.build/installer/`) |
| `dist/tmp/`                       | Ad-hoc debug/scratch leftovers                                                                                                    |

The installer Makefile and the `tools/publish/*.mjs` scripts share these paths via `DIST_DIR`
(Makefile) / `tools/publish/paths.js` constants; nothing under `dist/` is tracked.

### Testing the in-browser updater locally

A `upload:local` snapshot is self-contained on disk: it writes every artifact to
`dist/<mode>-<branch>-<hash>/`, and the generated `updater-config.sys.mjs` points the updater's
**download/install URLs** — `HASHES_URL`, `ZIP_BASE_URL`, `UI_BASE_URL`, `HELPER_BASE_URL` — at that
snapshot directory via `file://` URLs, so hash-checking and installing work straight from disk with
no server and no GitHub. The C installer keeps `http://localhost:<DEFAULT_PORT>/` instead (its tab
is HTTP-served and fetches from the installer's own local server, `CFG_LOCAL`). The updater tab UI
is the local `updater-ui.zip` in the same snapshot: `scriptsUpdater.sys.mjs` downloads and extracts
it into `chrome/utils/updater/ui` before opening the tab.

1. `upload:local --mode=prod` (or `dev`) and run the snapshot's installer — it installs `utils.zip`,
   `fx-folder.zip` and `updater-ui.zip` from the local server.
2. In another profile (or the same one after the installer finishes), the daily check opens
   `chrome://firefox-scripts/content/ui/updater.html`; you can also open it directly. Zips and
   hashes are read straight from the snapshot directory via `file://`.

A `--local` or `--mode=dev` build identifies itself: the installer tab and the updater tab both show
a yellow **"Test build"** banner (from `/api/build-info` in the installer, from the generated
config's `IS_DEV`/`IS_LOCAL`/`LOCAL_DIST_PATH`/`DEV_BRANCH` in the updater), telling the developer
this is a test run and where the snapshot lives.

### Configurable constants

Edit these files to change GitHub URLs and repository owners:

| File                                               | Constant                                                                                                                                                                                                                 | Description                                                        |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `installer/src/platform.h`                         | `INSTALLER_REPO_OWNER`, `INSTALLER_REPO_NAME`, `INSTALLER_ZIP_URL`, `INSTALLER_HASHES_URL`, `INSTALLER_VERSION`                                                                                                          | Installer identity                                                 |
| `config/installer.conf`                            | `REPO_OWNER`, `REPO_NAME`, `ZIP_DOWNLOAD_REPO`, `ZIP_PAGES_URL`, `ZIP_PAGES_REPO`, `ZIP_PAGES_BRANCH`, `HASHES_URL`, `RELEASE_NAME`, `HELPER_BASE_URL`, `DEFAULT_PORT`, `ASSET_SUFFIX`                                   | URLs for zips / manifest / helpers (gh-pages) + releases           |
| `tools/publish/paths.js`                           | `RELEASE_NAME`, `REPO_OWNER`, `REPO_NAME`, `ZIP_DOWNLOAD_REPO`, `ZIP_PAGES_REPO`, `ZIP_PAGES_BRANCH`, `PROFILE_PATH`, `REMOTE_UI_DIR`, `GITHUB_TOKEN_VAR` + `PUBLISH_MODE`, `DEV_BUILD_ID`, `DEV_BRANCH`, `ASSET_SUFFIX` | Publish settings + mode-derived dev values + updater-ui source dir |
| `core/chrome/utils/updater/updater-config.sys.mjs` | `CONFIG.HASHES_URL`, `ZIP_BASE_URL`, `UI_BASE_URL`, `HELPER_BASE_URL`, `ASSET_SUFFIX` (generated from `config/installer.conf`; untracked, generated on demand)                                                           | Auto-update URLs                                                   |

## Appendix: Design decisions (no further action)

Architectural decisions are recorded in `docs/decisions/` (see the
[decision log index](./decisions/index.md)); the items below are accepted implementation details
deliberately not promoted to ADRs. These were intentionally kept and documented here for future
maintainers.

- `parse_manifest_files()` in the installer is strstr-based JSON parsing — fragile but sufficient; a
  full JSON parser in C is out of scope.
- The installer's token/restart race and the zip-derived hash fallback are accepted as-is
  (documented in their respective code comments).
- The updater keeps its in-memory state; only the daily check and skip prefs persist.
- `updater-ui` has no per-package skip or status UI anywhere (installer or tab) — it is a silent
  self-updating dependency of utils.
