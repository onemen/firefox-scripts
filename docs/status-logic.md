# Status Logic — Install & Update

How the project decides whether a browser's `config.js` (fx-folder) and `utils` files are installed,
up to date, or missing.

Two phases feed the same hash-based status:

1. **Publish** — builds the zip packages and hash manifest, uploads them to GitHub.
2. **Install / Update** — the Windows installer downloads those artifacts, compares them against the
   local files in the browser's profile/binary folder, and reports **Up To Date** / **Update
   Available** / **Not Installed**.

---

## Where files are stored on GitHub

| Artifact                                                  | Host                 | URL                                                                                |
| --------------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------- |
| `fx-folder.zip` (config package)                          | GitHub Release asset | `https://github.com/onemen/firefox-scripts/releases/download/latest/fx-folder.zip` |
| `utils.zip`                                               | GitHub Release asset | `https://github.com/onemen/firefox-scripts/releases/download/latest/utils.zip`     |
| `hashes.json` (hash manifest)                             | gh-pages branch      | `https://onemen.github.io/firefox-scripts/hashes.json`                             |
| `helper_win.exe` / `helper_linux` / `helper_mac`          | gh-pages branch      | `https://onemen.github.io/firefox-scripts/helper_<platform>` (+ `.exe` on Windows) |
| `installer_win.exe` / `installer_linux` / `installer_mac` | GitHub Release asset | `https://github.com/onemen/firefox-scripts/releases/download/latest/`              |

Notes:

- The zip and installer packages are attached to a GitHub **Release** (tag `RELEASE_NAME` from
  `config/installer.conf`) in the `firefox-scripts` repo. The hash manifest lives on the
  **gh-pages** branch because it is updated more often than a release and the branch is CORS-enabled
  (the installer tab fetches it).
- The hash manifest has one entry per package, including the **canonical file list** the installer
  hashes over:
  `{"utils": {"hash": "...", "files": ["..."], "date": "..."}, "fx-folder": {"hash": "...", "files": ["..."], "date": "..."}}`,
  plus `installer` / `helper` entries recording the binary source hashes (used by `upload.mjs`). The
  installer has **no hardcoded file lists** — it reads `files` from this manifest (see §2.1).
- Config is driven by `config/installer.conf` → `installer/src/_config.h` (C) and
  `tools/publish/paths.js` (JS). The single source of truth is `config/installer.conf`.

---

## Phase 1 — Publish (upload to GitHub)

Entry point: `tools/publish/upload.mjs`.

### 1.0 Available scripts (root `package.json`)

| Script         | Command                                 | What it does                                                                                                    |
| -------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `upload`       | `node tools/publish/upload.mjs`         | Hashes sources, rebuilds changed zips + binaries, uploads release assets + Pages, publishes the hash manifest   |
| `upload:local` | `node tools/publish/upload.mjs --local` | Same, but writes a complete snapshot to `dist/<mode>-<branch>-<hash>/` instead of GitHub (no token, no network) |

All upload commands require the GitHub token (`GITHUB_TOKEN_VAR`) in a root `.env` (copied from
`.env-example`; read automatically via `--env-file-if-exists`). `upload` compares the computed hash
against the previously published hash and creates/upload an artifact **only when it changed**, and
pushes only that changed set to Pages. `--mode=dev` (or `--force`) skips the change check and always
rebuilds + re-uploads.

`upload` **fails fast** (exit 1, before building anything) when the token is empty — i.e. missing or
empty `.env` and no `GITHUB_TOKEN_VAR` exported. Without this guard, an empty token silently skipped
every upload yet still exited 0 with "✓ Done". `upload:local` intentionally runs without a token.

### 1.1 Flow

1. Load gitignore patterns (repo `.gitignore`) + custom ignores. Two filter sets are used:
   - **zip patterns** — the shipped file set (obsolete files excluded via `CUSTOM_IGNORE_PATTERNS`
     in createZip.mjs).
   - **hash patterns** — exclude the same obsolete files, so the hash covers only files the
     installer manages and the zip content equals the canonical list.
