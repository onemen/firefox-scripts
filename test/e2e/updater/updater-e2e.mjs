#!/usr/bin/env node
/**
 * Updater E2E test — puppeteer-core + WebDriver BiDi.
 *
 * Verifies the in-browser updater tab (chrome://firefox-scripts/content/ui/
 * updater.html) renders the correct state for every package-status combination
 * and all user actions work:
 *
 * Scenario 1 (utils-stale): utils Update Available, config Up To Date +
 * identity, all 8 buttons, checkbox wiring, skip checkbox, no page/console
 * errors, screenshot Scenario 2 (config-stale): config Update Available, utils
 * Up To Date Scenario 3 (both-stale): both Update Available Scenario 4
 * (up-to-date): tab does NOT open (no state to surface) Scenario 5 (skipped):
 * skip pref suppresses the tab entirely Scenario 6 (install-applies): click
 * btn-install and assert the packages are actually copied to disk (issue #37);
 * under Snap the config package is never offered in-tab — the checkbox is
 * hidden and the manual-install band shown, so the run installs utils only and
 * asserts the config files stay untouched Scenario 7 (manual-install-upgrade):
 * a hand-installed utils.zip brings the updater — no tab with a pre-updater
 * utils, tab after replacing it (issue #53) Scenario 8 (manual-install-no-ui):
 * a hand-installed utils.zip ships NO ui folder (the tab UI lives in the
 * separate updater-ui.zip); after a fresh check the scheduler self-installs the
 * ui (ensureUpdaterUi) and the tab is visible (issue #102)
 *
 * Each scenario: fresh temp profile → seed utils + fx-folder → modify files to
 * force desired state → launch Firefox → wait for tab (or assert none) → run
 * assertions → close.
 *
 * Usage: node test/e2e/updater/updater-e2e.mjs --firefox <path> --snapshot<dir>
 */

import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {
  REPO_ROOT,
  launchFirefox,
  attachProcessLogging,
  check,
  createCounter,
  findPageByUrl,
  waitForCondition,
  screenshotPrivileged,
  tempDir,
  rmDir,
  summary,
  localConfigOverrides,
} from '../shared/helpers.mjs';
import {
  findSnapshot,
  findZip,
  extractZip,
  discoverFirefoxBinary,
  findGreDir,
} from '../shared/browsers.mjs';

const UPDATER_URL = 'chrome://firefox-scripts/content/ui/updater.html';
const FORCE_UTILS_STALE = 'RDFDataSource.sys.mjs';
const FORCE_UTILS_STALE_MARKER = '\n// e2e-test: forced stale\n';
const FORCE_CONFIG_STALE_MARKER = '// e2e-test\n';

/**
 * Appended to the seeded GreD config.js: proves autoconfig executed (pref) and
 * mirrors all console-service messages to <profile>/e2e-console.log so silent
 * updater bails become visible in CI logs.
 */
const CONFIG_PROBE_SNIPPET = `
// e2e-test probe
try {
  pref('extensions.firefox-scripts.e2eAutoconfigRan', 'yes');
  const Cc = Components.classes;
  const Ci = Components.interfaces;
  const cs = Cc['@mozilla.org/consoleservice;1'].getService(Ci.nsIConsoleService);
  const f = Cc['@mozilla.org/file/local;1'].createInstance(Ci.nsIFile);
  f.initWithPath(Services.dirsvc.get('ProfD', Ci.nsIFile).path + '/e2e-console.log');
  const fos = Cc['@mozilla.org/network/file-output-stream;1'].createInstance(
    Ci.nsIFileOutputStream
  );
  fos.init(f, 0x02 | 0x08 | 0x10, -1, 0); // write | create | append
  cs.registerListener({
    observe(aMessage, aTopic, aData) {
      try {
        const line =
          new Date().toISOString() +
          ' ' +
          (aMessage.QueryInterface(Ci.nsIScriptError)?.errorMessage || aData || '') +
          '\\n';
        fos.write(line, line.length);
      } catch (e) {}
    },
  });
  // Watch for the updater tab and record the moment it appears — WebDriver
  // BiDi cannot reliably enumerate trusted chrome:// tabs on CI.
  let polls = 0;
  const watcher = Cc['@mozilla.org/timer;1'].createInstance(Ci.nsITimer);
  watcher.initWithCallback(
    {
      notify() {
        try {
          // 30 s of polls comfortably exceeds the 15 s test deadline below.
          if (++polls > 30) {
            watcher.cancel();
            return;
          }
          const win = Services.wm.getMostRecentWindow('navigator:browser');
          for (const tab of win?.gBrowser?.tabs || []) {
            const spec = tab.linkedBrowser?.currentURI?.spec || '';
            if (spec.startsWith('chrome://firefox-scripts/content/ui/')) {
              const line = 'TAB_OPENED ' + new Date().toISOString() + ' ' + spec + '\\n';
              fos.write(line, line.length);
              watcher.cancel();
              return;
            }
          }
        } catch (e) {}
      },
    },
    1000,
    Ci.nsITimer.TYPE_REPEATING_SLACK
  );
} catch (e) {}
`;

// ── Parse args ────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--firefox' && args[i + 1]) opts.firefox = args[++i];
    else if (args[i] === '--snapshot' && args[i + 1]) opts.snapshot = args[++i];
    else if (args[i] === '--headless') opts.headless = true;
    else if (args[i] === '--keep-profile') opts.keepProfile = true;
    else if (args[i] === '--no-fail-fast') opts.failFast = false;
    else if (args[i] === '--scenario' && args[i + 1])
      opts.scenarios = args[++i].split(',').map(s => s.trim());
    else if (args[i] === '--help') {
      console.log(
        '        Usage: node updater-e2e.mjs --firefox <path> --snapshot <dir> [--scenario 1,2,3]'
      );
      process.exit(0);
    }
  }
  return opts;
}

// ── Profile helpers ────────────────────────────────────────────────────────

function installFxFolder(snapshotDir, greDir) {
  const fxZip = findZip(snapshotDir, ['fx-folder-dev.zip', 'fx-folder.zip']);
  if (!fxZip) return {ok: false, error: 'no fx-folder zip in snapshot'};
  const staging = tempDir('fxs-fx');
  try {
    extractZip(fxZip, staging);
    const base = path.join(staging, 'fx-folder');
    const pairs = ['config.js', 'defaults/pref/config-prefs.js'];
    for (const rel of pairs) {
      const src = path.join(base, ...rel.split('/'));
      const dst = path.join(greDir, ...rel.split('/'));
      if (!fs.existsSync(src)) {
        return {ok: false, error: `${rel} missing from ${path.basename(fxZip)}`};
      }
      try {
        fs.mkdirSync(path.dirname(dst), {recursive: true});
        fs.writeFileSync(dst, fs.readFileSync(src));
      } catch (err) {
        return {ok: false, error: `cannot write ${dst}: ${err.message}`};
      }
    }
    return {ok: true, error: ''};
  } finally {
    rmDir(staging);
  }
}

