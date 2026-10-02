// test/e2e/shared/updaterDriver.mjs — the updater E2E's in-browser driver (#309).
//
// Driver mode = "unit tests in puppeteer": ONE live browser per scenario family,
// with the harness driving the production orchestrator (checkForUpdates, the
// module export added for this) from a privileged page and asserting the result
// through BiDi, prefs and the disk. Scenario variants differ only in seed state
// (marker files, override prefs, skip prefs, manifest content), so flipping the
// inputs between calls replaces a browser relaunch — the launch step is where
// the flake class lives (the TargetCloseError retry machinery exists only to
// survive it).
//
// Why a written page instead of calling the orchestrator inside the updater tab:
//
//   - the updater tab is not a stable realm — it closes and re-opens as the
//     check decides, and its own engineInit() carries side effects (it records
//     the shown day, self-closes when a twin tab exists, and runs its own
//     check), so a driver living there would perturb what it measures;
//   - the driver page is a plain privileged chrome:// document: no twin-tab
//     guard, no engine, no pref writes. It only exposes explicit commands.
//
// The page is written into the seeded profile's `updater/` directory — the
// directory chrome.manifest maps to `chrome://firefox-scripts/content/`
// (`content firefox-scripts updater/` in core/chrome/utils/chrome.manifest).
// Extra files there are invisible to the package hash: computeFilesHash() and
// the C twin hash the manifest's `files` list only, so seeding a test-only file
// cannot flip the utils hash or the staleness the scenarios assert.

import fs from 'node:fs';
import path from 'node:path';

/** The real updater tab (what the scheduler opens, what the twin guard counts). */
export const UPDATER_URL = 'chrome://firefox-scripts/content/ui/updater.html';

/** The driver page — deliberately NOT this URL, so no updater-tab logic sees it. */
export const DRIVER_URL = 'chrome://firefox-scripts/content/e2e-driver.html';

/** Driver page file names, relative to the seeded profile's `updater/` dir. */
export const DRIVER_PAGE = 'e2e-driver.html';
export const DRIVER_SCRIPT = 'e2e-driver.js';

/**
 * The privileged driver surface. Commands are deliberately dumb: each one is a
 * single observable the harness asserts on, and none of them narrate (the
 * harness owns the expectations).
 *
 * `check()` is the driver's core verb — the exact production entry point, with
 * the daily gate cleared first so the call always re-decides. It reports the
 * gate pref AFTER the call (the up-to-date path is its only writer) and how
 * many updater tabs the call added (the scheduler's own addTrustedTab).
 *
 * Chrome ES modules are per-GLOBAL: importing scriptsUpdater.sys.mjs here gives
 * this page its own module instance (fresh gWindow/gInitialized/…), not the one
 * BootstrapLoader.js initialized in the browser window's global. That is why
 * the driver initializes "its" scheduler explicitly (initScheduler, the same
 * entry point the loader uses) instead of assuming the browser's instance is
 * reachable — every check the driver runs then goes through the production code
 * path, in the realm that is calling it.
 */
