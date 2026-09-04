'use strict';

/**
 * Firefox Scripts - Auto-Updater Module (ESM)
 *
 * Runs inside the browser (loaded by BootstrapLoader.js / userChrome.js) and
 * keeps the three published packages up to date:
 *
 * - fx-folder (config.js, defaults/pref/config-prefs.js) -> browser dir (GreD)
 * - utils (chrome scripts) -> profile chrome/utils
 * - updater-ui (the update tab itself) -> profile chrome/utils/updater/ui
 *
 * Update detection reuses the installer's hash-based logic
 * (docs/status-logic.md): fetch the manifest from the gh-pages branch, hash the
 * locally installed file set with the manifest's canonical `files` list, and
 * compare. No versionInfo.json dependency.
 *
 * This module is the ONLY updater code that ships inside utils.zip: it checks
 * for updates and downloads/extracts the updater-ui package. Everything the tab
 * does (rendering, installing utils/config, restarting) lives in updater-ui.zip
 * (chrome://firefox-scripts/content/ui/updater.html). If a package cannot be
 * downloaded, the check fails silently — there is no error UI to show, so the
 * tab is simply not opened.
 *
 * Notification = a new tab, shown at most once per day (pref
 * extensions.firefox-scripts.lastUpdateTabShown). The user-decision date
 * (extensions.firefox-scripts.lastScriptsCheckDate) is recorded ONLY by the tab
 * UI on real interaction — installing, skipping, "Remind me Tomorrow", or a
 * restart — never when the tab merely opens. Per-package skips are stored as
 * extensions.firefox-scripts.skippedHash.<package> = remote hash.
 */

// URL/path configuration — generated from config/installer.conf at publish
// time (tools/publish/generateUpdaterConfig.mjs).  Single source of truth.
const {CONFIG} = ChromeUtils.importESModule(
  'chrome://firefox-scripts/content/updater-config.sys.mjs'
);

// Test/local override prefs: a string pref
// extensions.firefox-scripts.override.<KEY> (HASHES_URL, ZIP_BASE_URL,
// UI_BASE_URL, HELPER_BASE_URL) wins over the generated CONFIG value.  This
// lets tests point the updater at any local snapshot (e.g. one built on
// another OS) WITHOUT touching the config file — it ships inside utils.zip and
// is part of the hashed file set, so rewriting it would flip the package hash
// and break the staleness check.
const PREF_OVERRIDE_PREFIX = 'extensions.firefox-scripts.override.';

function configValue(key) {
  try {
    const override = Services.prefs.getStringPref(PREF_OVERRIDE_PREFIX + key, '');
    if (override) {
      return override;
    }
  } catch (_) {
    // unreadable pref → fall back to the generated CONFIG value
  }
  return CONFIG[key];
}

export function getHashesUrl() {
  return configValue('HASHES_URL');
}

export function getZipBaseUrl() {
  return configValue('ZIP_BASE_URL');
}

/**
 * Base URL of the updater tab UI package (updater-ui.zip). It is published next
 * to the hash manifest (gh-pages / the dev-build branch / the local snapshot
 * dir) and is never a release asset (upload.mjs), so it must come from the
 * manifest's own host — not ZIP_BASE_URL, which is the release URL and has no
 * updater-ui zip in prod (issue #102).
 */
export function getUiBaseUrl() {
  // Fall back to ZIP_BASE_URL only when the paired generated config predates
  // UI_BASE_URL (never true for zips built by the same publish run) — it keeps
  // the pre-#102 behavior instead of building an invalid URL.
  return configValue('UI_BASE_URL') || getZipBaseUrl();
}

export function getHelperBaseUrl() {
  return configValue('HELPER_BASE_URL');
}

const {Downloads} = ChromeUtils.importESModule('resource://gre/modules/Downloads.sys.mjs');

// The actual update tab (updater-ui.zip) — a privileged chrome:// page.
const UPDATER_UI_URI = 'chrome://firefox-scripts/content/ui/updater.html';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // once per day
const MANIFEST_TIMEOUT_MS = 15000; // dead manifest host -> failed check, not a hang