function seedProfile(
  snapshotDir,
  {forceConfigStale = false, forceUtilsStale = false, skipUtils = false, skipConfig = false} = {}
) {
  const profileDir = tempDir('fxs-e2e');
  // Prefs are injected via puppeteer's extraPrefsFirefox (see launchFirefox):
  // puppeteer replaces any caller-written user.js with its own preferences
  // before launch, so a user.js here would silently never reach Firefox.
  // Every scenario has a fresh profile, but the daily notification gate is
  // made explicit so an inherited/default pref can never suppress a stale
  // fixture.
  const prefs = {
    'extensions.firefox-scripts.lastUpdateTabShown': '',
    'extensions.firefox-scripts.lastScriptsCheckDate': '',
  };
  const chromeUtils = path.join(profileDir, 'chrome', 'utils');

  // Extract utils
  const utilsZip = findZip(snapshotDir, ['utils-dev.zip', 'utils.zip']);
  if (utilsZip) {
    extractZip(utilsZip, chromeUtils);
  }

  // Cross-OS snapshot sharing: when the snapshot was built elsewhere its baked
  // file:// URLs point at the builder's dist dir. Repoint them at THIS
  // machine's snapshot via pref overrides (never by rewriting the config — it
  // is part of the hashed utils file set). No-op when the paths already match.
  // Runs after the utils extract so the generated config file exists.
  Object.assign(prefs, localConfigOverrides(chromeUtils, snapshotDir));

  // Force utils stale by changing a valid, non-startup module. Deleting a
  // shipped module can prevent the scheduler from running at all, which would
  // make the stale-state test meaningless.
  if (forceUtilsStale) {
    const stale = path.join(chromeUtils, FORCE_UTILS_STALE);
    if (!fs.existsSync(stale)) {
      throw new Error(`cannot force utils stale: ${FORCE_UTILS_STALE} missing from utils zip`);
    }
    fs.appendFileSync(stale, FORCE_UTILS_STALE_MARKER);
  }

  // Force config stale: modify config.js in GreD
  if (forceConfigStale) {
    return {profileDir, chromeUtils, _greModNeeded: true, prefs};
  }

  // Per-package skip prefs (extensions.firefox-scripts.skippedHash.<pkg> =
  // remote hash) — seeded from the snapshot's own manifest.
  if (skipUtils || skipConfig) {
    try {
      const hashesPath = path.join(snapshotDir, 'hashes.json');
      if (fs.existsSync(hashesPath)) {
        const hashes = JSON.parse(fs.readFileSync(hashesPath, 'utf-8'));
        if (skipUtils && hashes.utils?.hash) {
          prefs['extensions.firefox-scripts.skippedHash.utils'] = hashes.utils.hash;
        }
        if (skipConfig && hashes['fx-folder']?.hash) {
          prefs['extensions.firefox-scripts.skippedHash.fx-folder'] = hashes['fx-folder'].hash;
        }
      }
    } catch {
      /* manifest missing */
    }
  }

  return {profileDir, chromeUtils, _greModNeeded: false, prefs};
}

/**
 * Snapshot GreD before the test writes over it. Returns a map: {[path]:
 * data|null} — null means the file did NOT exist before the test (created by
 * installFxFolder) and should be removed.
 */
function saveGreConfig(greDir) {
  const snapshot = {};
  for (const name of ['config.js', 'defaults/pref/config-prefs.js']) {
    const p = path.join(greDir, ...name.split('/'));
    snapshot[p] = fs.existsSync(p) ? fs.readFileSync(p) : null;
  }
  return snapshot;
}

/** Restore (or remove) GreD files after the test run. */
function restoreGreConfig(snapshot) {
  const errors = [];
  for (const [p, data] of Object.entries(snapshot)) {
    try {
      if (data !== null) {
        fs.mkdirSync(path.dirname(p), {recursive: true});
        fs.writeFileSync(p, data);
      } else {
        try {
          fs.unlinkSync(p);
        } catch (err) {
          if (err.code !== 'ENOENT') throw err;
        }
        // Clean up empty defaults/pref dir if we created it
        const dir = path.dirname(p);
        try {
          const files = fs.readdirSync(dir);
          if (files.length === 0) fs.rmdirSync(dir);
        } catch (err) {
          if (err.code !== 'ENOENT' && err.code !== 'ENOTEMPTY') throw err;
        }
      }
    } catch (err) {
      errors.push(`${p}: ${err.message}`);
    }
  }
  return errors;
}

/**
 * Replicate the updater's runtime hash (scriptsUpdater.computeFilesHash):
 * sha256 over rel_path + '\n' + file_bytes for every file in the manifest's
 * file list, sorted with localeCompare. Used to assert that an install actually
 * restored the installed tree to the manifest state (issue #37).
 */
function computeInstalledHash(files, dir) {
  const hash = createHash('sha256');
  for (const relative of [...files].sort((a, b) => a.localeCompare(b))) {
    const abs = path.join(dir, ...relative.split('/'));
    // A missing manifest-listed file means the tree does not match. Return a
    // sentinel so callers record a FAIL instead of throwing ENOENT.
    if (!fs.existsSync(abs)) return null;
    hash.update(relative + '\n');
    hash.update(fs.readFileSync(abs));
  }
  return hash.digest('hex');
}

function modifyGreConfig(greDir) {
  const configJs = path.join(greDir, 'config.js');
  if (fs.existsSync(configJs)) {
    let content = fs.readFileSync(configJs, 'utf-8');
    if (!content.includes(FORCE_CONFIG_STALE_MARKER)) {
      content += FORCE_CONFIG_STALE_MARKER;
      fs.writeFileSync(configJs, content);
    }
  }
}

/** Try modifyGreConfig; return null on success, error message on EPERM. */
function tryModifyGreConfig(greDir) {
  try {
    modifyGreConfig(greDir);
    return null;
  } catch (err) {
    if (err.code === 'EPERM' || err.code === 'EACCES') {
      return `GreD not writable (${err.code}) — run with admin or use a writable Firefox install`;
    }
    throw err;
  }
}

// ── Scenario runners ───────────────────────────────────────────────────────

/**
 * Launch Firefox with a seeded profile, wait for the updater tab, run generic
 * action assertions (identity, buttons, checkbox, errors, screenshot).
 */

/** Log the update URLs baked into the snapshot's generated updater config. */

function logBakedConfig(snapshotDir) {
  const staging = tempDir('fxs-cfg');
  try {
    const utilsZip = findZip(snapshotDir, ['utils-dev.zip', 'utils.zip']);
    if (!utilsZip) return;
    extractZip(utilsZip, staging);
    const cfgPath = path.join(staging, 'updater', 'updater-config.sys.mjs');
    if (!fs.existsSync(cfgPath)) {
      console.log('  [diag] updater-config.sys.mjs not found in utils zip');
      return;
    }
    for (const line of fs.readFileSync(cfgPath, 'utf-8').split('\n')) {
      if (/HASHES_URL|ZIP_BASE_URL|UI_BASE_URL|LOCAL_DIST_PATH|ASSET_SUFFIX/.test(line)) {
        console.log(`  [diag] baked config: ${line.trim()}`);
      }
    }
  } catch (err) {
    console.log(`  [diag] could not read baked config: ${err.message}`);
  } finally {
    rmDir(staging);
  }
}

/** Dump every open tab URL — used when the updater tab never appeared. */
async function dumpPages(browser) {
  try {
    const pages = await browser.pages();
    console.log('  [diag] open pages at timeout:');
    for (const p of pages) console.log(`    ${p.url() || '(untitled)'}`);
  } catch (err) {
    console.log(`  [diag] could not list pages: ${err.message}`);
  }
}