2. For each source directory:
   - `core/chrome/utils` → `utils.zip` + utils hash + utils `files` list
   - `core/fx-folder` → `fx-folder.zip` + fx-folder hash + fx-folder `files` list
3. `computeDirectoryHash()` returns `{hash, files}` — the hash of the filtered file set and the
   sorted list of relative paths that were hashed. The `files` list is the package's **canonical
   file list** and is published in the manifest.
   - The generated `updater/updater-config.sys.mjs` is **untracked/gitignored**, so it is added back
     explicitly to the utils set (`computeDirectoryHash`'s `extraFiles`, and `createZip`'s
     `extraFiles`) after the gitignore filter — the zip, hash and manifest always agree, and a
     config change still bumps the utils hash.
4. Compare the computed hash against the previously published hash (from the gh-pages manifest).
   - If unchanged → nothing to do.
   - If changed → create the zip (with the zip patterns), upload it as a Release asset, and update
     the gh-pages manifest hash **and the `files` list**.
5. Push every changed artifact to the `gh-pages` branch of `onemen/firefox-scripts` in **one
   commit** (`uploadFilesToPages()` — the installer UI fetches the zips from Pages because it sends
   `Access-Control-Allow-Origin: *`): the rebuilt zips (`utils`, `fx-folder`, `updater-ui`), the
   helper binaries, and the hash manifest. Each blob is content-addressed, so unchanged files are
   skipped and an idle run creates no commit; only changed files are written, so an unchanged
   package keeps its live artifact instead of being replaced by a stale `dist/` copy.
6. In `--local` mode the artifacts and the manifest (hash + `files` + date) are written to
   `dist/<mode>-<branch>-<hash>/` instead of uploaded; its `hashes.json` becomes the baseline for
   the next local run. The generated `updater-config.sys.mjs` points the in-browser updater at that
   directory via `file://` URLs (self-contained, no server); the C installer keeps
   `http://localhost:<DEFAULT_PORT>/` (its tab is HTTP-served, `CFG_LOCAL`).

### 1.2 Binary publish (unified with the zips in `upload.mjs`)

- Scope: the current OS locally; `--ci` for all three platforms; `--platform=win|linux|mac` for an
  explicit set. A binary is (re)compiled only when the hash of its source inputs changed: the
  installer hash covers `installer/src` (minus `helper/`) **plus** `installer/web/*` and
  `config/installer.conf` — the generated `_config.h`/`resources.h` are gitignored build products,
  so their true sources are hashed instead (`computeFileSetHash` in hashUtils.mjs). The helper hash
  covers `installer/src/helper`. Both are recorded in the manifest's `installer`/`helper` entries.
  In `--mode=dev` (or with `--force`) binaries are always recompiled and re-uploaded.
- `installer_*` binaries are uploaded as **release assets** of the `RELEASE_NAME` release;
  `helper_*` binaries and the hash manifest are pushed to the **gh-pages** branch. In dev mode
  everything goes to the `dev-build-<id>` branch, and a matching `dev-build-<id>` **pre-release** is
  created/updated (its body links the branch) with the manual-download artifacts attached: the
  `utils` + `fx-folder` zips and the installer binary — the `updater-ui` zip and helper binaries are
  branch-only, so a dev build is manually downloadable without duplicating what the
  updater/installer fetch from the branch.
- `--ref=<branch|commit>` builds a specific ref in a temporary detached worktree (the checkout is
  left untouched) and re-runs the upload inside it, so the ref's own tooling builds its source; the
  snapshot / dev-build identity is named after the ref.

> **Branch guard:** the upload path throws unless the current git branch is `main`, so a release can
> only be published from the main branch.

### 1.2 Zip creation (`createZip.mjs`)

