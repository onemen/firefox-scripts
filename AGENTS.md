# Repository Guidelines

## Scope

These instructions apply to the entire `firefox-scripts` repository. If a subdirectory ever adds its
own `AGENTS.md`, that nested file is more specific and overrides this one where they conflict.

## Critical Rules

- **Never hand-edit generated files.** They are gitignored build products, regenerated on demand
  from their sources (see the Generated files section).
- **Do not publish or upload** unless the user explicitly asks. Use `upload:local` for offline
  validation.
- **Never merge a PR without the user's explicit approval** — open PRs for review and wait.
- **Never expose the GitHub token.** It lives only in an untracked root `.env` under the fixed
  `GITHUB_TOKEN_VAR` name — do not commit, log, or rename that variable.
- **Do not introduce Python**; build and asset tooling uses Node.js.
- Prefer the smallest change that solves the requested problem. Avoid unrelated refactoring,
  formatting, renaming, dependency updates, or architectural changes.
- Do not base work on `.local` files/dirs; they are local drafts and gitignored.
- Preserve upstream provenance in `core/`: files outside `updater/` come from
  xiaoxiaoflood/firefox-scripts (MPL-2.0); `updater/` is custom (MIT). Avoid unrelated changes to
  upstream-derived files.
- Read the relevant `docs/` (and `docs/local_plan/`) before architectural or design changes.

## Overview

**firefox-scripts** installs and keeps up to date the helper scripts that let Firefox-family
browsers (Firefox stable/Nightly/Developer Edition, Waterfox, Zen, LibreWolf, Floorp) run legacy
(non-WebExtension) extensions. Three parts:

1. **Native C installer** (`installer/`) — detects a running browser (process scan + lock-file
   inspection), serves an embedded web UI over `127.0.0.1:8777`, and copies two packages:
   - **fx-folder** (`core/fx-folder/`) — `config.js` + `config-prefs.js`, copied to the browser
     install dir (`GreD`).
   - **utils** (`core/chrome/utils/`) — userChromeJS loader, legacy-extension shim, and the
     in-browser updater scheduler, copied to `ProfD/chrome/utils/`.
2. **In-browser updater** (`core/chrome/utils/updater/` + `tools/publish/remote-ui/`) — a privileged
   module that checks a published hash manifest daily, self-updates the updater tab UI, notifies on
   new versions, and applies updates in place. The tab itself is a chrome-privileged page shipped
   inside `updater-ui.zip` (built from `tools/publish/remote-ui/`) — no remote page, no iframe, no
   postMessage.
3. **Updater tab UI** (`updater-ui.zip` → `ProfD/chrome/utils/updater/ui/`) — `updater.html`,
   `updater.js` (engine), `updater-ui.js` (client), the generated `updater.css`, and the brand
   logos. `scriptsUpdater.sys.mjs` (utils.zip) keeps it current before opening the tab.

Publishing is Node/ESM tooling in `tools/publish/` that uploads zips and installer binaries to a
**GitHub Release** (`latest`) and the package zips + `hashes.json` + helper binaries to the
**gh-pages** branch (Pages sends `Access-Control-Allow-Origin: *`, which the installer tab needs;
release-asset CDNs do not).

## Architecture invariants

Full design notes live in `docs/` (`DEVELOPING.md`, `auto-updater.md`, `status-logic.md`). These
facts most often cause bugs:

- **Single source of truth** is `config/installer.conf`: it generates `installer/src/_config.h` (C),
  `core/chrome/utils/updater/updater-config.sys.mjs` (updater), and feeds `tools/publish/paths.js`.
- **Hash-based detection.** Per-package SHA-256 manifest (`hashes.json`): for each file
  `sha256(rel_path + '\n') + sha256(file_bytes)`, files sorted case-insensitively; a missing file
  contributes only its path. Equal → Up to date; differs with at least one file present → Update
  available; zero files present → Not installed. JS ref `tools/publish/hashUtils.mjs`; C twin
  `compute_directory_sha256` in `installer/src/detect_browser.c`; cross-checked by
  `installer/test/test_hash.mjs`.
- **The C installer does zero network I/O** — the browser tab fetches the zips, manifest and release
  lists from CORS-enabled hosts and POSTs the bytes to the local server.
- **Updater flow:** `scriptsUpdater.sys.mjs` does a daily check of utils + fx-folder → if either
  needs an update it keeps `updater-ui.zip` current (silent download+verify+extract into
  `chrome/utils/updater/ui`) → opens one
  `b.addTrustedTab(chrome://firefox-scripts/content/ui/updater.html)` → `updater.js` (same package)
  downloads, verifies, extracts and copies; admin-protected dirs use a freshly downloaded standalone
  helper binary (single UAC prompt, exit 2 = cancelled). If a package cannot be downloaded the check
  exits silently — no fallback UI.
