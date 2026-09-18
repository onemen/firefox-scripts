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
│   │                       manifest (--mode=prod|dev, --local/--force, --platform=)
│   ├── createZip.mjs       Zip creation helpers (fx-folder.zip, utils.zip, updater-ui.zip)
│   ├── generateUpdaterConfig.mjs  Regenerates updater-config.sys.mjs from installer.conf
│   ├── syncGeneratedFiles.mjs     Regenerates the generated files (untracked, on demand)
│   ├── generatedRegistry.mjs      Single registry of the generated files: shipping rels,
│   │                              zip/hash extraFiles, scan excludes (ADR 0008)
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
| Publish scripts | Node.js ≥ 24, pnpm                    | `apt install nodejs pnpm` / `winget install OpenJS.NodeJS` |
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

# ARM64 (cross-compile; a native aarch64 host can pass AARCH64_CC=cc)
sudo apt install gcc-aarch64-linux-gnu
make dist_linux_aarch64 helper_linux_aarch64
#   builds dist/installer/installer_linux_aarch64 + helper_linux_aarch64
#   upload.mjs builds both automatically: 'linux' implies the aarch64 twin

# Windows cross-compile from Linux/WSL
sudo apt install gcc-mingw-w64-x86-64-posix binutils-mingw-w64-x86-64
make dist_win CC=x86_64-w64-mingw32-gcc WINDRES=x86_64-w64-mingw32-windres
#   builds dist/installer/installer_win.exe with the PE version resource
```

### macOS

```bash
xcode-select --install
make dist_mac   # builds dist/installer/installer_mac
```

The macOS build is **universal** (x86_64 + arm64 in one binary, mirroring `helper_mac`), so the
single `installer_mac` asset serves Apple Silicon and Intel Macs — verify with
`lipo -archs dist/installer/installer_mac` (the E2E macOS runner asserts both slices and executes
each one; #132).

## AV false positives and the AV scan gate

The installer/helper binaries are unsigned, stripped, statically-linked PEs — the classic profile
for antivirus **machine-learning** false positives. `installer_win.exe` was once flagged by Windows
Defender (`Program:Script/Wacapew.A!ml`) while every local build of the same source scanned clean.
The confirmed root cause was a **toolchain bump, not a code change**: the publish workflow ran
`msys2/setup-msys2` with `update: true`, and a full `pacman -Syu` on 2026-09-05 pulled the gcc
16.1.0 → 16.2.0 package update (published to MSYS2 repos the day before). The rebuilt artifact's
bytes landed inside the `!ml` model's detection pocket (the near-identical dev-mode build and all
local 16.1.0 builds scanned clean). `!ml` models are byte-sensitive and change over time, so the
workflow now skips the system upgrade (`update: false`) — the AV gate below is what enforces that a
rebuild with any new toolchain still scans clean before it ships. Three structural measures keep
this in check:

1. **PE metadata** — `installer/src/installer.rc` + `installer.manifest` (compiled by `windres` on
   the Windows build) give the exe a version resource (FileDescription/CompanyName/ProductName), an
   asInvoker manifest and Win10/11 compatibility GUIDs. A stripped PE with _no_ version info is the
   #1 ML false-positive profile — and an **unmanifested** exe is the other: Windows applies
   installer-detection and UAC virtualization heuristics to it. `helper_win.exe` therefore carries
   the same pair as the installer (`installer/src/helper/version.rc` + `helper.manifest`), instead
   of relying on the mingw crt's auto-linked `default-manifest.o`: the crt version CI installs did
   not supply one, so the shipped helper used to have a version resource and no manifest at all.
2. **The AV scan gate** — `tools/scan-av.mjs` scans built binaries before they are published
   (Windows: Windows Defender via `MpCmdRun.exe`; Linux/macOS: ClamAV `clamscan`). The publish flow
   (`tools/publish/upload.mjs`) scans the EXACT bytes about to be uploaded and refuses to publish
   when any engine reports a detection. A missing engine is only a warning (GitHub Windows runners
   often run Defender in passive mode), so the gate degrades gracefully but never ships a flagged
   artifact silently.
3. **The magic-byte artifact check** — before hashing and publishing, `upload.mjs` verifies every
   staged installer/helper binary starts with its platform's executable magic (PE `MZ`, ELF,
   Mach-O). This guards against issue #233: Defender real-time protection on a local Windows host
   can intermittently hold a write lock on the freshly linked exe and leave a truncated artifact
   behind (`collect2: ld returned 5`, output starting `00 00`) — a partial file that would otherwise
   be hashed and shipped. The check runs after the build/reuse pass and again before the pass-2
   security gates. If it fires: delete the named artifact(s) and re-run the build (the link usually
   succeeds on retry).

### Local scan (after `make dist_win`)

```bash
pnpm scan:av -- dist/installer/installer_win.exe dist/installer/helper_win.exe
# exit 0 = clean, exit 1 = detection, exit 2 = usage
```

### Multi-engine check (optional — VirusTotal)

```bash
# put VT_API_KEY=... in the root .env (gitignored), then:
pnpm scan:vt -- dist/installer/installer_win.exe
```

The publish flow also runs every built binary through VirusTotal when `VT_API_KEY` is present
(GitHub secret on CI; root `.env` for a local `pnpm upload`). The publish fails when ≥
`VT_FAIL_THRESHOLD` (default 3) engines report a binary as malicious **or** when a veto engine
(`VT_VETO_ENGINES`, default `Microsoft`) reports it as malicious at any count — a Microsoft/Defender
verdict must never ship, even alone. Hits below the configured threshold from non-veto engines warn
but do not block (the known-FP band at the default of 3). The run log names the flagging engines.
Without a key it just skips with a warning, and an analysis VirusTotal has not finished when the
poll times out is reported as a skip — never as clean.

### False-positive handling

- If a scanner flags a freshly built binary, do **not** publish it — investigate first. Local builds
  and the CI artifact differ (toolchain package set — measured below), so a clean local scan does
  not guarantee the CI build is clean; the upload gate is what enforces that. To keep shipping the
  parts that are clean, use the partial-publish holdback below instead of freezing the whole run.
- Report confirmed false positives to Microsoft (Defender/other Microsoft engines):
  <https://www.microsoft.com/en-us/wdsi/filesubmission> — select “Your app or file was incorrectly
  detected as malware” and attach the flagged binary. Microsoft can clear the hash/family in
  Defender’s cloud, which also clears it for users.
- A durable long-term fix is **code signing**; it is the only measure that systematically improves
  AV/OS reputation. Paid options exist (Azure Trusted Signing), and the **SignPath Foundation**
  sponsors free Authenticode signing for accepted open-source projects (Windows binaries only —
  exactly the flagged artifacts here). The measures above are the zero-cost alternative while the
  signing application is pending.
- AV-shape changes are a lottery, not a dial: the 2026-09-07 PE subsystem bump (5.2 → 6.0, the
  XP-era "packer profile" signal) was reverted the same day because it _flipped_ Microsoft's ML
  verdict (#160 → #161). Do not churn binary bytes expecting a fix — the gate plus signing are the
  levers; measure before/after with `pnpm scan:av` / `pnpm scan:vt`.

### Why a clean local scan does not clear a CI build (measured 2026-09-17)

`upload:local` and the CI publish build the same sources but **not the same bytes**. Only the gcc
version is effectively pinned (`msys2/setup-msys2` with `update: false` still installs the current
`mingw-w64-ucrt-x86_64-*` packages); binutils, the mingw-w64 crt and the headers package float.
Measured on commit `e393191` — the CI build that VirusTotal flagged on 2026-09-15 (issue #157):

| Build                       | gcc      | binutils      | `installer_win-dev.exe` | `helper_win-dev.exe` |
| --------------------------- | -------- | ------------- | ----------------------- | -------------------- |
| CI (`staged-win` artifact)  | 16.1.0-5 | 2.46-4        | 199,168 B               | 18,944 B             |
| local (`pnpm upload:local`) | 16.1.0-5 | 2.47.20260726 | 203,264 B               | 19,456 B             |

Reproducing the CI bytes locally needs CI's whole package set — which is what
`config/msys2-toolchain.json` now installs on both sides (see the pinned-toolchain section below).
Two consequences worth keeping in mind:

- **A local `upload:local` run cannot validate or clear the bytes CI will ship.** Its scan is
  evidence about the local toolchain only; the publish gates (host AV on the runner + the VirusTotal
  veto) are what cover the ship-bound bytes. To inspect them locally, download what a run staged:
  `gh run download <run-id> -n staged-win`.
- Engine verdicts are as version-dependent as the compiler: local Windows Defender reported the CI
  bytes that VirusTotal's Microsoft engine flagged (`Trojan:Win32/Wacatac.B!ml`) as clean. Treat
  AV/VT as a gate, not as a truth.

### Pinned toolchain (`config/msys2-toolchain.json`)

The comparison above is what the pin removes as a variable. `config/msys2-toolchain.json` fixes the
whole Windows package set (gcc, gcc-libs, binutils, crt, headers, winpthreads, and the library
packages behind them) with a per-file SHA-256; `.github/actions/pinned-msys2` installs exactly those
files with `pacman -U`, puts that tree **first on the PATH the build steps use**, and then proves
it: `node tools/ci/msys2Toolchain.mjs --provenance` resolves `gcc`/`ld`/`as`/`windres`/`make` the
way the build does and fails the job unless every one reports the pinned version and all of them
come from a single directory. `pacman -Q` says what is _installed_; provenance says what _compiles_
— and it lands in the run log next to the uploaded artifact.

On a local machine the same files are two commands away:

```bash
pnpm toolchain:local      # extract the pinned packages into dist/.toolchain/ (sha256-verified)
export PATH="$PWD/dist/.toolchain/ucrt64/bin:$PATH"
make -C installer dist_win helper_win
```

The `deterministic` publish job closes the loop: it builds one commit with the environment toolchain
and again with that extracted prefix, and fails if the two are not byte-identical — i.e. if the pin
does not cover everything that shapes the bytes. A published commit's hashes are therefore
reproducible on a machine that ran `pnpm toolchain:local`. `pnpm toolchain:check` validates the
manifest alone (no download).

The MSYS2 pin is not the only byte input. `installer/embed.mjs` gzip-compresses the embedded web
assets with Node's bundled zlib (`zlib.gzipSync(..., {level: 9})`), so a runtime whose zlib emits
different deflate bytes would change `resources.h` — and the installer's bytes and hashes — while
every tracked source stays identical. CI pins the Node major (`node-version: 24`; the flagged run
resolved **24.20.0**), and `--provenance` logs the exact `node`/`zlib` pair on every build. Measured
2026-09-17: two runtimes with different zlib builds (26.8.2, and CI's 24.20.0 /
1.3.2.1-motley-42c2f19) emit **different** deflate bytes for the same input — the output of this
input cannot be pinned across runtimes, so treat it as version-sensitive: reproduce published bytes
with the node/zlib pair `--provenance` recorded. What the unit test pins instead are the
runtime-independent invariants (in-runtime determinism, round-trip, gzip magic) plus a plausible
size band, so a wild format change still fails `pnpm test`. The `deterministic` job cannot see this
one: its two builds share one Node.

One config-level gotcha when reproducing a **dev** build: the generated `_config.h` bakes
`dev-build-<branch>-<sha>`, and a detached checkout (`git worktree add`, a `git checkout <sha>`)
reports its branch as `HEAD` — so a dev-mode rebuild from a worktree carries `dev-build-HEAD-<sha>`
URLs where CI's appends `dev-build-main-<sha>`, and the binaries differ even with an identical
toolchain. Export `FIREFOX_SCRIPTS_REF_NAME=<branch>` to reproduce CI's spelling.

**Not retroactive.** The 2026-09-15 artifact predates the pin and stays unattributable. Rebuilding
`e393191` from the pinned package set gives `installer_win-dev.exe` at 202,752 B — `.text` 2,752 B
larger, and a `helper_win-dev.exe` that links one extra CRT import
(`api-ms-win-crt-multibyte-l1-1-0.dll`) — the same sources, demonstrably a different compiler. Which
compiler is now unknowable, precisely because that run recorded versions but never provenance; that
is the gap the `--provenance` step closes. Do not treat VT/WDSI verdicts on those specific bytes as
re-derivable: re-scan the current pin's output instead. The pinned prefix itself is deterministic
(two builds byte-identical) and hermetic (it built with nothing but the extracted packages).

### Partial publishes — publishing only the roles you name

A flag usually hits one binary, not the packages: the zips are plain JS/text and are what installed
browsers actually pull. `--include=<roles>` (or the `pnpm release:*` presets) publishes exactly the
named roles instead of freezing all of them (decision:
[ADR 0030](./decisions/0030-partial-publishes.md)):

```bash
pnpm upload:local -- --mode=prod --include=packages  # offline rehearsal (zips + hashes.json)
pnpm upload -- --mode=dev --include=packages,helper  # dev build: ship a clean helper,
                                                     # withhold the installer
