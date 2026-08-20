# Firefox Scripts — Auto-Updater

Design notes for the in-browser auto-updater that keeps installed scripts and configuration files up
to date. It ships across two packages: the scheduler in `utils.zip` and the tab UI in
`updater-ui.zip`.

## 0. Decisions (from review with author, Aug 2026)

1. **Notification = new tab.** No OS notification: when an update is available the updater opens
   `chrome://firefox-scripts/content/ui/updater.html` as a new tab (via `b.addTrustedTab(...)`).
2. **Card look = installer card, UI shipped as a package.** The updater tab is a chrome-privileged
   page shipped inside `updater-ui.zip` (`updater.html` + `updater.js` engine + `updater-ui.js`
   client + generated `updater.css` + brand logos), installed into `chrome/utils/updater/ui` and
   served as `chrome://firefox-scripts/content/ui/*`. The client calls the engine directly — there
   is no remote page, no iframe and no postMessage bridge. The page renders the installer's design
   system (`installer/web/style.css` classes: `.app-container`, `.header`, `.browser-card`,
   `.badge-*`, `.btn-action`, `.card-progress`, `.manual-download-bar`) verbatim.
   `tools/publish/syncGeneratedFiles.mjs` builds the updater stylesheet in-memory from
   `installer/web/style.css` + the updater-only `tools/publish/updater.css` tail and `createZip.mjs`
   writes it into `updater-ui.zip` (see §3.1/§3.2).
3. **Per-package skip per update-hash.** Prefs `extensions.firefox-scripts.skippedHash.fx-folder` /
   `skippedHash.utils` store the remote hash the user skipped; the check honors them exactly
   (`updateNeeded = hashMismatch && skipHash !== remoteHash`) and clears them when the remote hash
   changes or local files match. `updater-ui` has no skip toggle — it self-updates silently.