/**
 * Post-mortem: which extensions.firefox-scripts prefs did the browser persist?
 * A lastUpdateTabShown=today pref proves the scheduler ran and TRIED to show
 * the tab; an empty dump means the autoconfig/loader never ran at all.
 */
function dumpUpdaterPrefs(profileDir) {
  try {
    const prefs = fs.readFileSync(path.join(profileDir, 'prefs.js'), 'utf-8');
    const hits = prefs
      .split('\n')
      .filter(line => line.includes('extensions.firefox-scripts'))
      .map(line => line.trim());
    if (hits.length === 0) {
      console.log('  [diag] no firefox-scripts prefs persisted (loader never ran?)');
    } else {
      for (const line of hits) console.log(`  [diag] pref ${line}`);
    }
  } catch (err) {
    console.log(`  [diag] prefs.js unreadable: ${err.message}`);
  }
}

/** Append the diagnostic probe to the seeded GreD config.js. */
function appendConfigProbe(greDir) {
  try {
    fs.appendFileSync(path.join(greDir, 'config.js'), CONFIG_PROBE_SNIPPET);
    return true;
  } catch (err) {
    console.log(`  [diag] could not append config probe: ${err.message}`);
    return false;
  }
}

/** Tail the console mirror written by the config probe. */
function dumpConsoleLog(profileDir) {
  try {
    const lines = fs
      .readFileSync(path.join(profileDir, 'e2e-console.log'), 'utf-8')
      .trimEnd()
      .split('\n');
    console.log(`  [diag] console mirror: ${lines.length} lines, last 25:`);
    for (const line of lines.slice(-25)) console.log(`  [diag:c] ${line}`);
  } catch {
    console.log('  [diag] console mirror: no e2e-console.log written');
  }
}

/** True when the probe's mirror log contains the given marker. */
function mirrorHasMarker(profileDir, marker) {
  try {
    return fs.readFileSync(path.join(profileDir, 'e2e-console.log'), 'utf-8').includes(marker);
  } catch {
    return false;
  }
}

/** True when the probe's watcher has recorded TAB_OPENED in the mirror log. */
function mirrorSaysTabOpened(profileDir) {
  return mirrorHasMarker(profileDir, 'TAB_OPENED');
}

/**
 * Resolve once BiDi reports at least one open page — the main browser window is
 * up, so the scheduler (which needs the window) has made its decision.
 */
async function waitForFirstPage(browser, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await browser.pages()).length > 0) return true;
    } catch {
      /* browser not ready yet */
    }
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}

/**
 * True when prefs.js records lastUpdateTabShown = today — the scheduler writes
 * it immediately before addTrustedTab, so it proves the tab was opened even
 * when WebDriver BiDi cannot enumerate trusted chrome:// tabs.
 */
function greShownToday(profileDir) {
  try {
    const prefs = fs.readFileSync(path.join(profileDir, 'prefs.js'), 'utf-8');
    const match = prefs.match(
      /user_pref\("extensions\.firefox-scripts\.lastUpdateTabShown", "([^"]*)"\)/
    );
    return match?.[1] === new Date().toISOString().slice(0, 10);
  } catch {
    return false;
  }
}

async function runStaleScenario(
  counter,
  opts,
  snapshotDir,
  label,
  {forceConfigStale, forceUtilsStale, skipUtils, skipConfig}
) {
  console.log(`\n## Scenario: ${label}`);
  const firefoxBin = opts.firefox || discoverFirefoxBinary();
  if (!firefoxBin) throw new Error('Firefox not found');

  const seeded = seedProfile(snapshotDir, {
    forceConfigStale,
    forceUtilsStale,
    skipUtils,
    skipConfig,
  });

  // GreD install — a silent seed failure means the loader never runs and every
  // later assertion misfires, so report it as its own failed check and stop.
  const greDir = findGreDir(firefoxBin);
  const greSeed = installFxFolder(snapshotDir, greDir);
  check(counter, greSeed.ok, `seed GreD (${label})`, greSeed.error);
  if (!greSeed.ok) return seeded.profileDir;
  if (seeded._greModNeeded) {
    const err = tryModifyGreConfig(greDir);
    if (err) {
      check(counter, false, `mark config stale (${label})`, err);
      return seeded.profileDir;
    }
  }

  appendConfigProbe(greDir);

  let browser;
  let openedPage = null;
  try {
    browser = await launchFirefox(firefoxBin, seeded.profileDir, {
      headless: opts.headless,
      extraPrefsFirefox: seeded.prefs,
    });
    attachProcessLogging(browser, label);

    // Wait on both channels: BiDi page enumeration (needed for UI assertions)
    // and the probe's TAB_OPENED mirror line (fast, BiDi-independent). When
    // only the mirror fires, close early and let the finally block decide via
    // the persisted lastUpdateTabShown pref instead of burning the full window.
    // The scheduler runs at startup: if the tab has not opened in ~15 s it
    // will not open at all. The mirror-line + pref fast paths still fire
    // early, so a working scenario returns in a couple of seconds.
    const deadline = Date.now() + 15_000;
    let sawMirrorLine = false;
    let page = null;
    while (Date.now() < deadline && !page && !sawMirrorLine) {
      try {
        page =
          (await browser.pages()).find(p => {
            try {
              return p.url().startsWith(UPDATER_URL);
            } catch {
              return false;
            }
          }) || null;
      } catch {
        /* browser not ready yet */
      }
      if (!page && mirrorSaysTabOpened(seeded.profileDir)) {
        sawMirrorLine = true;
        break;
      }
      if (!page) await new Promise(r => setTimeout(r, 500));
    }
    openedPage = page;
    if (page) check(counter, true, `tab opens (${label})`);

    if (!page && sawMirrorLine) {
      console.log('  [diag] probe reported the tab open; closing early');
      return seeded.profileDir;
    }

    if (!page) {
      await dumpPages(browser);
      return seeded.profileDir;
    }

    console.log(`  tab URL: ${page.url()}`);

    // Collect errors
    const pageErrors = [];
    page.on('pageerror', err => pageErrors.push(err.message));

    // Wait for card to render
    const rendered = await waitForCondition(
      page,
      () => {
        const title = document.getElementById('card-title');
        return Boolean(title && title.textContent);
      },
      15_000,
      'card rendered'
    );
    check(counter, rendered, `card rendered (${label})`);

    if (!rendered) return seeded.profileDir;

    // ── Identity ──
    const identity = await page.evaluate(() => ({
      title: document.getElementById('card-title')?.textContent || '',
      version: document.getElementById('card-version')?.textContent || '',
      binary: document.getElementById('binary-path')?.textContent || '',
      profile: document.getElementById('profile-path')?.textContent || '',
    }));
    check(counter, identity.title.length > 0, `browser name shown: ${identity.title}`);
    check(counter, identity.binary.length > 0, 'binary path shown');
    check(counter, identity.profile.length > 0, 'profile path shown');

    // ── Package status ──
    const utilsStatus = await page.evaluate(() => ({
      update: !document.getElementById('utils-badge-update')?.hidden,
      ok: !document.getElementById('utils-badge-ok')?.hidden,
    }));
    const configStatus = await page.evaluate(() => ({
      update: !document.getElementById('config-badge-update')?.hidden,
      ok: !document.getElementById('config-badge-ok')?.hidden,
    }));

    if (forceUtilsStale) {
      check(
        counter,
        utilsStatus.update && !utilsStatus.ok,
        `utils shows Update Available (${label})`
      );
    }
    check(
      counter,
      configStatus.update !== configStatus.ok,
      `config shows exactly one badge (${label})`
    );
    if (forceConfigStale) {
      check(counter, configStatus.update, 'config shows Update Available');
    }

    // ── Buttons ──
    const buttons = await page.evaluate(() =>
      [
        'btn-install',
        'btn-restart',
        'btn-close',
        'btn-remind-tomorrow',
        'link-download-fx',
        'link-download-utils',
        'btn-open-folder-binary',
        'btn-open-folder-profile',
      ].map(id => Boolean(document.getElementById(id)))
    );
    check(counter, buttons.every(Boolean), 'all 8 buttons present');

    // ── Checkbox → Update button wiring ──
    const cbWired = await page.evaluate(async () => {
      // Only visible checkboxes can be clicked by the user — under Snap the
      // hidden config checkbox must not drive the Update button.
      const chks = document.querySelectorAll('.chk-component:not([hidden])');
      if (chks.length === 0) return null;
      const btn = document.getElementById('btn-install');
      if (!btn) return null;
      const first = chks[0];
      first.click();
      const enabled = btn.disabled === false;
      first.click();
      const disabled = btn.disabled === true;
      return {enabled, disabled};
    });
    check(counter, cbWired?.enabled && cbWired?.disabled, 'checkbox toggles Update button');

    // ── Skip checkbox visible for stale packages ──
    const skipLabels = await page.evaluate(() => ({
      config: !document.getElementById('skip-config')?.hidden,
      utils: !document.getElementById('skip-utils')?.hidden,
    }));
    if (forceUtilsStale) check(counter, skipLabels.utils, 'skip checkbox shown for utils');
    if (forceConfigStale) check(counter, skipLabels.config, 'skip checkbox shown for config');

    // ── No page errors ──
    check(counter, pageErrors.length === 0, 'no page errors', pageErrors.slice(0, 3).join(' | '));

    // ── Screenshot ──
    const shotPath = path.join(REPO_ROOT, 'dist', `updater-e2e-${label.replace(/\s+/g, '_')}.png`);
    fs.mkdirSync(path.dirname(shotPath), {recursive: true});
    const shotOk = await screenshotPrivileged(page, shotPath);
    if (shotOk) check(counter, true, `screenshot saved (${label})`);

    return seeded.profileDir;
  } finally {
    try {
      await browser?.close();
    } catch {
      /* ignore */
    }
    if (!openedPage) {
      const viaPref = greShownToday(seeded.profileDir);
      check(
        counter,
        viaPref,
        `tab opens (${label})`,
        viaPref ?
          '(verified via lastUpdateTabShown; BiDi could not enumerate the chrome tab)'
        : 'scheduler never reached addTrustedTab'
      );
      dumpUpdaterPrefs(seeded.profileDir);
      dumpConsoleLog(seeded.profileDir);
    }
  }
}

