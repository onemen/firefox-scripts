'use strict';

/**
 * Firefox Scripts - Updater Tab Engine (privileged)
 *
 * Runs inside the updater tab — chrome://firefox-scripts/content/ui/
 * updater.html (updater-ui.zip) — loaded via a chrome:// script src. The engine
 * owns every privileged operation:
 *
 * - the fresh per-package hash check (manifest + local files)
 * - downloading the package zips, verifying their hashes against the manifest
 * - installing utils into the profile (user-writable, plain copy)
 * - installing config into the browser dir (GreD), using the standalone
 *   elevated-copy helper when the destination is not writable
 * - manual zip downloads (fetch -> blob URL -> save dialog)
 * - per-package skip prefs and the user-decision date pref
 * - restarting the browser (with cache invalidation) once an install completes
 *
 * It exposes window.UpdaterEngine for the UI client (updater-ui.js, same
 * package): the client renders state and forwards user actions as direct calls.
 * No iframe, no remote page, no postMessage — this document is
 * chrome-privileged end to end.
 *
 * Discoverability contract (see scriptsUpdater.sys.mjs):
 *
 * - The daily-check date pref (lastScriptsCheckDate) is recorded ONLY when the
 *   user makes a decision (installs, checks a skip box, clicks "Remind me
 *   Tomorrow", or restarts). Closing the tab without acting records nothing, so
 *   the pending update resurfaces later instead of being marked "checked".
 * - Every tab re-runs the real hash check on init (the module performs no
 *   tab-data handoff), so a tab restored from a session (manual browser restart
 *   with the tab left open) or a direct chrome:// visit renders the truth
 *   instead of a stale "All packages are up to date.".
 */

const {Downloads} = ChromeUtils.importESModule('resource://gre/modules/Downloads.sys.mjs');
const {Subprocess} = ChromeUtils.importESModule('resource://gre/modules/Subprocess.sys.mjs');
const {AppConstants} = ChromeUtils.importESModule('resource://gre/modules/AppConstants.sys.mjs');

const {computeFilesHash, checkScriptsUpdateNeeded, extractZipFlatten, copyFileList, fetchBytes} =
  ChromeUtils.importESModule('chrome://firefox-scripts/content/scriptsUpdater.sys.mjs');

// URL/path configuration — generated from config/installer.conf at publish
// time (tools/publish/generateUpdaterConfig.mjs).  Single source of truth.
const {CONFIG} = ChromeUtils.importESModule(
  'chrome://firefox-scripts/content/updater-config.sys.mjs'
);

const ZIP_BASE_URL = CONFIG.ZIP_BASE_URL;
// Asset-name suffix ('' prod / '-dev' dev): dev zips and helpers are
// published as utils-dev.zip / helper_win-dev.exe etc.
const ASSET_SUFFIX = CONFIG.ASSET_SUFFIX || '';
const FX_FOLDER_URL = `${ZIP_BASE_URL}/fx-folder${ASSET_SUFFIX}.zip`;
const UTILS_URL = `${ZIP_BASE_URL}/utils${ASSET_SUFFIX}.zip`;

// Standalone elevated-copy helper — source of the binary is config-driven too
// (installer.conf HELPER_BASE_URL, generated into updater-config.sys.mjs).
const HELPER_BASE_URL = CONFIG.HELPER_BASE_URL;
const HELPER_FILENAMES = {
  win: `helper_win${ASSET_SUFFIX}.exe`,
  macosx: `helper_mac${ASSET_SUFFIX}`,
  linux: `helper_linux${ASSET_SUFFIX}`,
};

const PREF_LAST_CHECK = 'extensions.firefox-scripts.lastScriptsCheckDate';
const PREF_SKIP_PREFIX = 'extensions.firefox-scripts.skippedHash.';

const UPDATER_UI_URI = 'chrome://firefox-scripts/content/ui/updater.html';

