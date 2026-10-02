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
 * tab is simply not opened. One exception (ADR 0026): a dev-channel install
 * whose own manifest is unreachable falls back to the stable channel's manifest
 * (generated STABLE_* URLs) and auto-migrates; see fetchOwnManifestOrFallback()
 * below. --local snapshots keep the silent exit.
 *
 * The schedulable entry points are exported (checkForUpdates, the URL getters,
 * checkScriptsUpdateNeeded, ensureUpdaterUi, the zip/hash helpers) so the tab
 * engine and the E2E driver (#309) can call them directly; nothing about the
 * production flow depends on the exports.
 *
 * Notification = a new tab, shown at most once per day. A single daily pref
 * gates every check (extensions.firefox-scripts.lastScriptsCheckDate): it is
 * written by the scheduler when a check ran and found everything up to date,
 * and by the updater tab itself once shown for a pending update — so a tab the
 * user closes without acting suppresses only until tomorrow; the update keeps
 * resurfacing daily until it is installed or skipped. Per-package skips are
 * stored as extensions.firefox-scripts.skippedHash.<package> = remote hash.
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

/**
 * Stable-channel URL (the STABLE_* keys exist in dev-build configs only; a
 * stable build's own URLs are its channel, so its empty STABLE_* values fall
 * back to the own key). Like configValue, the test-local override pref wins —
 * the e2e harness points the fallback at its local snapshot server the same way
 * it points the own-channel URLs. Real users never set override prefs, so
 * behavior is unchanged for them.
 */
function stableConfigValue(key) {
  const stable = configValue(`STABLE_${key}`);
  return stable || configValue(key);
}

/**
 * Resolved against the ACTIVE channel, so a dev build that migrated to stable
 * keeps resolving stable URLs (the channel functions read the same state
 * fetchOwnManifestOrFallback writes).
 */
function channelValue(key) {
  // A dev install on its own test channel (and every --local snapshot)
  // resolves its own baked URLs; anything on the stable channel resolves the
  // STABLE_* URLs (a migrated dev build) or the own values (a stable build,
  // whose STABLE_* keys are empty).
  if (CONFIG.IS_LOCAL || activeChannel() === CHANNEL_DEV) {
    return configValue(key);
  }
  return stableConfigValue(key);
}

export function getHashesUrl() {
  return channelValue('HASHES_URL');
}

export function getZipBaseUrl() {
  return channelValue('ZIP_BASE_URL');
}

/**
 * Base URL of the updater tab UI package (updater-ui.zip) on the active
 * channel. It is published next to the hash manifest (gh-pages / the dev-build
 * branch / the local snapshot dir) and is never a release asset (upload.mjs),
 * so it must come from the manifest's own host — not ZIP_BASE_URL, which is the
 * release URL and has no updater-ui zip in prod (issue #102).
 */
export function getUiBaseUrl() {
  // Fall back to ZIP_BASE_URL only when the paired generated config predates
  // UI_BASE_URL (never true for zips built by the same publish run) — it keeps
  // the pre-#102 behavior instead of building an invalid URL.
  // Channel-aware: on the dev channel this is UI_BASE_URL (or the pre-#102
  // ZIP_BASE_URL fallback); on stable it resolves from the STABLE_* pair.
  return channelValue('UI_BASE_URL') || getZipBaseUrl();
}

export function getHelperBaseUrl() {
  return channelValue('HELPER_BASE_URL');
}

/** True when the running platform is `version` or newer (Services.vc.compare). */
const isVersion = version => Services.vc.compare(Services.appinfo.platformVersion, version) >= 0;

// Window-independent timers for the updater's module scope: setTimeout
// does not exist in ESM module scope (a bare reference throws — the #292
// lesson), so the one deferred step that needs it comes from Timer.sys.mjs,
// through the canonical lazy getters below — THE one defineESModuleGetters
// block. Every module lives here; importESModule is reserved for CONFIG, the
// generated file read in module scope, because a spec that depends on the
// running version (SessionStore) cannot be chosen at module scope.
const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  // The one top-level module the updater uses outside the browser chrome:
  // resolved through this block too, so `ChromeUtils.importESModule` remains
  // only for CONFIG — the generated file every entry point needs immediately.
  Downloads: 'resource://gre/modules/Downloads.sys.mjs',
  setTimeout: 'resource://gre/modules/Timer.sys.mjs',
  // 156.0a1 moved SessionStore to moz-src:// — the resource:///modules alias
  // stops working after that, and moz-src:// does not exist before it. The
  // session-restore gate and the closed-tab purge must therefore resolve the
  // spec at runtime: ESR 140 gets resource://, Nightly gets moz-src://.
  SessionStore:
    isVersion('156.0a1') ?
      'moz-src:///browser/components/sessionstore/SessionStore.sys.mjs'
    : 'resource:///modules/sessionstore/SessionStore.sys.mjs',
});

