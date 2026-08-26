#!/usr/bin/env node
/**
 * Core smoke test — issue #30 Level 2 (the scheduled leg).
 *
 * Boots a real Firefox (stable or Nightly — whichever binary is passed) with a
 * dev snapshot's utils + fx-folder installed, then asserts the startup chain:
 *
 * config.js (autoconfig, GreD) executed →
 * extensions.firefox-scripts.e2eAutoconfigRan pref userChrome.js loader
 * top-level ran → userChromeJS.enabled pref (the loader default-sets it with
 * lockPref=true) no startup errors in OUR modules → scan of the e2e-console.log
 * mirror
 *
 * Same fresh-profile + GreD-seed approach as updater-e2e.mjs, but asserting the
 * loader chain instead of the updater tab. Runs once per browser — the
 * core-smoke-nightly workflow invokes it for stable and Nightly in one job.
 *
 * Usage: node test/e2e/core/core-smoke.mjs --firefox <path> [--snapshot <dir>]
 * [--label <name>] [--headless] [--keep-profile]
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  launchFirefox,
  attachProcessLogging,
  check,
  createCounter,
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

/**
 * Appended to the seeded GreD config.js: proves autoconfig executed (pref, read
 * from prefs.js after close — prefs.js is available even when BiDi could not
 * enumerate pages) and mirrors console-service messages to the profile's
 * e2e-console.log so startup errors become visible in CI logs.
 */
const CONFIG_PROBE_SNIPPET = `
// e2e-core-smoke probe
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
} catch (e) {}
`;

// ── Args ───────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--firefox' && args[i + 1]) opts.firefox = args[++i];
    else if (args[i] === '--snapshot' && args[i + 1]) opts.snapshot = args[++i];
    else if (args[i] === '--label' && args[i + 1]) opts.label = args[++i];
    else if (args[i] === '--headless') opts.headless = true;
    else if (args[i] === '--keep-profile') opts.keepProfile = true;
  }
  return opts;
}

// ── Profile + GreD seeding (mirrors updater-e2e.mjs) ──────────────────────

function seedProfile(snapshotDir) {
  const profileDir = tempDir('fxs-core');
  const chromeUtils = path.join(profileDir, 'chrome', 'utils');

  const utilsZip = findZip(snapshotDir, ['utils-dev.zip', 'utils.zip']);
  if (!utilsZip) {
    throw new Error('no utils zip in snapshot — run `pnpm upload:local --mode=dev` first');
  }
  extractZip(utilsZip, chromeUtils);

  // Cross-OS snapshot sharing: repoint the baked file:// URLs at this
  // machine's snapshot via pref overrides (never by rewriting the config —
  // it is part of the hashed utils file set).
  const prefs = localConfigOverrides(chromeUtils, snapshotDir);

  return {profileDir, chromeUtils, prefs};
}

