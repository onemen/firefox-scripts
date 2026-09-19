#!/usr/bin/env node
/**
 * Updater E2E test — puppeteer-core + WebDriver BiDi.
 *
 * Verifies the in-browser updater tab (chrome://firefox-scripts/content/ui/
 * updater.html) renders the correct state for every package-status combination
 * and all user actions work:
 *
 * Scenario 1 (stale-variants, merged session per #197): one browser session
 * renders all three stale combinations — utils-stale → config-stale →
 * both-stale — by mutating the stale fixtures on disk between tab reloads (the
 * tab re-hashes from disk on every load, so no re-seed or relaunch is needed).
 * Full card assertions per variant: identity, all 8 buttons, checkbox wiring,
 * skip checkbox, no page/console errors, screenshot Scenario 4 (up-to-date):
 * tab does NOT open (no state to surface) Scenario 5 (skipped): skip pref
 * suppresses the tab entirely Scenario 6 (install-applies): click btn-install
 * and assert the packages are actually copied to disk (issue #37); under Snap
 * the config package is never offered in-tab — the checkbox is hidden and the
 * manual-install band shown, so the run installs utils only and asserts the
 * config files stay untouched Scenario 7 (manual-install-upgrade): a
 * hand-installed utils.zip brings the updater — no tab with a pre-updater
 * utils, tab after replacing it (issue #53) Scenario 8 (manual-install-no-ui):
 * a hand-installed utils.zip ships NO ui folder (the tab UI lives in the
 * separate updater-ui.zip); after a fresh check the scheduler self-installs the
 * ui (ensureUpdaterUi) and the tab is visible (issue #102)
 *
 * Each scenario: fresh temp profile → seed utils + fx-folder → modify files to
 * force desired state → launch Firefox → wait for tab (or assert none) → run
 * assertions → close. The merged stale session (scenario 1) keeps ONE session
 * across its three variants (#197); a startup flake there would fail all three
 * at once, so it is wrapped in a retry-once-with-fresh-profile guard ([retry]
 * logged separately — a real regression still fails the leg).
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
import {startLocalManifestServer, serverOverridePrefs} from '../shared/localManifestServer.mjs';
import {
  findSnapshot,
  findZip,
  extractZip,
  discoverFirefoxBinary,
  findGreDir,
} from '../shared/browsers.mjs';
import {
  closeBrowser,
  killStrayProcesses,
  removeProfileCompatibilityIni,
} from '../shared/processHygiene.mjs';

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
    else if (args[i] === '--repeat' && args[i + 1] && Number(args[i + 1]) > 0)
      opts.repeat = Number(args[++i]);
    else if (args[i] === '--scenario' && args[i + 1])
      opts.scenarios = args[++i].split(',').map(s => s.trim());
    else if (args[i] === '--help') {
      console.log(
        'Usage: node updater-e2e.mjs --firefox <path> --snapshot <dir> [--scenario 1,4,5] [--repeat 2]'
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

  // Profile hygiene (issue #130): never reuse a previous run's GRE
  // compatibility state, even if a profile directory were ever reused.
  removeProfileCompatibilityIni(profileDir);

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

/** Timing helper: log scenario duration. */
function logScenarioTime(label, startMs, phases) {
  const total = Date.now() - startMs;
  const parts = [`total=${total}ms`];
  for (const [name, ms] of Object.entries(phases)) {
    parts.push(`${name}=${ms}ms`);
  }
  console.log(`  [timing] ${label}: ${parts.join(' ')}`);
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

/**
 * One stale variant's tab state as the UI must show it.
 *
 * @returns {{utilsStale: boolean; configStale: boolean}}
 */
function expectedStaleState(variant) {
  return {
    'utils-stale': {utilsStale: true, configStale: false},
    'config-stale': {utilsStale: false, configStale: true},
    'both-stale': {utilsStale: true, configStale: true},
  }[variant];
}

/**
 * Prepare the disk fixtures for one stale variant in the RUNNING session's
 * seeded trees (#197): the utils marker lives in the profile's chrome/utils
 * copy and the config marker in the GreD config.js. The tab re-hashes from disk
 * on every engine init ("must render the truth"), so re-running init after this
 * mutation re-renders the new variant — no re-seed or relaunch.
 *
 * config.js is written WHOLE from the captured pristine bytes: the startup
 * probe is itself an append that makes config stale as a side effect, so a
 * config-OK variant can only be produced by restoring the exact zip bytes
 * (dropping the probe — fine, the watcher is only needed before the tab handle
 * exists).
 */
function applyStaleVariantOnDisk(firefoxBin, seeded, variant, pristineConfig) {
  const {utilsStale, configStale} = expectedStaleState(variant);
  const utilsFile = path.join(seeded.chromeUtils, FORCE_UTILS_STALE);
  const utilsMarked = fs.readFileSync(utilsFile, 'utf-8').includes(FORCE_UTILS_STALE_MARKER);
  if (utilsStale && !utilsMarked) {
    fs.appendFileSync(utilsFile, FORCE_UTILS_STALE_MARKER);
  } else if (!utilsStale && utilsMarked) {
    // Restore the pristine module bytes: strip the marker line. The marker is
    // exactly what seedProfile appends, so removing it restores the zip state.
    const content = fs.readFileSync(utilsFile, 'utf-8');
    fs.writeFileSync(utilsFile, content.replace(FORCE_UTILS_STALE_MARKER, ''));
  }

  const configJs = path.join(findGreDir(firefoxBin), 'config.js');
  const configContent =
    pristineConfig.toString('utf-8') +
    (configStale ? `\n${CONFIG_PROBE_SNIPPET}${FORCE_CONFIG_STALE_MARKER}` : '');
  try {
    fs.writeFileSync(configJs, configContent);
  } catch (err) {
    if (err.code === 'EPERM' || err.code === 'EACCES') {
      // Friendly message for the local-dev case (read-only GreD); in CI the
      // portable install's GreD is always writable and this never fires.
      throw new Error(
        `GreD not writable (${err.code}) — run with admin or use a writable Firefox install`,
        {cause: err}
      );
    }
    throw err;
  }
}

/**
 * Read the tab's badge state, tolerating an in-flight navigation: a reload of
 * the privileged chrome:// page makes evaluate() throw until the new document
 * is ready, and puppeteer's own navigation waiter times out on chrome:// URLs
 * (it cannot observe the trusted document's lifecycle) — so the poll, not the
 * reload promise, is the synchronization point.
 */
async function readBadgeState(page) {
  try {
    return await page.evaluate(() => ({
      title: Boolean(document.getElementById('card-title')?.textContent),
      utils: {
        update: !document.getElementById('utils-badge-update')?.hidden,
        ok: !document.getElementById('utils-badge-ok')?.hidden,
      },
      config: {
        update: !document.getElementById('config-badge-update')?.hidden,
        ok: !document.getElementById('config-badge-ok')?.hidden,
      },
    }));
  } catch {
    return null; // navigation in flight or page not ready — retry
  }
}

/** Poll until the tab renders `variant`'s expected state (or timeout). */
async function waitForStaleState(page, variant, timeoutMs = 20_000) {
  const want = expectedStaleState(variant);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await readBadgeState(page);
    if (
      s &&
      s.title &&
      s.utils.update === want.utilsStale &&
      s.utils.ok === !want.utilsStale &&
      s.config.update === want.configStale &&
      s.config.ok === !want.configStale
    ) {
      return true;
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

/**
 * Run the full stale-variant card assertions against one live updater tab.
 * Shared by the merged session (all three variants over reloads) and by the
 * retry attempt (single variant, fresh profile) — the assertion set is the same
 * either way (per-variant labels keep the output attributable). `pageErrors` is
 * owned by the caller (attached before the reload that triggered this variant's
 * render) and only read here.
 */
async function assertStaleCard(counter, page, variant, pageErrors) {
  const {utilsStale, configStale} = expectedStaleState(variant);

  // Wait for the card to render the variant's expected state — the
  // navigation-tolerant poll (see readBadgeState) is the reload sync point.
  const rendered = await waitForStaleState(page, variant);
  check(
    counter,
    rendered,
    `card re-rendered with ${variant} state`,
    rendered ? '' : 'badges never matched the expected combination after reload'
  );
  if (!rendered) return false;

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

  check(
    counter,
    utilsStatus.update === utilsStale && utilsStatus.ok === !utilsStale,
    `utils badge = ${utilsStale ? 'Update Available' : 'Up To Date'} (${variant})`
  );
  check(
    counter,
    configStatus.update === configStale && configStatus.ok === !configStale,
    `config badge = ${configStale ? 'Update Available' : 'Up To Date'} (${variant})`
  );

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
  check(counter, buttons.every(Boolean), `all 8 buttons present (${variant})`);

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
  check(
    counter,
    cbWired?.enabled && cbWired?.disabled,
    `checkbox toggles Update button (${variant})`
  );

  // ── Skip checkbox visible for stale packages (hidden for up-to-date) ──
  const skipLabels = await page.evaluate(() => ({
    config: !document.getElementById('skip-config')?.hidden,
    utils: !document.getElementById('skip-utils')?.hidden,
  }));
  check(
    counter,
    skipLabels.utils === utilsStale && skipLabels.config === configStale,
    `skip checkboxes match staleness (${variant})`
  );

  // ── No page errors ──
  check(
    counter,
    pageErrors.length === 0,
    `no page errors (${variant})`,
    pageErrors.slice(0, 3).join(' | ')
  );

  // ── Screenshot ──
  const shotPath = path.join(REPO_ROOT, 'dist', `updater-e2e-${variant.replace(/\s+/g, '_')}.png`);
  fs.mkdirSync(path.dirname(shotPath), {recursive: true});
  const shotOk = await screenshotPrivileged(page, shotPath);
  if (shotOk) check(counter, true, `screenshot saved (${variant})`);

  return true;
}

/**
 * #197 — the three stale variants (utils-stale / config-stale / both-stale)
 * share ONE browser session: seed once (utils stale + GreD probe installed),
 * then per variant mutate the stale fixtures on disk and reload the tab (the
 * engine re-hashes from disk on every load). Two Firefox launches per leg
 * become one; only the disk state changes between variants.
 *
 * Wrapped in a retry-once guard with a fresh profile: a browser-internal
 * startup race (observed live on waterfox, run 35460461221 —
 * NS_ERROR_NOT_INITIALIZED from the URL-classifier service) would otherwise
 * fail all three variants at once. The retry is logged on its own [retry] lines
 * so a real regression cannot hide behind it; a second failure fails the leg.
 */
async function runStaleVariantsScenario(counter, opts, snapshotDir, variants) {
  const label = variants.join('+');
  console.log(`\n## Scenario: stale variants (${label}) — one session (#197)`);
  const firefoxBin = opts.firefox || discoverFirefoxBinary();
  if (!firefoxBin) throw new Error('Firefox not found');

  const t0 = Date.now();
  const phases = {};
  // Every profile this function creates (attempt 1 + optional retry) is
  // returned for run()'s centralized cleanup; a retry's first profile also
  // stays on disk until then for post-mortem.
  const createdProfiles = [];

  // Seed: first variant's state (utils stale; config stale comes from the GreD
  // probe, which is installed for every variant — the marker toggles it).
  let seeded = seedProfile(snapshotDir, {forceUtilsStale: true});
  createdProfiles.push(seeded.profileDir);
  phases.seed = Date.now() - t0;

  const greDir = findGreDir(firefoxBin);
  const greSeed = installFxFolder(snapshotDir, greDir);
  check(counter, greSeed.ok, `seed GreD (${label})`, greSeed.error);
  if (!greSeed.ok) return createdProfiles;

  // Capture the pristine config.js BEFORE the probe lands on it — variant 1
  // (config OK) restores exactly these bytes.
  let pristineConfig = fs.readFileSync(path.join(greDir, 'config.js'));

  appendConfigProbe(greDir);

  let browser;
  let attempted = 0;
  try {
    // ── attempt loop (retry-once) ──
    while (attempted < 2) {
      attempted++;
      const attemptLabel = attempted === 1 ? label : `[retry ${attempted - 1}] ${label}`;
      if (attempted > 1) {
        console.log(`\n  [retry] attempt 2/2 for (${label}) with a FRESH profile —`);
        console.log('  [retry] attempt 1 never opened the tab ([diag] above; likely a');
        console.log('  [retry] browser startup race, e.g. waterfox run 35460461221). A');
        console.log('  [retry] second failure fails the leg — the retry never masks regressions.');
        // Fresh profile: the previous attempt's seeded trees stay behind for
        // post-mortem; seedProfile makes a new temp dir each call.
        seeded = seedProfile(snapshotDir, {forceUtilsStale: true});
        createdProfiles.push(seeded.profileDir);
        const greSeed2 = installFxFolder(snapshotDir, greDir);
        check(counter, greSeed2.ok, `seed GreD (retry ${label})`, greSeed2.error);
        if (!greSeed2.ok) break;
        pristineConfig = fs.readFileSync(path.join(greDir, 'config.js'));
        appendConfigProbe(greDir);
      }

      const launchStart = Date.now();
      browser = await launchFirefox(firefoxBin, seeded.profileDir, {
        headless: opts.headless,
        extraPrefsFirefox: seeded.prefs,
      });
      attachProcessLogging(browser, attemptLabel);
      phases.launch = Date.now() - launchStart;

      // Wait on both channels: BiDi page enumeration (needed for UI assertions)
      // and the probe's TAB_OPENED mirror line (fast, BiDi-independent).
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
      const viaPref = greShownToday(seeded.profileDir);
      const tabOpened = Boolean(page) || viaPref || sawMirrorLine;

      if (!page && tabOpened) {
        // Tab opened (probe mirror / persisted pref) but BiDi cannot attach to
        // the trusted chrome:// tab in this environment — a deterministic
        // limitation on some CI runners (observed on Windows), not a startup
        // race, so a retry cannot help. Record the tab-open proof with the
        // limitation spelled out in the label (the historical CI contract for
        // these legs, previously silent); full card assertions run where BiDi
        // attaches (locally, other runners).
        check(
          counter,
          true,
          `tab opens (${attemptLabel}; no card assertions — BiDi cannot attach to the trusted tab in this environment)`
        );
        console.log('  [diag] probe/pref verified the tab; BiDi missed the handle');
        return createdProfiles;
      }

      if (!tabOpened) {
        // Scheduler never opened the tab: the startup-race case the retry
        // exists for. Only the FINAL attempt records the verdict — a FAIL is
        // permanent in the counter (fail-fast would skip the remaining
        // scenarios even if attempt 2 succeeded).
        if (attempted < 2) {
          console.log(
            `  [diag] tab never opened within 15 s (attempt ${attempted}) — retrying with a fresh profile`
          );
          try {
            await closeBrowser(browser);
          } catch {
            /* ignore */
          }
          browser = null;
          continue;
        }
        check(
          counter,
          false,
          `tab opens (${attemptLabel})`,
          'scheduler never reached addTrustedTab'
        );
        await dumpPages(browser);
        dumpUpdaterPrefs(seeded.profileDir);
        dumpConsoleLog(seeded.profileDir);
        break;
      }

      console.log(`  tab URL: ${page.url()}`);

      // ── Per-variant: mutate disk → re-render → assert ──
      let variantFailure = false;
      for (const variant of variants) {
        // Errors are collected per variant, attached BEFORE the reload that
        // triggers this variant's render.
        const pageErrors = [];
        const onErr = err => pageErrors.push(err.message);
        page.on('pageerror', onErr);
        try {
          applyStaleVariantOnDisk(firefoxBin, seeded, variant, pristineConfig);
          // Re-render through the production path: UpdaterEngine.init() re-runs
          // the fresh hash check (manifest fetch + local re-hash) and pushes
          // state in-document. A page.reload() was tried first — BiDi cannot
          // observe chrome:// navigations (its waiter times out and the
          // evaluation channel wedges), so the engine's own re-check entry
          // point is the reliable in-document equivalent.
          await page.evaluate(() => window.UpdaterEngine.init());
          const ok = await assertStaleCard(counter, page, variant, pageErrors);
          if (!ok) {
            variantFailure = true;
            break;
          }
        } catch (err) {
          // Disk mutation failed (e.g. GreD became unwritable): record it as
          // the variant's failed check with a readable message and stop — the
          // harness keeps running the remaining scenarios via fail-fast.
          check(counter, false, `variant fixture update (${variant})`, err.message);
          variantFailure = true;
          break;
        } finally {
          page.off('pageerror', onErr);
        }
      }

      if (!variantFailure) {
        phases.total = Date.now() - t0;
        logScenarioTime(attemptLabel, t0, phases);
        return createdProfiles;
      }
      // Assertion failure: retry only makes sense for startup-shaped failures;
      // a card assertion failure is deterministic (bad fixture/code), so do
      // not burn the retry on it — fail fast.
      console.log(
        `  [retry] card assertions failed on attempt ${attempted} — deterministic, not retrying`
      );
      break;
    }
    return createdProfiles;
  } finally {
    try {
      await closeBrowser(browser);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Launch Firefox with both packages up to date (or skipped), assert the updater
 * tab does NOT open within the timeout.
 *
 * Uses a local manifest server for fast, deterministic "no update" checks: the
 * scheduler fetches HASHES_URL from localhost instead of the network, so the
 * check completes in ~1ms instead of network latency. The 3s blind margin is
 * cut to 500ms (enough for the scheduler to run after the window is up).
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

  const t0 = Date.now();
  const phases = {};

  const seeded = seedProfile(snapshotDir, {
    forceConfigStale: false,
    forceUtilsStale,
    skipUtils,
    skipConfig,
  });
  phases.seed = Date.now() - t0;

  const greDir = findGreDir(firefoxBin);
  const greSeed = installFxFolder(snapshotDir, greDir);
  check(counter, greSeed.ok, `seed GreD (${label})`, greSeed.error);
  if (!greSeed.ok) {
    phases.total = Date.now() - t0;
    logScenarioTime(label, t0, phases);
    return seeded.profileDir;
  }
  phases.seedGreD = Date.now() - t0;

  let server = null;
  let browser;
  try {
    // Start local manifest server for fast, deterministic "no update" check.
    // The server serves the snapshot's real hashes.json — the scheduler's
    // local hash computation will match, so it correctly decides "up to date"
    // without hitting the network.
    server = await startLocalManifestServer(snapshotDir, seeded.chromeUtils, {
      multiRequest: true, // scheduler may fetch more than once (retry logic)
    });
    phases.serverStart = Date.now() - t0;
    // Override HASHES_URL to point at the local server
    Object.assign(seeded.prefs, serverOverridePrefs(server.url));

    const launchStart = Date.now();
    browser = await launchFirefox(firefoxBin, seeded.profileDir, {
      headless: opts.headless,
      extraPrefsFirefox: seeded.prefs,
    });
    attachProcessLogging(browser, label);
    phases.launch = Date.now() - launchStart;

    // No-tab scenarios assert absence. The scheduler runs at startup and
    // decides within a couple of seconds of the window being up (manifest
    // fetch + hash). With the local manifest server the fetch is ~1ms, so the
    // check completes quickly. Wait for the main window via BiDi page
    // enumeration, allow a short margin for the async check to complete, then
    // assert the tab never appeared. (The GreD config probe cannot be used
    // here: it changes config.js, which breaks the fx-folder hash and makes
    // the scheduler open the tab.)
    const waitStart = Date.now();
    const browserReady = await waitForFirstPage(browser, 15_000);
    phases.waitBrowser = Date.now() - waitStart;
    check(counter, browserReady, `browser ready (${label})`, 'BiDi did not report an open page');
    if (!browserReady) {
      phases.total = Date.now() - t0;
      logScenarioTime(label, t0, phases);
      return seeded.profileDir;
    }
    // Short margin: the local server makes the fetch fast, but we still need
    // to let the scheduler run after the window is up (it's async).
    await new Promise(r => setTimeout(r, 500));
    phases.postWait = 500;
    const page = await findPageByUrl(browser, UPDATER_URL, 2_000);
    phases.checkTab = Date.now() - t0;
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

    phases.total = Date.now() - t0;
    logScenarioTime(label, t0, phases);
    return seeded.profileDir;
  } finally {
    try {
      await closeBrowser(browser);
    } catch {
      /* ignore */
    }
    if (server) {
      await server.close().catch(() => {});
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
      await closeBrowser(browser);
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
  // NOTE: no local manifest server here (unlike runNoTabScenario). Phase 2
  // relaunches on the SAME profile: a HASHES_URL override pref handed to
  // extraPrefsFirefox is written to prefs.js on launch and FLUSHED BACK on
  // close, so it would survive into phase 2 — the dead localhost URL then
  // fails the manifest fetch, the check exits as "no update", and the updater
  // never activates. Only seed prefs that must persist across both phases.
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
      // Negative assertion: with no updater module the scheduler cannot run at
      // all, so a short blind margin + tab poll is sufficient evidence.
      await new Promise(r => setTimeout(r, 3_000));
      const page = await findPageByUrl(browser, UPDATER_URL, 2_000);
      check(counter, !page, `no updater tab with old utils (${label})`);
    }
  } finally {
    try {
      await closeBrowser(browser);
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
      await closeBrowser(browser);
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
      await closeBrowser(browser);
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

  // Process hygiene (issue #130): a cancelled or crashed previous run can
  // leave the detached installer holding port 8777 and BiDi browsers holding
  // temp profiles — kill them before anything waits on that port.
  await killStrayProcesses();

  const firefoxBin = opts.firefox || discoverFirefoxBinary();
  if (!firefoxBin) {
    console.error('Firefox not found. Set FIREFOX_BINARY or pass --firefox <path>');
    process.exit(1);
  }
  console.log(`  firefox: ${firefoxBin}`);
  console.log(`  GreD:    ${findGreDir(firefoxBin)}`);

  const scenarios = opts.scenarios || ['1', '4', '5', '6', '7', '8'];

  const profiles = [];

  // Save GreD config before we overwrite it (see issue #4)
  const savedGre = saveGreConfig(findGreDir(firefoxBin));

  try {
    // Scenario steps run in order; after the first failure the remaining
    // scenarios almost always fail for the same root cause, so skip them
    // (opt out with --no-fail-fast). Scenarios 1–3 are ONE step (#197): the
    // three stale variants share a browser session (fresh profile on retry).
    // --scenario 1 still runs the whole merged step — the variants are no
    // longer separable because they share the session.
    const scenarioSteps = [
      {
        id: '1',
        run: async () => {
          profiles.push(
            ...(await runStaleVariantsScenario(counter, opts, snapshotDir, [
              'utils-stale',
              'config-stale',
              'both-stale',
            ]))
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

    // --repeat <n> re-runs the whole scenario selection (fresh profile per
    // scenario per pass) — the deterministic repeat-run proof of #130.
    const repeat = opts.repeat ?? 1;
    for (let pass = 1; pass <= repeat; pass++) {
      if (repeat > 1) console.log(`\n===== repeat pass ${pass}/${repeat} =====`);

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
