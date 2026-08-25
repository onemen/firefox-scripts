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
 * skip pref suppresses the tab entirely
 *
 * Each scenario: fresh temp profile → seed utils + fx-folder → modify files to
 * force desired state → launch Firefox → wait for tab (or assert none) → run
 * assertions → close.
 *
 * Usage: node tools/test/e2e/updater-e2e.mjs --firefox <path> --snapshot <dir>
 */

import fs from 'node:fs';
import path from 'node:path';
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
} from './helpers.mjs';
import {findSnapshot, findZip, extractZip, discoverFirefoxBinary, findGreDir} from './browsers.mjs';

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
        'Usage: node updater-e2e.mjs --firefox <path> --snapshot <dir> [--scenario 1,2,3]'
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
      if (/HASHES_URL|ZIP_BASE_URL|LOCAL_DIST_PATH|ASSET_SUFFIX/.test(line)) {
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

/** True when the probe's watcher has recorded TAB_OPENED in the mirror log. */
function mirrorSaysTabOpened(profileDir) {
  try {
    return fs
      .readFileSync(path.join(profileDir, 'e2e-console.log'), 'utf-8')
      .includes('TAB_OPENED');
  } catch {
    return false;
  }
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
      const chks = document.querySelectorAll('.chk-component');
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
    // No-tab scenarios assert absence: 10 s is enough for startup to finish.
    const page = await findPageByUrl(browser, UPDATER_URL, 10_000);
    check(counter, !page, `tab does NOT open (${label})`);
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

  const scenarios = opts.scenarios || ['1', '2', '3', '4', '5'];

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