# prod is CI-only: dispatch the publish with the same list
gh workflow run pages.yml -f mode=prod -f include=packages
```

The flag is required on every run: a missing, empty or unknown role fails loudly instead of guessing
a scope, and `--include=all` is the explicit full publish. A role left out is not built, hashed,
scanned or uploaded, and its `hashes.json` entry stays frozen at its last published value — the
manifest keeps describing what is on the branch, so no installed copy is ever pointed at bytes that
were never published. The run logs a PARTIAL PUBLISH banner naming the held-back roles, and the
AV/VT gates state that they had nothing in scope. Whenever the withheld role's sources really
changed, its frozen entry stays stale until the next full publish of that role — one revision when
the very next run is full, longer under repeated holdbacks — which is what makes that run rebuild
and ship it (self-healing).

CI dispatches take the same list in their `include` input (`all` = full publish):

```bash
gh workflow run pages.yml -f mode=prod -f include=packages
```

### Verifying the elevated-copy helper by hand (the updater path)

The helper is the one artifact that runs outside the browser sandbox, so verify it end-to-end after
publishing helper bytes (or after an `--include=packages,helper` run that shipped a new helper):

1. Install the packages from the published branch — or, for a local snapshot, install `utils.zip`
   into `<ProfD>/chrome/utils/` by hand and copy `fx-folder.zip`'s files next to the browser binary.
   (Verify after publishing helper bytes — e.g. an `--include=packages,helper` run — or a full one.)
2. In the browser's install dir (admin-protected by default on Windows), modify a tracked config
   file — e.g. append a comment to `config.js` — to force a fx-folder update, and confirm the hash
   change with `about:config` → `extensions.firefox-scripts.*` / the updater tab's status card.
3. Let the daily check run (or trigger it: Browser Console → `checkForUpdates(window)`). The updater
   downloads `fx-folder.zip`, detects the unwritable install dir, fetches
   `<HELPER_BASE_URL>/helper_win.exe` plus its `.sha256` sidecar, verifies the digest, then runs the
   helper — exactly one UAC prompt, then the elevated copy.
4. Check the outcome: the status card flips to up to date, `config.js` carries the edit after a
   browser restart, and the helper's exit code is `0` (`2` = the user cancelled the UAC prompt,
   which the updater reports as a cancel, not a failure).

A missing sidecar only warns (pre-#33 publishes), a **mismatched** one aborts the elevated copy — so
a partial publish that ships the helper must ship its sidecar too (`upload.mjs` always writes both).

## Making changes

1. **Chrome scripts** (`core/chrome/utils/`): edit JS files.
2. **Installer** (`installer/src/`): edit C files, then run `make resources` if web assets changed
   (regenerates `resources.h`).
3. **Web UI** (`installer/web/`): the single design-system source — `index.html`, `style.css`,
   `script/*.js` (the UI script, authored as phase part files concatenated by `embed.mjs` into the
   single served `script.js`; see the header of `installer/embed.mjs`). Edit here, then run
   `node embed.mjs` to update the embedded assets. The remote updater UI reuses the same CSS: at
   publish time `uploadToPages.mjs` builds the updater stylesheet in-memory from
   `installer/web/style.css` plus the updater-only `tools/publish/updater.css` tail, so the remote
   updater page and the installer UI always render from one CSS source.

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

| Variable                    | Default          | Meaning                                                                                                                                                 |
| --------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DOWNLOAD_STALL_TIMEOUT_MS` | 60000            | Abort the attempt when no bytes arrive for this long. A 0.3 MB/s trickle delivers a chunk every ~2 s and is never killed — only a dead stream trips it. |
| `DOWNLOAD_TOTAL_BUDGET_MS`  | 1200000 (20 min) | Wall-clock budget across all 5 attempts (retries resume, so slow links still complete). Must stay below the watchdog job's `timeout-minutes: 30`.       |
| `DOWNLOAD_RETRY_BACKOFF_MS` | 5000             | Wait between attempts.                                                                                                                                  |

Each is read per call, so a workflow step can set one (e.g. `env: DOWNLOAD_TOTAL_BUDGET_MS: 1500000`
— 25 min, still inside the watchdog job's 30-minute timeout — on a known-slow runner) without
touching the others.

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

`installer/test/test_self_update.mjs` additionally needs a **built binary** (it drives the
installer's `--test-self-update` mode), so it runs where a build exists: the Windows publish gate in
CI, or locally after `make all` / `dist_win`. On a Linux/macOS host without a Windows build, run the
Windows-target cross-compile from WSL (or the reverse with MSYS2 — see the platform sections above)
and point the test at the result; the pure-Node `pnpm test` suite never needs a binary.

## Continuous integration

`.github/workflows/ci.yml` runs on every PR and on `main` pushes:

- **checks** (Linux) — `pnpm lint` (ESLint incl. `eslint-plugin-security`, markdownlint-cli2 — MD056
  table-column-count catches merged table rows that prettier cannot see (#147) — clang-format,
  `gcc -fanalyzer`), `pnpm format`, `pnpm test`, and a separate
  `node --test --experimental-test-coverage "test/unit/**/*.test.mjs"` pass whose report goes to the
  log — informational only, no threshold gate.
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
  `node tools/check-browser-downloads.mjs --dry-run`. Its pure reporting layer — the domain
  constants, drift classification, the E2E dispatch planner, and all GitHub-visible rendering
  (status table, version history, issue titles/bodies) — lives in `tools/ci/watchdog-report.mjs`,
  unit-testable without network access; the watchdog re-exports it for its importers.
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