/** @type {{fxFolder: Object; utils: Object}} */
let scriptsInfo = {fxFolder: {}, utils: {}};
let chromeWin = null;
let updateTab = null;
// True while an install flow is running: keeps the Update button disabled
// (the UI mirrors this flag via state.installing).
let installing = false;
// Enable the Restart button once an install ran this session (mirrors the
// installer: never before).
let restartEnabled = false;
// Display name read once from the binary's application.ini ([App] CodeName +
// Name), the same source the installer shows the name from ("Firefox Developer
// Edition", "Zen Twilight", "Waterfox", ...). AppConstants.MOZ_APP_DISPLAYNAME
// reports a bare "Firefox" for Developer Edition, so it is not used here.
let appDisplayName = 'Firefox';

// Rendered-state callback (set by updater-ui.js).  Called after every state
// change — the client re-renders the card from the returned snapshot.
let onState = null;
// Progress callback (set by updater-ui.js) — install flows report percentage
// steps through it.
let onProgress = null;

function logError(msg, err) {
  console.error(`Firefox Scripts updater: ${msg}`, err);
}

/** Read the display name once from <GreD>/application.ini (synchronous, ~2 KB). */
function readAppDisplayName() {
  try {
    const dir = Services.dirsvc.get('GreD', Ci.nsIFile);
    const ini = dir.clone();
    ini.append('application.ini');
    if (!ini.exists()) {
      return;
    }

    const fstream = Cc['@mozilla.org/network/file-input-stream;1'].createInstance(
      Ci.nsIFileInputStream
    );
    const sstream = Cc['@mozilla.org/scriptableinputstream;1'].createInstance(
      Ci.nsIScriptableInputStream
    );
    fstream.init(ini, -1, 0, 0);
    sstream.init(fstream);
    const content = sstream.read(-1);
    sstream.close();
    fstream.close();

    let name = '';
    let codeName = '';
    for (const line of content.split(/\r?\n/)) {
      if (line.startsWith('CodeName=')) {
        codeName = line.slice('CodeName='.length).trim();
      } else if (line.startsWith('Name=')) {
        name = line.slice('Name='.length).trim();
      }
    }
    // Prefer CodeName when it begins with Name ("Firefox Developer Edition",
    // "Firefox Nightly", "Zen Browser"); otherwise CodeName is a bare channel
    // word (Zen Twilight ships Name=Zen + CodeName=Twilight), so combine them.
    if (codeName && name) {
      appDisplayName =
        codeName.toLowerCase().startsWith(name.toLowerCase()) ? codeName : `${name} ${codeName}`;
    } else {
      appDisplayName = codeName || name || 'Firefox';
    }
  } catch (e) {
    logError('reading application.ini display name', e);
  }
}

/* ---------------- user decisions ---------------- */

/**
 * Record that the user made a decision today (installed / skipped / reminded /
 * restarted). The module's daily check honors this pref, so the tab is never
 * re-opened on a day the user already acted. Closing the tab without any action
 * does NOT record anything: the update stays pending and resurfaces later.
 */
function recordUserDecision() {
  Services.prefs.setCharPref(PREF_LAST_CHECK, new Date().toISOString().slice(0, 10));
}

/* ---------------- state ---------------- */

/** Per-package data for the state snapshot (skip = skipped this hash). */
function packageSnapshot(kind, info) {
  const prefKey = kind === 'config' ? 'fx-folder' : 'utils';
  const skipHash = Services.prefs.getCharPref(PREF_SKIP_PREFIX + prefKey, '');
  return {
    updateNeeded: Boolean(info.updateNeeded),
    date: info.date || '',
    skipped: Boolean(skipHash && info.remoteHash && skipHash === info.remoteHash),
  };
}

/**
 * Map a build's display name to its brand logo file name (mirrors the
 * installer's detectType). Unknown builds fall back to the Firefox logo.
 *
 * @returns {'firefox' | 'waterfox' | 'zen' | 'librewolf' | 'floorp'}
 */
