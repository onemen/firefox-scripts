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
committed, never hand-edited (rationale and the hash-input consequences:
`docs/generated-files-decision.md`):

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

## Test: installer hash verification

A cross-platform Node.js test verifies that the C installer's hash computation matches the
JavaScript reference in `tools/publish/hashUtils.mjs`:

```bash
cd installer && make dist_linux
node installer/test/test_hash.mjs
```

Exit code 0 means every package's JS hash matches the C binary's (computed with `--test-hash`).

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

The C binary performs **zero network I/O** — every external payload (package zips, manifest,
Waterfox releases, latest-release JSON) is fetched by the browser tab from CORS-enabled hosts and
POSTed to the local server. `miniz` (vendored) extracts the uploaded zips in-process on all
platforms, using wide-char APIs on Windows for non-ASCII paths. No external library dependencies —
pure C with POSIX and Win32 APIs.

## Publishing a release

### Prepare

Set the required environment variables (or put them in a root `.env` file — copied from
`.env-example`; `upload` reads it automatically):

```bash
export GITHUB_TOKEN_VAR=ghp_...          # GitHub token with repo scope (contents:write)
export DEV_BUILD_ID=my-feature-1         # dev-mode only: dev-build-<id> branch id (optional)
```

### Modes — `--mode=prod|dev` (REQUIRED for any real publish)

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
**download/install URLs** — `HASHES_URL`, `ZIP_BASE_URL`, `HELPER_BASE_URL` — at that snapshot
directory via `file://` URLs, so hash-checking and installing work straight from disk with no server
and no GitHub. The C installer keeps `http://localhost:<DEFAULT_PORT>/` instead (its tab is
HTTP-served and fetches from the installer's own local server, `CFG_LOCAL`). The updater tab UI is
the local `updater-ui.zip` in the same snapshot: `scriptsUpdater.sys.mjs` downloads and extracts it
into `chrome/utils/updater/ui` before opening the tab.

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
| `core/chrome/utils/updater/updater-config.sys.mjs` | `CONFIG.HASHES_URL`, `ZIP_BASE_URL`, `HELPER_BASE_URL`, `ASSET_SUFFIX` (generated from `config/installer.conf`; untracked, generated on demand)                                                                          | Auto-update URLs                                                   |