const PREF_LAST_CHECK = 'extensions.firefox-scripts.lastScriptsCheckDate';
const PREF_LAST_SHOWN = 'extensions.firefox-scripts.lastUpdateTabShown';
const PREF_SKIP_PREFIX = 'extensions.firefox-scripts.skippedHash.';

let gInitialized = false;
let gWindow = null;

/**
 * Initialize the updater. Called per browser window on startup by
 * BootstrapLoader.js / userChrome.js; idempotent so double-init is harmless.
 *
 * @param {Window} win - the browser window
 */
export function initScriptsUpdater(win) {
  if (gInitialized) {
    return;
  }
  gInitialized = true;

  gWindow = win;

  // Check immediately (gated by the daily prefs), then once per day.
  checkForUpdates();
  setInterval(checkForUpdates, CHECK_INTERVAL_MS);
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Daily check: fetch the manifest, compute local hashes, keep the updater UI
 * current, and open the update tab when utils or fx-folder needs an update.
 *
 * Two independent daily prefs gate this:
 *
 * - PREF_LAST_CHECK (lastScriptsCheckDate) is set ONLY by the tab UI when the
 *   user makes a decision (installs / skips / reminds / restarts). A tab the
 *   user merely closed — or a manual browser restart with the tab left open —
 *   records nothing, so the pending update resurfaces instead of being marked
 *   as "checked".
 * - PREF_LAST_SHOWN is set here when the tab is opened, so an ignored tab does
 *   not re-open every few minutes within the same day.
 */
async function checkForUpdates() {
  const win = gWindow;
  if (!win || win.closed) {
    return;
  }

  const today = todayStr();
  if (Services.prefs.getCharPref(PREF_LAST_CHECK, '') === today) {
    return;
  }
  if (Services.prefs.getCharPref(PREF_LAST_SHOWN, '') === today) {
    return;
  }

  const scriptsInfo = await checkScriptsUpdateNeeded();

  // The tab opens only when utils or fx-folder needs attention; a pure
  // updater-ui change never disturbs the user.
  const updateNeeded = scriptsInfo.fxFolder.updateNeeded || scriptsInfo.utils.updateNeeded;
  if (!updateNeeded) {
    return;
  }

  // Keep the tab UI itself current before it opens (silent self-update). If
  // updater-ui.zip cannot be fetched and no UI is installed, there is nothing
  // useful to open — exit quietly instead of showing a broken tab.
  if (!(await ensureUpdaterUi(scriptsInfo.updaterUi))) {
    return;
  }

  const b = win.gBrowser;
  if (!b) {
    return;
  }

  // An updater tab may already be open (e.g. restored from a session): keep a
  // single instance.  Pending session-restore tabs expose the target via
  // initialURI before they finish loading.
  for (const tab of b.tabs) {
    if (
      tab.linkedBrowser?.currentURI?.spec === UPDATER_UI_URI ||
      tab.linkedBrowser?.initialURI === UPDATER_UI_URI
    ) {
      return;
    }
  }

  // Remember the tab was SHOWN today (not that the user decided).  The check
  // re-runs on the next browser start after a manual restart with the tab
  // left open: the restored tab re-checks in updater.js instead of showing a
  // stale "All packages are up to date.".
  Services.prefs.setCharPref(PREF_LAST_SHOWN, today);

  const tab = b.addTrustedTab(UPDATER_UI_URI);
  tab._scriptsUpdateTab = true;
  tab.loadOnStartup = true;
  b.selectedTab = tab;
}

/**
 * Race a promise against a deadline: rejects with an Error once `ms` elapses
 * without the promise settling. Uses an nsITimer and no window-dependent
 * globals, so it is safe in this module's (non-window) global.
 *
 * @param {Promise} promise - the operation to bound
 * @param {number} ms - deadline in milliseconds
 * @returns {Promise<any>} resolves/rejects with the promise's outcome
 */
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = Cc['@mozilla.org/timer;1'].createInstance(Ci.nsITimer);
    timer.initWithCallback(
      () => reject(new Error(`operation timed out after ${ms}ms`)),
      ms,
      Ci.nsITimer.TYPE_ONE_SHOT
    );
    promise.then(
      value => {
        timer.cancel();
        resolve(value);
      },
      error => {
        timer.cancel();
        reject(error);
      }
    );
  });
}