/**
 * Launch Firefox with both packages up to date (or skipped), assert the updater
 * tab does NOT open within the timeout.
 */
async function runNoTabScenario(
  counter,
  opts,
  snapshotDir,
  label,
  {skipUtils, skipConfig, forceUtilsStale = false}
) {
  console.log(`\n## Scenario: ${label}`);
  const firefoxBin = opts.firefox || discoverFirefoxBinary();
  if (!firefoxBin) throw new Error('Firefox not found');

  const seeded = seedProfile(snapshotDir, {
    forceConfigStale: false,
    forceUtilsStale,
    skipUtils,
    skipConfig,
  });

  const greDir = findGreDir(firefoxBin);
  const greSeed = installFxFolder(snapshotDir, greDir);
  check(counter, greSeed.ok, `seed GreD (${label})`, greSeed.error);
  if (!greSeed.ok) return seeded.profileDir;

  let browser;
  try {
    browser = await launchFirefox(firefoxBin, seeded.profileDir, {
      headless: opts.headless,
      extraPrefsFirefox: seeded.prefs,
    });
    attachProcessLogging(browser, label);
    // No-tab scenarios assert absence. The scheduler runs at startup and
    // decides within a couple of seconds of the window being up (manifest
    // fetch + hash). Wait for the main window via BiDi page enumeration,
    // allow a short margin for the async check to complete, then assert the
    // tab never appeared. No blind fixed wait. (The GreD config probe cannot
    // be used here: it changes config.js, which breaks the fx-folder hash and
    // makes the scheduler open the tab.)
    const browserReady = await waitForFirstPage(browser, 15_000);
    check(counter, browserReady, `browser ready (${label})`, 'BiDi did not report an open page');
    if (!browserReady) return seeded.profileDir;
    await new Promise(r => setTimeout(r, 3_000));
    const page = await findPageByUrl(browser, UPDATER_URL, 2_000);
    // The tab opened when it should not — say WHICH package the scheduler
    // thinks is stale so a misfire (e.g. the snap leg's fx-folder GreD) is
    // attributable instead of a bare assertion failure.
    let tabDiag = '';
    if (page) {
      tabDiag = await page
        .evaluate(() => {
          const vis = id =>
            Boolean(document.getElementById(id)) && !document.getElementById(id).hidden;
          return [
            vis('utils-badge-update') ? 'utils=update' : null,
            vis('utils-badge-ok') ? 'utils=ok' : null,
            vis('config-badge-update') ? 'config=update' : null,
            vis('config-badge-ok') ? 'config=ok' : null,
            `binary=${document.getElementById('binary-path')?.textContent || '?'}`,
            `profile=${document.getElementById('profile-path')?.textContent || '?'}`,
          ]
            .filter(Boolean)
            .join(' | ');
        })
        .catch(() => 'could not read the updater tab DOM');
    }
    check(counter, !page, `tab does NOT open (${label})`, tabDiag || '');
    return seeded.profileDir;
  } finally {
    try {
      await browser?.close();
    } catch {
      /* ignore */
    }
    // BiDi cannot reliably enumerate trusted chrome:// tabs; the persisted
    // lastUpdateTabShown pref is the ground truth that the tab did NOT open.
    const shown = greShownToday(seeded.profileDir);
    check(
      counter,
      !shown,
      `no tab-open signal (${label})`,
      shown ? 'lastUpdateTabShown persisted although the tab should stay closed' : ''
    );
  }
}

/**
 * Issue #37 — "install applies": with utils stale (forced marker) and config
 * stale (the GreD probe changes config.js), click btn-install in the tab and
 * assert the packages are ACTUALLY copied to disk — both installed trees
 * re-hash to the manifest and the forced-stale marker / probe are gone.
 *
 * Pre-install sanity: the seeded trees must NOT match the manifest hashes,
 * otherwise the equality assertions below would pass vacuously.
 */
