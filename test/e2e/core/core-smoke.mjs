#!/usr/bin/env node

/**
 * test/e2e/core/core-smoke.mjs — issue #30 Level 2: the real-browser core
 * smoke.
 *
 * The Level 1 unit suites (#416) prove config.js and BootstrapLoader.js behave
 * against STUBBED Firefox APIs. That catches syntax errors and obvious API
 * drift, but it cannot catch the failure mode that actually matters: Mozilla
 * removing or changing a real API. Every stub in test/unit/core/ was written
 * against today's Gecko, so the stubs keep passing while the browser breaks.
 *
 * This harness boots a REAL Firefox (stable or Nightly — whichever binary is
 * passed) with a dev snapshot's utils + fx-folder installed and asserts the
 * startup chain actually completed:
 *
 * config.js (autoconfig, GreD) executed → the userChromeJS loader top level ran
 * (userChrome.js lockPref'ed userChromeJS.enabled with lockPref=true, so the
 * pref is on disk after close) → no startup errors from OUR modules
 *
 * Why the assertions are on-disk (prefs.js + a console mirror) rather than over
 * BiDi: BiDi page enumeration is the flakiest part of the harness, and these
 * three facts are all provable from files the browser wrote itself. A probe
 * appended to the seeded GreD config.js sets a pref (proves autoconfig ran) and
 * mirrors nsIConsoleService messages to a log (makes startup errors visible in
 * CI), so no assertion depends on the automation channel.
 *
 * Runs once per browser — the scheduled workflow invokes it for stable and
 * Nightly in the same job. The PR-time coverage of core/** on all three OSes is
 * test/e2e/core/manifest-lifecycle-e2e.mjs (Level 2b, shipped in #245); this
 * leg exists to catch UPSTREAM FIREFOX CHANGES on a schedule, not on every PR.
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
  readFileSyncWithRetry,
} from '../shared/helpers.mjs';
import {
  findSnapshot,
  findZip,
  extractZip,
  discoverFirefoxBinary,
  findGreDir,
} from '../shared/browsers.mjs';

// ── GreD probe (appended to the seeded config.js) ──────────────────────────

/**
 * Marker line the probe writes once userChrome.js has executed.
 *
 * Checked AFTER config.js's
 * `loadSubScript('chrome://userchromejs/content/userChrome.js')`, because the
 * appended snippet runs after every statement in that file. If the marker is
 * absent, config.js either never got past that call (the chrome://userchromejs
 * registration the loader needs is broken) or userChrome.js threw before its
 * top-level statements ran. Either way the loader did not come up — and because
 * config.js wraps both calls in `catch (ex) {}`, nothing else would report it.
 *
 * The `typeof` guard is what makes this a statement-level probe: the globals
 * are created by userChrome.js's own top level, so their presence proves it
 * ran.
 */
const UC_LOADER_MARKER = '[core-smoke] userChrome.js top level executed';

/**
 * Appended to fx-folder's seeded GreD config.js.
 *
 * Three jobs, all on the autoconfig side so they run at a point where the
 * answer is unambiguous:
 *
 * 1. `pref()` records that config.js executed AT ALL. This is the weakest link: if
 *    autoconfig silently failed, every later assertion would still "pass" on a
 *    browser that never loaded our code.
 * 2. A marker line records that userChrome.js — loaded by the statement
 *    immediately before this snippet — actually executed.
 * 3. An nsIConsoleService listener mirrors console output to the same file, so
 *    startup errors surface in the CI log instead of dying inside the browser.
 *
 * ORDERING IS LOAD-BEARING: the log file is opened and the marker written
 * FIRST, and only then are the loader globals inspected. `userChrome.js`
 * declares `const UserChrome_js` / `const _uc`, and `typeof` on a `const`
 * binding that is in its temporal dead zone THROWS a ReferenceError rather than
 * returning 'undefined'. An earlier version evaluated that check first, so a
 * loader that threw half-way through killed the whole probe block and wrote
 * nothing at all — the harness could not then tell "loader broke" from "probe
 * broke". Writing first means the file always exists and always carries a
 * diagnosis.
 */