function brandLogoName(displayName) {
  const n = String(displayName || '').toLowerCase();
  if (n.includes('zen')) return 'zen';
  if (n.includes('waterfox')) return 'waterfox';
  if (n.includes('librewolf')) return 'librewolf';
  if (n.includes('floorp')) return 'floorp';
  return 'firefox';
}

/** The full state snapshot the UI renders. */
function stateSnapshot() {
  const brand = brandLogoName(appDisplayName);
  return {
    brand,
    appName: appDisplayName,
    appVersion: AppConstants.MOZ_APP_VERSION_DISPLAY || Services.appinfo.version || '',
    binaryPath: Services.dirsvc.get('XREExeF', Ci.nsIFile).path,
    profilePath: Services.dirsvc.get('ProfD', Ci.nsIFile).path,
    packages: {
      config: packageSnapshot('config', scriptsInfo.fxFolder),
      utils: packageSnapshot('utils', scriptsInfo.utils),
    },
    // Manual-download targets (config + utils zips). The UI fills its
    // "Download the latest scripts" link hrefs from these; the dev
    // ASSET_SUFFIX already makes them utils-dev.zip / fx-folder-dev.zip.
    fxFolderUrl: FX_FOLDER_URL,
    utilsUrl: UTILS_URL,
    installing,
    restartEnabled,
  };
}

function sendState() {
  if (typeof onState === 'function') {
    onState(stateSnapshot());
  }
}

/** Push a progress update to the progress bar in the UI. */
function sendProgress(pct, text, error) {
  if (typeof onProgress === 'function') {
    onProgress(pct, text, error || null);
  }
}

/* ---------------- user actions ---------------- */

/** Update the "don't show again for this update" pref from a checkbox toggle. */
function handleSkipCommand(kind, checked) {
  if (kind !== 'config' && kind !== 'utils') {
    return;
  }
  const info = scriptsInfo[kind === 'config' ? 'fxFolder' : 'utils'];
  if (!info || !info.remoteHash) {
    return;
  }
  const prefKey = kind === 'config' ? 'fx-folder' : 'utils';
  if (checked) {
    Services.prefs.setCharPref(PREF_SKIP_PREFIX + prefKey, info.remoteHash);
    recordUserDecision();
  } else {
    Services.prefs.clearUserPref(PREF_SKIP_PREFIX + prefKey);
  }
  sendState();
}

/**
 * Manual "Download" link: fetch the zip, hand it to the browser via a blob URL
 *
 * - <a download>, so the updater tab is never navigated away from and no new tab
 *   is opened.
 */
function downloadPackage(kind) {
  const url = kind === 'config' ? FX_FOLDER_URL : UTILS_URL;
  fetchBytes(url)
    .then(bytes => {
      const blob = new Blob([bytes], {type: 'application/zip'});
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = url.split('/').pop() || 'package.zip';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(a.href);
    })
    .catch(err => {
      logError('manual download failed', err);
      sendProgress(0, 'Manual download failed', err.message);
    });
}

/* ---------------- tab plumbing ---------------- */

function closeUpdateTab() {
  try {
    const browser = window.docShell?.chromeEventHandler;
    if (browser && chromeWin?.gBrowser) {
      const tab = chromeWin.gBrowser.getTabForBrowser(browser);
      if (tab) {
        chromeWin.gBrowser.removeTab(tab);
      }
    }
  } catch {
    // tab may already be closed
  }
}

/**
 * Open the browser install dir or the profile dir in the OS file manager (the
 * UI's "open folder" buttons).
 */
function revealFolder(kind) {
  try {
    const dir =
      kind === 'profile' ?
        Services.dirsvc.get('ProfD', Ci.nsIFile)
      : Services.dirsvc.get('XREExeF', Ci.nsIFile).parent;
    dir.reveal();
  } catch (e) {
    logError('open folder failed', e);
  }
}