async function runInstallAppliesScenario(counter, opts, snapshotDir, label) {
  console.log(`\n## Scenario: ${label}`);
  const firefoxBin = opts.firefox || discoverFirefoxBinary();
  if (!firefoxBin) throw new Error('Firefox not found');
  // Snap (strict confinement): the config package lives in /etc/firefox and
  // the confined browser can never write it, so the UI hides the config
  // checkbox and shows the manual-install band — Update installs utils only.
  const isSnap = firefoxBin.includes('/snap/');

  const seeded = seedProfile(snapshotDir, {forceUtilsStale: true});

  const manifest = JSON.parse(fs.readFileSync(path.join(snapshotDir, 'hashes.json'), 'utf-8'));
  const utilsHash = manifest.utils?.hash;
  const utilsFiles = manifest.utils?.files;
  const configHash = manifest['fx-folder']?.hash;
  const configFiles = manifest['fx-folder']?.files;
  if (!utilsHash || !Array.isArray(utilsFiles) || !configHash || !Array.isArray(configFiles)) {
    check(counter, false, `manifest has both package hashes+files (${label})`);
    return seeded.profileDir;
  }

  const greDir = findGreDir(firefoxBin);
  const greSeed = installFxFolder(snapshotDir, greDir);
  check(counter, greSeed.ok, `seed GreD (${label})`, greSeed.error);
  if (!greSeed.ok) return seeded.profileDir;

  // The probe changes GreD config.js, forcing config stale. It is appended
  // before the sanity checks so both packages start mismatched.
  check(counter, appendConfigProbe(greDir), `config probe appended (${label})`);
  check(
    counter,
    computeInstalledHash(utilsFiles, seeded.chromeUtils) !== utilsHash,
    `pre-install utils hash differs from manifest (${label})`
  );
  check(
    counter,
    computeInstalledHash(configFiles, greDir) !== configHash,
    `pre-install config hash differs from manifest (${label})`
  );

  let browser;
  let page = null;
  try {
    browser = await launchFirefox(firefoxBin, seeded.profileDir, {
      headless: opts.headless,
      extraPrefsFirefox: seeded.prefs,
    });
    attachProcessLogging(browser, label);

    // Like runStaleScenario: BiDi cannot reliably enumerate trusted chrome://
    // tabs on CI, so ALSO watch the probe's TAB_OPENED mirror line. If the
    // mirror fires but BiDi never surfaces the page, the finally block falls
    // back to the persisted lastUpdateTabShown pref. The wait is longer than
    // the other scenarios because it runs last on a cold runner.
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !page) {
      try {
        page =
          (await browser.pages()).find(p => {
            try {
              return p.url().startsWith(UPDATER_URL);
            } catch {
              return false;
            }
          }) || null;
      } catch {
        /* browser not ready yet */
      }
      if (!page && mirrorSaysTabOpened(seeded.profileDir)) {
        // The tab is open; keep polling BiDi a little longer — it may
        // enumerate the chrome tab late.
        await new Promise(r => setTimeout(r, 2_000));
      }
      if (!page) await new Promise(r => setTimeout(r, 500));
    }
    if (page) check(counter, true, `tab opens (${label})`);
    if (!page) {
      await dumpPages(browser);
      return seeded.profileDir;
    }

    const rendered = await waitForCondition(
      page,
      () => Boolean(document.getElementById('card-title')?.textContent),
      15_000,
      'card rendered'
    );
    check(counter, rendered, `card rendered (${label})`);
    if (!rendered) return seeded.profileDir;

    // The install flow differs by packaging: normally both stale packages
    // install in-tab (config first, then utils, badges flip as each lands);
    // under Snap the config checkbox is hidden and Update installs utils only.
    if (isSnap) {
      // Snap: config never offered in-tab — its checkbox is hidden and the
      // amber manual band explains the manual paths instead.
      const cfg = await page.evaluate(() => {
        const chk = document.getElementById('chk-config');
        const band = document.getElementById('config-manual');
        const chkUtils = document.getElementById('chk-utils');
        return {
          configCheckboxHidden: chk ? chk.hidden : null,
          bandShown: band ? !band.hidden : false,
          utilsCheckbox: Boolean(chkUtils),
        };
      });
      check(counter, cfg.configCheckboxHidden === true, `config checkbox hidden (snap, ${label})`);
      check(counter, cfg.bandShown, `manual guidance band shown (snap, ${label})`);
      check(counter, cfg.utilsCheckbox, `utils checkbox present (snap, ${label})`);

      const clicked = await page.evaluate(() => {
        const cb = document.getElementById('chk-utils');
        const btn = document.getElementById('btn-install');
        if (!cb || !btn) return false;
        // The Update button is disabled until a checkbox is checked — tick
        // utils first, then click once the button enables.
        if (!cb.checked) cb.click();
        if (btn.disabled) return false;
        btn.click();
        return true;
      });
      check(counter, clicked, `install clicked (utils only, ${label})`);

      // Completion: utils badge flipped to OK and the progress bar hidden.
      const completed = await waitForCondition(
        page,
        () => {
          const utilsOk = document.getElementById('utils-badge-ok');
          const utilsUpd = document.getElementById('utils-badge-update');
          const progress = document.getElementById('card-progress');
          const err = document.getElementById('card-progress-error');
          return Boolean(
            utilsOk &&
            !utilsOk.hidden &&
            utilsUpd &&
            utilsUpd.hidden &&
            progress?.hidden &&
            err?.style.display === 'none'
          );
        },
        60_000,
        'utils install completed'
      );
      check(counter, completed, `utils install completes in tab (${label})`);
      if (!completed) {
        // Diagnostic: capture the tab's error banner + badge DOM and the
        // console mirror so an in-tab install failure is identifiable from CI
        // logs alone.
        const dom = await page
          .evaluate(() => {
            const prog = document.getElementById('card-progress');
            const err = document.getElementById('card-progress-error');
            const utilsOk = document.getElementById('utils-badge-ok');
            const utilsUpd = document.getElementById('utils-badge-update');
            return {
              progress: prog?.textContent?.trim() ?? null,
              progressError: err?.textContent?.trim() ?? null,
              progressHidden: prog ? prog.hidden : null,
              errorDisplay: err?.style?.display ?? null,
              utilsOk: Boolean(utilsOk && !utilsOk.hidden),
              utilsUpdate: Boolean(utilsUpd && !utilsUpd.hidden),
            };
          })
          .catch(() => null);
        console.log(`  [diag:install-applies] tab at completion timeout: ${JSON.stringify(dom)}`);
        const shotPath = path.join(
          REPO_ROOT,
          'dist',
          `updater-e2e-${label.replace(/\s+/g, '_')}.png`
        );
        await screenshotPrivileged(page, shotPath).catch(() => {});
        dumpConsoleLog(seeded.profileDir);
      }

      // Config stays stale + manual under Snap — nothing was attempted in-tab
      // and the all-good banner must NOT show while config is still pending.
      const configManualStill = await page
        .evaluate(() => {
          const upd = document.getElementById('config-badge-update');
          const ok = document.getElementById('config-badge-ok');
          const band = document.getElementById('config-manual');
          const chk = document.getElementById('chk-config');
          const banner = document.getElementById('success-banner');
          return {
            stillManual: Boolean(
              upd && !upd.hidden && ok && ok.hidden && band && !band.hidden && chk && chk.hidden
            ),
            successBannerHidden: banner ? banner.hidden : null,
          };
        })
        .catch(() => ({}));
      check(
        counter,
        configManualStill.stillManual === true,
        `config still manual after install (${label})`
      );
      check(
        counter,
        configManualStill.successBannerHidden !== false,
        `success banner hidden while config pending (${label})`
      );
    } else {
      // Standard install: check BOTH checkboxes (utils + config stale), then
      // click install. handleInstallCommand installs config first, then utils,
      // and refreshPackageState flips each badge to OK as it finishes.
      const clicked = await page.evaluate(() => {
        const btn = document.getElementById('btn-install');
        if (!btn) return false;
        for (const kind of ['chk-config', 'chk-utils']) {
          const cb = document.getElementById(kind);
          if (!cb) return false;
          if (!cb.checked) cb.click();
        }
        btn.click();
        return true;
      });
      check(counter, clicked, `install clicked (${label})`);

      // Completion: both badges flipped to OK and the progress bar hidden once
      // the whole flow finishes. Local file:// downloads take a couple of
      // seconds per package, so allow a generous margin.
      const completed = await waitForCondition(
        page,
        () => {
          const utilsOk = document.getElementById('utils-badge-ok');
          const configOk = document.getElementById('config-badge-ok');
          const progress = document.getElementById('card-progress');
          const err = document.getElementById('card-progress-error');
          return Boolean(
            utilsOk &&
            !utilsOk.hidden &&
            configOk &&
            !configOk.hidden &&
            progress?.hidden &&
            err?.style.display === 'none'
          );
        },
        60_000,
        'install completed'
      );
      check(counter, completed, `install completes in tab (${label})`);
      if (!completed) {
        // Diagnostic: capture the tab's error banner + badge DOM and the
        // console mirror so an in-tab install failure is identifiable from CI
        // logs alone.
        const dom = await page
          .evaluate(() => {
            const prog = document.getElementById('card-progress');
            const err = document.getElementById('card-progress-error');
            const utilsOk = document.getElementById('utils-badge-ok');
            const configOk = document.getElementById('config-badge-ok');
            return {
              progress: prog?.textContent?.trim() ?? null,
              progressError: err?.textContent?.trim() ?? null,
              progressHidden: prog ? prog.hidden : null,
              errorDisplay: err?.style?.display ?? null,
              utilsOk: Boolean(utilsOk && !utilsOk.hidden),
              configOk: Boolean(configOk && !configOk.hidden),
            };
          })
          .catch(() => null);
        console.log(`  [diag:install-applies] tab at completion timeout: ${JSON.stringify(dom)}`);
        const shotPath = path.join(
          REPO_ROOT,
          'dist',
          `updater-e2e-${label.replace(/\s+/g, '_')}.png`
        );
        await screenshotPrivileged(page, shotPath).catch(() => {});
        dumpConsoleLog(seeded.profileDir);
      }

      const successShown = await page
        .evaluate(() => !document.getElementById('success-banner')?.hidden)
        .catch(() => false);
      check(counter, successShown, `success banner shown after install (${label})`);
    }
  } finally {
    try {
      await browser?.close();
    } catch {
      /* ignore */
    }
    if (!page) {
      const viaPref = greShownToday(seeded.profileDir);
      check(
        counter,
        viaPref,
        `tab opens (${label})`,
        viaPref ?
          '(verified via lastUpdateTabShown; BiDi could not enumerate the chrome tab)'
        : 'scheduler never reached addTrustedTab'
      );
      dumpUpdaterPrefs(seeded.profileDir);
      dumpConsoleLog(seeded.profileDir);
    }
  }

  // ── On-disk assertions (node side) ──
  const staleFile = path.join(seeded.chromeUtils, FORCE_UTILS_STALE);
  check(
    counter,
    fs.existsSync(staleFile) &&
      !fs.readFileSync(staleFile, 'utf-8').includes(FORCE_UTILS_STALE_MARKER),
    `stale marker replaced by install (${label})`
  );
  check(
    counter,
    computeInstalledHash(utilsFiles, seeded.chromeUtils) === utilsHash,
    `installed utils re-hashes to the manifest (${label})`
  );
  const greConfig = path.join(greDir, 'config.js');
  if (isSnap) {
    // Config untouched: the tab only offered the manual band under Snap, so
    // the probe stays and the dir still differs from the manifest.
    check(
      counter,
      fs.existsSync(greConfig) && fs.readFileSync(greConfig, 'utf-8').includes('e2e-test probe'),
      `config probe NOT replaced (snap manual, ${label})`
    );
    check(
      counter,
      computeInstalledHash(configFiles, greDir) !== configHash,
      `config dir still differs from the manifest (snap manual, ${label})`
    );
  } else {
    check(
      counter,
      fs.existsSync(greConfig) && !fs.readFileSync(greConfig, 'utf-8').includes('e2e-test probe'),
      `config probe replaced by install (${label})`
    );
    check(
      counter,
      computeInstalledHash(configFiles, greDir) === configHash,
      `installed config re-hashes to the manifest (${label})`
    );
  }

  return seeded.profileDir;
}