const CONFIG_PROBE_SNIPPET = `
// [core-smoke-e2e probe]
try {
  pref('extensions.firefox-scripts.e2eAutoconfigRan', 'yes');
} catch (e) {}
try {
  const Cc = Components.classes;
  const Ci = Components.interfaces;
  // dirsvc.get + append, NOT nsIFile.initWithPath: this is the exact construction
  // the manifest-lifecycle probe uses and it is known to work inside autoconfig.
  // The initWithPath form left the stream uninitialised, so every write threw and
  // the probe produced an EMPTY log — indistinguishable, from the harness, from a
  // browser that logs nothing.
  const f = Services.dirsvc.get('ProfD', Ci.nsIFile);
  f.append('e2e-console.log');
  const fos = Cc['@mozilla.org/network/file-output-stream;1'].createInstance(
    Ci.nsIFileOutputStream
  );
  fos.init(f, 0x02 | 0x08 | 0x10, -1, 0); // write | create | append
  const emit = line => {
    try { const s = line + '\\n'; fos.write(s, s.length); } catch (e) {}
  };
  // 1) the marker line, unconditionally, so the file always has content
  emit('${UC_LOADER_MARKER}');
  // 2) then the diagnosis, each probe guarded on its own
  try {
    emit('  typeof UserChrome_js = ' + typeof UserChrome_js);
  } catch (e) {
    emit('  typeof UserChrome_js THREW: ' + e);
  }
  try {
    emit('  typeof _uc = ' + typeof _uc);
  } catch (e) {
    emit('  typeof _uc THREW: ' + e);
  }
  try {
    emit('  typeof xPref = ' + typeof xPref);
  } catch (e) {
    emit('  typeof xPref THREW: ' + e);
  }
  // 3) the console mirror, last: a failure here must not cost the marker
  try {
    const cs = Cc['@mozilla.org/consoleservice;1'].getService(Ci.nsIConsoleService);
    cs.registerListener({
      observe(aMessage, aTopic, aData) {
        try {
          emit(
            new Date().toISOString() +
              ' ' +
              (aMessage.QueryInterface(Ci.nsIScriptError)?.errorMessage || aData || '')
          );
        } catch (e) {}
      },
    });
  } catch (e) {
    emit('  console mirror unavailable: ' + e);
  }
} catch (e) {}
// [core-smoke-e2e probe end]
`;

// ── Args ───────────────────────────────────────────────────────────────────

/**
 * pnpm run forwards a literal `--` separator; drop it so both `pnpm … --
 * --headless` and direct `node … --headless` work.
 *
 * @returns {{
 *   firefox?: string;
 *   snapshot?: string;
 *   label?: string;
 *   headless?: boolean;
 *   keepProfile?: boolean;
 * }}
 */
function parseArgs() {
  const args = process.argv.slice(2).filter(a => a !== '--');
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--firefox' && args[i + 1]) opts.firefox = args[++i];
    else if (args[i] === '--snapshot' && args[i + 1]) opts.snapshot = args[++i];
    else if (args[i] === '--label' && args[i + 1]) opts.label = args[++i];
    else if (args[i] === '--headless') opts.headless = true;
    else if (args[i] === '--keep-profile') opts.keepProfile = true;
    else if (args[i] === '--help') {
      console.log(`Usage: node test/e2e/core/core-smoke.mjs
  [--firefox <bin>] [--snapshot <dir>] [--label <name>] [--headless] [--keep-profile]`);
      process.exit(0);
    }
  }
  return opts;
}

// ── GreD seeding (mirrors manifest-lifecycle-e2e.mjs) ──────────────────────

/**
 * Snapshot the GreD files this harness overwrites, so they are restored byte
 * for byte afterwards. This writes into the browser's INSTALL dir — the browser
 * rewrote config.js at startup and a previous run may still hold it (Windows
 * EBUSY), hence the retrying read.
 *
 * @param {string} greDir
 * @returns {Record<string, string | null>} path → original bytes (null =
 *   absent)
 */
function saveGreState(greDir) {
  const saved = {};
  for (const rel of ['config.js', 'defaults/pref/config-prefs.js']) {
    const p = path.join(greDir, ...rel.split('/'));
    saved[p] = fs.existsSync(p) ? readFileSyncWithRetry(p) : null;
  }
  return saved;
}