- **Publishing:** `--mode=prod` → `latest` release + `gh-pages` (branch `main` only); `--mode=dev` →
  disposable `dev-build-<id>` branch, `-dev` artifact names, served via jsDelivr. Requires a clean
  worktree; real runs need `GITHUB_TOKEN_VAR`.
- **Gotchas:** Waterfox skips `BootstrapLoader.js` in `config.js`. Per-package skip prefs
  `extensions.firefox-scripts.skippedHash.<pkg>`; daily gate prefs `lastScriptsCheckDate` /
  `lastUpdateTabShown`. `versionInfo.json` is obsolete (excluded from zips; installed copies cleaned
  by `installer/src/obsolete_files.h`).

## Key directories

| Path                 | Purpose                                                                                                                           |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `core/fx-folder/`    | Config package: `config.js` + `defaults/pref/config-prefs.js`                                                                     |
| `core/chrome/utils/` | userChromeJS loader (`userChrome.js`), legacy shim (`BootstrapLoader.js`), RDF/xPref modules, `updater/`                          |
| `installer/src/`     | C app: `main.c`, `detect_browser.c`, `http_server.c`, `admin_copy.c`, `file_utils.c`, `self_update.c`, `helper/`, `vendor/miniz/` |
| `installer/web/`     | Embedded UI (`index.html`, `script.js`, `style.css`, `logos/`) → gzip-embedded into `resources.h`                                 |
| `tools/publish/`     | Release pipeline: zips, installer/helper binaries, hashing, Pages upload, on-demand generated-file generation, `remote-ui/`       |
| `config/`            | `installer.conf` (source of truth) + eslint/prettier configs                                                                      |
| `docs/`              | Developer guide + design notes (auto-updater, status logic, restart UI tab, generated-files decision, future work)                |

Entry points when debugging: `core/fx-folder/config.js` (autoConfig bootstrap that starts
everything), `core/chrome/utils/chrome.manifest` (maps `chrome://userchromejs/*`,
`resource://userchromejs/*`, `chrome://firefox-scripts/content/*`),
`core/chrome/utils/updater/scriptsUpdater.sys.mjs` (daily check + updater-ui self-update),
`tools/publish/remote-ui/updater.js` (tab engine), `tools/publish/syncGeneratedFiles.mjs`
(regenerate/verify the generated files).

## Generated files

Three files are generated from sources, **gitignored and regenerated on demand** — never hand-edit
them; edit the source and regenerate (the installer Makefile does it on every build, createZip.mjs
at publish time, or by hand via `node tools/publish/syncGeneratedFiles.mjs`):

| Generated file                                     | Source(s)                                                 | Regenerated by                                            |
| -------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------- |
| `core/chrome/utils/updater/updater-config.sys.mjs` | `config/installer.conf` (via `generateUpdaterConfig.mjs`) | `createZip.mjs` at publish time (ships in utils.zip)      |
| `tools/publish/remote-ui/updater.css`              | `installer/web/style.css` + `tools/publish/updater.css`   | `createZip.mjs` at publish time (ships in updater-ui.zip) |
| `installer/src/_config.h`                          | `config/installer.conf`                                   | installer Makefile (`config` target)                      |
| `installer/src/resources.h`                        | `installer/web/*` (via `installer/embed.mjs`)             | installer Makefile (`resources` target)                   |

Because the files are not committed, the publish hashes cover their **true sources** instead of the
artifacts: the utils hash/file list explicitly includes `updater/updater-config.sys.mjs` (it ships
inside the zip), the updater-ui hash/file list includes `updater.css` (it ships inside
updater-ui.zip), and the installer hash covers `installer/src` + `installer/web/*` +
`config/installer.conf` (see `docs/generated-files-decision.md`). At the end of every `upload` run
the generated files are **deleted from disk** (`cleanGenerated`) so the working tree matches a fresh
clone — no localhost/dev-baked copies linger. `installer.conf` is a base value — changing it shifts
package hashes, which is how updates propagate.

## Local plans

`docs/local_plan/` holds working design drafts in their **own git repository** (ignored by this
repo). Read the relevant draft before planning work in an area; when the plan changes while you
work, commit the update inside that repo (`git -C docs/local_plan add -A && git commit -m "…"`).
Never commit `docs/local_plan/` content to this repository.

## Commands

Package manager is **pnpm** (root-only workspace, `"type": "module"`). No git hooks — generated
files are produced on demand by the build/publish tooling.