/**
 * Issue #53 — "manual install": a user who installs utils.zip by hand (no
 * installer) must get a working updater with no extra step. Phase 1 launches
 * with an OLD utils.zip (no updater/ dir, no firefox-scripts chrome mapping)
 * and asserts no updater tab and no daily-gate prefs. Phase 2 replaces
 * utils.zip manually with the real one, forces utils stale, and asserts the
 * updater ACTIVATES on the next launch (tab opens, lastUpdateTabShown set).
 */
async function runManualInstallScenario(counter, opts, snapshotDir, label) {
  console.log(`\n## Scenario: ${label}`);
  const firefoxBin = opts.firefox || discoverFirefoxBinary();
  if (!firefoxBin) throw new Error('Firefox not found');

  const seeded = seedProfile(snapshotDir, {});

  // Simulate a pre-updater utils.zip: strip the updater module AND its
  // chrome://firefox-scripts mapping. userChrome.js/BootstrapLoader warn and
  // continue when scriptsUpdater.sys.mjs is unavailable.
  const chromeManifest = path.join(seeded.chromeUtils, 'chrome.manifest');
  if (fs.existsSync(chromeManifest)) {
    const lines = fs
      .readFileSync(chromeManifest, 'utf-8')
      .split('\n')
      .filter(l => !l.includes('firefox-scripts'));
    fs.writeFileSync(chromeManifest, lines.join('\n'));
  }
  fs.rmSync(path.join(seeded.chromeUtils, 'updater'), {recursive: true, force: true});

  const greDir = findGreDir(firefoxBin);
  const greSeed = installFxFolder(snapshotDir, greDir);
  check(counter, greSeed.ok, `seed GreD (${label})`, greSeed.error);
  if (!greSeed.ok) return seeded.profileDir;
  appendConfigProbe(greDir);

  // ── Phase 1: old utils → no updater ──
  let browser;
  try {
    browser = await launchFirefox(firefoxBin, seeded.profileDir, {
      headless: opts.headless,
      extraPrefsFirefox: seeded.prefs,
    });
    attachProcessLogging(browser, label);
    const browserReady = await waitForFirstPage(browser, 15_000);
    check(counter, browserReady, `old-utils browser ready (${label})`);
    if (browserReady) {
      await new Promise(r => setTimeout(r, 3_000));
      const page = await findPageByUrl(browser, UPDATER_URL, 2_000);
      check(counter, !page, `no updater tab with old utils (${label})`);
    }
  } finally {
    try {
      await browser?.close();
    } catch {
      /* ignore */
    }
  }
  // The scheduler's ensureUpdaterUi extracts updater-ui.zip into
  // chrome/utils/updater/ui — with the old utils (no updater) it never runs,
  // so the ui dir cannot exist.
  const uiDir = path.join(seeded.chromeUtils, 'updater', 'ui');
  check(
    counter,
    !fs.existsSync(path.join(uiDir, 'updater.html')),
    `no updater-ui with old utils (${label})`
  );
  // Let the old process fully release the profile lock before relaunching on
  // the SAME profile (unlike the other scenarios, phase 2 reuses this dir).
  await new Promise(r => setTimeout(r, 2_000));

  // ── Phase 2: manually replace utils.zip with the real one → updater appears ──
  const utilsZip = findZip(snapshotDir, ['utils-dev.zip', 'utils.zip']);
  if (!utilsZip) {
    check(counter, false, `utils zip available (${label})`);
    return seeded.profileDir;
  }
  extractZip(utilsZip, seeded.chromeUtils); // overwrite: restores updater/ + mapping
  const stale = path.join(seeded.chromeUtils, FORCE_UTILS_STALE);
  fs.appendFileSync(stale, FORCE_UTILS_STALE_MARKER);

  let page = null;
  try {
    browser = await launchFirefox(firefoxBin, seeded.profileDir, {
      headless: opts.headless,
      extraPrefsFirefox: seeded.prefs,
    });
    attachProcessLogging(browser, label);
    const browserReady = await waitForFirstPage(browser, 20_000);
    check(counter, browserReady, `upgraded-utils browser ready (${label})`);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !page) {
      try {
        page =
          (await browser.pages()).find(p => {
            try {
              return p.url().startsWith(UPDATER_URL);
            } catch {
              return false;
            }
          }) || null;
      } catch {
        /* browser not ready yet */
      }
      if (!page && mirrorSaysTabOpened(seeded.profileDir)) {
        await new Promise(r => setTimeout(r, 2_000));
      }
      if (!page) await new Promise(r => setTimeout(r, 500));
    }
    // BiDi cannot always enumerate the chrome tab on a relaunched profile; the
    // activation proof is the ui-dir check after close (see below).
    if (page) {
      const rendered = await waitForCondition(
        page,
        () => Boolean(document.getElementById('card-title')?.textContent),
        15_000,
        'card rendered'
      );
      check(counter, rendered, `card rendered after upgrade (${label})`);
    }
  } finally {
    try {
      await browser?.close();
    } catch {
      /* ignore */
    }
  }
  // Updater ACTIVATED: ensureUpdaterUi ran (extracting updater-ui) and the
  // scheduler opened the tab. The ui-dir check is flush/BiDi-independent — a
  // tab can be missed by BiDi and a pref can be lost on a killed close, but
  // the extracted ui files persist on disk. The tab-open check passes via the
  // disk signal when BiDi missed the chrome tab on the relaunch.
  const uiExtracted = fs.existsSync(path.join(uiDir, 'updater.html'));
  check(
    counter,
    Boolean(page) || uiExtracted,
    `updater tab opens after manual utils.zip replace (${label})`,
    uiExtracted && !page ?
      '(activation proven by extracted updater-ui; BiDi missed the chrome tab)'
    : ''
  );
  check(counter, uiExtracted, `updater activated — updater-ui extracted (${label})`);

  return seeded.profileDir;
}