// The actual update tab (updater-ui.zip) — a privileged chrome:// page.
const UPDATER_UI_URI = 'chrome://firefox-scripts/content/ui/updater.html';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily re-check while the session lives
const MANIFEST_TIMEOUT_MS = 15000; // dead manifest host -> failed check, not a hang

// The single daily-gate pref (ADR 0012): the last day the updater acted —
// either a check ran and found everything up to date (written by
// checkForUpdates) or the updater tab was shown for a pending update (written
// by the tab's engine, updater.js in updater-ui.zip, right after it opens).
const PREF_LAST_CHECK = 'extensions.firefox-scripts.lastScriptsCheckDate';
const PREF_SKIP_PREFIX = 'extensions.firefox-scripts.skippedHash.';

/* ---------------- publish channels (ADR 0026) ----------------
 *
 * A dev install's generated config points exclusively at its dev-build branch.
 * When that branch is deleted the install would be stranded forever, so the
 * generated dev config carries the stable channel's URLs (STABLE_* keys) and
 * the daily check falls back to the stable manifest when the test channel's
 * own manifest is unreachable. Installing stable rewrites the installed
 * updater-config.sys.mjs with prod URLs — the channel migrates itself; the
 * persisted pref records it.
 *
 * --local snapshots keep the silent exit (ephemeral by design, ADR 0026):
 * their initial channel is 'local' regardless of the build mode.
 */
const PREF_ACTIVE_CHANNEL = 'extensions.firefox-scripts.activeChannel';
// The dev-build branch identity a migration belonged to (`CONFIG.DEV_BRANCH`).
// A stored stable channel is honored only while this matches the running
// build — otherwise a different dev build would inherit the migration and be
// dragged to stable (its own manifest may still be alive).
const PREF_ACTIVE_CHANNEL_BUILD = 'extensions.firefox-scripts.activeChannelBuild';
const CHANNEL_STABLE = 'stable';
const CHANNEL_DEV = 'dev';
const CHANNEL_LOCAL = 'local';

let gActiveChannel = null;
// Repeating daily timer (see initScriptsUpdater). An nsITimer, not setInterval:
// window-bound timer globals don't exist in this ESM's module scope (the bare
// ReferenceError was swallowed for the updater's entire lifetime — #292), and
// a window-scoped one would die with the first window while the browser stays
// up. nsITimer lives on the main thread for the session's lifetime.
let gDailyTimer = null;
// True only for the session in which the daily check actually migrated from
// the dev channel to stable — the updater tab turns this into its banner.
let gMigratedFromDev = false;

function initialChannel() {
  // Local snapshots never channel: a harness profile that once held a real
  // install must not inherit its stored channel.
  if (CONFIG.IS_LOCAL) {
    return CHANNEL_LOCAL;
  }
  try {
    if (Services.prefs.getPrefType(PREF_ACTIVE_CHANNEL) === Services.prefs.PREF_STRING) {
      const stored = Services.prefs.getCharPref(PREF_ACTIVE_CHANNEL, '');
      if (stored) {
        // A persisted stable channel is honored only when it belongs to THIS
        // dev build. A different dev build evaluates its own IS_DEV branch:
        // its manifest may still be alive, and if it later dies, the fallback
        // records its own migration.
        if (stored === CHANNEL_STABLE) {
          try {
            const build = Services.prefs.getCharPref(PREF_ACTIVE_CHANNEL_BUILD, '');
            if (build && build === CONFIG.DEV_BRANCH) {
              return CHANNEL_STABLE;
            }
          } catch (_) {
            // unreadable build pref → fall through to build-mode derivation
          }
          return CONFIG.IS_DEV ? CHANNEL_DEV : CHANNEL_STABLE;
        }
        return stored;
      }
    }
  } catch (_) {
    // unreadable pref store → derive from the build mode
  }
  return CONFIG.IS_DEV ? CHANNEL_DEV : CHANNEL_STABLE;
}