4. **Two daily prefs, no false "checked".** `extensions.firefox-scripts.lastUpdateTabShown`
   (YYYY-MM-DD) is set when the notification tab is OPENED, so an ignored tab does not re-open
   within the same day. `extensions.firefox-scripts.lastScriptsCheckDate` is set ONLY by the tab UI
   when the user makes a decision (installs, checks a "Don't show again" box, clicks "Remind me
   Tomorrow", or restarts). Closing the tab without acting — or restarting the browser with the tab
   left open — records nothing, so the pending update resurfaces later instead of being marked as
   "checked".
5. **Admin copy via standalone helper.** A small C binary (`helper_win.exe` / `helper_linux` /
   `helper_mac`) — sources at `installer/src/helper/`, built by `installer/Makefile helper_*` — is
   downloaded from the publish branch (`HELPER_BASE_URL` in `config/installer.conf`), unblocked
   (`Zone.Identifier` ADS / quarantine / chmod +x), and invoked from the tab with
   `Subprocess.sys.mjs` as `helper <src> <dst> <src> <dst> ...`. It self-elevates with a single UAC
   prompt when the destination is not writable.
6. **No "Check for updates now" button** — daily timer only.
7. **Manual download option.** Users who prefer not to install automatically can download both zips
   (`utils.zip`, `fx-folder.zip`) — the updater tab and the installer UI both show two plain links
   ("configuration files", "utils"). Each link is a real user click; the zip is fetched and turned
   into a same-origin blob URL (`<a download>`), so the current tab is never navigated away and no
   new tab is opened.
8. **Config URLs come from installer.conf.** The updater imports `updater-config.sys.mjs` —
   auto-generated from `config/installer.conf` by `tools/publish/generateUpdaterConfig.mjs` at
   publish time (same pattern as the C installer's Makefile-generated `_config.h`). A URL/path
   change by the developer propagates everywhere and, because the generated file ships inside
   `utils.zip`, changes its hash → the hash-based detector treats it as an update.
9. **Waterfox.** Waterfox bundles the legacy-extension BootstrapLoader, so `config.js` skips only
   the `BootstrapLoader.js` load on Waterfox; `userChrome.js` and the updater work normally.

## 1. Purpose

The installer (`installer_win.exe` / `installer_linux` / `installer_mac`) installs three packages
into a Firefox-based browser:

| Package          | Contents                                                                                                     | Destination                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| `fx-folder.zip`  | `config.js`, `defaults/pref/config-prefs.js`                                                                 | browser installation directory (`GreD`)      |
| `utils.zip`      | `BootstrapLoader.js`, `chrome.manifest`, `userChrome.js`, `RDF*.sys.mjs`, `xPref.sys.mjs`, updater scheduler | profile `chrome/utils/` (`ProfD`)            |
| `updater-ui.zip` | `updater.html`, `updater.js`, `updater-ui.js`, `updater.css`, `logos/*`                                      | profile `chrome/utils/updater/ui/` (`ProfD`) |

> **fx-folder target locations** (per the official install docs
> [tabmixplus-docs/installation#install-config-script](https://onemen.github.io/tabmixplus-docs/other/installation/#install-config-script)):
> `config.js` always lands at the browser install root (`GreD`); `config-prefs.js` lands at
> `GreD/defaults/pref/` on Windows/macOS and at `GreD/browser/defaults/preferences/` on Linux. Both
> the C installer (`admin_copy_tree(staging, g_binary_dir)`) and the updater (`installConfigFiles`)
> copy the **flattened manifest layout** to `GreD` — install and update flows are identical by
> construction. The zip layout (`defaults/pref/config-prefs.js`) matches the manifest's canonical
> `files` list, so the hash check stays valid on every platform.

The **auto-updater** is privileged code that runs _inside_ the browser (not the C installer) and
keeps those packages up to date automatically:

- checks **periodically** (daily) for newer published versions,
- **notifies** the user when an update is available,
- lets the user apply the update **in a tab** without re-downloading the installer,
- applies updates that land in **admin-protected folders** (config files → Program Files) with a
  single elevation prompt.

## 2. Design constraints

1. **ESM loader.** `BootstrapLoader.js` loads the scheduler via
   `ChromeUtils.importESModule('chrome://firefox-scripts/content/scriptsUpdater.sys.mjs')` — the
   entry module is an ESM (`.sys.mjs`), not a plain script.
2. **Hash-based detection only.** Update detection relies on the hash-based status logic in
   `docs/status-logic.md`. The manifest's `date` field is for display only; `versionInfo.json` is
   obsolete (no longer shipped) and must not be a dependency.
3. **Config updates write into `GreD`.** Applying a config update must copy `config.js` /
   `config-prefs.js` into the browser installation directory (the admin-rights problem) — not merely
   offer a download.
4. **Single hash source.** One content-hash pass produces both the install presence and the
   aggregate status; no duplicated digest pipeline.
5. **Dedicated content namespace.** The updater maps `chrome://firefox-scripts/content/…` to the
   `updater/` subfolder via its own `content firefox-scripts` entry in `chrome.manifest`; the tab UI
   resolves under `updater/ui/` (`chrome://firefox-scripts/content/ui/…`).

## 3. Architecture

### 3.1 Files

| File                                                    | Package          | Role                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scriptsUpdater.sys.mjs` (`core/chrome/utils/updater/`) | `utils.zip`      | ESM scheduler: daily check, hash comparison, `ensureUpdaterUi` (download/verify/extract `updater-ui.zip`), launching the tab. Loaded once per window by `BootstrapLoader.js` / `userChrome.js`.                                                                                                           |
| `updater-config.sys.mjs` (`core/chrome/utils/updater/`) | `utils.zip`      | **Auto-generated** (untracked/gitignored) from `config/installer.conf`: `HASHES_URL`, `ZIP_BASE_URL`, `HELPER_BASE_URL`, `ASSET_SUFFIX` plus the test-build identity `IS_DEV`/`IS_LOCAL`/`LOCAL_DIST_PATH`/`DEV_BRANCH`. Ships in the zip (added back explicitly); URL changes propagate as hash changes. |
| `updater.html` (`tools/publish/remote-ui/`)             | `updater-ui.zip` | The chrome-privileged tab page. No iframe, no remote page — it loads the engine and client directly.                                                                                                                                                                                                      |
| `updater.js` (`tools/publish/remote-ui/`)               | `updater-ui.zip` | Privileged engine (`window.UpdaterEngine`): fresh hash check, zip download/verify/extract/copy, elevated helper, skip prefs, restart. Loaded via a `chrome://` script src.                                                                                                                                |
| `updater-ui.js` (`tools/publish/remote-ui/`)            | `updater-ui.zip` | Client: renders `UpdaterEngine` state and forwards user actions as direct calls.                                                                                                                                                                                                                          |
| `updater.css` (`tools/publish/remote-ui/`)              | `updater-ui.zip` | **Auto-generated** (untracked/gitignored): `installer/web/style.css` + `tools/publish/updater.css`, built by `buildRemoteUiCss` and written into the zip by `createZip.mjs`.                                                                                                                              |
| `logos/*` (`tools/publish/remote-ui/`)                  | `updater-ui.zip` | Brand PNGs + `favicon.svg` for the card and tab icon.                                                                                                                                                                                                                                                     |

`chrome.manifest` keeps a single mapping (`content firefox-scripts updater/`), so both packages
resolve without any manifest change:

```
content firefox-scripts updater/
```

### 3.2 Init path

`BootstrapLoader.js` imports the scheduler on browser-window startup:

```js
// BootstrapLoader.js
Services.obs.addObserver(doc => {
  if (doc.documentURI === 'chrome://browser/content/browser.xhtml') {
    const win = doc.defaultView;
    try {
      const {initScriptsUpdater} = ChromeUtils.importESModule(
        'chrome://firefox-scripts/content/scriptsUpdater.sys.mjs'
      );
      initScriptsUpdater(win);
    } catch (e2) {
      console.warn('Firefox Scripts updater not available', e2);
    }
  }
}, 'chrome-document-loaded');
```

`userChrome.js` also carries a hook (legacy compat); `initScriptsUpdater` is idempotent.

## 4. Logic — how updates are detected

Reuses the exact algorithm documented in `docs/status-logic.md`:

**Manifest** (`hashes.json` on the gh-pages branch):

```json
{
  "utils": {
    "hash": "<sha256>",
    "files": ["BootstrapLoader.js", "..."],
    "date": "2026-07-31"
  },
  "fx-folder": {
    "hash": "<sha256>",
    "files": ["config.js", "defaults/pref/config-prefs.js"],
    "date": "2026-07-31"
  },
  "updater-ui": {
    "hash": "<sha256>",
    "files": ["updater.html", "updater.js", "updater-ui.js", "updater.css", "logos/..."],
    "date": "2026-07-31"
  }
}
```

**Per-package hash** (publish scripts, installer and updater all compute this):

```
input = ""
for each relative path, sorted:
    input += rel_path + "\n"
    if file exists: input += file_bytes
hash = SHA256(input)
```

The scheduler (`checkScriptsUpdateNeeded`) fetches the manifest, then for each package hashes the
installed files against the canonical `files` list:

- `utils` → `ProfD/chrome/utils/`
- `fx-folder` → `GreD/`
- `updater-ui` → `ProfD/chrome/utils/updater/ui/`
- **Missing file = empty content** (path + `"\n"`, no bytes) — same rule as the installer.

## 5. Workflow

```
browser window opens
        │
        ▼
BootstrapLoader / userChrome imports scriptsUpdater.sys.mjs
        │
        ▼
initScriptsUpdater(win)                     # idempotent
  ├─ checkForUpdates(win)                   # skipped if lastScriptsCheckDate == today or
  │                                         #   lastUpdateTabShown == today
  └─ setInterval(checkForUpdates, 24h)
        │
        ▼ (fetch manifest, compute local hashes, apply skippedHash prefs)
utils OR fx-folder needs an update?
        │  no → stay silent
        │  yes
        ▼
ensureUpdaterUi(updaterUi)                  # silent self-update of the tab UI
        │  failed (zip missing/fetch error) → exit silently — nothing useful to open
        ▼
b.addTrustedTab(chrome://firefox-scripts/content/ui/updater.html)
  # lastUpdateTabShown = today; NOT lastScriptsCheckDate
        │
        ▼ (tab: updater.js engine re-runs checkScriptsUpdateNeeded, updater-ui.js renders)
*Single card (one process/profile): Update + Restart buttons · APPLICATION BINARY row
(config.js badge) · PROFILE FOLDER row (utils badge) · per-row selection checkbox (gates
Update) · per-row "Don't show again" checkbox · Remind me Tomorrow · brand logo (local
chrome://firefox-scripts/content/ui/logos/; tab favicon = local favicon.svg) · app version next
to the display name (from <GreD>/application.ini CodeName/Name)
        │
        ▼ (user acts: Install / skip / Remind me Tomorrow / Restart)
updater.js → recordUserDecision() → lastScriptsCheckDate = today
        │
        ▼ (user clicks Install on a section)
updater.js:
  1. download <pkg>.zip to a temp dir (Downloads.fetch)
  2. extract (flatten top-level fx-folder/ prefix)
  3. verify: hash of extracted file set == manifest hash   ← integrity gate
  4a. utils  → copy into ProfD/chrome/utils (plain IOUtils copy)
  4b. config → download+unblock elevated-copy helper into the SAME temp dir,
               Subprocess.call(helper <src> <dst> ...) → single UAC prompt
  5. per-file progress; on success show "Restart to apply"
        │
        ▼ (user clicks Restart, or Remind me Tomorrow)
close tab → Services.startup.quit(eAttemptQuit | eRestart) (+ invalidateCachesOnRestart)
```

### 5.1 Zip layout handling

`fx-folder.zip` wraps its files under a top-level `fx-folder/` directory; `utils.zip` and
`updater-ui.zip` are flat. The extractor mirrors
`installer/src/file_utils.c::extract_zip_flatten()`: extract to a temp dir, descend into a single
top-level wrapper if present, then copy files to their final destinations.

### 5.2 Self-update

- The scheduler (`scriptsUpdater.sys.mjs`) ships inside `utils.zip`; a utils update replaces it on
  disk and the running instance keeps the old code until the next restart.
- The tab UI ships inside `updater-ui.zip`; `ensureUpdaterUi` downloads/verifies/installs it before
  the tab opens, so the UI never needs a restart to update itself.

## 6. Admin-rights file copy — reuse the elevated-copy helper

Unchanged from the original design: config files must land in the browser installation directory. On
Windows that is `C:\Program Files\...` — not writable by the un-elevated browser process. The
standalone helper binary (sources at `installer/src/helper/`) self-elevates:

| Platform | Binary           | Elevation                                       |
| -------- | ---------------- | ----------------------------------------------- |
| Windows  | `helper_win.exe` | `ShellExecuteExW` + `runas` (single UAC prompt) |
| Linux    | `helper_linux`   | `pkexec` (falls back to `sudo`)                 |
| macOS    | `helper_mac`     | `osascript` "with administrator privileges"     |

CLI: `helper <src1> <dst1> <src2> <dst2> ...` — creates parent dirs, copies each pair, exits `0` on
success, `1` bad args, `2` elevation failed, `3` copy failed. The updater tries a direct `IOUtils`
copy first (portable/user-owned installs), then the helper; exit code `2` maps to "elevation
cancelled".

## 7. Reuse summary

| Concern                 | Reused from                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------ |
| Update detection        | `docs/status-logic.md`, `installer/src/detect_browser.c::compute_directory_sha256()` |
| Canonical file lists    | manifest `files` array (published by `upload.mjs`)                                   |
| URLs/paths              | `config/installer.conf` → `generateUpdaterConfig.mjs` → `updater-config.sys.mjs`     |
| Zip layout / flattening | `installer/src/file_utils.c::extract_zip_flatten()`                                  |
| Elevation / admin copy  | `installer/src/helper/*` (built by `installer/Makefile`)                             |
| Status display strings  | `installer/web/script.js` badge logic                                                |
| Card UI / design system | `installer/web/style.css` + `tools/publish/updater.css`                              |

## 8. Security & safety considerations

- **Hash gate before install:** zips are extracted to a temp dir and hashed over the manifest's file
  list _before_ anything is copied into place.
- **Elevation is user-initiated** (single UAC prompt from the helper); the updater never runs
  elevated itself.
- **No remote code execution:** only files listed in the manifest's `files` array are ever
  extracted/copied. The helper binary is a fixed, known asset (HTTPS) downloaded fresh to a per-run
  temp dir and deleted after install.
- The updater runs with system privileges; keep the network surface minimal: one manifest fetch per
  day, three zip downloads per update, all over HTTPS.

## 9. Testing plan

See `docs/future-work.md` §1 for the manual + automated test matrix (hash parity, detection,
utils/config/updater-ui install flows, failure paths, elevation).