/**
 * Fetch the hash manifest and compare per-package local hashes against it.
 *
 * @returns {Promise<{fxFolder: Object; utils: Object; updaterUi: Object}>}
 */
export async function checkScriptsUpdateNeeded() {
  const result = {
    fxFolder: {updateNeeded: false, date: '', remoteHash: '', files: []},
    utils: {updateNeeded: false, date: '', remoteHash: '', files: []},
    updaterUi: {updateNeeded: false, date: '', remoteHash: '', files: []},
  };

  try {
    // Never hang on a dead/stalled manifest host: the daily check must fail
    // fast and leave the tab closed rather than spin.
    const responseText = await withTimeout(fetchText(getHashesUrl()), MANIFEST_TIMEOUT_MS);
    const remoteInfo = JSON.parse(responseText);

    const greDir = Services.dirsvc.get('GreD', Ci.nsIFile).path;
    const profileDir = Services.dirsvc.get('ProfD', Ci.nsIFile).path;
    const dirs = {
      'fx-folder': greDir,
      'utils': profileDir + '/chrome/utils',
      'updater-ui': profileDir + '/chrome/utils/updater/ui',
    };
    const keys = [
      ['fxFolder', 'fx-folder'],
      ['utils', 'utils'],
      ['updaterUi', 'updater-ui'],
    ];

    for (const [resultKey, pkgKey] of keys) {
      const remote = remoteInfo[pkgKey];
      if (!remote || !Array.isArray(remote.files) || !remote.hash) {
        continue;
      }
      const target = result[resultKey];
      target.date = remote.date || '';
      target.remoteHash = remote.hash;
      target.files = remote.files;

      const localHash = computeFilesHash(remote.files, dirs[pkgKey]);
      const hashMismatch = localHash !== remote.hash;

      // updater-ui is self-updating and has no user-facing skip toggle.
      if (pkgKey === 'updater-ui') {
        target.updateNeeded = hashMismatch;
        continue;
      }

      // Reset the skip pref when the remote hash changed or local files
      // already match.
      const skipHash = Services.prefs.getCharPref(PREF_SKIP_PREFIX + pkgKey, '');
      if (skipHash && (skipHash !== remote.hash || !hashMismatch)) {
        Services.prefs.clearUserPref(PREF_SKIP_PREFIX + pkgKey);
      }

      target.updateNeeded = hashMismatch && skipHash !== remote.hash;
    }

    return result;
  } catch (e) {
    console.error('Firefox Scripts: update check failed', e);
    return result;
  }
}

/**
 * Keep the updater UI package current. When the installed updater/ui/ files do
 * not hash to the manifest's updater-ui entry, download updater-ui.zip, verify
 * it, and swap it in. Silent and idempotent.
 *
 * @param {Object} info - the manifest's updater-ui entry ({files, hash})
 * @returns {Promise<boolean>} true when the UI is usable afterwards
 */
export async function ensureUpdaterUi(info) {
  const uiDir = PathUtils.join(PathUtils.profileDir, 'chrome', 'utils', 'updater', 'ui');

  // A manifest without an updater-ui entry predates this package: keep whatever
  // is already installed (the UI is still usable for utils/config updates).
  if (!info || !Array.isArray(info.files) || !info.remoteHash) {
    return IOUtils.exists(PathUtils.join(uiDir, 'updater.html'));
  }

  if (computeFilesHash(info.files, uiDir) === info.remoteHash) {
    return true; // already current
  }

  const tmpDir = PathUtils.join(PathUtils.tempDir, `fxs-updater-ui-${Date.now()}`);
  try {
    const zipUrl = `${getUiBaseUrl()}/updater-ui${CONFIG.ASSET_SUFFIX || ''}.zip`;
    const zipPath = PathUtils.join(tmpDir, 'updater-ui.zip');
    await Downloads.fetch(zipUrl, zipPath);

    // Verify the manifest hash BEFORE extracting anything: a failed check must
    // not leave a single file behind (and a tampered archive must never get
    // its entries written, even inside the temp dir).  computeZipFilesHash
    // reads the zip entries straight from the archive.
    if ((await computeZipFilesHash(info.files, zipPath)) !== info.remoteHash) {
      console.error(
        'Firefox Scripts: downloaded updater-ui.zip failed hash verification; keeping the current UI'
      );
      return false;
    }

    const extractDir = PathUtils.join(tmpDir, 'extracted');
    const baseDir = await extractZipFlatten(zipPath, extractDir);

    await copyFileList(info.files, baseDir, uiDir);
    // chrome://firefox-scripts/content/ui/* is served from disk per load, but
    // invalidate any chrome caches so navs pick up the swapped files at once.
    Services.obs.notifyObservers(null, 'chrome-flush-caches', null);
    return true;
  } catch (e) {
    // Missing/stale remote package: nothing the user can act on — fall back to
    // whatever UI is already installed (if any) and never throw.
    console.error('Firefox Scripts: updater-ui install failed', e);
    return IOUtils.exists(PathUtils.join(uiDir, 'updater.html'));
  } finally {
    try {
      await IOUtils.remove(tmpDir, {recursive: true, ignoreAbsent: true});
    } catch (e) {
      console.warn('Firefox Scripts: updater-ui temp cleanup failed', e);
    }
  }
}