/**
 * Put the GreD back. Restoring config.js matters beyond tidiness: leaving the
 * probe in place would keep writing e2e-console.log into every later run of
 * this browser.
 *
 * @param {Record<string, string | null>} saved
 * @returns {string[]} human-readable failures (empty = clean)
 */
function restoreGreState(saved) {
  const errors = [];
  for (const [p, data] of Object.entries(saved)) {
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
      }
    } catch (err) {
      errors.push(`${p}: ${err.message}`);
    }
  }
  return errors;
}

/**
 * Seed fx-folder's config.js + config-prefs.js into the GreD, then append the
 * probe. Same two files the manifest-lifecycle leg seeds — autoconfig reads
 * exactly this pair.
 *
 * @param {string} greDir - the browser's install dir
 * @param {string} snapshotDir
 * @returns {string | null} an error string, or null on success
 */
function seedGre(greDir, snapshotDir) {
  const fxZip = findZip(snapshotDir, ['fx-folder-dev.zip', 'fx-folder.zip']);
  if (!fxZip) return `no fx-folder zip in ${snapshotDir}`;
  const staging = tempDir('fxs-fx');
  try {
    extractZip(fxZip, staging);
    const base = path.join(staging, 'fx-folder');
    for (const rel of ['config.js', 'defaults/pref/config-prefs.js']) {
      const src = path.join(base, ...rel.split('/'));
      const dst = path.join(greDir, ...rel.split('/'));
      if (!fs.existsSync(src)) return `${rel} missing from ${path.basename(fxZip)}`;
      try {
        fs.mkdirSync(path.dirname(dst), {recursive: true});
        fs.writeFileSync(dst, fs.readFileSync(src));
      } catch (err) {
        return `cannot write ${dst}: ${err.message}`;
      }
    }
    try {
      fs.appendFileSync(path.join(greDir, 'config.js'), CONFIG_PROBE_SNIPPET);
    } catch (err) {
      return `cannot append probe to ${path.join(greDir, 'config.js')}: ${err.message}`;
    }
    return null;
  } finally {
    rmDir(staging);
  }
}

// ── Profile seeding ────────────────────────────────────────────────────────

/**
 * A fresh profile with the snapshot's utils extracted VERBATIM into
 * chrome/utils — no source patching, so what runs is exactly what ships.
 *
 * @param {string} snapshotDir
 * @returns {{profileDir: string; chromeUtils: string; prefs: object}}
 */
function seedProfile(snapshotDir) {
  const profileDir = tempDir('fxs-core');
  const chromeUtils = path.join(profileDir, 'chrome', 'utils');
  const utilsZip = findZip(snapshotDir, ['utils.zip', 'utils-dev.zip']);
  if (!utilsZip) throw new Error(`no utils zip in ${snapshotDir}`);
  extractZip(utilsZip, chromeUtils);

  // Cross-OS snapshot sharing: repoint the baked file:// URLs at THIS machine's
  // snapshot through pref overrides — never by rewriting the config, which is
  // part of the hashed utils file set.
  return {profileDir, chromeUtils, prefs: localConfigOverrides(chromeUtils, snapshotDir)};
}

/**
 * Resolve once BiDi reports at least one open page — the main window is up.
 *
 * @param {import('puppeteer-core').Browser} browser
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
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

// ── Smoke ──────────────────────────────────────────────────────────────────

/**
 * One browser's smoke run.
 *
 * @param {object} counter - createCounter() handle
 * @param {object} opts - parsed args (firefox resolved by the caller)
 * @param {string} snapshotDir
 * @returns {Promise<string | null>} the profile dir, or null if seeding failed
 */