function activeChannel() {
  if (gActiveChannel === null) {
    gActiveChannel = initialChannel();
  }
  return gActiveChannel;
}

function setActiveChannel(channel) {
  gActiveChannel = channel;
  try {
    Services.prefs.setCharPref(PREF_ACTIVE_CHANNEL, channel);
    if (channel === CHANNEL_STABLE && CONFIG.IS_DEV) {
      // Record which dev build the migration belonged to (see
      // initialChannel — a different dev build must not inherit it).
      Services.prefs.setCharPref(PREF_ACTIVE_CHANNEL_BUILD, CONFIG.DEV_BRANCH || '');
    }
  } catch (_) {
    // A read-only pref store cannot persist the migration; the session flag
    // still drives the tab banner for this run.
  }
}

/**
 * Channel state for the updater tab: the channel URLs currently resolve
 * against, and whether THIS session's check migrated from the dev channel (the
 * tab shows the one-time migration banner from it).
 */
export function getChannelState() {
  return {channel: activeChannel(), migratedFromDev: gMigratedFromDev};
}

/**
 * Asset-name suffix for the active channel ('' everywhere since #282's suffix
 * drop). Kept as an indirection so a generated config that still carries '-dev'
 * (an older dev install before it re-downloads) keeps fetching its namespaced
 * assets, and so the channel contract has a single seam.
 */
export function getAssetSuffix() {
  if (CONFIG.IS_LOCAL || activeChannel() === CHANNEL_DEV) {
    return CONFIG.ASSET_SUFFIX || '';
  }
  return '';
}

let gInitialized = false;
let gWindow = null;

// Session-restore gate (#384 follow-up): the tab-attach decision must run
// AFTER SessionStore finished restoring, or the guard scans half-restored
// windows (no updater tab yet), opens a duplicate, and the restored tab
// lands afterwards. Set by an observer below; a session that never fires
// the event (e.g. no saved session) is covered by the bounded wait in
// checkForUpdates's attach block (sessionRestoredWait).
let gSessionRestored = false;

/**
 * Initialize the updater. Called per browser window on startup by
 * BootstrapLoader.js / userChrome.js; idempotent so double-init is harmless.
 *
 * @param {Window} win - the browser window
 */