function restartFirefox() {
  closeUpdateTab();
  Services.appinfo.invalidateCachesOnRestart();
  const cancelQuit = Cc['@mozilla.org/supports-PRBool;1'].createInstance(Ci.nsISupportsPRBool);
  Services.obs.notifyObservers(cancelQuit, 'quit-application-requested', 'restart');
  if (cancelQuit.data) {
    return;
  }
  Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit | Ci.nsIAppStartup.eRestart);
}

function remindTomorrow() {
  recordUserDecision();
  closeUpdateTab();
}

/* ---------------- elevated-copy helper ---------------- */

function helperFilename() {
  return HELPER_FILENAMES[AppConstants.platform] || HELPER_FILENAMES.linux;
}

function helperUrl() {
  return `${HELPER_BASE_URL}/${helperFilename()}`;
}

/**
 * Download the elevated-copy helper into tmpDir (the same temp dir used for the
 * package zips) and return its path. No persistent cache in the profile: fresh
 * download each run, removed when installConfig cleans up tmpDir.
 */
async function ensureHelper(tmpDir) {
  const targetPath = PathUtils.join(tmpDir, helperFilename());
  await Downloads.fetch(helperUrl(), targetPath);
  await unblockFile(targetPath);
  return targetPath;
}

/** Remove Windows Zone.Identifier ADS / macOS quarantine, chmod +x on POSIX. */
async function unblockFile(targetPath) {
  const platform = AppConstants.platform;
  if (platform === 'win') {
    const adsPath = `${targetPath}:Zone.Identifier`;
    try {
      await IOUtils.remove(adsPath);
    } catch (ex) {
      if (ex.name !== 'NotFoundError') {
        logError('unblock ADS failed', ex);
      }
    }
  } else {
    let proc = await Subprocess.call({command: '/bin/chmod', arguments: ['+x', targetPath]});
    await proc.wait();
    if (platform === 'macosx') {
      proc = await Subprocess.call({
        command: '/usr/bin/xattr',
        arguments: ['-d', 'com.apple.quarantine', targetPath],
      });
      await proc.wait();
    }
  }
}

/**
 * Copy pairs via the elevated-copy helper (self-elevates with a single UAC
 * prompt).
 *
 * @param {[string, string][]} pairs - [src, dst] pairs
 * @param {string} tmpDir - temp dir holding the downloaded helper
 * @returns {Promise<number>} helper exit code
 */
async function copyWithHelper(pairs, tmpDir) {
  const helperPath = await ensureHelper(tmpDir);
  const arguments_ = [];
  for (const [src, dst] of pairs) {
    arguments_.push(src, dst);
  }
  const proc = await Subprocess.call({command: helperPath, arguments: arguments_});
  const {exitCode} = await proc.wait();
  return exitCode;
}

/**
 * Copy config files into the browser dir (GreD). Tries a plain IOUtils copy
 * first (portable/user-owned installs), then the elevated helper.
 */
async function installConfigFiles(extractDir, files, greDir, tmpDir) {
  const pairs = files.map(rel => {
    const parts = rel.split('/');
    return [PathUtils.join(extractDir, ...parts), PathUtils.join(greDir, ...parts)];
  });

  // 1) Direct copy — works when the install dir is user-writable.
  try {
    for (const [src, dst] of pairs) {
      await IOUtils.makeDirectory(PathUtils.parent(dst), {
        ignoreExisting: true,
        createAncestors: true,
      });
      await IOUtils.copy(src, dst, {noOverwrite: false});
    }
    return {ok: true, elevated: false};
  } catch {
    // fall through to the elevated helper
  }

  // 2) Admin-copy helper (single UAC prompt inside the helper).
  sendProgress(70, 'Requesting administrator permission...');
  const exitCode = await copyWithHelper(pairs, tmpDir);
  if (exitCode === 0) {
    return {ok: true, elevated: true};
  }
  if (exitCode === 2) {
    throw new Error('Elevation was cancelled.');
  }
  throw new Error(`Admin copy helper failed (exit code ${exitCode}).`);
}