const DRIVER_SCRIPT_SOURCE = `'use strict';

// Firefox Scripts updater E2E driver (#309). Written into the seeded profile by
// test/e2e/shared/updaterDriver.mjs; never part of any published package.

const SCHEDULER_URL = 'chrome://firefox-scripts/content/scriptsUpdater.sys.mjs';
const UPDATER_URL = '${UPDATER_URL}';
const PREF_LAST_CHECK = 'extensions.firefox-scripts.lastScriptsCheckDate';
const PREF_SKIP_PREFIX = 'extensions.firefox-scripts.skippedHash.';

function gBrowser() {
  return window.browsingContext?.topChromeWindow?.gBrowser || null;
}

/** The real updater tabs (the twin guard / scheduler scan match exactly this). */
function updaterTabs() {
  const b = gBrowser();
  if (!b) return [];
  const out = [];
  for (const tab of b.tabs) {
    try {
      if (tab.linkedBrowser?.currentURI?.spec === UPDATER_URL) out.push(tab);
    } catch (e) {
      // A tab mid-teardown has no usable currentURI; not an updater tab.
    }
  }
  return out;
}

window.UpdaterE2EDriver = {
  url: UPDATER_URL,

  /** Command channel is live (the harness polls this before it drives). */
  ready() {
    return typeof this.check === 'function' && gBrowser() !== null;
  },

  /** How many real updater tabs are open right now. */
  updaterTabCount() {
    return updaterTabs().length;
  },

  /** Their specs (diagnostics: a second tab means the scheduler opened one). */
  updaterSpecs() {
    return updaterTabs().map(tab => tab.linkedBrowser.currentURI.spec);
  },

  /** Close every real updater tab — call before an assertion that counts them. */
  closeUpdaterTabs() {
    const b = gBrowser();
    for (const tab of updaterTabs()) b.removeTab(tab);
    return true;
  },

  /** Open a real updater tab (renders the card without the scheduler). */
  openUpdaterTab() {
    const b = gBrowser();
    const tab = b.addTrustedTab(UPDATER_URL);
    // Select it so the document actually loads and its engine renders.
    b.selectedTab = tab;
    return true;
  },

  /** Clear the daily gate: the next check always re-decides (ADR 0012 pref). */
  clearDailyGate() {
    Services.prefs.clearUserPref(PREF_LAST_CHECK);
    return true;
  },

  readDailyGate() {
    return Services.prefs.getCharPref(PREF_LAST_CHECK, '');
  },

  /** Per-package "don't show again for this update" pref (variant input). */
  setSkip(pkg, hash) {
    Services.prefs.setCharPref(PREF_SKIP_PREFIX + pkg, hash);
    return true;
  },

  /**
   * Generic char-pref write (a folded scenario's input): the override prefs
   * (extensions.firefox-scripts.override.*) are read by the scheduler at every
   * call, so a scenario can repoint a URL for its own phase without a relaunch.
   */
  setPref(name, value) {
    Services.prefs.setCharPref(name, value);
    return true;
  },

  /** Drop a pref set by setPref, restoring the baked configuration. */
  clearPref(name) {
    Services.prefs.clearUserPref(name);
    return true;
  },

  readSkip(pkg) {
    return Services.prefs.getCharPref(PREF_SKIP_PREFIX + pkg, '');
  },

  /**
   * Initialize THIS realm's scheduler instance (gWindow = the browser window —
   * the same call BootstrapLoader.js makes). Idempotent: a second call only
   * refreshes the tab target, exactly like a new browser window in production.
   *
   * initScriptsUpdater() also runs one check immediately; the day is set to
   * today first (the tab the startup check opened already owns it), so that
   * first check is a no-op and every variant decision comes from the harness's
   * own call below.
   */
  initScheduler() {
    Services.prefs.setCharPref(PREF_LAST_CHECK, new Date().toISOString().slice(0, 10));
    ChromeUtils.importESModule(SCHEDULER_URL).initScriptsUpdater(
      window.browsingContext?.topChromeWindow
    );
    return true;
  },

  /**
   * The production orchestrator, driven on demand: clear the gate, run the
   * check, report what it observed. The module URI is the same one
   * BootstrapLoader.js and the tab engine import, so this is the same module
   * instance (same gWindow, same channel state) the browser is running.
   *
   * @returns {Promise<{gate: string; opened: number; tabs: number}>}
   */
  async check() {
    Services.prefs.clearUserPref(PREF_LAST_CHECK);
    const before = updaterTabs().length;
    const scheduler = ChromeUtils.importESModule(SCHEDULER_URL);
    await scheduler.checkForUpdates();
    // addTrustedTab() returns before the new tab's linkedBrowser has committed
    // its URI, so a count taken at the instant the promise resolves reads 0 for
    // a tab that is already opening (observed on Windows, 2026-09-27). Settle
    // on the first observable outcome of the decision instead — a new updater
    // tab, or the up-to-date path's day write (the pending path writes nothing:
    // its tab records the shown day later, in the tab's engineInit).
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (updaterTabs().length > before || Services.prefs.getCharPref(PREF_LAST_CHECK, '')) {
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return {
      gate: Services.prefs.getCharPref(PREF_LAST_CHECK, ''),
      opened: updaterTabs().length - before,
      tabs: updaterTabs().length,
    };
  },

  /** The updater tab's engine, for card assertions in a tab we opened. */
  hasUpdaterEngine() {
    return typeof window.UpdaterEngine?.init === 'function';
  },
};
`;