/**
 * Issue #102 — "manual install without the ui": utils.zip (release page) does
 * NOT contain the updater ui folder — the tab UI ships in the separate
 * updater-ui.zip and the scheduler (ensureUpdaterUi) must download + install it
 * on the first check. A user who manually installs utils.zip only must still
 * get a fully working updater: ui files appear under chrome/utils/updater/ui
 * and the updater tab is visible.
 *
 * The prod release topology is reproduced faithfully: HASHES_URL points at the
 * manifest host (Pages-equivalent — the snapshot dir, which always ships
 * updater-ui.zip next to hashes.json) while ZIP_BASE_URL points at a local
 * "release dir" that mirrors the GitHub 'latest' release — utils.zip +
 * fx-folder.zip but NO updater-ui.zip (publish keeps it Pages-only,
 * upload.mjs). Before the fix the ui download came from ZIP_BASE_URL (the
 * release) and 404'd silently; after it the ui comes from the manifest's own
 * host, which always has it.
 *
 * Steps: install utils.zip manually (no ui folder exists — asserted) → modify a
 * utils file (comment appended → utils stale) → start Firefox → assert the ui
 * folder was auto-downloaded + installed and the ui tab opened.
 */

/**
 * Build a directory that mirrors the GitHub 'latest' release layout: the
 * package zips and the hash manifest, but no updater-ui zip (never a release
 * asset). Returns the dir path.
 */
function buildReleaseLayout(snapshotDir) {
  const releaseDir = tempDir('fxs-release');
  for (const name of ['utils-dev.zip', 'utils.zip', 'fx-folder-dev.zip', 'fx-folder.zip']) {
    const src = path.join(snapshotDir, name);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(releaseDir, name));
  }
  fs.copyFileSync(path.join(snapshotDir, 'hashes.json'), path.join(releaseDir, 'hashes.json'));
  // Sanity: the layout must NOT contain the updater-ui zip — that is the
  // released state this scenario exercises (a ui zip here would fake a fix).
  for (const name of ['updater-ui.zip', 'updater-ui-dev.zip']) {
    if (fs.existsSync(path.join(releaseDir, name))) {
      throw new Error(`release layout must not contain ${name}`);
    }
  }
  return releaseDir;
}