/* ---------------- install flows ---------------- */

async function installUtils() {
  const info = scriptsInfo.utils;
  const tmpDir = PathUtils.join(PathUtils.tempDir, `fxs-utils-${Date.now()}`);
  try {
    sendProgress(5, 'Downloading utils.zip...');
    const zipPath = PathUtils.join(tmpDir, 'utils.zip');
    await Downloads.fetch(UTILS_URL, zipPath);

    sendProgress(35, 'Extracting...');
    const extractDir = PathUtils.join(tmpDir, 'extracted');
    const baseDir = await extractZipFlatten(zipPath, extractDir);

    sendProgress(60, 'Verifying hash...');
    const actualHash = computeFilesHash(info.files, baseDir);
    if (actualHash !== info.remoteHash) {
      throw new Error('Downloaded utils.zip failed hash verification.');
    }

    sendProgress(80, 'Installing to profile...');
    const utilsDir = PathUtils.join(PathUtils.profileDir, 'chrome', 'utils');
    await copyFileList(info.files, baseDir, utilsDir);

    sendProgress(100, 'Utils installed. Restart Firefox to apply changes.');
    await refreshPackageState('utils');
  } catch (err) {
    logError('install utils', err);
    sendProgress(0, 'Install failed', `Failed to install utils: ${err.message}`);
  } finally {
    try {
      await IOUtils.remove(tmpDir, {recursive: true, ignoreAbsent: true});
    } catch (e) {
      logError('cleanup utils temp dir', e);
    }
  }
}

async function installConfig() {
  const info = scriptsInfo.fxFolder;
  const tmpDir = PathUtils.join(PathUtils.tempDir, `fxs-config-${Date.now()}`);
  try {
    sendProgress(5, 'Downloading fx-folder.zip...');
    const zipPath = PathUtils.join(tmpDir, 'fx-folder.zip');
    await Downloads.fetch(FX_FOLDER_URL, zipPath);

    sendProgress(30, 'Extracting...');
    const extractDir = PathUtils.join(tmpDir, 'extracted');
    const baseDir = await extractZipFlatten(zipPath, extractDir);

    sendProgress(50, 'Verifying hash...');
    const actualHash = computeFilesHash(info.files, baseDir);
    if (actualHash !== info.remoteHash) {
      throw new Error('Downloaded fx-folder.zip failed hash verification.');
    }

    const greDir = Services.dirsvc.get('GreD', Ci.nsIFile).path;
    sendProgress(70, 'Copying configuration files...');
    const {elevated} = await installConfigFiles(baseDir, info.files, greDir, tmpDir);

    sendProgress(
      100,
      elevated ?
        'Configuration files installed (elevated). Restart Firefox to apply changes.'
      : 'Configuration files installed. Restart Firefox to apply changes.'
    );
    await refreshPackageState('config');
  } catch (err) {
    logError('install config', err);
    sendProgress(0, 'Install failed', `Failed to install configuration files: ${err.message}`);
  } finally {
    try {
      await IOUtils.remove(tmpDir, {recursive: true, ignoreAbsent: true});
    } catch (e) {
      logError('cleanup config temp dir', e);
    }
  }
}

/** Install the requested packages (the UI sends the checked set). */
async function handleInstallCommand(kinds) {
  const requested = new Set(
    Array.isArray(kinds) ? kinds.filter(k => k === 'config' || k === 'utils') : []
  );
  if (requested.size === 0 || installing) {
    return;
  }
  installing = true;
  restartEnabled = true; // mirrors the installer: enabled once install runs
  recordUserDecision();
  sendState();
  try {
    const flows = [
      ['config', scriptsInfo.fxFolder, installConfig],
      ['utils', scriptsInfo.utils, installUtils],
    ];
    for (const [kind, info, flow] of flows) {
      if (info.updateNeeded && requested.has(kind)) {
        await flow();
      }
    }
  } finally {
    installing = false;
    sendState();
  }
}