const DRIVER_PAGE_SOURCE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <!-- Same shape as the updater tab: XML-parsed XHTML, no inline script, no
         document-level network. This page is a test harness surface — it ships
         in no package. -->
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; script-src chrome://firefox-scripts; base-uri 'none'; form-action 'none'"
    />
    <title>Firefox Scripts - updater E2E driver</title>
  </head>
  <body>
    <p>Updater E2E driver — driven over BiDi by test/e2e/updater/updater-e2e.mjs.</p>
    <script src="e2e-driver.js"></script>
  </body>
</html>
`;

/**
 * Write the driver page into a seeded profile, next to the utils package's
 * module dir (the chrome.manifest content root). Idempotent.
 *
 * @param {string} chromeUtils - the profile's chrome/utils dir (post-extract)
 * @returns {string} the driver URL to open
 */
export function installDriverPage(chromeUtils) {
  const dir = path.join(chromeUtils, 'updater');
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, DRIVER_PAGE), DRIVER_PAGE_SOURCE);
  fs.writeFileSync(path.join(dir, DRIVER_SCRIPT), DRIVER_SCRIPT_SOURCE);
  return DRIVER_URL;
}

/** The driver script as written (unit tests cross-check its constants). */
export function driverScriptSource() {
  return DRIVER_SCRIPT_SOURCE;
}

/**
 * Open the driver tab FROM an existing privileged page — the harness cannot
 * navigate a content tab to chrome://, so a realm must already exist (the
 * scheduler's own tab, i.e. a stale start). Fire-and-forget: the tab starts
 * loading and the caller collects it with attachDriver().
 *
 * @param {import('puppeteer-core').Page} page - a privileged page (the updater
 *   tab)
 * @param {string} driverUrl
 * @returns {Promise<boolean>} whether the request was dispatched
 */
export async function openDriverTab(page, driverUrl = DRIVER_URL) {
  try {
    return await page.evaluate(url => {
      const win = window.browsingContext?.topChromeWindow;
      if (!win?.gBrowser) return false;
      const tab = win.gBrowser.addTrustedTab(url);
      // Select it: a background trusted tab can stay unloaded (about:blank) and
      // an unloaded tab has no realm to evaluate in. The scheduler's own
      // tab-open path selects its tab for the same reason.
      win.gBrowser.selectedTab = tab;
      return true;
    }, driverUrl);
  } catch {
    // The opener tab can be torn down as the driver tab loads; the caller's
    // wait on the driver page is the synchronization point either way.
    return false;
  }
}

/**
 * Find the driver realm and return its command object.
 *
 * Discovery is by REALM, not by URL: BiDi's per-context URL for a chrome tab
 * opened after the session attached can stay about:blank while the document is
 * fully loaded (observed on Windows — the tab enumerates, evaluates, and
 * reports its chrome:// URL through contentDocument, but page.url() says
 * about:blank). Asking every page whether it carries the driver surface is the
 * reliable identity; the URL is only a diagnostic.
 *
 * Every command is an independent BiDi evaluation on that page, so the harness
 * sets inputs (disk, prefs) between calls — the whole point of driver mode.
 *
 * @param {import('puppeteer-core').Browser} browser
 * @param {number} [timeoutMs]
 * @returns {Promise<object | null>} driver commands, or null when no page
 *   exposes the driver (BiDi cannot evaluate in a privileged page here, or the
 *   page never loaded)
 */
export async function attachDriver(browser, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let pages = [];
    try {
      pages = await browser.pages();
    } catch {
      /* browser not ready yet */
    }
    for (const candidate of pages) {
      try {
        if (await candidate.evaluate(() => window.UpdaterE2EDriver?.ready() === true)) {
          return driverCommands(candidate);
        }
      } catch {
        // Not an evaluable context (or the document is still loading).
      }
    }
    await new Promise(r => setTimeout(r, 250));
  }
  return null;
}

/**
 * Find the updater tab's page handle by REALM, not by URL.
 *
 * BiDi's per-context URL for a chrome tab opened AFTER the session attached can
 * stay about:blank for the whole run (observed on Windows: the startup tab —
 * opened while the session was still attaching — reports its chrome:// URL,
 * every tab opened later enumerates as about:blank while its document is the
 * real page). Realm identity is what the harness actually needs: the updater
 * tab is the page that exposes UpdaterEngine and is not the driver page.
 *
 * @param {import('puppeteer-core').Browser} browser
 * @param {number} [timeoutMs]
 * @returns {Promise<import('puppeteer-core').Page | null>}
 */
/**
 * Every BiDi page currently showing the updater tab (the first one is what
 * findUpdaterPage returns).
 *
 * A list, not a single page, because a page target OUTLIVES the tab it belongs
 * to: right after a tab closes, its document is still evaluable for a while, so
 * "the updater page" can be a tab that is already going away. Callers that need
 * THIS run's tab must pick by rendered state instead of by position (see the
 * install-applies step: it clicked the dying tab on zen · windows-latest,
 * 2026-10-02, and the install never started).
 *
 * @param {import('puppeteer-core').Browser} browser
 * @returns {Promise<import('puppeteer-core').Page[]>}
 */
export async function updaterPages(browser) {
  let pages;
  try {
    pages = await browser.pages();
  } catch {
    return [];
  }
  const found = [];
  for (const candidate of pages) {
    try {
      const isUpdaterTab = await candidate.evaluate(
        () =>
          typeof window.UpdaterEngine?.init === 'function' &&
          typeof window.UpdaterE2EDriver === 'undefined'
      );
      if (isUpdaterTab) found.push(candidate);
    } catch {
      // Not an evaluable context (or a document still loading).
    }
  }
  return found;
}

/**
 * The first updater page, polling until one exists (or the deadline passes).
 *
 * @param {import('puppeteer-core').Browser} browser
 * @param {number} [timeoutMs] Default is `15_000`
 * @returns {Promise<import('puppeteer-core').Page | null>}
 */
export async function findUpdaterPage(browser, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [first] = await updaterPages(browser);
    if (first) return first;
    if (Date.now() >= deadline) return null;
    await new Promise(r => setTimeout(r, 250));
  }
}

/**
 * The command surface for one driver page. The realm is assumed live (see
 * attachDriver) — every command re-evaluates on it, so a torn-down realm shows
 * up as a rejected promise rather than a stale object.
 *
 * @param {import('puppeteer-core').Page} page
 * @returns {object}
 */
function driverCommands(page) {
  return {
    page,
    /** Real updater tabs open right now. */
    updaterTabCount: () => page.evaluate(() => window.UpdaterE2EDriver.updaterTabCount()),
    /** Their specs (diagnostics). */
    updaterSpecs: () => page.evaluate(() => window.UpdaterE2EDriver.updaterSpecs()),
    /** Close them all, so the next count measures only what this run opened. */
    closeUpdaterTabs: () => page.evaluate(() => window.UpdaterE2EDriver.closeUpdaterTabs()),
    /** Open a real updater tab (card rendering without the scheduler). */
    openUpdaterTab: () => page.evaluate(() => window.UpdaterE2EDriver.openUpdaterTab()),
    /** The daily gate (ADR 0012 pref) as the browser sees it. */
    readDailyGate: () => page.evaluate(() => window.UpdaterE2EDriver.readDailyGate()),
    /** Set a per-package skip pref (a variant input). */
    setSkip: (pkg, hash) =>
      page.evaluate((p, h) => window.UpdaterE2EDriver.setSkip(p, h), pkg, hash),
    /** Generic char-pref write (folded scenarios repoint override URLs). */
    setPref: (name, value) =>
      page.evaluate((n, v) => window.UpdaterE2EDriver.setPref(n, v), name, value),
    /** Clear a pref set with setPref. */
    clearPref: name => page.evaluate(n => window.UpdaterE2EDriver.clearPref(n), name),
    /** Read it back (the check clears stale skip prefs). */
    readSkip: pkg => page.evaluate(p => window.UpdaterE2EDriver.readSkip(p), pkg),
    /**
     * Initialize this realm's scheduler instance (once, right after attach):
     * per-global module state means the driver's instance needs the same
     * initialization the browser gives its own.
     */
    initScheduler: () => page.evaluate(() => window.UpdaterE2EDriver.initScheduler()),
    /** Run the production orchestrator once, gate cleared. */
    check: () => page.evaluate(() => window.UpdaterE2EDriver.check()),
  };
}
