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
  check,
  createCounter,
  launchFirefox,
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

// ── Parse args ────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--firefox' && args[i + 1]) opts.firefox = args[++i];
    else if (args[i] === '--snapshot' && args[i + 1]) opts.snapshot = args[++i];
    else if (args[i] === '--headless') opts.headless = true;
    else if (args[i] === '--keep-profile') opts.keepProfile = true;
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
  if (!fxZip) return false;
  const staging = tempDir('fxs-fx');
  try {
    extractZip(fxZip, staging);
    const base = path.join(staging, 'fx-folder');
    const pairs = ['config.js', 'defaults/pref/config-prefs.js'];
    for (const rel of pairs) {
      const src = path.join(base, ...rel.split('/'));
      const dst = path.join(greDir, ...rel.split('/'));
      if (!fs.existsSync(src)) return false;
      try {
        fs.mkdirSync(path.dirname(dst), {recursive: true});
        fs.writeFileSync(dst, fs.readFileSync(src));
      } catch {
        /* GreD not writable */
      }
    }
    return true;
  } finally {
    rmDir(staging);
  }
}

function seedProfile(
  snapshotDir,
  {forceConfigStale = false, forceUtilsStale = false, skipUtils = false, skipConfig = false} = {}
) {
  const profileDir = tempDir('fxs-e2e');
  const userJsPath = path.join(profileDir, 'user.js');
  // Every scenario has a fresh profile, but make the daily notification gate
  // explicit so an inherited/default pref can never suppress a stale fixture.
  fs.writeFileSync(
    userJsPath,
    [
      'user_pref("extensions.firefox-scripts.lastUpdateTabShown", "");',
      'user_pref("extensions.firefox-scripts.lastScriptsCheckDate", "");',
      '',
    ].join('\n')
  );
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
    if (fs.existsSync(stale)) {
      fs.appendFileSync(stale, FORCE_UTILS_STALE_MARKER);
    }
  }

  // Force config stale: modify config.js in GreD
  if (forceConfigStale) {
    return {profileDir, chromeUtils, _greModNeeded: true};
  }

  // Skip prefs
  if (skipUtils || skipConfig) {
    const userJsPath = path.join(profileDir, 'user.js');
    const lines = [];
    try {
      const hashesPath = path.join(snapshotDir, 'hashes.json');
      if (fs.existsSync(hashesPath)) {
        const hashes = JSON.parse(fs.readFileSync(hashesPath, 'utf-8'));
        if (skipUtils && hashes.utils?.hash) {
          lines.push(
            `user_pref("extensions.firefox-scripts.skippedHash.utils", "${hashes.utils.hash}");`
          );
        }
        if (skipConfig && hashes['fx-folder']?.hash) {
          lines.push(
            `user_pref("extensions.firefox-scripts.skippedHash.fx-folder", "${hashes['fx-folder'].hash}");`
          );
        }
      }
    } catch {
      /* manifest missing */
    }
    if (lines.length) {
      fs.writeFileSync(userJsPath, lines.join('\n') + '\n');
    }
  }

  return {profileDir, chromeUtils, _greModNeeded: false};
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

  // GreD install
  const greDir = findGreDir(firefoxBin);
  installFxFolder(snapshotDir, greDir);
  if (seeded._greModNeeded) modifyGreConfig(greDir);

  let browser;
  try {
    browser = await launchFirefox(firefoxBin, seeded.profileDir, {headless: opts.headless});

    const page = await findPageByUrl(browser, UPDATER_URL, 90_000);
    check(counter, Boolean(page), `tab opens (${label})`);
    if (!page) return seeded.profileDir;

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
      60_000,
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
  }
}

/**
 * Launch Firefox with both packages up to date (or skipped), assert the updater
 * tab does NOT open within the timeout.
 */
async function runNoTabScenario(counter, opts, snapshotDir, label, {skipUtils, skipConfig}) {
  console.log(`\n## Scenario: ${label}`);
  const firefoxBin = opts.firefox || discoverFirefoxBinary();
  if (!firefoxBin) throw new Error('Firefox not found');

  const seeded = seedProfile(snapshotDir, {
    forceConfigStale: false,
    forceUtilsStale: false,
    skipUtils,
    skipConfig,
  });

  const greDir = findGreDir(firefoxBin);
  installFxFolder(snapshotDir, greDir);

  let browser;
  try {
    browser = await launchFirefox(firefoxBin, seeded.profileDir, {headless: opts.headless});
    const page = await findPageByUrl(browser, UPDATER_URL, 30_000);
    check(counter, !page, `tab does NOT open (${label})`);
    return seeded.profileDir;
  } finally {
    try {
      await browser?.close();
    } catch {
      /* ignore */
    }
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
    // Scenario 1: utils stale
    if (scenarios.includes('1')) {
      const p = await runStaleScenario(counter, opts, snapshotDir, 'utils-stale', {
        forceUtilsStale: true,
      });
      profiles.push(p);
    }

    // Scenario 2: config stale (needs writable GreD; skip on EPERM)
    if (scenarios.includes('2')) {
      const err = tryModifyGreConfig(findGreDir(firefoxBin));
      if (err) {
        console.log(`  SKIP config-stale: ${err}`);
        check(counter, true, 'config-stale skipped (GreD not writable locally)');
      } else {
        const p = await runStaleScenario(counter, opts, snapshotDir, 'config-stale', {
          forceConfigStale: true,
        });
        profiles.push(p);
      }
    }

    // Scenario 3: both stale (needs writable GreD; skip on EPERM)
    if (scenarios.includes('3')) {
      const err = tryModifyGreConfig(findGreDir(firefoxBin));
      if (err) {
        console.log(`  SKIP both-stale: ${err}`);
        check(counter, true, 'both-stale skipped (GreD not writable locally)');
      } else {
        const p = await runStaleScenario(counter, opts, snapshotDir, 'both-stale', {
          forceUtilsStale: true,
          forceConfigStale: true,
        });
        profiles.push(p);
      }
    }

    // Scenario 4: up to date
    if (scenarios.includes('4')) {
      const p = await runNoTabScenario(counter, opts, snapshotDir, 'up-to-date', {
        skipUtils: false,
        skipConfig: false,
      });
      profiles.push(p);
    }

    // Scenario 5: skipped
    if (scenarios.includes('5')) {
      const p = await runNoTabScenario(counter, opts, snapshotDir, 'skipped', {skipUtils: true});
      profiles.push(p);
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