/**
 * Privileged, CSP-bypassing fetch. The updater runs in chrome:// documents and
 * a module without a window; plain fetch() there is subject to Firefox's
 * default CSP for chrome pages (connect-src), which blocks the
 * http://localhost:<port> URLs baked into --local builds. Opening a channel
 * with the system principal bypasses that CSP and CORS.
 *
 * @param {string} url
 * @returns {Promise<Uint8Array>}
 */
export function fetchBytes(url) {
  return new Promise((resolve, reject) => {
    let channel;
    try {
      channel = Services.io.newChannelFromURI(
        Services.io.newURI(url),
        null,
        Services.scriptSecurityManager.getSystemPrincipal(),
        null,
        Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL,
        Ci.nsIContentPolicy.TYPE_OTHER
      );
    } catch (e) {
      reject(e);
      return;
    }

    const chunks = [];
    const binary = Cc['@mozilla.org/binaryinputstream;1'].createInstance(Ci.nsIBinaryInputStream);

    const listener = {
      QueryInterface: ChromeUtils.generateQI(['nsIStreamListener', 'nsIRequestObserver']),
      onStartRequest() {},
      onDataAvailable(request, stream, offset, count) {
        binary.setInputStream(stream);
        chunks.push(binary.readByteArray(count));
      },
      onStopRequest(request, status) {
        // nsresult success codes have bit 31 clear (Components.isSuccessCode).
        if (status & 0x80000000) {
          reject(new Error(`Fetch failed (0x${status.toString(16)}): ${url}`));
          return;
        }
        // HTTP 4xx/5xx complete the channel successfully but are still
        // failures.
        let httpStatus = 0;
        try {
          httpStatus = request.QueryInterface(Ci.nsIHttpChannel).responseStatus;
        } catch {
          // non-HTTP channel (file:, data:, ...) — nothing to check
        }
        if (httpStatus >= 400) {
          const httpError = new Error(`HTTP ${httpStatus}: ${url}`);
          httpError.httpStatus = httpStatus;
          reject(httpError);
          return;
        }
        let total = 0;
        for (const c of chunks) {
          total += c.length;
        }
        const out = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) {
          out.set(c, off);
          off += c.length;
        }
        resolve(out);
      },
    };

    channel.asyncOpen(listener);
  });
}

/** Privileged text fetch (UTF-8). */
export async function fetchText(url) {
  return new TextDecoder('utf-8').decode(await fetchBytes(url));
}

/**
 * Compute the SHA-256 over a file set, matching compute_directory_sha256() in
 * installer/src/detect_browser.c: for each relative path (sorted
 * case-insensitively): hash(rel_path + "\n") if the file exists:
 * hash(file_bytes) A listed-but-missing file contributes only path + "\n"
 * (empty content).
 *
 * @param {string[]} files - canonical relative paths (manifest `files` list)
 * @param {string} baseDir - absolute directory containing the files
 * @returns {string} hex digest
 */