async function runManualInstallNoUiScenario(counter, opts, snapshotDir, label) {
  console.log(`\n## Scenario: ${label}`);
  const firefoxBin = opts.firefox || discoverFirefoxBinary();
  if (!firefoxBin) throw new Error('Firefox not found');

  const seeded = seedProfile(snapshotDir, {});

  // utils.zip contains no ui folder: the tab UI is a separate package
  // (updater-ui.zip) installed under updater/ui by ensureUpdaterUi.
  const uiDir = path.join(seeded.chromeUtils, 'updater', 'ui');
  check(
    counter,
    !fs.existsSync(path.join(uiDir, 'updater.html')),
    `utils.zip ships without the ui folder (${label})`
  );

  // Release topology: ZIP_BASE_URL (zips) points at a dir with NO
  // updater-ui.zip — the released state this scenario must catch. The ui zip
  // comes from the manifest's own host (generated CONFIG.UI_BASE_URL, or the
  // cross-OS snapshot override in localConfigOverrides): that host always
  // ships updater-ui.zip next to hashes.json.  A pre-fix scheduler fetched it
  // from ZIP_BASE_URL (the release) and 404'd silently — exactly what this
  // scenario fails on.
  const releaseDir = buildReleaseLayout(snapshotDir);
  const base = pathToFileURL(releaseDir).href.replace(/\/$/, '');
  Object.assign(seeded.prefs, {
    'extensions.firefox-scripts.override.ZIP_BASE_URL': base,
    'extensions.firefox-scripts.override.HELPER_BASE_URL': base,
  });

  const greDir = findGreDir(firefoxBin);
  const greSeed = installFxFolder(snapshotDir, greDir);
  check(counter, greSeed.ok, `seed GreD (${label})`, greSeed.error);
  if (!greSeed.ok) return seeded.profileDir;
  appendConfigProbe(greDir);

  // The user modified a utils file by hand (adding a comment): utils goes
  // stale, so the daily check finds an update and reaches ensureUpdaterUi.
  const stale = path.join(seeded.chromeUtils, FORCE_UTILS_STALE);
  fs.appendFileSync(stale, FORCE_UTILS_STALE_MARKER);

  let page = null;
  let browser;
  try {
    browser = await launchFirefox(firefoxBin, seeded.profileDir, {
      headless: opts.headless,
      extraPrefsFirefox: seeded.prefs,
    });
    attachProcessLogging(browser, label);
    const browserReady = await waitForFirstPage(browser, 20_000);
    check(counter, browserReady, `browser ready (${label})`);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !page) {
      try {
        page =
          (await browser.pages()).find(p => {
            try {
              return p.url().startsWith(UPDATER_URL);
            } catch {
              return false;
            }
          }) || null;
      } catch {
        /* browser not ready yet */
      }
      if (!page && mirrorSaysTabOpened(seeded.profileDir)) {
        await new Promise(r => setTimeout(r, 2_000));
      }
      if (!page) await new Promise(r => setTimeout(r, 500));
    }
    if (page) {
      check(counter, true, `ui tab is visible (${label})`);
      const rendered = await waitForCondition(
        page,
        () => Boolean(document.getElementById('card-title')?.textContent),
        15_000,
        'card rendered'
      );
      check(counter, rendered, `card rendered (${label})`);
    }
  } finally {
    try {
      await browser?.close();
    } catch {
      /* ignore */
    }
  }

  // ui folder was automatically downloaded and installed (disk proof —
  // survives a BiDi-missed chrome tab; the tab-open check above needs the
  // page handle, here the pref + extracted files carry the assertion).
  const uiExtracted = fs.existsSync(path.join(uiDir, 'updater.html'));
  check(
    counter,
    uiExtracted,
    `ui folder auto-installed (${label})`,
    'ensureUpdaterUi never extracted updater-ui.zip into chrome/utils/updater/ui'
  );
  const viaPref = greShownToday(seeded.profileDir);
  check(
    counter,
    Boolean(page) || viaPref,
    `ui tab opened (${label})`,
    viaPref && !page ? '(verified via lastUpdateTabShown; BiDi missed the chrome tab)' : ''
  );
  if (!page) {
    dumpUpdaterPrefs(seeded.profileDir);
    dumpConsoleLog(seeded.profileDir);
  }

  rmDir(releaseDir);
  return seeded.profileDir;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function run() {
  const opts = parseArgs();
  const counter = createCounter();

  const snapshotDir = opts.snapshot || findSnapshot({branchCheck: false})?.dir;
  if (!snapshotDir) {
    console.error('No snapshot found. Run `pnpm upload:local --mode=dev` first.');
    process.exit(1);
  }
  console.log(`Updater E2E\n  snapshot: ${snapshotDir}`);
  if (!fs.existsSync(path.join(snapshotDir, 'hashes.json'))) {
    console.error(
      `Snapshot ${snapshotDir} has no hashes.json — rebuild it with ` +
        '`pnpm upload:local --mode=dev`.'
    );
    process.exit(1);
  }
  logBakedConfig(snapshotDir);

  const firefoxBin = opts.firefox || discoverFirefoxBinary();
  if (!firefoxBin) {
    console.error('Firefox not found. Set FIREFOX_BINARY or pass --firefox <path>');
    process.exit(1);
  }
  console.log(`  firefox: ${firefoxBin}`);
  console.log(`  GreD:    ${findGreDir(firefoxBin)}`);

  const scenarios = opts.scenarios || ['1', '2', '3', '4', '5', '6', '7', '8'];

  const profiles = [];

  // Save GreD config before we overwrite it (see issue #4)
  const savedGre = saveGreConfig(findGreDir(firefoxBin));

  try {
    // Scenario steps run in order; after the first failure the remaining
    // scenarios almost always fail for the same root cause, so skip them
    // (opt out with --no-fail-fast).

    const scenarioSteps = [
      {
        id: '1',
        run: async () => {
          profiles.push(
            await runStaleScenario(counter, opts, snapshotDir, 'utils-stale', {
              forceUtilsStale: true,
            })
          );
        },
      },
      {
        id: '2',
        pre: () => tryModifyGreConfig(findGreDir(firefoxBin)),
        skipLabel: 'config-stale',
        run: async () => {
          profiles.push(
            await runStaleScenario(counter, opts, snapshotDir, 'config-stale', {
              forceConfigStale: true,
            })
          );
        },
      },
      {
        id: '3',
        pre: () => tryModifyGreConfig(findGreDir(firefoxBin)),
        skipLabel: 'both-stale',
        run: async () => {
          profiles.push(
            await runStaleScenario(counter, opts, snapshotDir, 'both-stale', {
              forceUtilsStale: true,
              forceConfigStale: true,
            })
          );
        },
      },
      {
        id: '4',
        run: async () => {
          profiles.push(
            await runNoTabScenario(counter, opts, snapshotDir, 'up-to-date', {
              skipUtils: false,
              skipConfig: false,
            })
          );
        },
      },
      {
        id: '5',
        run: async () => {
          profiles.push(
            await runNoTabScenario(counter, opts, snapshotDir, 'skipped', {
              skipUtils: true,
              forceUtilsStale: true,
            })
          );
        },
      },
      {
        id: '6',
        run: async () => {
          profiles.push(
            await runInstallAppliesScenario(counter, opts, snapshotDir, 'install-applies')
          );
        },
      },
      {
        id: '7',
        run: async () => {
          profiles.push(
            await runManualInstallScenario(counter, opts, snapshotDir, 'manual-install-upgrade')
          );
        },
      },
      {
        id: '8',
        run: async () => {
          profiles.push(
            await runManualInstallNoUiScenario(counter, opts, snapshotDir, 'manual-install-no-ui')
          );
        },
      },
    ];

    for (const step of scenarioSteps) {
      if (!scenarios.includes(step.id)) continue;
      if ((opts.failFast ?? true) && counter.failed > 0) {
        console.log(`\n  SKIP scenario ${step.id}: fail-fast after earlier failure`);
        continue;
      }
      if (step.pre) {
        const err = step.pre();
        if (err) {
          console.log(`  SKIP ${step.skipLabel}: ${err}`);
          check(counter, true, `${step.skipLabel} skipped (GreD not writable locally)`);
          continue;
        }
      }
      await step.run();
    }
  } finally {
    if (!opts.keepProfile) {
      for (const p of profiles) {
        if (p) rmDir(p);
      }
    }
    const restoreErrors = restoreGreConfig(savedGre);
    for (const error of restoreErrors) {
      check(counter, false, 'GreD configuration restored', error);
    }
  }

  if (!summary(counter)) process.exitCode = 1;
}

run().catch(err => {
  console.error('Updater E2E failed:', err);
  process.exit(1);
});