function installFxFolder(snapshotDir, greDir) {
  const fxZip = findZip(snapshotDir, ['fx-folder-dev.zip', 'fx-folder.zip']);
  if (!fxZip) return {ok: false, error: 'no fx-folder zip in snapshot'};
  const staging = tempDir('fxs-fx');
  try {
    extractZip(fxZip, staging);
    const base = path.join(staging, 'fx-folder');
    for (const rel of ['config.js', 'defaults/pref/config-prefs.js']) {
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

/** Snapshot GreD config.js before the probe is appended; restore in finally. */
function saveGreConfig(greDir) {
  const p = path.join(greDir, 'config.js');
  return fs.existsSync(p) ? fs.readFileSync(p) : null;
}

// ── Smoke ──────────────────────────────────────────────────────────────────

/** Resolve once BiDi reports at least one open page — the main window is up. */
async function waitForFirstPage(browser, timeoutMs = 20_000) {
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

async function runSmoke(counter, opts, snapshotDir) {
  const label = opts.label || 'browser';
  console.log(`\n## Core smoke · ${label}`);
  const firefoxBin = opts.firefox || discoverFirefoxBinary();
  if (!firefoxBin) throw new Error('Firefox not found — pass --firefox or set FIREFOX_BINARY');

  const seeded = seedProfile(snapshotDir);
  const greDir = findGreDir(firefoxBin);
  const greSeed = installFxFolder(snapshotDir, greDir);
  check(counter, greSeed.ok, `seed GreD (${label})`, greSeed.error);
  if (!greSeed.ok) return;
  fs.appendFileSync(path.join(greDir, 'config.js'), CONFIG_PROBE_SNIPPET);

  let browser;
  try {
    browser = await launchFirefox(firefoxBin, seeded.profileDir, {
      headless: opts.headless,
      extraPrefsFirefox: seeded.prefs,
    });
    attachProcessLogging(browser, label);
    const ready = await waitForFirstPage(browser);
    check(counter, ready, `browser window up (${label})`);
    // Let the startup chain (autoconfig → loader → scriptsUpdater init)
    // settle before closing. Assertions are on-disk (prefs.js + mirror log),
    // so a short grace period is enough.
    if (ready) await new Promise(r => setTimeout(r, 5_000));
  } finally {
    try {
      await browser?.close();
    } catch {
      /* ignore */
    }
  }

  // ── Loader-chain assertions (post-close, BiDi-independent) ──
  const prefsJs = path.join(seeded.profileDir, 'prefs.js');
  const prefs = fs.existsSync(prefsJs) ? fs.readFileSync(prefsJs, 'utf-8') : '';
  check(
    counter,
    prefs.includes('user_pref("extensions.firefox-scripts.e2eAutoconfigRan", "yes")'),
    `autoconfig ran — config.js executed (${label})`
  );
  check(
    counter,
    prefs.includes('user_pref("userChromeJS.enabled", true)'),
    `userChromeJS loader ran — userChrome.js top-level executed (${label})`
  );

  const mirror = path.join(seeded.profileDir, 'e2e-console.log');
  const lines =
    fs.existsSync(mirror) ? fs.readFileSync(mirror, 'utf-8').split('\n').filter(Boolean) : [];
  check(counter, lines.length > 0, `console mirror written (${label})`);
  if (lines.length === 0) {
    console.log('  [diag] no e2e-console.log — autoconfig may not have run');
  }
  const suspicious = lines.filter(
    l =>
      /(userChrome|BootstrapLoader|firefox-scripts|config\.js)/i.test(l) &&
      /error|exception|failed|not defined|undefined is not/i.test(l)
  );
  check(
    counter,
    suspicious.length === 0,
    `no startup errors in our modules (${label})`,
    suspicious.slice(0, 5).join(' | ')
  );
  for (const line of suspicious) console.log(`  [diag:err] ${line}`);

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
  console.log(`Core smoke\n  snapshot: ${snapshotDir}`);

  const firefoxBin = opts.firefox || discoverFirefoxBinary();
  if (!firefoxBin) {
    console.error('Firefox not found — pass --firefox or set FIREFOX_BINARY');
    process.exit(1);
  }
  const greDir = findGreDir(firefoxBin);
  const savedConfig = saveGreConfig(greDir); // original bytes BEFORE seed/probe

  let profileDir = null;
  try {
    profileDir = await runSmoke(counter, {...opts, firefox: firefoxBin}, snapshotDir);
  } finally {
    if (!opts.keepProfile && profileDir) rmDir(profileDir);
    // Restore the original GreD config.js (only ever rewritten by this test).
    if (savedConfig !== null) {
      fs.mkdirSync(path.dirname(path.join(greDir, 'config.js')), {recursive: true});
      fs.writeFileSync(path.join(greDir, 'config.js'), savedConfig);
    }
  }

  if (!summary(counter)) process.exitCode = 1;
}

run().catch(err => {
  console.error('Core smoke failed:', err);
  process.exit(1);
});