- `getAllFiles()` walks the source directory and applies the gitignore patterns.
- Every file that passes the filter is added to the zip with its relative path.
- **Zip layout** (`zipPrefixFor()`): `fx-folder.zip` wraps its files under a top-level `fx-folder/`
  directory so a manual download unzips into an `fx-folder` folder (how it has worked for years).
  `utils.zip` stays flat.
- `versionInfo.json` no longer ships: it is excluded from the zips (`CUSTOM_IGNORE_PATTERNS`) and
  from the hash / manifest (the `HASH_EXCLUDE` entry in `upload.mjs`) so the zip content stays equal
  to the canonical list. It was never synced to a Gist in the consolidated `upload` pipeline.
- The installer treats `versionInfo.json` as a legacy **obsolete file**: previously-installed copies
  are deleted after install (§2.1).

### 1.3 Hash computation (`hashUtils.mjs`)

`computeDirectoryHash(dir, patterns, extraFiles?)`:

- Enumerate files via `getAllFiles()` (same filter as the zip).
- `extraFiles` (utils only) adds the untracked generated `updater/updater-config.sys.mjs` back to
  the set — it ships inside the zip and must be hashed and listed.
- Sort by relative path (case-insensitive).
- For each file: hash `rel_path + "\n"` followed by the raw file bytes.
- Result: `{ hash, files }` — SHA-256 hex of the concatenation plus the sorted list of hashed
  relative paths.

The installer binary hash uses `computeFileSetHash(entries)` instead: a labeled set of files
spanning `installer/src` (minus `helper/`), `installer/web/*` and `config/installer.conf`, so a UI
or config change still triggers an installer rebuild even though the generated C headers are not
committed.

> **Only the publish phase filters the file list.** Filtering here is what keeps unwanted files
> (e.g. local-only files like `*.local.*`, `*.local` directories) out of the zip and the hash. The
> installer's hash check must therefore compute over the **same final file set** that publish
> shipped — no filtering of its own. That set is published in the manifest's `files` array, so both
> sides hash the identical list.

### 1.4 Ignoring local-only files

The repo `.gitignore` contains ignore patterns that keep local-only files out of the zip and hash:

```
*.local.*
*.local
```

These exclude files such as `UpdateNotification.local.sys.mjs` and the whole `styloaix.local/`
directory, so `utils.zip` ships the full `core/chrome/utils` tree: the BootstrapLoader files
(`BootstrapLoader.js`, `chrome.manifest`, `RDFDataSource.sys.mjs`, `RDFManifestConverter.sys.mjs`,
`userChrome.js`, `xPref.sys.mjs`) **plus** the in-browser updater scheduler
(`updater/scriptsUpdater.sys.mjs`, `updater/updater-config.sys.mjs`). The tab UI itself is a
separate package — `updater-ui.zip` (see below). The canonical `files` list for utils in the
manifest covers the whole tree (see the generated list in the newest `dist/prod-*/hashes.json`
snapshot, produced by `upload:local`).

---

## Phase 2 — Install / Update (download from GitHub)

### 2.1 Startup flow

1. **Installer starts.**
2. **Verify both zip packages exist on the web** (`fx-folder.zip`, `utils.zip`).
   - If either is missing → show an alert to the user and exit. There is nothing to install.
3. **Fetch the package manifest** (`hashes.json`) and cache the published hashes **and the canonical
   `files` list** for each package. This happens before the browser scan so the initial detection
   and the first status polls never block on the network.
   - If the manifest is unreachable or unparseable, **download both zips**, derive each package's
     file list from the extracted contents **minus the obsolete-files set**, and compute the hashes
     locally with the same algorithm — the zips are the source of truth.
4. **Identify the active browser profiles.**
5. For each profile, **compute the local hash** over the canonical file list.
   - If a file is missing on disk, treat it as `""` (empty string) for the hash input (see §2.3).
6. Compare local vs published hash to derive the status badge.

The installer keeps **no hardcoded file lists**. The canonical list comes from the manifest's
`files` array (primary) or is derived from the zips minus the obsolete files (fallback). Obsolete
files are listed in `installer/src/obsolete_files.h` (`versionInfo.json` — legacy, no longer
shipped); they are excluded from the hash and are **deleted after install** so the installed set
matches the published list.