```bash
pnpm install
pnpm lint          # eslint + C format check
pnpm format        # check: C + prettier
pnpm format:fix    # apply both
pnpm test          # unit tests (tools/test/unit/, pure Node, no build)

# hash parity JS vs C (auto-generates a prod snapshot via upload:local if needed;
# also works against the newest dev- snapshot, so it runs after upload:local --mode=dev)
pnpm test:hash
```

**Publish — only when the user explicitly asks.** `upload:local` is the token-less offline check:

```bash
pnpm upload:local -- --mode=prod         # full snapshot to dist/prod-<branch>-<hash>/ (no token)
pnpm upload -- --mode=prod               # zips + binaries → latest release + gh-pages
```

`--mode=prod|dev` is required; prod publishes the `latest` release + gh-pages from `main` only, dev
publishes to `dev-build-<id>` (delete the branch after testing). Full walkthrough:
`docs/DEVELOPING.md`.

Installer build (Windows: MSYS2 UCRT64 `mingw32-make`): `make dist_win` / `dist_linux` / `dist_mac`,
`helper_*`, `resources`, `config`, `verify`.

## Conventions

- **Firefox privileged modules:** `.sys.mjs` ESM via `ChromeUtils.importESModule` /
  `defineESModuleGetters` with full `chrome://` or `resource://` specifiers. Never bare paths.
- **Window-context legacy JS:** plain `.js` with `'use strict';` loaded via
  `Services.scriptloader.loadSubScript`. No `innerHTML` in the updater tab (XML-parsed XHTML; toggle
  via `hidden`).
- **C:** clang-format LLVM base; UTF-8 paths with wide/UTF-16 conversion on Windows;
  `installer_log()` logging; vendored miniz read-only (`-DMINIZ_NO_DEFLATE_APIS`).
- **JS formatting/lint** is enforced by prettier + eslint (configs in `config/`) — run
  `pnpm format:fix` / `pnpm lint` before finishing.
- **Error handling:** fail-fast with clear messages; elevation failures distinguish cancel (exit 2);
  network failures surface a banner in the UI, not a silent partial install.

## Testing & QA

Match the change to its validation:

| Change                      | Validate with                                                           |
| --------------------------- | ----------------------------------------------------------------------- |
| C (`installer/src/`)        | build the affected target (`make dist_win` / `dist_linux` / `dist_mac`) |
| Hash / file list            | `pnpm test:hash`                                                        |
| Publish helpers / hashing   | `pnpm test` (unit tests in `tools/test/unit/`)                          |
| Generated-file sources      | `node tools/publish/syncGeneratedFiles.mjs`                             |
| Packaging / publish scripts | `pnpm upload:local -- --mode=prod`                                      |

Pre-PR gates: `pnpm lint`, `pnpm format`, `pnpm test`, and the hash test. **Do not claim tests
passed if the required toolchain or environment was unavailable.**

PRs that modify `core/**` must add or extend a test where feasible; if not, the PR description must
explain why. (The mechanical "core changed && no test changed → fail" CI gate lands together with
the core smoke tests — see issue #30.)

## Agent workflow

Before changing code:

1. Identify the affected subsystem.
2. Read the relevant `docs/` (and `docs/local_plan/`) documentation.
3. Check whether the affected files are generated.
4. Make the smallest appropriate change.
5. Regenerate generated files on demand when their sources change (make / createZip /
   syncGeneratedFiles).
6. Run the relevant validation (matrix above).

Before finishing:

- generated files are regenerated on demand (Makefile / createZip / syncGeneratedFiles);
- no `.local` files were used as authoritative sources;
- `docs/local_plan/` changes remain in its own repository;
- no unrelated files were modified;
- failed/unavailable validation is reported.

### Roadmap tracking

- GitHub is the live tracker: the v1.0 milestone, phase issues #3 (Phase 4) / #4 (Phase 5) and the
  Post-v1.0 roadmap umbrella (#38) hold the checklists; `docs/roadmap.md` is the durable snapshot.
- Every PR links its issue (`Fixes #x` / `Part of #y`); tick the checklist item when the work
  merges.
- Update `docs/roadmap.md` only in the PR that changes scope — never per-commit.
- Never duplicate a checklist in both a doc and an issue: the doc links to the issues.

## Tooling

- **Node ≥ 20.19** (`--env-file-if-exists`; eslint 10 engines need `^20.19 || ^22.13 || >=24`),
  **pnpm** (lockfile v9), `"type": "module"` for all `tools/` scripts.
- **C toolchain:** MSYS2 UCRT64/mingw-w64 on Windows (`-mwindows` GUI subsystem); clang/gcc
  elsewhere; `clang-format` pinned via npm. All asset embedding is Node (`installer/embed.mjs`).
- **No CI yet** (no `.github/workflows`); prod publish is manual from `main`. All publish scripts
  require a clean worktree.