export function computeFilesHash(files, baseDir) {
  const sorted = [...files].sort((a, b) => a.localeCompare(b));
  const nativeBase = Services.appinfo.OS === 'WINNT' ? baseDir.replace(/\//g, '\\') : baseDir;

  const baseFile = Cc['@mozilla.org/file/local;1'].createInstance(Ci.nsIFile);
  baseFile.initWithPath(nativeBase);

  const hasher = Cc['@mozilla.org/security/hash;1'].createInstance(Ci.nsICryptoHash);
  hasher.init(Ci.nsICryptoHash.SHA256);

  const encoder = new TextEncoder();
  const binStream = Cc['@mozilla.org/binaryinputstream;1'].createInstance(Ci.nsIBinaryInputStream);

  for (const relative of sorted) {
    const pathBytes = encoder.encode(relative + '\n');
    hasher.update(pathBytes, pathBytes.length);

    const file = baseFile.clone();
    for (const part of relative.split('/')) {
      file.append(part);
    }

    if (!file.exists() || !file.isFile()) {
      // Missing file -> path + "\n" only (matches the C installer).
      continue;
    }

    const fis = Cc['@mozilla.org/network/file-input-stream;1'].createInstance(
      Ci.nsIFileInputStream
    );
    fis.init(file, 0x01, 0o444, 0);
    binStream.setInputStream(fis);
    const count = fis.available();
    const data = new ArrayBuffer(count);
    binStream.readArrayBuffer(count, data);
    hasher.update(new Uint8Array(data), count);
    fis.close();
  }

  const base64 = hasher.finish(true);
  const binary = atob(base64);
  let hex = '';
  for (let i = 0; i < binary.length; i++) {
    hex += binary.charCodeAt(i).toString(16).padStart(2, '0');
  }
  return hex;
}

/* ---------------- zip helpers (shared with the updater tab engine) ---------------- */

/**
 * Hash the manifest-listed files straight from a zip archive, WITHOUT
 * extracting it first (matches computeFilesHash semantics: sorted rel paths,
 * path + '\n' then contents; missing entries contribute path + '\n' only).
 * Handles a single top-level wrapper folder the same way extractZipFlatten
 * flattens it, so a tampered archive is rejected before a single byte is
 * written anywhere.
 *
 * @returns {Promise<string>} hex sha256
 */
export async function computeZipFilesHash(files, zipPath) {
  const zipFile = await IOUtils.getFile(zipPath);
  const zipReader = Cc['@mozilla.org/libjar/zip-reader;1'].createInstance(Ci.nsIZipReader);
  zipReader.open(zipFile);

  // Detect a single top-level wrapper folder (fx-folder.zip style): no files
  // at the archive root and exactly one top-level entry -> descend into it.
  let prefix = '';
  const tops = new Set();
  let hasRootFile = false;
  for (const name of zipReader.findEntries('*?*')) {
    if (name.includes('/')) {
      tops.add(name.split('/')[0]);
    } else {
      hasRootFile = true;
    }
  }
  if (!hasRootFile && tops.size === 1) {
    prefix = [...tops][0] + '/';
  }

  const sorted = [...files].sort((a, b) => a.localeCompare(b));
  const hasher = Cc['@mozilla.org/security/hash;1'].createInstance(Ci.nsICryptoHash);
  hasher.init(Ci.nsICryptoHash.SHA256);
  const encoder = new TextEncoder();

  for (const relative of sorted) {
    const pathBytes = encoder.encode(relative + '\n');
    hasher.update(pathBytes, pathBytes.length);
    const entryName = prefix + relative;
    if (!zipReader.hasEntry(entryName)) continue; // missing -> path + '\n' only
    const bytes = await readZipEntry(zipReader, entryName);
    hasher.update(bytes, bytes.length);
  }
  zipReader.close();

  const base64 = hasher.finish(true);
  const binary = atob(base64);
  let hex = '';
  for (let i = 0; i < binary.length; i++) {
    hex += binary.charCodeAt(i).toString(16).padStart(2, '0');
  }
  return hex;
}

/** Read a zip entry fully. @returns {Promise<Uint8Array>} */
export function readZipEntry(zipReader, entryName) {
  return new Promise(resolve => {
    const input = zipReader.getInputStream(entryName);
    const bin = Cc['@mozilla.org/binaryinputstream;1'].createInstance(Ci.nsIBinaryInputStream);
    bin.setInputStream(input);
    const count = input.available();
    const data = new ArrayBuffer(count);
    bin.readArrayBuffer(count, data);
    input.close();
    resolve(new Uint8Array(data));
  });
}

/**
 * Extract a zip into destDir. Mirrors the installer's extract_zip_flatten(): if
 * the archive has a single top-level folder (fx-folder.zip wraps files under
 * 'fx-folder/'), descend into it so files land flat.
 *
 * @returns {Promise<string>} the base dir containing the extracted files
 */
/**
 * Reject zip entry names that could escape destDir: absolute paths, Windows
 * backslash separators, drive-letter tricks, and '.'/'..' components. Zip entry
 * names always use '/', so anything else is an attack.
 */
function isUnsafeZipEntryName(entryName) {
  if (!entryName || entryName.startsWith('/') || entryName.includes('\\')) return true;
  const parts = entryName.split('/').filter(Boolean);
  for (const part of parts) {
    if (part === '.' || part === '..' || /^[a-zA-Z]:/.test(part)) return true;
  }
  return false;
}

export async function extractZipFlatten(zipPath, destDir) {
  await IOUtils.makeDirectory(destDir, {ignoreExisting: true, createAncestors: true});

  const zipFile = await IOUtils.getFile(zipPath);
  const zipReader = Cc['@mozilla.org/libjar/zip-reader;1'].createInstance(Ci.nsIZipReader);
  zipReader.open(zipFile);

  const entries = zipReader.findEntries('*?*');
  for (const entryName of entries) {
    // Zip-slip guard: never let an entry write outside destDir.
    if (isUnsafeZipEntryName(entryName)) {
      zipReader.close();
      throw new Error(`Unsafe zip entry name: ${entryName}`);
    }
    const entry = zipReader.getEntry(entryName);
    if (entry.isDirectory) {
      const dirPath = PathUtils.join(destDir, ...entryName.split('/').filter(Boolean));
      await IOUtils.makeDirectory(dirPath, {ignoreExisting: true, createAncestors: true});
    } else {
      const parts = entryName.split('/').filter(Boolean);
      const targetPath = PathUtils.join(destDir, ...parts);
      await IOUtils.makeDirectory(PathUtils.parent(targetPath), {
        ignoreExisting: true,
        createAncestors: true,
      });
      const bytes = await readZipEntry(zipReader, entryName);
      await IOUtils.write(targetPath, bytes, {tmpPath: targetPath + '.tmp'});
    }
  }
  zipReader.close();

  // Flatten a single top-level wrapper folder. IOUtils.getChildren returns
  // PATH STRINGS, not FileInfo objects — classify each child with
  // IOUtils.stat, whose FileInfo.type is 'regular' | 'directory' | 'other'
  // (there is no 'file' value). Without this the wrapper is never descended
  // into and the extracted files are missed (fx-folder.zip style).
  let base = destDir;
  for (let depth = 0; depth < 4; depth++) {
    const children = await IOUtils.getChildren(base);
    const stats = await Promise.all(children.map(c => IOUtils.stat(c).catch(() => null)));
    const subDirs = stats.filter(s => s && s.type === 'directory');
    const files = stats.filter(s => s && s.type === 'regular');
    if (files.length > 0) {
      break;
    }
    if (subDirs.length === 1) {
      base = subDirs[0].path;
      continue;
    }
    break;
  }
  return base;
}

/** Copy files listed in the manifest from srcDir to dstDir (overwrite). */
export async function copyFileList(files, srcDir, dstDir) {
  for (const rel of files) {
    if (isUnsafeZipEntryName(rel)) {
      throw new Error(`Unsafe manifest path: ${rel}`);
    }
    const parts = rel.split('/');
    const srcPath = PathUtils.join(srcDir, ...parts);
    const dstPath = PathUtils.join(dstDir, ...parts);
    await IOUtils.makeDirectory(PathUtils.parent(dstPath), {
      ignoreExisting: true,
      createAncestors: true,
    });
    await IOUtils.copy(srcPath, dstPath, {noOverwrite: false});
  }
}