- **Skills checker** (`tools/check-skills.mjs`, wired into `pnpm lint`; static-only alias
  `pnpm test:skills`) — gates on SKILL.md frontmatter validity (name/description presence, name =
  directory, full or absent gh metadata) and runs the vendored skills' own `*.test.mjs` files with
  `node --test`. Validation only: per ADR 0022 vendor text is never linted or formatted.

**PR path filtering** — every E2E job (`.github/workflows/e2e.yml`: the `snapshot` build, the
installer/updater matrices, the `helper` elevated-copy test, and the `browser-matrix` fork legs) and
the publish gate (`build` in `.github/workflows/ci.yml`) run only when a changed file can affect
them (`core/**`, `config/installer.conf`, `installer/**`, `tools/publish/**`, `tools/scan-av.mjs`,
`tools/scan-vt.mjs`, `test/e2e/**`, `package.json`, `pnpm-lock.yaml`, the workflows/actions).
Docs-only / tooling-only PRs skip all of them; `changes`, `checks`, `ci-gate` and `e2e-gate` always
run, so the required checks keep reporting. The aggregate gates share one engine —
`.github/actions/verify-gate` (required / advisory / skip-guard / always-report checks) — and
`pnpm check:gates` statically enforces the contract: every workflow job is listed in its gate's
`needs:`, path-filter `if:`s stay in place, and always-report jobs carry no job-level `if:`. The
`browser-matrix` fork legs (LibreWolf, Floorp, Zen — downloaded from third-party hosts:
librewolf.dev's package registry and GitHub release assets) are advisory when they run: failures
warn in the gate instead of failing the PR. Firefox Developer Edition is first-party Mozilla, so it
runs as a required leg of the `updater` job (#35), not in the advisory matrix. Waterfox graduated
from the advisory matrix to its own required `updater-waterfox` leg (Windows-only, ADR 0025) after
its soak; its current version must also be covered by the validated-versions record before a prod
publish, and the pin-first break-glass runbook for vendor-flake days lives in that ADR.

**Agent file-change hooks (recommended, per-workstation)** — agent clients (Codebuff, Claude Code,
…) can run a command after each file edit and feed the output back to the agent in the same turn.
They are client config, not repo config — nothing runs for plain git users, and CI stays the
enforcement layer. Keep the set minimal and **read-only** (checks, not mutations); the repo's own
generation/build steps are deliberately _not_ hook material — generated files are produced on demand
by the Makefile and publish scripts (ADR 0008), never per-edit. A mapping that matches the Testing &
QA matrix:

| Changed file                   | Hook                                                                                                 | Cost  |
| ------------------------------ | ---------------------------------------------------------------------------------------------------- | ----- |
| `**/*.md`, `**/*.{js,mjs,cjs}` | `prettier --check <file>`                                                                            | ~0.5s |
| `docs/decisions/**`            | `pnpm check:decisions` (duplicate numbers, stale links, `Amends:`/`Amended:` reciprocity — ADR 0029) | <1s   |

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

## Git hooks (opt-in)

The repo ships two optional git hooks; both are **opt-in** — ADR 0008 removed required hooks, so
nothing changes for plain clones:

```bash
pnpm hooks:install     # sets core.hooksPath=githooks (self-heals a stale value)
git config --unset core.hooksPath   # uninstall
```

- `githooks/pre-push` runs the CI-equivalent gates (`pnpm lint && pnpm format && pnpm test`, ~3–5s
  with caches) before a push leaves the machine, so a red CI run is predictable. The gates are
  repo-wide (like CI), not scoped to the pushed range; bypass a single push with
  `git push --no-verify`. Docs-only contributors without a C toolchain should push with
  `--no-verify` (the `make analyze` leg of `pnpm lint` hard-fails without gcc) — CI still runs the
  full gate.
- `githooks/post-checkout` self-initializes a brand-new worktree: it fires only when the checkout
  creates one (null previous head + branch checkout, i.e. `git worktree add`) and runs
  `pnpm install --prefer-offline`, so the worktree is immediately usable. A failure never aborts the
  checkout — it just leaves the worktree to initialize by hand. The hook is install-only and never
  copies the main checkout's `.env`: the GitHub token lives only in the untracked root `.env`
  (AGENTS), and duplicating it into every worktree widens its exposure — copy `.env` by hand only
  when a token-using command (publish, AI review) must run from a worktree.

Do **not** add generation steps to hooks: generated files are produced on demand by the Makefile and
publish tooling (ADR 0008).

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

`dev` publishes to a per-run branch (`dev-build-<id>`, where `<id>` defaults to
`<current-branch>[-<note-slug>]-<short-sha>` or `DEV_BUILD_ID`), so a test build never touches the
live `latest` release or the `gh-pages` site. Publishes are **branch-only** by default (ADR
[0026](./decisions/0026-publish-channels-and-dead-channel-fallback.md)) — no release is created;
`--tag` additionally creates the pre-release page (title `dev-build-<id>` or, with a note,
`dev-build-<id> — <label>`; body with the note, a test-build warning and provenance) for RC-style
announcements. `--note="<label>"` labels the build either way: the slug joins the branch id
(`--note="RC 1"` → `dev-build-<branch>-RC-1-<sha>`), and with `--tag` it leads the page title and
body. Both flags are dev-only. The release body links the branch and carries the manual-download
artifacts: the `utils` + `fx-folder` zips and the installer binary (the `updater-ui` zip and helper
binaries stay branch-only — the updater fetches `updater-ui` itself and helpers are installer-side).
Dev URLs are baked into the built artifacts and served from `cdn.jsdelivr.net` for the
browser-facing pieces (installer web UI, remote updater UI) and `raw.githubusercontent.com` for the
privileged engine fetches (chrome:// context has no CORS). Delete the dev branch only after its
users have received the fallback logic (ADR 0026 — republish into the same `DEV_BUILD_ID` first so
installed test builds auto-update while the branch lives): `git push origin --delete dev-build-<id>`
(CI test runs delete it automatically in a `finally`; `pnpm dev-clean` removes branches and their
tags).

### `pnpm upload` reference

Complete flag + environment surface of the publish entry point. **On your machine, `pnpm upload` is
dev-channel-only** — `--mode=dev` publishes a test build, `--mode=prod` aborts (the `latest` release
needs the full cross-OS binary set, buildable only in CI). The one local prod exception is
`upload:local`, the offline snapshot: same command, nothing leaves the machine. Everything here
applies to `pnpm upload:local` too unless noted (its only differences: `--local` is implied, no
token needed, nothing leaves the machine).

For the common cases you do not need this table — the role-oriented front doors dispatch CI with the
right pre-set (`pnpm release` accepts `--mode/--include/--ref/--force` and passes any other
`-f key=value` to gh verbatim):

```bash
pnpm release:all         # full prod publish (all roles)
pnpm release:packages    # the script zips + updater-ui only — a held-back installer/helper
                         # keeps serving its last published bytes (the AV holdback)
pnpm release:installer   # installer + helper only — a held-back packages role is rarely
                         # what you want in prod (see the dev-strand warning in ADR 0030)
pnpm release -- --include=packages,helper --mode=dev --ref=<branch>   # any combination
```

| Flag                            | Modes         | What it does                                                                                                                                                                                                                                                                                     |
| ------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--mode=prod\|dev`              | both          | **Required.** `prod` → `latest` release + `gh-pages` (CI-only, ADR 0026); `dev` → the disposable `dev-build-<id>` branch                                                                                                                                                                         |
| `--tag`                         | dev           | Create the RC-style prerelease page for this dev build. **The only release-creating path** — without it a dev publish touches no release at all                                                                                                                                                  |
| `--note="<label>"`              | dev           | Label the build: the slug joins the branch id (`--note="RC 1"` → `dev-build-<branch>-RC-1-<sha>`); with `--tag` it leads the page title + body                                                                                                                                                   |
| `--ref=<branch\|commit>`        | both          | Build that ref in a temporary detached worktree — your checkout is left untouched; the ref's own publish scripts run                                                                                                                                                                             |
| `--force`                       | prod          | Rebuild + re-upload even when hashes are unchanged (dev always rebuilds everything)                                                                                                                                                                                                              |
| `--include=<roles>`             | both          | **Required.** Roles this run publishes: `packages`, `installer`, `helper`, or `all` — comma-separated/repeatable. Partial publish (AV holdback): a role left out is not built, scanned or uploaded, and its `hashes.json` entry stays frozen (ADR [0030](./decisions/0030-partial-publishes.md)) |
| `--platform=win\|linux\|mac`    | binary builds | Platform set, repeatable; `linux` also builds the aarch64 twin. Defaults to the current OS — CI passes one per job; a local prod run cannot widen past its own OS (the guard below)                                                                                                              |
| `--local`                       | both          | Offline snapshot to `dist/<mode>-<branch>-<hash>/` (no token, no network) — what `upload:local` implies                                                                                                                                                                                          |
| `--keep-copy`                   | GitHub runs   | Also keep a `dist/<mode>-copy-…/` copy of what was uploaded                                                                                                                                                                                                                                      |
| `--no-tag`                      | prod          | Skip moving the `latest` tag to the uploaded commit                                                                                                                                                                                                                                              |
| `--build-only` / `--skip-build` | prod          | Pass 1 / pass 2 of the SignPath signing flow (stage-and-exit / publish signed artifacts)                                                                                                                                                                                                         |
| `--verbose` / `--quiet`         | both          | Per-file zip listings / suppress progress (errors still print)                                                                                                                                                                                                                                   |

A real (non-`--local`) `--mode=prod` run outside the Pages workflow is **aborted before building**
(`prodCiGuard.mjs`, ADR 0026): a dev machine builds only its own OS's binaries, while the `latest`
release contract is the full cross-OS set (ADR 0024) — buildable only by the workflow's per-OS
matrix. The `--ci` flag is gone: it only ever widened the platform set, so a laptop `--ci` run would
still have published a partial release. The workflow sets an internal marker env on its upload jobs;
nothing else passes the guard.

The local front door for the prod publish is the **`pnpm release`** alias — a thin wrapper that runs
exactly `gh workflow run pages.yml -f mode=<mode> -f include=<roles>` (no local build, no watch
mode; follow the run in the Actions tab). Its scope is opt-in like upload.mjs's: `--include=all` (or
the `release:all` preset) is the full publish, and a bare `pnpm release` fails loudly rather than
guessing:

```bash
pnpm release:all              # dispatch the prod publish (full cross-OS matrix in CI)
pnpm release -- --include=all --force   # rebuild even when hashes are unchanged
```

Prod dispatch never runs from a branch other than `main` (the workflow's own gate), and the run diff
every OS job against the same pre-run baseline manifest, so the release always ends up the complete
set or nothing new.

| Environment variable                 | Effect                                                                                                                              |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `DEV_BUILD_ID`                       | dev only — override the branch id, so `dev-build-<id>` (republish into an existing name)                                            |
| `GITHUB_TOKEN_VAR`                   | Fixed name of the env var holding the GitHub token; read from the root `.env`                                                       |
| `FIREFOX_SCRIPTS_STORED_HASHES_FILE` | Diff against this manifest instead of the live one (how the CI matrix keeps every OS job diffing against the same pre-run baseline) |
| `FIREFOX_SCRIPTS_REF_NAME` / `_SHA`  | Internal — set by the `--ref` machinery, not for hand use                                                                           |

What a run publishes (the hash comparison itself is [status-logic.md](./status-logic.md)):

- **Local artifacts** — `dist/` staging: the three zips (`utils`, `fx-folder`, `updater-ui`), the
  installer + helper binaries for the selected platforms, and `hashes.json`. Unchanged binaries are
  reused from the newest previous snapshot instead of recompiled; the untracked generated files are
  regenerated for the run and removed afterwards.
- **prod → GitHub** — rebuilt zips and installer binaries are attached to the `latest` release as
  **release assets (the human manual-download surface)**; the zips (for machine fetches), helpers,
  `hashes.json` + `updater-ui.zip` go to `gh-pages`, the single host every installer/updater fetch
  reads; the `latest` tag moves to the published commit (unless idle or `--no-tag`); the component
  date tags are synced (#72). A run where nothing changed uploads nothing.
- **dev → GitHub** — the same artifact set (with `-dev` names) to the `dev-build-<id>` branch via
  the git-data API, content-addressed: unchanged files create no commit. No release unless `--tag`.

### Run

```bash
pnpm release:all                         # prod publish: dispatch the CI cross-OS matrix (gh)
pnpm upload -- --mode=dev                # always rebuild + upload, to the dev-build-<id> branch (branch-only, no release)
pnpm upload -- --mode=dev --tag          # + create the RC-style prerelease page for this dev build
pnpm upload -- --mode=dev --note="RC 1" --tag   # label: branch dev-build-<branch>-RC-1-<sha>, page title `… — RC 1`
pnpm upload -- --mode=dev --ref=<ref>    # build <ref> in a temp worktree (your checkout untouched)
DEV_BUILD_ID=main-450468f pnpm upload -- --mode=dev   # republish into an existing dev-build branch name
pnpm upload:local -- --mode=prod         # offline snapshot to dist/prod-<branch>-<hash>/ (no token)
pnpm upload:local -- --mode=dev          # dev snapshot (-dev artifact names), no token
```

`pnpm upload -- --mode=prod` is CI's command, not a local one — from a dev machine it aborts before
building (see the guard note under the reference above).

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
3. In prod, uploads the changed artifacts (`utils.zip`, `installer_win.exe`, …) as release assets —
   the human manual-download surface; no machine consumer reads them.
4. Pushes the **changed** artifacts to the publish branch — this is the host every machine fetch
   reads (installer tab and in-browser updater alike: `ZIP_BASE_URL` = `ZIP_PAGES_URL`), because
   GitHub Pages sends `Access-Control-Allow-Origin: *` (in dev mode the same branch is read through
   jsDelivr, which is also CORS-enabled). The branch is created automatically on first run. Only the
   artifacts rebuilt this run are pushed, so an unchanged package keeps its live artifact.
5. Publishes the hash manifest (`hashes.json`) to the same branch.
6. Prod only, when something was rebuilt: syncs the date-stamped **component releases**
   (`scripts-<date>` for rebuilt package zips, `installer-<date>` for rebuilt installers + helpers,
   incl. the helper `.sha256` sidecars) alongside `latest` — created with `prerelease: true` so they
   can never take GitHub's "Latest" badge, which stays on `latest` (issue #72, ADR 0019). The tags
   are frozen per-component snapshots for humans to browse; artifacts are always fetched by the
   permanent unversioned names from `latest`/gh-pages, and `hashes.json` stays the machine source of
   truth. An idle run (nothing rebuilt) leaves the date tags untouched.

Prod mode refuses to publish unless the current git branch is `main`; dev mode works from any branch
(dev URLs are baked into the regenerated generated files on purpose). `upload:local` runs on any
branch with no token. A missing manifest on the publish branch (first run) is treated as "publish
everything", so the first run creates it; `--force` also refreshes the manifest even when hashes are
unchanged.

The same run compiles the installer and helper binaries when their source (`installer/src/`,
`installer/src/helper/`) changes:

- `installer_win.exe` / `installer_linux` / `installer_linux_aarch64` / `installer_mac` — uploaded
  as assets of the release tagged by `RELEASE_NAME` (`installer_win-dev.exe` etc. in dev mode).
- `helper_win.exe` / `helper_linux` / `helper_mac` — pushed to the publish branch (the in-browser
  updater fetches them from there).
- By default it builds only the current OS, or `--platform=win|linux|mac` for an explicit set (each
  platform needs its own build machine — which is why prod publishes are workflow-only).

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