/**
 * Re-hash a package's installed files and refresh the card. Called after an
 * install so the badges flip to "Up To Date" and the success banner appears
 * once both packages are current.
 */
async function refreshPackageState(kind) {
  const info = scriptsInfo[kind === 'config' ? 'fxFolder' : 'utils'];
  if (info.files && info.remoteHash) {
    const dir =
      kind === 'config' ?
        Services.dirsvc.get('GreD', Ci.nsIFile).path
      : PathUtils.join(PathUtils.profileDir, 'chrome', 'utils');
    try {
      info.updateNeeded = computeFilesHash(info.files, dir) !== info.remoteHash;
    } catch (e) {
      logError('re-hash after install', e);
      info.updateNeeded = true;
    }
  }
  sendState();
}

/* ---------------- engine API ---------------- */

/**
 * The privileged API exposed to the UI client (updater-ui.js). Called by the
 * client after it registered onState/onProgress: wires tab plumbing and runs a
 * fresh hash check so the card always renders the current truth.
 */
async function engineInit() {
  readAppDisplayName();

  // Tab plumbing is best-effort and never blocks the UI: a failure here
  // (odd window context, missing gBrowser) only disables Close/Restart paths.
  try {
    chromeWin = window.browsingContext?.topChromeWindow;
    const browser = window.docShell?.chromeEventHandler;
    if (chromeWin && browser) {
      updateTab = chromeWin.gBrowser?.getTabForBrowser(browser);
    }
  } catch (e) {
    logError('updater tab plumbing', e);
    chromeWin = null;
    updateTab = null;
  }

  // Twin-tab guard (defense-in-depth; the module already keeps a single
  // instance): if another updater tab is open, this one closes itself.
  if (updateTab && chromeWin?.gBrowser) {
    const anotherOpen = chromeWin.gBrowser.tabs.some(
      t => t !== updateTab && t.linkedBrowser?.currentURI?.spec === UPDATER_UI_URI
    );
    if (anotherOpen) {
      closeUpdateTab();
      return;
    }
  }

  // Fresh check — the module attaches no tab data: restored tabs and direct
  // chrome:// visits must render the truth, never a stale snapshot.
  try {
    const info = await checkScriptsUpdateNeeded();
    if (info) {
      scriptsInfo = info;
    }
  } catch (e) {
    logError('re-check on tab open', e);
    scriptsInfo = {fxFolder: {}, utils: {}};
  }
  sendState();
}

/** The API surface for updater-ui.js. */
window.UpdaterEngine = {
  /** Test/dev identity from the generated config (drives the banner). */
  buildInfo: {
    isDev: Boolean(CONFIG.IS_DEV),
    isLocal: Boolean(CONFIG.IS_LOCAL),
    distPath: CONFIG.LOCAL_DIST_PATH || '',
    devBranch: CONFIG.DEV_BRANCH || '',
  },
  /** Called by the client once on load (after onState/onProgress are set). */
  init: engineInit,
  /** Runs the requested install flows; the checkbox set ('config'|'utils'). */
  install: handleInstallCommand,
  /** Restart the browser (records the decision + invalidates caches). */
  restart() {
    recordUserDecision();
    restartFirefox();
  },
  /** "Remind me Tomorrow" — records the decision and closes the tab. */
  remind: remindTomorrow,
  /** Close just this tab. */
  close: closeUpdateTab,
  /** Per-package "don't show again for this update". */
  setSkip: handleSkipCommand,
  /** Manual download of a package zip. */
  download: downloadPackage,
  /** Open the browser install dir / profile dir in the OS file manager. */
  revealFolder,
};

// Live callbacks — the client assigns these before calling init().
Object.defineProperties(window.UpdaterEngine, {
  onState: {
    get: () => onState,
    set: fn => {
      onState = fn;
    },
  },
  onProgress: {
    get: () => onProgress,
    set: fn => {
      onProgress = fn;
    },
  },
});