**Zip layout is handled at install time.** The config package is installed with
`extract_zip_flatten()` (`installer/src/file_utils.c`), which extracts into a temp dir, descends
into a single top-level folder when the archive has one (the `fx-folder/` wrapper), and moves the
contents into the browser's binary dir — so files land flat regardless of the zip layout. The
zip-derived hash fallback applies the same descent (`find_flat_package_base`), so the published hash
and the installed layout always agree.

### 2.2 Hash comparison rules

| Local hash vs published hash | File presence      | Meaning                                |
| ---------------------------- | ------------------ | -------------------------------------- |
| Equal                        | any                | **Up To Date**                         |
| Different                    | all files present  | **Update Available**                   |
| Different                    | some files present | **Update Available** (partial install) |
| Different                    | no files present   | **Not Installed**                      |

**Not Installed** is reserved for the case where **every** file in the canonical list is missing
from the profile. A partial install (some files present, some missing) is treated as **Update
Available**, because installing/updating is the action that restores the missing files.

### 2.3 Missing files = empty string

The installer treats a missing file as `rel_path + "\n"` with **no bytes**:

- Every file in the canonical list contributes `rel_path + "\n" + file_bytes` to the hash.
- If the file is missing on disk, it still contributes `rel_path + "\n"` but with no bytes (empty
  content), so the hash stays well-defined for partial installs.

**The canonical list must exactly equal the file set publish ships.** Publish's hash
(`computeDirectoryHash` in `tools/publish/hashUtils.mjs`) iterates only over files that actually
exist — it emits **no entry** for a listed-but-missing file. So a file that is on the list but
absent from the source/zip makes the local and published hashes diverge and the UI will report
**Update Available** forever. The empty-string substitution does _not_ by itself create cross-side
agreement. Agreement comes from the two sides hashing the **same list**: the publish `files` array
is embedded in the manifest the installer reads, and the zip-derived fallback builds the list from
the very zips publish produced (minus obsolete files) — so no separate hand-maintained list exists
in the installer to drift.

### 2.4 Status derivation

With the empty-string rule, a single pass over the canonical file list can produce all the
information the UI needs:

- how many listed files exist (drives **Installed** vs **Not Installed**), and
- the aggregate hash (drives **Up To Date** vs **Update Available**).

Status decision from one hash pass:

1. Compute the local hash with empty-string substitution for missing files.
2. If it equals the published hash → **Up To Date**.
3. Else, if **zero** listed files exist → **Not Installed**.
4. Else (hash differs but at least one file exists) → **Update Available**.

So `installed` means "at least one listed file exists", and **Not Installed** requires
`installed == false` (i.e. all files missing).

The UI badge logic:

- up to date → **Up To Date**
- installed (≥1 file) but not up to date → **Update Available**
- not installed (0 files) → **Not Installed**

---

## Hash algorithm (shared by both phases)

Reference JS: `tools/publish/hashUtils.mjs`, `installer/test/test_hash.mjs`. C implementation:
`compute_directory_sha256()` in `installer/src/detect_browser.c`.

```
input = ""
for each relative path, sorted (case-insensitive):
    input += rel_path + "\n"
    if file exists: input += file_bytes   # else nothing
hash = SHA256(input)
```

Important: the hash covers the exact byte content. Line-ending changes (CRLF vs LF) or any
whitespace change alter the hash, so publish and install must agree on byte-for-byte content.

---

## File lists

The canonical lists are **published in the manifest** (`hashes.json`, `files` array per package) and
read at runtime by the installer — they are not hardcoded in the installer binary. The lists below
are the current values, generated by `upload.mjs` (`upload:local` writes them to the newest
`dist/prod-*/hashes.json` snapshot).

### utils (`core/chrome/utils`, shipped as `utils.zip`)