async function runSmoke(counter, opts, snapshotDir) {
  const label = opts.label || 'browser';
  console.log(`\n## Core smoke · ${label}`);

  const seeded = seedProfile(snapshotDir);
  const greDir = findGreDir(opts.firefox);
  const seedError = seedGre(greDir, snapshotDir);
  check(counter, !seedError, `seed GreD (${label})`, seedError || '');
  if (seedError) {
    rmDir(seeded.profileDir);
    return null;
  }

  let browser;
  try {
    browser = await launchFirefox(opts.firefox, seeded.profileDir, {
      headless: opts.headless,
      extraPrefsFirefox: seeded.prefs,
    });
    attachProcessLogging(browser, label);
    const ready = await waitForFirstPage(browser);
    check(counter, ready, `browser window up (${label})`);
    // Let the startup chain (autoconfig → loader → scriptsUpdater init) settle
    // before closing. The assertions below are on-disk (prefs.js + the mirror
    // log), so a short grace period is enough.
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
  const prefs = fs.existsSync(prefsJs) ? readFileSyncWithRetry(prefsJs, 'utf-8') : '';
  check(
    counter,
    prefs.includes('extensions.firefox-scripts.e2eAutoconfigRan'),
    `autoconfig ran — config.js executed (${label})`,
    prefs ? '' : 'no prefs.js — the profile was never written'
  );

  // The GreD probe wrote its marker and mirrored the console into one file.
  // Absence of that file is NOT itself a failure — a browser that logs nothing
  // writes no file, and the draft asserted on its presence, which failed on a
  // healthy quiet start. What matters is whether the MARKER is in it.
  const mirror = path.join(seeded.profileDir, 'e2e-console.log');
  const lines =
    fs.existsSync(mirror) ? readFileSyncWithRetry(mirror, 'utf-8').split('\n').filter(Boolean) : [];
  console.log(`  [diag] console mirror: ${lines.length} line(s)`);

  // The real proof of the loader: config.js got PAST its loadSubScript call and
  // userChrome.js's top-level statements actually executed.
  //
  // The draft asserted `user_pref("userChromeJS.enabled", true)` in prefs.js.
  // That can never work: userChrome.js sets the pref through
  // `xPref.set(PREF_ENABLED, true, def=true)`, and `def=true` writes the DEFAULT
  // branch — which never reaches prefs.js. It failed against a perfectly
  // working browser. An earlier revision of this harness instead seeded a
  // .uc.js and asserted it executed; that is the loader's real job, but it only
  // runs once a browser.xhtml window exists, and a HEADLESS Firefox opens only
  // about:blank, which UserChrome_js.load() skips by design.
  //
  // So the probe reports what it can see. The marker line means "config.js ran
  // to the end"; the `typeof` lines say whether the loader's globals came into
  // existence. Both are echoed on failure, because "the loader's globals are
  // missing" and "the probe never ran" need different fixes.
  const marker = lines.find(l => l.includes(UC_LOADER_MARKER));
  const loaderGlobal = lines.find(l => l.includes('typeof UserChrome_js ='));
  const loaderUp = loaderGlobal !== undefined && loaderGlobal.includes('= object');
  check(
    counter,
    marker !== undefined && loaderUp,
    `userChromeJS loader ran — userChrome.js top level executed (${label})`,
    [
      marker === undefined ? 'probe never reached its marker line' : null,
      loaderGlobal === undefined ? 'probe wrote no typeof line' : null,
      loaderUp || loaderGlobal === undefined ? null : loaderGlobal.trim(),
    ]
      .filter(Boolean)
      .join(' | ') || 'config.js did not execute'
  );

  const suspicious = lines.filter(
    l =>
      !l.includes(UC_LOADER_MARKER) &&
      !l.trimStart().startsWith('typeof ') &&
      !l.includes('typeof ') &&
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
    console.error('No snapshot found. Run `pnpm snapshot:dev` first.');
    process.exit(1);
  }

  const firefoxBin = opts.firefox || discoverFirefoxBinary();
  if (!firefoxBin) {
    console.error('Firefox not found — pass --firefox or set FIREFOX_BINARY');
    process.exit(1);
  }

  console.log(`Core smoke\n  snapshot: ${snapshotDir}\n  firefox: ${firefoxBin}`);
  const greDir = findGreDir(firefoxBin);
  const savedGre = saveGreState(greDir); // original bytes BEFORE seed/probe

  let profileDir = null;
  try {
    profileDir = await runSmoke(counter, {...opts, firefox: firefoxBin}, snapshotDir);
  } finally {
    if (!opts.keepProfile && profileDir) rmDir(profileDir);
    // Restore the original GreD (only ever rewritten by this test).
    for (const err of restoreGreState(savedGre)) {
      console.error(`  [warn] could not restore GreD: ${err}`);
    }
  }

  if (!summary(counter)) process.exitCode = 1;
}

run().catch(err => {
  console.error('Core smoke failed:', err);
  process.exit(1);
});