export function initScriptsUpdater(win) {
  if (gInitialized) {
    // Window churn (the browser can outlive its first window): a new window
    // must become the tab-opening target, or the daily timer's re-checks
    // would no-op on a closed gWindow for the rest of the session.
    if (!gWindow || gWindow.closed) {
      gWindow = win;
      // A check may be in flight (started before window 1 closed) holding a
      // stale window; it can never open the tab. The daily prefs make this
      // cheap: a same-day check no-ops right after the gate. Without this, a
      // user who closed window 1 mid-check misses the notification until the
      // next daily tick (review on #310).
      checkForUpdates();
    }
    return;
  }
  gInitialized = true;

  gWindow = win;

  // Track session-restore completion (once per process, never removed —
  // the module lives as long as the browser).
  try {
    Services.obs.addObserver(function observe(subject, topic) {
      if (topic === 'sessionstore-windows-restored') {
        gSessionRestored = true;
        Services.obs.removeObserver(observe, topic);
      }
    }, 'sessionstore-windows-restored');
  } catch {
    // Observer registration failed (unusual): the restore wait falls back to
    // its module flag + bounded nsITimer poll.
  }

  // Check on startup, then re-check daily for as long as the session lives.
  // The daily pref (PREF_LAST_CHECK vs todayStr()) gates every invocation, so
  // same-day re-checks are no-ops. The timer must be an
  // nsITimer: window-bound timer globals (setInterval / win.setInterval) don't
  // exist in, or die with, the ESM's module scope vs the window (the original
  // bare setInterval never actually fired — its ReferenceError was swallowed
  // by the loader's catch for the updater's entire lifetime; found via the
  // #292 seeded-error experiment).
  checkForUpdates();
  gDailyTimer = Cc['@mozilla.org/timer;1'].createInstance(Ci.nsITimer);
  gDailyTimer.initWithCallback(
    checkForUpdates,
    CHECK_INTERVAL_MS,
    Ci.nsITimer.TYPE_REPEATING_SLACK
  );
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Resolve once SessionStore has finished restoring this session. Preferred
 * path: SessionStore's own promiseAllWindowsRestored — the restore itself takes
 * 1–2 s, and the promise resolves once done (expected to also resolve when
 * there was nothing to restore — no saved session, sessionstore off — which the
 * bounded fallback covers if it ever stays pending). Fallbacks: the module flag
 * set by the sessionstore-windows-restored observer, then a bounded nsITimer
 * poll — attaching late is cosmetic, attaching early duplicates tabs (#384).
 * The 5 s bound covers any anomaly (a pending promise burns the bound once per
 * day at worst); setTimeout does not exist in module scope, so the poll steps
 * through an nsITimer.
 */
async function sessionRestoredWait() {
  if (gSessionRestored) {
    return;
  }
  try {
    await withTimeout(Promise.resolve(lazy.SessionStore.promiseAllWindowsRestored), 5000);
    gSessionRestored = true;
    return;
  } catch {
    // Getter (unsupported version) or promise unavailable: fall back below.
  }
  const deadline = Date.now() + 10000;
  while (!gSessionRestored && Date.now() < deadline) {
    await new Promise(resolve => lazy.setTimeout(resolve, 100));
  }
}

/**
 * True when `tab` is showing the updater page. A tab whose browser is
 * mid-teardown can throw on the property access; callers run it inside a
 * try/catch.
 *
 * @param {Tab} tab - the tab to classify
 * @returns {boolean}
 */
function isUpdaterTab(tab) {
  return (
    tab.linkedBrowser?.currentURI?.spec === UPDATER_UI_URI ||
    tab.linkedBrowser?.initialURI === UPDATER_UI_URI
  );
}

/**
 * True when `tab` is the updater page and is NOT this session's own fresh open
 * (`_scriptsUpdateTab` is set by the attach block, and never by a restored
 * tab).
 *
 * @param {Tab} tab - the tab to classify
 * @returns {boolean}
 */
function isUnmarkedUpdaterTab(tab) {
  return !tab._scriptsUpdateTab && isUpdaterTab(tab);
}

/**
 * The window the user is actually on: the most-recently-used
 * `navigator:browser` window, or null when the browser has none.
 *
 * The updater tab must open where the user is looking, and that is NOT the
 * window initScriptsUpdater() was called with: BootstrapLoader.js /
 * userChrome.js call it per window off `chrome-document-loaded`, so on a
 * restored session gWindow is whichever window that observer happened to see
 * first (window 1 of the saved session), while SessionStore re-selects the
 * window that was selected at shutdown — usually a different one. The window
 * mediator's MRU order is also the order allBrowserWindows() enumerates in, so
 * the fresh tab lands in the first window the attach block scans.
 *
 * @returns {Window | null}
 */
function mostRecentBrowserWindow() {
  try {
    return Services.wm.getMostRecentWindow('navigator:browser') || null;
  } catch {
    // A mediator without the method (or a bogus window): callers fall back to
    // the window they already hold.
    return null;
  }
}

/** Every live navigator:browser window, in MRU order. */
function allBrowserWindows() {
  const wins = [];
  const enumerator = Services.wm.getEnumerator('navigator:browser');
  while (enumerator.hasMoreElements()) {
    wins.push(enumerator.getNext());
  }
  return wins;
}

/**
 * Select `tab` in `win` once its browser has committed a load (load or pageshow
 * — about:blank placeholders can fire load without committing, so both are
 * awaited), then move keyboard focus into it: selecting the tab alone leaves
 * the focus on whatever the user was in, so the tab is visible but unresponsive
 * to typing. Selecting earlier is the #384 wedge: see checkForUpdates.
 *
 * A load that never comes must not wedge selection forever: a one-shot 10 s
 * timer selects anyway (tabbar cosmetics at worst — the load itself is never
 * affected). Listeners/timer are cleaned up on whichever path wins first.
 *
 * @param {Window} win - the window hosting the tab
 * @param {Tab} tab - the freshly added updater tab
 */
function selectWhenLoaded(win, tab) {
  const gBrowser = win.gBrowser;
  let done = false;
  const finish = () => {
    if (done) {
      return;
    }
    done = true;
    try {
      lb.removeEventListener('load', onLoad, true);
      lb.removeEventListener('pageshow', onPageShow, true);
      timer.cancel();
    } catch {
      // Tab/window already gone: nothing to clean up.
    }
    // Window churn after the add (the awaited ensureUpdaterUi above can
    // outlive the window addTrustedTab targeted): select only if the tab is
    // still in ITS window's gBrowser.
    try {
      if (!win.closed && gBrowser.tabContainer.contains(tab)) {
        gBrowser.selectedTab = tab;
        lb.focus();
      }
    } catch {
      // Same: teardown mid-select is not a scheduler failure.
    }
  };
  const lb = tab.linkedBrowser;
  const onLoad = () => {
    if (lb.currentURI?.spec !== 'about:blank') {
      finish();
    }
  };
  const onPageShow = () => {
    if (lb.currentURI?.spec !== 'about:blank') {
      finish();
    }
  };
  let timer = null;
  try {
    lb.addEventListener('load', onLoad, true);
    lb.addEventListener('pageshow', onPageShow, true);
    timer = Cc['@mozilla.org/timer;1'].createInstance(Ci.nsITimer);
    timer.initWithCallback(finish, 10000, Ci.nsITimer.TYPE_ONE_SHOT);
  } catch {
    // No usable browser right now (nothing to select into): leave unselected —
    // the same outcome as the pre-#384 code with a dead window.
  }
}

/**
 * Remove a restored updater tab from a non-current window: close the tab and
 * purge the matching entry from the recently-closed list so the tab cannot be
 * resurrected (Ctrl+Shift+T) as a duplicate updater later. Best-effort: a
 * missing or changed SessionStore API degrades to a plain tab close (the fresh
 * open below still yields exactly one live updater tab).
 *
 * @param {Window} win - the window hosting the restored updater tab
 * @param {Tab} tab - the restored updater tab to forget
 */
function forgetUpdaterTab(win, tab) {
  try {
    win.gBrowser.removeTab(tab);
    try {
      // Services.ss exists only on newer Firefox (159+); the SessionStore
      // module is the portable path — same API, every supported engine — and
      // its spec is version-conditional in the lazy getter block above.
      const SessionStore = lazy.SessionStore;
      const closed = SessionStore.getClosedTabDataForWindow(win);
      const data = typeof closed === 'string' ? JSON.parse(closed) : closed;
      // Shape varies by method AND version: the window-state object carries
      // _closedTabs[] (the array form), the plain list form carries tabs[] or
      // windows[0]._closedTabs — scan every one of them.
      const candidates =
        [
          data?._closedTabs,
          data?.tabs,
          data?.windows?.[0]?._closedTabs,
          data?.windows?.[0]?.tabs,
        ].find(Array.isArray) ?? [];
      const index = candidates.findIndex(
        t =>
          t?.state?.entries?.[0]?.url === UPDATER_UI_URI || t?.entries?.[0]?.url === UPDATER_UI_URI
      );
      if (index >= 0) {
        SessionStore.forgetClosedTab(win, index);
      }
    } catch {
      // No session data for this tab: the plain removeTab above is enough.
    }
  } catch {
    // Tab/window gone mid-normalize: nothing to forget.
  }
}

/**
 * Daily check: fetch the manifest, compute local hashes, keep the updater UI
 * current, and open the update tab when utils or fx-folder needs an update.
 *
 * One daily pref gates this (ADR 0012): PREF_LAST_CHECK (lastScriptsCheckDate)
 * holds the last day the updater acted, and it has exactly two writers —
 *
 * - here, when a check COMPLETED and found everything up to date — the manifest
 *   was reached and parsed and both user-facing packages (fx-folder, utils)
 *   were actually compared — so the happy path (manifest fetch + hash of every
 *   package) runs once per DAY, not once per browser session (#333);
 * - in the updater tab (updater.js engineInit), once the tab is shown for a
 *   pending update, so an ignored tab does not re-open the same day.
 *
 * The pref therefore means "the updater handled today", never "the update is
 * done": a pending update that is ignored resurfaces tomorrow, and the only
 * ways to stop the tab are to install, or check "Don't show again for this
 * update" (per-package skippedHash prefs).
 */
export async function checkForUpdates() {
  // The early gate only needs A live window for the fetch phase; the tab-open
  // step below re-reads gWindow (window churn mid-check must not attach the
  // tab to a captured, possibly-closed window — review on #310).
  if (!gWindow || gWindow.closed) {
    return;
  }

  const today = todayStr();
  if (Services.prefs.getCharPref(PREF_LAST_CHECK, '') === today) {
    return;
  }

  const scriptsInfo = await checkScriptsUpdateNeeded();

  // The tab opens only when utils or fx-folder needs attention; a pure
  // updater-ui change never disturbs the user.
  const updateNeeded = scriptsInfo.fxFolder.updateNeeded || scriptsInfo.utils.updateNeeded;
  if (!updateNeeded) {
    // Everything matches the manifest: the updater handled today, so the check
    // runs once per day, not once per session (the pre-#333 gap — this return
    // re-ran the full fetch+hash on every browser start).
    //
    // ONLY on a COMPLETED check: an unreachable manifest also lands here with
    // every package updateNeeded:false (manifestReached:false below), and so
    // does a manifest missing a user-facing package entry — a broken or
    // truncated publish must never consume the day (CodeRabbit retained
    // concern on #333). A non-empty remoteHash marks an entry that was present
    // and compared; fx-folder + utils are both required, updater-ui alone is
    // optional (pre-ADR-0007 manifests legitimately lack it).
    const userPackagesCompared =
      Boolean(scriptsInfo.fxFolder.remoteHash) && Boolean(scriptsInfo.utils.remoteHash);
    if (scriptsInfo.manifestReached !== false && userPackagesCompared) {
      Services.prefs.setCharPref(PREF_LAST_CHECK, today);
    }
    return;
  }

  // Keep the tab UI itself current before it opens (silent self-update). If
  // updater-ui.zip cannot be fetched and no UI is installed, there is nothing
  // useful to open — exit quietly instead of showing a broken tab.
  if (!(await ensureUpdaterUi(scriptsInfo.updaterUi))) {
    return;
  }

  // Resolve the tab target HERE, not from the window the check started on: an
  // await above can outlive it, and the window initScriptsUpdater() saw first
  // is not the window the user is on (a restored session re-selects the window
  // that was selected at shutdown, which is not necessarily window 1 — see
  // mostRecentBrowserWindow). gWindow stays the fallback for a mediator that
  // cannot answer; if neither yields a live window, the browser is windowless
  // and there is nothing to attach the tab to.
  const liveWin = mostRecentBrowserWindow() || (gWindow && !gWindow.closed ? gWindow : null);
  const b = liveWin?.gBrowser;
  if (!b) {
    return;
  }

  // Session-restore gate: run the attach block only after SessionStore has
  // finished restoring (see gSessionRestored). Bounded: proceed after 30 s
  // even if the event never fires (no saved session, or restore disabled) —
  // attaching late is cosmetic, attaching early duplicates tabs (#384).
  await sessionRestoredWait();

  {
    // A restored session can hold an updater tab from the previous session —
    // possibly in a window the user is not looking at, and a lazily restored
    // chrome page may never run its engine. Rather than reuse it, ALWAYS forget
    // it (close + purge from the recently-closed list, so Ctrl+Shift+T cannot
    // resurrect a duplicate) and fall through to ONE fresh open in the current
    // window (#384 follow-up). Scanned across ALL windows; window churn (a
    // window closing mid-scan) and tabs mid-teardown are tolerated. A
    // scheduler-MARKED tab (this session's own fresh open) is never a victim:
    // a second check that reaches this block while the fresh tab's engine is
    // still running (the pending path writes the day only in engineInit) must
    // not close it — the re-scan below sees the surviving tab and bails.
    for (const win of allBrowserWindows()) {
      if (win.closed) {
        continue;
      }
      for (const tab of [...win.gBrowser.tabs]) {
        try {
          if (isUnmarkedUpdaterTab(tab)) {
            forgetUpdaterTab(win, tab);
          }
        } catch {
          // A tab mid-teardown has no usable browser; not an updater tab.
        }
      }
    }

    // Re-scan after the forget pass: a just-forgotten tab's SessionStore record
    // can briefly keep initialURI visible to a racing fresh-open. If any updater
    // tab survived (mid-teardown twin), let IT be the one and bail — never two.
    for (const win of allBrowserWindows()) {
      if (win.closed) {
        continue;
      }
      for (const tab of win.gBrowser.tabs) {
        try {
          if (isUpdaterTab(tab)) {
            return;
          }
        } catch {
          // Mid-teardown: not countable here.
        }
      }
    }
  }

  // The tab records its own shown-day (updater.js engineInit, right after it
  // opens): one pref means the shown tab owns the day whether or not the user
  // acts. A restored tab (manual restart with the tab left open) re-checks in
  // updater.js instead of showing a stale "All packages are up to date.".
  const tab = liveWin.gBrowser.addTrustedTab(UPDATER_UI_URI);
  tab._scriptsUpdateTab = true;
  tab.loadOnStartup = true;
  // Select the tab only once its browser has actually started loading the
  // updater page. The selection here used to be synchronous, and under startup
  // CPU contention that could wedge the tab forever in headless Nightly: the
  // forced async tab switch raced the new browser's still-null currentURI
  // (AsyncTabSwitcher.sys.mjs schemeIs TypeError in the wild), the load never
  // committed — the tab stayed at about:blank busy=true, the engine never ran,
  // and the pending update stayed hidden for the whole session (#384).
  // Deferring to load/pageshow keeps the "updater tab selected" behavior on
  // the healthy path while the load itself can never be killed by it.
  selectWhenLoaded(liveWin, tab);
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
 * The directory fx-folder (config.js, defaults/pref/config-prefs.js) lives in.
 * Ordinary installs keep it in GreD — the app dir next to the binary.
 * Snap-packaged Firefox is different: Services GreD is the read-only
 * /snap/<name>/<rev>/... app mount, while the browser reads its autoconfig from
 * /etc/firefox on the host (where the install docs tell snap users to place
 * config.js). Hashing or copying against /snap/... can never match or write —
 * it left fx-folder permanently "Update Available" on the snap E2E leg (#55) —
 * so map snap installs to /etc/firefox.
 *
 * @returns {string}
 */
export function fxFolderDir() {
  const exePath = Services.dirsvc.get('XREExeF', Ci.nsIFile).path;
  if (exePath.includes('/snap/')) {
    return '/etc/firefox';
  }
  return Services.dirsvc.get('GreD', Ci.nsIFile).path;
}

/**
 * Fetch the hash manifest and compare per-package local hashes against it.
 *
 * Dead-test-channel fallback (ADR 0026): when the active dev channel's own
 * manifest is unreachable (its dev-build branch was deleted), fetch the stable
 * channel's manifest from the generated STABLE_* URLs and run the same hash
 * comparison against it — one attempt, then the normal silent exit. The
 * migration is recorded (channel pref + session flag) only after the stable
 * manifest is actually in hand; if stable is also unreachable the install stays
 * on the dev channel and the check fails silently as before. --local snapshots
 * never fall back (ephemeral by design).
 *
 * @returns {Promise<{fxFolder: Object; utils: Object; updaterUi: Object}>}
 */
export async function checkScriptsUpdateNeeded() {
  const result = {
    fxFolder: {updateNeeded: false, date: '', remoteHash: '', files: []},
    utils: {updateNeeded: false, date: '', remoteHash: '', files: []},
    updaterUi: {updateNeeded: false, date: '', remoteHash: '', files: []},
  };

  const manifestText = await fetchOwnManifestOrFallback();
  if (manifestText === null) {
    // Unreachable manifest: the daily gate must treat this day as UNVERIFIED (a
    // network-failure day must never let the up-to-date path write its marker —
    // see checkForUpdates). Reachability rides on the existing result object so
    // callers need no new shape: every package stays updateNeeded:false, exactly
    // the silent exit the failure path always had.
    result.manifestReached = false;
    return result;
  }
  result.manifestReached = true;

  try {
    const remoteInfo = JSON.parse(manifestText);
    // NOTE: a malformed manifest (or a throw partway through the loop) is
    // reset to manifestReached:false in the catch below — only a fully parsed,
    // fully compared check may count the day as handled.

    const profileDir = Services.dirsvc.get('ProfD', Ci.nsIFile).path;
    const dirs = {
      'fx-folder': fxFolderDir(),
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
    // Malformed manifest or a throw partway through the comparison: the day is
    // UNVERIFIED exactly like an unreachable transport — a broken publish must
    // not consume the next day of checks (local review on #333).
    result.manifestReached = false;
    return result;
  }
}

/**
 * Fetch the active channel's manifest; on failure, attempt the dead-test-
 * channel fallback to stable (ADR 0026). --local snapshots never fall back.
 *
 * @returns {Promise<string | null>} manifest JSON text, or null when both the
 *   own channel and (where applicable) the fallback are unreachable
 */
async function fetchOwnManifestOrFallback() {
  const url = getHashesUrl();
  try {
    // Never hang on a dead/stalled manifest host: the daily check must fail
    // fast and leave the tab closed rather than spin.
    return await withTimeout(fetchText(url), MANIFEST_TIMEOUT_MS);
  } catch (e) {
    console.error('Firefox Scripts: manifest fetch failed', e);
  }

  // Own manifest unreachable. Only a dev-channel install may fall back, and
  // only when its generated config actually carries the stable URLs.
  if (CONFIG.IS_LOCAL || activeChannel() !== CHANNEL_DEV) {
    return null;
  }
  if (!CONFIG.STABLE_HASHES_URL) {
    return null; // pre-0026 dev build: no stable URLs baked in, silent exit
  }
  // Resolve through stableConfigValue so the harness override prefs steer the
  // fallback too (same mechanism as every other URL getter). The baked
  // CONFIG.STABLE_HASHES_URL above stays the presence check: a pre-0026 build
  // has no key at all, while the resolved value would just fall back to the
  // (dead) own URL.
  const stableHashesUrl = stableConfigValue('HASHES_URL');
  if (!stableHashesUrl) {
    return null;
  }

  console.warn(
    'Firefox Scripts: dev channel manifest unreachable — falling back to the stable channel'
  );
  try {
    const stableText = await withTimeout(fetchText(stableHashesUrl), MANIFEST_TIMEOUT_MS);
    // Migration recorded only when stable answered: from here the URLs resolve
    // against stable and the updater tab shows the migration banner.
    setActiveChannel(CHANNEL_STABLE);
    gMigratedFromDev = true;
    console.warn('Firefox Scripts: dev channel is gone — migrated to the stable channel');
    return stableText;
  } catch (stableError) {
    console.error('Firefox Scripts: stable-channel fallback also failed', stableError);
    return null;
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
    const zipUrl = `${getUiBaseUrl()}/updater-ui${getAssetSuffix()}.zip`;
    const zipPath = PathUtils.join(tmpDir, 'updater-ui.zip');
    await lazy.Downloads.fetch(zipUrl, zipPath);

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
 * The canonical hash-order comparator: case-insensitive comparison over UTF-8
 * bytes — ASCII letters fold (primary key), and paths that fold equal but
 * differ in case tie-break on the raw bytes, so the order is total and
 * input-independent. Byte-exact mirror of cmp_path_ci() in
 * installer/src/detect_browser.c (and compareCaseInsensitive() in
 * tools/publish/hashUtils.mjs) — the manifest contract is that C, publish-side
 * Node and this in-browser module all derive the identical order. Deliberately
 * NOT localeCompare(): its ordering follows the application locale and could
 * silently diverge from the C twin.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} negative / 0 / positive, for Array.prototype.sort
 */
function compareHashOrder(a, b) {
  const fa = new TextEncoder().encode(a);
  const fb = new TextEncoder().encode(b);
  const FOLD = 0x20; // 'a' - 'A'
  const len = Math.min(fa.length, fb.length);
  for (let i = 0; i < len; i++) {
    const ca = fa[i] >= 65 && fa[i] <= 90 ? fa[i] + FOLD : fa[i];
    const cb = fb[i] >= 65 && fb[i] <= 90 ? fb[i] + FOLD : fb[i];
    if (ca !== cb) return ca - cb;
  }
  // Folded-equal so far: the shorter byte string sorts first, and identical
  // lengths tie-break on the raw bytes (distinct case-variants stay ordered).
  if (fa.length !== fb.length) return fa.length - fb.length;
  for (let i = 0; i < len; i++) {
    if (fa[i] !== fb[i]) return fa[i] - fb[i];
  }
  return 0;
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
  const sorted = [...files].sort(compareHashOrder);
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

  const sorted = [...files].sort(compareHashOrder);
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

/**
 * Extract a zip into destDir. Mirrors the installer's extract_zip_flatten(): if
 * the archive has a single top-level folder (fx-folder.zip wraps files under
 * 'fx-folder/'), descend into it so files land flat.
 *
 * @returns {Promise<string>} the base dir containing the extracted files
 */
export async function extractZipFlatten(zipPath, destDir) {
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