```
BootstrapLoader.js
chrome.manifest
RDFDataSource.sys.mjs
RDFManifestConverter.sys.mjs
updater/scriptsUpdater.sys.mjs
updater/updater-config.sys.mjs
userChrome.js
xPref.sys.mjs
```

`updater/updater-config.sys.mjs` is the generated (untracked) updater config — regenerated at
publish time and added back to the set explicitly. `versionInfo.json` was removed from the source
(it no longer ships) and is a legacy **obsolete file** (`installer/src/obsolete_files.h`): excluded
from the hash, previously-installed copies are deleted after install. Local-only files (`*.local.*`,
`*.local`) are gitignored and never shipped.

### updater-ui (`tools/publish/remote-ui`, shipped as `updater-ui.zip` → `chrome/utils/updater/ui`)

```
logos/favicon.svg
logos/firefox.png
logos/floorp.png
logos/librewolf.png
logos/waterfox.png
logos/zen.png
updater.css
updater.html
updater.js
updater-ui.js
```

`updater.css` is the generated (untracked) tab stylesheet — regenerated at publish time and added
back to the set explicitly, exactly like `updater/updater-config.sys.mjs`. `updater-ui.zip` is the
updater tab: `updater.html` + `updater.js` (engine) + `updater-ui.js` (client) + `updater.css` +
brand logos, installed into `chrome/utils/updater/ui` and served as
`chrome://firefox-scripts/content/ui/*`. It is not hash-checked by the C installer (no per-package
status UI); the in-browser updater hashes it against this manifest entry to decide when to
self-update.

### fx-folder (`core/fx-folder`, shipped as `fx-folder.zip`)

```
config.js
defaults/pref/config-prefs.js
```

---

## Where the code lives

| Concern                                                   | File / function                                                                           |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Publish: zip creation + filters                           | `tools/publish/createZip.mjs`                                                             |
| Publish: zip layout prefix (`fx-folder` wrapper)          | `tools/publish/createZip.mjs` — `zipPrefixFor()`                                          |
| Publish: hash computation (+ canonical `files` list)      | `tools/publish/hashUtils.mjs` (`computeDirectoryHash` / `computeFileSetHash`)             |
| Publish: orchestration + manifest update                  | `tools/publish/upload.mjs`                                                                |
| Publish: Release asset helpers (module)                   | `tools/publish/uploadUtilsZip.mjs`                                                        |
| Publish: Pages push (module)                              | `tools/publish/uploadToPages.mjs`                                                         |
| Publish: filter helpers                                   | `tools/publish/gitignoreUtils.mjs`                                                        |
| Shared config (owner/repo/URLs/gist)                      | `config/installer.conf`                                                                   |
| Installer: hash check (config/utils)                      | `installer/src/detect_browser.c` — `check_config_status()` / `check_utils_status()`       |
| Installer: directory hash computation                     | `installer/src/detect_browser.c` — `compute_directory_sha256()`                           |
| Installer: remote hash + file-list fetch + cache          | `installer/src/detect_browser.c` — `fetch_remote_hashes()`                                |
| Installer: manifest fetch at startup                      | `installer/src/detect_browser.c` — `prime_hash_cache()`                                   |
| Installer: zip-derived fallback (list + hash)             | `installer/src/detect_browser.c` — `fetch_hashes_from_zips()` / `download_zip_and_hash()` |
| Installer: obsolete files list                            | `installer/src/obsolete_files.h`                                                          |
| Installer: zip extraction (config install strips wrapper) | `installer/src/file_utils.c` — `extract_zip_flatten()`                                    |
| Installer: `--test-hash` from manifest                    | `installer/src/detect_browser.c` — `test_hash_from_manifest()`                            |
| Installer: post-install refresh                           | `installer/src/detect_browser.c` — `refresh_install_status()`                             |
| Installer: status API JSON                                | `installer/src/main.c` — `handle_api_browsers()`                                          |
| Installer: badge rendering                                | `installer/web/script.js`                                                                 |
| Reference hash test                                       | `installer/test/test_hash.mjs`                                                            |
