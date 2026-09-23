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
 * ui (ensureUpdaterUi) and the tab is visible (issue #102) Scenario 9
 * (helper-checksum-win, Windows-only): ACL-write-denies GreD so the config
 * install falls through to the elevated-copy helper, and asserts the downloaded
 * helper's checksum verification PASSES before the (headless-doomed) elevation
 * step — the PR #271 mojibake regression net. Requires a user-owned GreD (CI's
 * portable installs; skips on admin-owned dirs like Program Files, which cannot
 * be denied without elevation)
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

import {execFileSync} from 'node:child_process';
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
  startLocalManifestServer,
  serverOverridePrefs,
  buildTreeManifest,
} from '../shared/localManifestServer.mjs';
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
  // Build the mirror path via clone()+appendRelativePath, NOT a string
  // concat into initWithPath: the concat mixes separators on Windows
  // ("C:\\...\\profile/e2e-console.log") and initWithPath throws
  // NS_ERROR_FILE_UNRECOGNIZED_PATH — the whole probe died there (swallowed
  // by this catch), so the mirror never wrote a byte and TAB_OPENED never
  // landed (root-caused 2026-09-23, issue #292). clone()+append is proven
  // working by the same experiment.
  const f = Services.dirsvc
    .get('ProfD', Ci.nsIFile)
    .clone()
    .QueryInterface(Ci.nsIFile);
  f.appendRelativePath('e2e-console.log');
  const fos = Cc['@mozilla.org/network/file-output-stream;1'].createInstance(
    Ci.nsIFileOutputStream
  );
  fos.init(f, 0x02 | 0x08 | 0x10, -1, 0); // write | create | append
  fos.write('MIRROR-OPEN' + String.fromCharCode(10), 12);
  cs.registerListener({
    observe(aMessage, aTopic, aData) {
      try {
        // Severity + source so the harness can assert on updater errors
        // (assertNoUpdaterConsoleErrors): plain messages keep the legacy
        // format, script errors gain [level] and source:line.
        let line;
        try {
          const se = aMessage.QueryInterface(Ci.nsIScriptError);
          // Classify info → warn, everything else = error (review thread on
          // #271): the flag constants moved between Firefox versions, so
          // testing errorFlag first with a numeric fallback could
          // misclassify. Defaulting to error means the console net can only
          // over-report, never under-report.
          const infoFlag = Ci.nsIScriptError.infoFlag || 8;
          const warnFlag = Ci.nsIScriptError.warningFlag || 2;
          const level =
            se.flags & infoFlag ? 'info' : se.flags & warnFlag ? 'warn' : 'error';
          const src = se.sourceName ? ' [' + se.sourceName + ':' + (se.lineNumber || 0) + ']' : '';
          line = level + src + ' ' + se.errorMessage;
        } catch {
          line = aData || aMessage.message || '';
        }
        const out = new Date().toISOString() + ' ' + line + '\\n';
        fos.write(out, out.length);
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
  const fxZip = findZip(snapshotDir, ['fx-folder.zip', 'fx-folder-dev.zip']);
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
        return {
          ok: false,
          error: `${rel} missing from ${path.basename(fxZip)}`,
        };
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
  const utilsZip = findZip(snapshotDir, ['utils.zip', 'utils-dev.zip']);
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
  addSkipPrefs(prefs, snapshotDir, skipUtils, skipConfig);

  return {profileDir, chromeUtils, _greModNeeded: false, prefs};
}

/**
 * Set the per-package skip prefs (extensions.firefox-scripts.skippedHash.<pkg>
 * = remote hash) from the snapshot's own manifest. Shared by seedProfile and
 * the launch-reuse hand-off (scenario 4 → 5): launch prefs re-inject on every
 * start, so a reused profile needs the same pref deltas a fresh seed would have
 * written, sourced from the same manifest.
 *
 * @param {Record<string, string>} prefs launch prefs (mutated)
 * @param {string} snapshotDir
 * @param {boolean} skipUtils
 * @param {boolean} skipConfig
 */
function addSkipPrefs(prefs, snapshotDir, skipUtils, skipConfig) {
  if (!skipUtils && !skipConfig) return;
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

/**
 * Snapshot GreD before the test writes over it. Returns a map: {[path]:
 * data|null} — null means the file did NOT exist before the test (created by
 * installFxFolder) and should be removed.
 */
/**
 * Whether the browser's install dir is writable by this account.
 *
 * @param {string} greDir
 * @returns {string} Empty when writable, else the reason (for the message).
 */
function greNotWritableReason(greDir) {
  const probe = path.join(greDir, '.fxs-e2e-write-probe');
  try {
    fs.writeFileSync(probe, 'probe');
    fs.unlinkSync(probe);
    return '';
  } catch (err) {
    return `${greDir}: ${err.message}`;
  }
}

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
        // Only rewrite what the run actually changed. An unconditional rewrite
        // fails with EPERM on an admin-owned GreD (Program Files) even though
        // nothing needs restoring — noise, not a failure.
        if (fs.existsSync(p) && fs.readFileSync(p).equals(data)) continue;
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

/**
 * Wait until an installed tree re-hashes to the expected manifest hash (or the
 * timeout expires). This is the install-completion ground truth — the same disk
 * state the updater itself verifies in refreshPackageState — so the harness can
 * wait on it instead of polling the tab's DOM badges (which are a UI proxy that
 * can miss or lag the actual copy). File watches are platform-fragile; a fast
 * hash poll (250 ms) is event-adjacent: it detects the copy within one tick of
 * completion without a fixed sleep.
 *
 * @param {string[]} files manifest file list
 * @param {string} dir installed tree root
 * @param {string} expectedHash manifest hash
 * @param {number} [timeoutMs=30_000] Default is `30_000`
 * @returns {Promise<boolean>} true when the tree matched
 */
async function waitForTreeHash(files, dir, expectedHash, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (computeInstalledHash(files, dir) === expectedHash) return true;
    if (Date.now() >= deadline) return false;
    await new Promise(r => setTimeout(r, 250));
  }
}

// ── Scenario runners ───────────────────────────────────────────────────────

/**
 * Launch-reuse hand-off shape helpers (scenarios 4→5 and 7→8).
 *
 * A hand-off-capable runner returns EITHER the full state object (`{profileDir,
 * chromeUtils, prefs}`) on its success path OR a bare profile-dir string on an
 * early-exit path (GreD-seed failure, browser never became ready, …).
 * Everything downstream guards on `fullHandoffState` so a partial return can
 * never flow into a step that would consume its `chromeUtils`/`prefs` fields as
 * undefined (which built paths like "undefined/…" and confused step 5), and
 * `handoffProfileDir` always yields a string for the centralized `profiles`
 * cleanup list.
 *
 * @param {any} state - whatever a hand-off-capable runner returned
 * @returns {{profileDir: string; chromeUtils: string; prefs: object} | null}
 *   the full state, or null when it is a bare/early-exit return
 */
function fullHandoffState(state) {
  return (
      Boolean(state) &&
        typeof state === 'object' &&
        typeof state.profileDir === 'string' &&
        typeof state.chromeUtils === 'string' &&
        Boolean(state.prefs)
    ) ?
      state
    : null;
}

/**
 * Always a profile-dir string: unwraps a full hand-off state object, passes
 * through a bare path, and throws loudly on anything else (never silently
 * pushes an object into `profiles` — `rmDir` would swallow it and leak the
 * profile directory).
 *
 * @param {any} state - whatever a hand-off-capable runner returned
 * @returns {string} the profile directory for the cleanup list
 */
function handoffProfileDir(state) {
  if (typeof state === 'string') return state;
  const full = fullHandoffState(state);
  if (full) return full.profileDir;
  throw new Error(
    'hand-off: unexpected runner return — expected a profile dir string or full hand-off state'
  );
}

/**
 * Launch Firefox with a seeded profile, wait for the updater tab, run generic
 * action assertions (identity, buttons, checkbox, errors, screenshot).
 */

/** Log the update URLs baked into the snapshot's generated updater config. */

function logBakedConfig(snapshotDir) {
  const staging = tempDir('fxs-cfg');
  try {
    const utilsZip = findZip(snapshotDir, ['utils.zip', 'utils-dev.zip']);
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
 * Severity + source of every console error the mirror recorded (1a's probe
 * format). Returns {line, level, source} per hit.
 *
 * @param {string} profileDir
 * @param {string[]} allowPatterns regex source strings; a line whose source
 *   matches one is not an updater failure (other components legitimately
 *   error)
 * @returns {{line: string; level: string; source: string}[]}
 */
function collectConsoleErrors(profileDir, allowPatterns = []) {
  let text;
  try {
    text = fs.readFileSync(path.join(profileDir, 'e2e-console.log'), 'utf-8');
  } catch {
    return []; // no mirror = nothing to assert on (scenario never opened a console)
  }
  const allows = allowPatterns.map(
    p =>
      // security/detect-non-literal-regexp: the patterns are test-source
      // constants (allowlists passed by this file), never user input.
      // eslint-disable-next-line security/detect-non-literal-regexp
      new RegExp(p)
  );
  const hits = [];
  for (const line of text.split('\n')) {
    // The mirror line format is "<ISO> <level> [source:line] msg". Tab-script
    // informational traces are console.debug (2026-09-21) — Firefox's mirror
    // classifies those as info severity, so cut after the LEVEL MARKER, not
    // after a literal ' error ': a debug/info line has no ' error ' substring,
    // and the old cut silently relied on the remainder still containing the
    // source. Only OUR sources count, at any level.
    const levelMatch = / (error|debug|info|warn) \[/.exec(line);
    const rest = levelMatch ? line.slice(levelMatch.index + 1) : line;
    // The probe appends " [source:line] msg" for script errors; the updater
    // scripts surface as chrome://firefox-scripts/... sources. The hit rule is
    // OURS ONLY, at any level (logError is console.debug now) — a foreign
    // source is Firefox's business, and counting it reds legs on pure noise:
    // `chrome://browser/.../ext-browser.js:396 Cannot attach ID to a tab in a
    // closed window` (ubuntu updater leg, 2026-09-22) and the resource://gre
    // Telemetry line before it. Two shipped bugs were caught through this net
    // (helper checksum mojibake, CSP-blocked inline style) and both were ours.
    const srcMatch = / \[(chrome:\/\/[^\]:]+[^\]]*?):\d+\]/.exec(rest);
    const source = srcMatch ? srcMatch[1] : '';
    const level = levelMatch ? levelMatch[1] : '';
    const ours = source.includes('chrome://firefox-scripts');
    if (!ours) continue;
    // Allowlist matches the FULL line (source AND message): scenario 9's
    // expected headless-elevation failure IS a chrome://firefox-scripts
    // logError and must be exemptable without masking any other error.
    if (allows.some(re => re.test(line))) continue;
    hits.push({line: line.trim(), level, source});
  }
  return hits;
}

/**
 * Assert the console mirror recorded zero errors sourced from the updater
 * scripts (chrome://firefox-scripts/.../updater/* — the engine module and the
 * tab's updater.js/updater-ui.js). The 2026-09-20 manual session caught TWO
 * shipped bugs as console errors (helper checksum mojibake, CSP-blocked inline
 * style) that green CI never saw — every updater scenario now closes the net.
 *
 * Allow patterns: other components legitimately error (e.g. blocked processes
 * under the harness); only chrome://firefox-scripts sources are ours.
 */
function assertNoUpdaterConsoleErrors(counter, profileDir, label, allowPatterns = []) {
  const hits = collectConsoleErrors(profileDir, allowPatterns);
  check(
    counter,
    hits.length === 0,
    `console mirror: zero updater errors (${label})`,
    hits.length ? hits.map(h => `${h.source}: ${h.line}`).join('\n    ') : undefined
  );
  if (hits.length) dumpConsoleLog(profileDir);
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
        // The variants re-rendered the real card through the engine's init():
        // close the net — no console errors from the updater scripts during
        // the whole stale-variants session.
        assertNoUpdaterConsoleErrors(counter, seeded.profileDir, attemptLabel);
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
  {skipUtils, skipConfig, forceUtilsStale = false},
  reuseState = null
) {
  console.log(`\n## Scenario: ${label}`);
  const firefoxBin = opts.firefox || discoverFirefoxBinary();
  if (!firefoxBin) throw new Error('Firefox not found');

  const t0 = Date.now();
  const phases = {};

  const seeded =
    reuseState ??
    seedProfile(snapshotDir, {
      forceConfigStale: false,
      forceUtilsStale,
      skipUtils,
      skipConfig,
    });
  if (reuseState) {
    // Launch-reuse hand-off (scenario 4 → 5): the profile already holds the
    // seeded utils + GreD state; scenario 5's deltas are applied on top —
    // (a) forceUtilsStale is the disk marker below, (b) skipUtils is a launch
    // pref (addSkipPrefs — extraPrefsFirefox re-injects every start, so no
    // user.js write), (c) the GreD is re-seeded for byte-identical state.
    // The daily gate is already cleared by the seeded prefs on every launch.
    console.log(
      "  [reuse] continuing on scenario 4's profile (profile + utils state reused; GreD re-seeded for byte-identical state)"
    );
    if (forceUtilsStale) {
      const stale = path.join(seeded.chromeUtils, FORCE_UTILS_STALE);
      fs.appendFileSync(stale, FORCE_UTILS_STALE_MARKER);
    }
    addSkipPrefs(seeded.prefs, snapshotDir, skipUtils, skipConfig);
  }
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

  // Launch-reuse hand-off (scenario 4 → 5): return the full seeded state so
  // step 5 can continue on this profile. `chromeUtils` + `prefs` are what the
  // reuse path mutates (stale marker, skip prefs); the daily-gate clears stay
  // in `prefs` so the second launch re-runs the check. The `'profileDir' in
  // state` unwrap in run() still routes the profile into `profiles` for
  // centralized cleanup.
  return {profileDir: seeded.profileDir, chromeUtils: seeded.chromeUtils, prefs: seeded.prefs};
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

      // Completion: the installed utils TREE re-hashes to the manifest — the
      // ground truth, waited on directly (waitForTreeHash) instead of polling
      // the tab's DOM badges for 60 s. One read-only evaluate afterwards still
      // asserts the UI layer reflected the install.
      const completed = await waitForTreeHash(utilsFiles, seeded.chromeUtils, utilsHash, 30_000);
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

      // Completion: BOTH installed trees re-hash to the manifest (utils then
      // config — the tab installs config first). Disk hash is the completion
      // ground truth; the badge DOM is asserted once afterwards instead of
      // being polled for a minute.
      const completed =
        (await waitForTreeHash(utilsFiles, seeded.chromeUtils, utilsHash, 30_000)) &&
        (await waitForTreeHash(configFiles, greDir, configHash, 30_000));
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

      // UI reflection: POLL, don't read once (review on #310). The disk waits
      // above prove the FILES are installed, but the tab's refreshPackageState
      // + re-render runs after the last copy — a single read can execute
      // before it and fail on a slow runner even though the install succeeded
      // (the exact class the old 60s DOM poll covered). Bounded 10s poll per
      // condition, 250ms tick: fast when the render already landed, bounded
      // when it never will.
      const uiCondition = async (fn, what) => {
        const deadline = Date.now() + 10_000;
        for (;;) {
          const v = await page.evaluate(fn).catch(() => false);
          if (v) return true;
          if (Date.now() >= deadline) {
            console.log(`  [diag] UI condition not reached within 10s: ${what}`);
            return false;
          }
          await new Promise(r => setTimeout(r, 250));
        }
      };
      const successShown = await uiCondition(
        () => !document.getElementById('success-banner')?.hidden,
        'success banner'
      );
      check(counter, successShown, `success banner shown after install (${label})`);

      const badgesOk = await uiCondition(() => {
        const ok = id => {
          const el = document.getElementById(id);
          return Boolean(el && !el.hidden);
        };
        return ok('utils-badge-ok') && ok('config-badge-ok');
      }, 'badges OK');
      check(counter, badgesOk, `badges show OK after install (${label})`);
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

  // The install session ran the full in-tab flow (downloads, verification,
  // copies, re-hash): the net — no console errors from the updater scripts.
  // (Wrapped install failures DO log via logError, but those fail the earlier
  // completion assertions first; this catches the silent-console regressions.)
  assertNoUpdaterConsoleErrors(counter, seeded.profileDir, label);

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
/**
 * Bounded poll until the profile directory accepts create+delete again (i.e.
 * the exiting Firefox process's handles are gone). Cheap probe: a 0-byte file
 * named after the poll attempt, removed immediately. Resolves once one probe
 * succeeds or after `timeoutMs`; never throws — a still-locked profile fails
 * later at relaunch with the real error.
 */
async function waitForProfileUnlocked(profileDir, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Probe the LOCK ARTIFACT, not the directory (review on #310): Firefox
    // holds the profile lock on parent.lock (Windows) / .parentlock (Linux) —
    // the directory itself stays writable, so a create+delete probe succeeds
    // while the dying process still holds the lock and the wait proves
    // nothing. On Windows opening parent.lock for write access fails with
    // EBUSY/EPERM until the owning process is gone; elsewhere the sentinel
    // file disappears at shutdown.
    const lock = path.join(
      profileDir,
      process.platform === 'win32' ? 'parent.lock' : '.parentlock'
    );
    try {
      // 'r+' without truncation: opens the existing lock file for write
      // access, which is exactly what the lock holder forbids.
      const fh = fs.openSync(lock, 'r+');
      fs.closeSync(fh);
      return;
    } catch (err) {
      // ENOENT is a pass: the lock file is gone (or was never created) —
      // nothing is holding the profile.
      if (err.code === 'ENOENT') return;
      // Unix: the sentinel file disappearing is the actual unlock signal.
      if (process.platform !== 'win32' && !fs.existsSync(lock)) return;
      await new Promise(r => setTimeout(r, 100));
    }
  }
}

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
  fs.rmSync(path.join(seeded.chromeUtils, 'updater'), {
    recursive: true,
    force: true,
  });

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
    // Observed 2026-09-22 (measurement runs): Nightly can crash during BiDi
    // connect (TargetCloseError at session.new, "Exiting due to channel
    // error") — an environment/process-foreign crash, not a harness failure.
    // Retry up to 3 attempts with a hygiene sweep + short backoff between
    // them; a persistent crash still fails the run loudly.
    const launchOnce = async () => {
      browser = await launchFirefox(firefoxBin, seeded.profileDir, {
        headless: opts.headless,
        extraPrefsFirefox: seeded.prefs,
      });
      attachProcessLogging(browser, label);
    };
    for (let attempt = 1; ; attempt++) {
      try {
        await launchOnce();
        break;
      } catch (err) {
        if (
          attempt >= 3 ||
          !/TargetCloseError|ProtocolError|Protocol error|timed out/.test(String(err?.message))
        )
          throw err;
        console.log(
          `  [diag] browser crashed or wedged during launch (attempt ${attempt}) — sweeping and retrying`
        );
        await killStrayProcesses();
        await new Promise(r => setTimeout(r, attempt * 1_000));
      }
    }
    const browserReady = await waitForFirstPage(browser, 15_000);
    check(counter, browserReady, `old-utils browser ready (${label})`);
    if (browserReady) {
      // Negative assertion: with the firefox-scripts mapping stripped from
      // chrome.manifest the scheduler module cannot load, so no updater tab
      // can open. The probe mirror IS live here (the probe runs from the GreD
      // autoconfig regardless of profile utils), so two channels must BOTH
      // stay silent for a bounded window: the mirror's TAB_OPENED marker and
      // the BiDi page handle. The window (~2.5 s) covers the ~1-2 s a running
      // scheduler needs to open the tab (measured 2026-09-23, #292) — the old
      // shape (blind 3 s sleep + 2 s tab poll) paid 5 s and saw only BiDi.
      const quietDeadline = Date.now() + 2_500;
      let tabEvidence = '';
      while (Date.now() < quietDeadline) {
        if (mirrorSaysTabOpened(seeded.profileDir)) {
          tabEvidence = 'probe mirror recorded TAB_OPENED although the mapping is stripped';
          break;
        }
        if (await findPageByUrl(browser, UPDATER_URL, 500).catch(() => null)) {
          tabEvidence = 'BiDi found the updater tab although the mapping is stripped';
          break;
        }
      }
      check(counter, !tabEvidence, `no updater tab with old utils (${label})`, tabEvidence);
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
  // closeBrowser() already waited for the firefox process to EXIT, which on
  // Windows releases the profile's file handles at termination — so this is a
  // bounded poll (probe: the profile dir must accept a create+delete), not a
  // blind 2s sleep. Usually resolves in ~0ms; the old fixed sleep cost 2s on
  // every run of this scenario.
  await waitForProfileUnlocked(seeded.profileDir);

  // ── Phase 2: manually replace utils.zip with the real one → updater appears ──
  const utilsZip = findZip(snapshotDir, ['utils.zip', 'utils-dev.zip']);
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

  // State hand-off for the launch-reuse prototype (--scenario 7,8): the
  // profile already holds the real (stale) utils this scenario installed, so
  // runManualInstallNoUiScenario can reuse it instead of re-seeding and
  // relaunching from scratch. `prefs` still carries the daily-gate clears +
  // local overrides; scenario 8 adds its own release-topology overrides.
  return {
    profileDir: seeded.profileDir,
    chromeUtils: seeded.chromeUtils,
    prefs: seeded.prefs,
  };
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
  for (const name of ['utils.zip', 'utils-dev.zip', 'fx-folder.zip', 'fx-folder-dev.zip']) {
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

async function runManualInstallNoUiScenario(counter, opts, snapshotDir, label, reuseState = null) {
  console.log(`\n## Scenario: ${label}`);
  const firefoxBin = opts.firefox || discoverFirefoxBinary();
  if (!firefoxBin) throw new Error('Firefox not found');

  // Launch-reuse prototype (--scenario 7,8): start from scenario 7's end
  // state instead of a fresh profile. The utils are already real and
  // stale-forced, the GreD is already seeded, and the profile dir is reused
  // (as within scenario 7's own phases) — the launch prefs re-clear the
  // daily gate so the check runs.
  const seeded = reuseState ?? seedProfile(snapshotDir, {});
  if (reuseState) {
    console.log(
      "  [reuse] continuing on scenario 7's profile (profile + utils state reused; GreD re-seeded for byte-identical state)"
    );
  }

  // utils.zip contains no ui folder: the tab UI is a separate package
  // (updater-ui.zip) installed under updater/ui by ensureUpdaterUi. In the
  // reuse path scenario 7's activation DID extract the ui — remove it so the
  // "ships without ui" precondition and the auto-install assertion mean the
  // same thing as on a fresh profile.
  const uiDir = path.join(seeded.chromeUtils, 'updater', 'ui');
  if (reuseState) {
    fs.rmSync(uiDir, {recursive: true, force: true});
  }
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
    // Same launch-retry loop as scenario 7's phase 1 (Nightly can crash
    // during BiDi connect — an environment crash, not a harness failure).
    const launchOnce = async () => {
      browser = await launchFirefox(firefoxBin, seeded.profileDir, {
        headless: opts.headless,
        extraPrefsFirefox: seeded.prefs,
      });
      attachProcessLogging(browser, label);
    };
    for (let attempt = 1; ; attempt++) {
      try {
        await launchOnce();
        break;
      } catch (err) {
        if (
          attempt >= 3 ||
          !/TargetCloseError|ProtocolError|Protocol error|timed out/.test(String(err?.message))
        )
          throw err;
        console.log(
          `  [diag] browser crashed or wedged during launch (attempt ${attempt}) — sweeping and retrying`
        );
        await killStrayProcesses();
        await new Promise(r => setTimeout(r, attempt * 1_000));
      }
    }
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
  // ACTIVATION PROOF (not just the pref): PREF_LAST_SHOWN is set in memory
  // right before addTrustedTab, but its prefs.js flush at close can race the
  // harness read (greShownToday), which occasionally fails the check even
  // though the ui WAS extracted by the same call chain. The extracted ui
  // dir + utils-stale marker are the same-class disk proof the other
  // scenarios accept, so the OR accepts it too.
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
    Boolean(page) || viaPref || uiExtracted,
    `ui tab opened (${label})`,
    viaPref && !page ? '(verified via lastUpdateTabShown; BiDi missed the chrome tab)'
    : !viaPref && !page && uiExtracted ?
      '(verified via extracted updater-ui; prefs.js flush raced close)'
    : ''
  );
  if (!page) {
    dumpUpdaterPrefs(seeded.profileDir);
    dumpConsoleLog(seeded.profileDir);
  }

  rmDir(releaseDir);
  return seeded.profileDir;
}

/**
 * Scenario 9 — Windows helper-checksum path (PR #271 regression net).
 *
 * The 2026-09-20 manual session caught the elevated-copy helper's checksum
 * verification failing on EVERY download (mojibake hex from finish(false)) —
 * invisible to CI because every leg installs into a user-writable dir where the
 * direct copy succeeds and the helper never runs.
 *
 * This scenario forces the helper path without a real UAC prompt (none exists
 * on a headless runner):
 *
 * 1. Seed a STAND-IN helper into the snapshot dir: `helper_win.exe` bytes
 *    (arbitrary — cmd.exe copy) + a `helper_win.exe.sha256` sidecar computed
 *    over those bytes. The tab's HELPER_BASE_URL resolves here, so ensureHelper
 *    downloads exactly these.
 * 2. ACL-DENY the browser's GreD (icacls) so the direct IOUtils copy fails and
 *    installConfig falls through to the helper.
 * 3. Click Update and assert the flow gets PAST verification: the console mirror
 *    must show NO 'failed checksum verification' error (the old bug's
 *    signature), and the failure mode must be the elevation path (exit 2 cancel
 *    / progress error), never verification.
 * 4. Remove the ACL and verify GreD content is UNCHANGED (a verified helper that
 *    could not elevate must not have copied anything).
 *
 * The stand-in bytes are never executed (UAC cannot succeed headless), so this
 * stays a checksum-verification test — the real elevated copy is the installer
 * E2E's RS-10 territory. Windows-only; other platforms skip.
 */
async function runHelperChecksumScenario(counter, opts, snapshotDir, label) {
  console.log(`\n## Scenario: ${label}`);
  if (process.platform !== 'win32') {
    console.log('  SKIP: Windows-only (icacls + helper_win).');
    check(counter, true, `${label} skipped (non-Windows)`);
    return null;
  }
  const firefoxBin = opts.firefox || discoverFirefoxBinary();
  if (!firefoxBin) throw new Error('Firefox not found');

  // ── Real GreD, write-denied; scratch snapshot ──
  // The updater resolves GreD from the RUNNING binary, so the target must be
  // the real install dir — its WRITE is ACL-denied to force the helper path.
  // A deny ACE needs this user to own the tree: CI's browser legs install
  // user-owned portable copies (fine); an admin-owned dir like Program Files
  // cannot be denied without elevation, so the scenario skips gracefully.
  // Everything the updater READS (packages, helper stand-in, sidecar) is
  // seeded into a scratch COPY of the snapshot and the updater is repointed
  // at it via override prefs — the real snapshot dir is never mutated.
  const scratch = tempDir('fxs-helper');
  const scratchSnap = path.join(scratch, 'snap');
  const greDir = findGreDir(firefoxBin);
  try {
    fs.cpSync(snapshotDir, scratchSnap, {recursive: true});

    // ── Seed the stand-in helper + sidecar into the scratch snapshot ──
    // Arbitrary non-executable bytes; >0x80 spread exercises the fixed
    // per-byte conversion (the mojibake bug only corrupted bytes >= 0x80).
    // 'MZ' DOS header magic + a >0x80-heavy body; the '-dev' variant is
    // legacy tolerance for pre-#282 snapshots.
    const standIn = Buffer.concat([
      Buffer.from([0x4d, 0x5a, 0x90, 0x00]),
      Buffer.from(Array.from({length: 4096}, (_, i) => (i * 37 + 128) & 0xff)),
    ]);
    for (const helperName of ['helper_win.exe', 'helper_win-dev.exe']) {
      const helperPath = path.join(scratchSnap, helperName);
      fs.writeFileSync(helperPath, standIn);
      fs.writeFileSync(
        helperPath + '.sha256',
        `${createHash('sha256').update(standIn).digest('hex')}  ${helperName}\n`
      );
    }

    const seeded = seedProfile(scratchSnap, {forceConfigStale: true});
    // The seeded profile ships utils only; updater-ui.zip is a separate package
    // the browser installs for itself, and this fixture's UI base is a file://
    // scratch dir. Install the UI the way a real profile has it: with no UI on
    // disk the scheduler's ensureUpdaterUi() has to fetch it first, and this
    // scenario's tab never opened in that state with either manifest wiring
    // (reproduced locally 2026-09-22 on a portable GreD: no tab on both
    // attempts; the same run with the UI seeded proves the tab open on the
    // first attempt). Keeps the scenario about the config update, not about
    // self-updating the tab UI.
    const uiZip = findZip(scratchSnap, ['updater-ui.zip', 'updater-ui-dev.zip']);
    if (uiZip) {
      extractZip(uiZip, path.join(seeded.profileDir, 'chrome', 'utils', 'updater', 'ui'));
    }
    // Repoint the updater at the scratch snapshot (it baked the original
    // snapshot's dist path — helper stand-in + sidecar live there now).
    Object.assign(seeded.prefs, localConfigOverrides(seeded.chromeUtils, scratchSnap));
    // Serve the manifest over http://localhost (reachable on every runner) but
    // serve the SNAPSHOT's own hashes.json — NOT startLocalManifestServer's
    // default manifest, which is built to make utils match and leaves
    // `fx-folder: {hash: '', files: []}`. With fx-folder emptied, the config
    // package stops reading as stale, the scheduler decides there is nothing to
    // surface, and the tab never opens — i.e. the scenario silently asserts
    // nothing (reproduced locally 2026-09-22 on the portable GreD: no tab on
    // either attempt, while the same seed with the snapshot manifest opens it).
    // The snapshot's manifest keeps fx-folder's real hash, which the probed
    // GreD config.js no longer matches → "config: Update Available" → tab.
    const manifestServer = await startLocalManifestServer(scratchSnap, seeded.chromeUtils, {
      multiRequest: true,
      manifestOverride: JSON.parse(fs.readFileSync(path.join(scratchSnap, 'hashes.json'), 'utf-8')),
    });
    Object.assign(seeded.prefs, serverOverridePrefs(manifestServer.url));
    // fx-folder into the real GreD (utils go into the profile via seedProfile;
    // the config package's direct copy will target GreD and hit the deny).
    const fxSeed = installFxFolder(scratchSnap, greDir);
    check(counter, fxSeed.ok, `fx-folder seeded into scratch GreD (${label})`, fxSeed.error);
    if (!fxSeed.ok) {
      await manifestServer.close();
      return seeded.profileDir;
    }
    // The config probe: makes the fx-folder package read STALE (so the tab
    // offers the config install and the scheduler opens it) AND mirrors every
    // console message to e2e-console.log (the net assertNoUpdaterConsoleErrors
    // reads). MUST land before the ACL deny — it is itself a write.
    check(counter, appendConfigProbe(greDir), `config probe appended (${label})`);

    // ── ACL-deny the seeded config FILES ──
    // The deny targets the seeded config.js / config-prefs.js themselves:
    // Firefox only READS them (spawns fine), while the updater's direct copy
    // must WRITE them (noOverwrite: false) — which the deny blocks, forcing
    // the helper path. A directory deny cannot do this: it does not stop
    // overwriting an existing file's data, and any inheritance flag that
    // covers firefox.exe breaks the launch. Admin-owned GreD (Program Files)
    // cannot be denied without elevation → skip gracefully.
    const icacls = args => execFileSync('icacls', args, {encoding: 'utf8'});
    const denyAce = `${process.env.USERNAME}:(W)`;
    const seededFiles = ['config.js', 'defaults/pref/config-prefs.js'].map(rel =>
      path.join(greDir, ...rel.split('/'))
    );
    const configBefore = fs.readFileSync(seededFiles[0]);

    let browser;
    let page = null;
    let aclDenied = false;
    try {
      // ── Launch FIRST, deny SECOND ──
      // A write-deny on config.js present at launch suppresses the scheduler
      // entirely (observed 2026-09-20: no tab, no console mirror — autoconfig
      // bail-out). Denying AFTER the tab is up keeps the launch clean; the
      // scheduler's staleness scan has already read the files by then, and
      // the deny only needs to stop the direct COPY that follows the click.
      browser = await launchFirefox(firefoxBin, seeded.profileDir, {
        headless: opts.headless,
        extraPrefsFirefox: seeded.prefs,
      });
      attachProcessLogging(browser, label);
      // Wait for the main window FIRST, exactly like every other tab
      // scenario: on a busy headed runner Firefox can take >10 s to paint its
      // first window, and the mirror wait below is useless until the
      // scheduler even ran (first CI run of this scenario failed exactly
      // here — two about:blank pages, no mirror, 'browser ready' never
      // reached before the 20 s deadline burned).
      const browserReady = await waitForFirstPage(browser, 20_000);
      check(counter, browserReady, `browser ready (${label})`);
      // Like the other tab scenarios: three channels prove the tab, because
      // on CI (1) BiDi cannot enumerate trusted chrome:// tabs and (2) the
      // console mirror never writes (both deterministic there — observed on
      // every leg of 2026-09-21). The scheduler writes lastUpdateTabShown to
      // prefs.js immediately before addTrustedTab, so the pref is the
      // always-available proof; the mirror and the BiDi handle add detail
      // where the environment allows it.
      // Wait for the tab-open proof LONGER than the browser-startup cost:
      // prefs.js is flushed lazily, and the poll below measured 20 s as not
      // enough on a cold runner (the pref was on disk seconds after the
      // deadline). 45 s covers cold NFS-startup + a slow first scheduler tick
      // without adding materially to the leg's runtime (it returns the moment
      // the proof lands).
      //
      // HOST-side poll (mirrorSaysTabOpened/greShownToday read host disk and
      // close over host state). The previous waitForCondition(browser, …)
      // call was doubly broken: Browser has no .evaluate in puppeteer-core
      // 25.10.0, and even with a page the host closure cannot run in-page —
      // both errors were swallowed by waitForCondition's catch, so the loop
      // always burned its full 45 s before findPageByUrl ever ran (also
      // root-caused 2026-09-23, #292). Same loop shape as the other tab
      // scenarios' mirror+page polls: BiDi page check rides along so this
      // exits the moment ANY of the three channels lands.
      const tabProofDeadline = Date.now() + 45_000;
      let tabMirror = false;
      while (Date.now() < tabProofDeadline) {
        if (mirrorSaysTabOpened(seeded.profileDir) || greShownToday(seeded.profileDir)) {
          tabMirror = true;
          break;
        }
        page = await findPageByUrl(browser, UPDATER_URL, 500).catch(() => null);
        if (page) break;
      }
      if (!page) {
        page = await findPageByUrl(browser, UPDATER_URL, 10_000).catch(() => null);
      }
      let tabOpened = Boolean(page) || tabMirror;
      if (!tabOpened) {
        // Both in-run channels can be unavailable at once: BiDi cannot
        // enumerate the trusted chrome:// tab in this environment (the
        // documented CI limitation), and prefs.js is flushed only at shutdown,
        // so the in-run poll sees no pref even when the scheduler DID open the
        // tab (verified 2026-09-22: both attempt profiles carried
        // lastUpdateTabShown=<today> once their browsers had closed, while the
        // in-run poll had timed out on both). Close the browser and read the
        // flush: the scheduler sets that pref in its tab-open branch only, so
        // it is exact proof, and the remaining assertions (ACL deny, no copy)
        // need no live page.
        await dumpPages(browser);
        await closeBrowser(browser).catch(() => {});
        browser = null;
        tabOpened = greShownToday(seeded.profileDir);
        console.log(
          tabOpened ?
            '  [diag] tab-open proven by the persisted pref (flushed at shutdown)'
          : '  [diag] no tab-open proof on any channel (BiDi, mirror, pref)'
        );
        if (!tabOpened) dumpConsoleLog(seeded.profileDir);
      }
      check(counter, tabOpened, `tab opens (${label})`);

      // ── NOW deny writes to the seeded config files ──
      // (tab up; scheduler's read done — see the comment above)
      for (const f of seededFiles) {
        try {
          icacls([f, '/deny', denyAce]);
          aclDenied = true;
        } catch {
          // Admin-owned file (e.g. Program Files): cannot deny without UAC.
          console.log(`  SKIP: ${f} is not ACL-controllable here.`);
        }
      }
      if (!aclDenied) {
        check(counter, true, `${label} skipped (GreD not ACL-controllable)`);
        return seeded.profileDir;
      }
      // Empirical guard: the deny must actually block THIS user's writes,
      // else the direct copy succeeds and the scenario asserts nothing.
      let denyWorks = true;
      try {
        fs.appendFileSync(seededFiles[0], '\n/* probe */\n');
        denyWorks = false; // write succeeded — deny is ineffective
      } catch {
        denyWorks = true;
      }
      check(counter, denyWorks, `GreD write blocked by ACL (${label})`);
      if (page) {
        // (flow continues below)
      } else {
        // Tab existed (pref/mirror proves it) but BiDi lost it — trusted-tab
        // enumeration is deterministic on CI (2026-09-21: every leg, every
        // scenario). No page to click, so the download→verify→gate→spawn flow
        // cannot be driven here; what IS assertable: the deny held, nothing
        // wrote GreD, and the tab's own session logged no updater errors.
        console.log('  [diag] BiDi never surfaced the trusted tab; pref/mirror-only path.');
        assertNoUpdaterConsoleErrors(counter, seeded.profileDir, label, [
          'Elevation was cancelled',
          'Admin copy helper failed',
        ]);
        // The no-copy assertion is skipped by the early return below (it sits
        // after the finally), so run it here. Drop the deny first: on some
        // hosts the write-deny blocks READS too (observed locally 2026-09-22:
        // EPERM on open, while CI allowed the same read), and the ACE never
        // changes file content — so reading after the removal is still proof
        // that the denied copy wrote nothing.
        for (const f of seededFiles) {
          try {
            icacls([f, '/remove:d', process.env.USERNAME]);
          } catch {
            /* not denied */
          }
        }
        const configAfter = fs.readFileSync(seededFiles[0]);
        check(
          counter,
          configAfter.equals(configBefore),
          `GreD config unchanged (no copy without elevation, ${label})`
        );
        return seeded.profileDir;
      }

      // Tick config only and install.
      // page can be null on the pref/mirror-only path even after the tab-open
      // check passed — guard so the crash cannot mask the verdicts below.
      const clicked =
        page &&
        (await page.evaluate(() => {
          const btn = document.getElementById('btn-install');
          const cb = document.getElementById('chk-config');
          if (!btn || !cb) return false;
          if (!cb.checked) cb.click();
          btn.click();
          return true;
        }));
      if (!page) {
        console.log('  [diag] no BiDi page after tab-open proof; pref/mirror-only assertions.');
        assertNoUpdaterConsoleErrors(counter, seeded.profileDir, label, [
          'Elevation was cancelled',
          'Admin copy helper failed',
        ]);
        // The deny must come off BEFORE the config read (observed 2026-09-22:
        // even a read can EPERM while the deny ACE is applied). The finally's
        // removal is idempotent, so a plain second attempt after this is safe.
        try {
          icacls([seededFiles[0], '/remove:d', process.env.USERNAME]);
        } catch {
          /* restored again in the finally */
        }
        let configAfterNoPage = null;
        try {
          configAfterNoPage = fs.readFileSync(seededFiles[0]);
        } catch (err) {
          check(counter, false, `GreD config readable (${label})`, err.message);
        }
        if (configAfterNoPage) {
          check(
            counter,
            configAfterNoPage.equals(configBefore),
            `GreD config unchanged (no copy without elevation, ${label})`
          );
        }
        return seeded.profileDir;
      }
      check(counter, clicked, `config install clicked (${label})`);

      // Completion: the flow must END. Pass = verification ran on the stand-in
      // bytes and the flow reached the elevation step (which fails/cancels
      // headless). TWO completion channels, whichever fires first:
      // - the console mirror's terminal error (logError → installConfig's
      //   catch) — event-driven, lands the moment it happens where the mirror
      //   writes (verified locally; CI legs are a separate root cause, #292);
      // - the tab's progress DOM completing (progress hidden or error shown)
      //   — the historically CI-proven channel. A host-side in-page evaluate
      //   is impossible (waitForCondition requires a Page — #292), so the DOM
      //   check rides along via findPageByUrl's live handle every 500ms tick.
      const flowDeadline = Date.now() + 60_000;
      let finished = false;
      while (Date.now() < flowDeadline) {
        if (
          mirrorHasMarker(seeded.profileDir, 'Elevation was cancelled') ||
          mirrorHasMarker(seeded.profileDir, 'Admin copy helper failed')
        ) {
          finished = true;
          break;
        }
        const live =
          page && !page.isClosed() ?
            page
          : await findPageByUrl(browser, UPDATER_URL, 500).catch(() => null);
        page = live || page;
        if (live) {
          finished = await live
            .evaluate(() => {
              const progress = document.getElementById('card-progress');
              const err = document.getElementById('card-progress-error');
              return Boolean(progress?.hidden || err?.style.display !== 'none');
            })
            .catch(() => false);
          if (finished) break;
        }
      }
      check(counter, finished, `config install flow finished (${label})`);

      // THE assertion: no 'failed checksum verification' console error — the
      // mojibake bug's exact signature. Asserted directly (not via the
      // allowlist net) so a regression cannot hide behind an allowlist entry.
      let mirrorText;
      try {
        mirrorText = fs.readFileSync(path.join(seeded.profileDir, 'e2e-console.log'), 'utf-8');
      } catch {
        mirrorText = '';
      }
      check(
        counter,
        !mirrorText.includes('failed checksum verification'),
        `helper checksum verification passed (${label})`,
        mirrorText.includes('failed checksum verification') ?
          'the tab refused the stand-in helper — checksum conversion regressed'
        : undefined
      );
      // And no other updater errors either (the generic net). On a headless
      // runner the flow legitimately dies at elevation — either "Elevation
      // was cancelled" (real helper + declined UAC) or "Admin copy helper
      // failed (exit code N)" (spawn/copy failure, e.g. this scenario's
      // stand-in bytes) — both via logError('install config'). Expected.
      assertNoUpdaterConsoleErrors(counter, seeded.profileDir, label, [
        'Elevation was cancelled',
        'Admin copy helper failed',
      ]);
    } finally {
      await manifestServer.close().catch(() => {});
      try {
        await closeBrowser(browser);
      } catch {
        /* ignore */
      }
      if (aclDenied) {
        for (const f of seededFiles) {
          try {
            icacls([f, '/remove:d', process.env.USERNAME]);
          } catch (err) {
            check(counter, false, `GreD ACL restored (${label})`, err.message);
          }
        }
      }
    }

    // GreD untouched: a verified helper that could not elevate must not copy.
    // configBefore was captured pre-deny, so the read here is unblocked.
    const configAfter = fs.readFileSync(seededFiles[0]);
    check(
      counter,
      configAfter.equals(configBefore),
      `GreD config unchanged (no copy without elevation, ${label})`
    );

    return seeded.profileDir;
  } finally {
    rmDir(scratch);
  }
}

/**
 * Scenario 10 — timer regression (#292): the daily in-session re-check must
 * actually fire.
 *
 * History: for the updater's entire lifetime the re-check never ran —
 * initScriptsUpdater called the window-bound setInterval global, which does not
 * exist in a chrome ESM's module scope; the ReferenceError (thrown after the
 * startup check had returned) was swallowed by userChrome.js's silent catch.
 * Every browser start re-ran the startup check, so the only observable was a
 * missing daily re-check — invisible to any test that only asserts tab-open
 * behavior. This scenario pins the fix (session-lifetime nsITimer).
 *
 * Mechanism: the scheduler runs its check on a prefs-gated cadence and the
 * shipped interval is 24h — too slow to observe. So the harness patches the
 * EXTRACTED scheduler's CHECK_INTERVAL_MS down to 4s (host-side string replace,
 * before launch), serves a fully up-to-date manifest built from the PATCHED
 * tree (nothing to surface → no tab, gates stay clear), and counts manifest
 * fetches: startup check + N timer fires in the observation window. On the
 * pre-fix code this scenario measured exactly 1 fetch (startup only); with the
 * fix it grows with the window.
 *
 * Assertions:
 *
 * - served >= 3 (startup + >= 2 timer fires inside the ~9s window): the timer
 *   demonstrably re-runs checkForUpdates within one browser session.
 * - no tab, no daily gates set: the re-check is pref-gated (same-day no-op for
 *   the tab path) — the timer must not nag the user between daily gates.
 */
async function runTimerRegressionScenario(counter, opts, snapshotDir, label) {
  console.log(`\n## Scenario: ${label}`);
  const firefoxBin = opts.firefox || discoverFirefoxBinary();
  if (!firefoxBin) throw new Error('Firefox not found');

  const t0 = Date.now();
  const seeded = seedProfile(snapshotDir, {});
  // Seed the GreD HERE — never rely on a previous scenario having done it
  // (review on #310): standalone (`--scenario 10`) on a clean install there is
  // no fx-folder config.js in the GreD, autoconfig never loads the loader, the
  // manifest server sees 0 requests, and the scenario fails for a reason that
  // has nothing to do with the timer.
  const greDir10 = findGreDir(firefoxBin);
  const greSeed10 = installFxFolder(snapshotDir, greDir10);
  check(counter, greSeed10.ok, `seed GreD (${label})`, greSeed10.error);
  try {
    // Patch the extracted scheduler: 24h → 4s (host-side, pre-launch). The
    // snapshot's utils.zip may predate the source tree (e.g. built before a
    // scheduler fix landed), so first overwrite the extracted module from
    // REPO_ROOT/core — this scenario tests the CURRENT source. If the constant
    // is ever renamed this fails LOUDLY here instead of silently measuring
    // only the startup fetch.
    const schedPath = path.join(seeded.chromeUtils, 'updater', 'scriptsUpdater.sys.mjs');
    const repoSched = path.join(
      REPO_ROOT,
      'core',
      'chrome',
      'utils',
      'updater',
      'scriptsUpdater.sys.mjs'
    );
    const schedSrc = fs.readFileSync(repoSched, 'utf8');
    const patched = schedSrc.replace(
      'const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;',
      'const CHECK_INTERVAL_MS = 4000;'
    );
    if (patched === schedSrc) {
      throw new Error(
        'timer scenario: CHECK_INTERVAL_MS declaration not found in scriptsUpdater.sys.mjs — ' +
          'the constant was renamed; update this scenario'
      );
    }
    fs.writeFileSync(schedPath, patched);

    // Serve an UP-TO-DATE manifest built from the PATCHED tree: the check
    // succeeds, finds nothing to surface, and never opens the tab — leaving
    // the fetch counter as the only timer observable.
    const server = await startLocalManifestServer(snapshotDir, seeded.chromeUtils, {
      multiRequest: true,
      manifestOverride: buildTreeManifest(seeded.chromeUtils),
    });
    Object.assign(seeded.prefs, serverOverridePrefs(server.url));

    let browser;
    try {
      browser = await launchFirefox(firefoxBin, seeded.profileDir, {
        headless: opts.headless,
        extraPrefsFirefox: seeded.prefs,
      });
      attachProcessLogging(browser, label);
      const browserReady = await waitForFirstPage(browser, 20_000);
      check(counter, browserReady, `browser ready (${label})`);

      // Observation window: startup check lands with the first window; ~9 s
      // then allows the 4s timer 2 fires beyond it. Generous to scheduler
      // startup jitter; small enough to keep the leg cheap.
      await new Promise(r => setTimeout(r, 9_000));
      const served = server.servedCount();
      check(
        counter,
        served >= 3,
        `daily re-check timer fires (startup + >=2 re-fetches, got ${served}, ${label})`,
        served < 3 ?
          'manifest fetched only ' + served + 'x — the in-session re-check did not run'
        : ''
      );

      // The re-check must stay pref-gated: an up-to-date tree surfaces
      // nothing, so no tab may open and the daily gates stay unset.
      const page = await findPageByUrl(browser, UPDATER_URL, 1_000).catch(() => null);
      check(counter, !page, `no updater tab when up to date (${label})`);
      check(counter, !greShownToday(seeded.profileDir), `daily tab gate untouched (${label})`);
      console.log(`  [timing] timer scenario wall: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    } finally {
      try {
        await closeBrowser(browser);
      } catch {
        /* ignore */
      }
      await server.close().catch(() => {});
    }
  } finally {
    if (!opts.keepProfile) rmDir(seeded.profileDir);
    else console.log(`  [keep] profile: ${seeded.profileDir}`);
  }
  return null;
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
  const greDir = findGreDir(firefoxBin);
  console.log(`  GreD:    ${greDir}`);
  // Every seeded scenario copies fx-folder's config.js into GreD first (the
  // scheduler cannot run without it), so a GreD this account cannot write means
  // nothing can be tested. Fail once, with the fix, instead of a wall of EPERM
  // failures: use a user-owned (portable) Firefox. CI's runners are admins,
  // which is why the CI legs can seed into Program Files.
  const greIssue = greNotWritableReason(greDir);
  if (greIssue) {
    // Warn, never hard-stop: some hosts legitimately can write where this
    // probe cannot (and vice versa — platform quirks must not decide whether a
    // leg runs). The scenarios report their own seeding failure when it does
    // bite, with the same recipe to fix it.
    console.error(
      `  WARNING: GreD is not writable here — ${greIssue}\n` +
        '  The updater scenarios seed config.js into the browser install dir; if they\n' +
        '  fail with EPERM they need a user-owned Firefox: a portable copy\n' +
        '  (`PORTABLE_BROWSER_DIR`, see test/e2e/shared/downloads.mjs) or\n' +
        '  `--firefox <portable firefox.exe>`. An installed browser under\n' +
        '  Program Files needs an elevated account.'
    );
  }

  // Scenario 9 (helper-checksum-win) is in the default set (Windows-only; it
  // self-skips elsewhere): ACL-denied GreD config files force the updater down
  // the admin-copy-helper path, so it guards the scheduler's decision and the
  // no-copy-without-elevation rule. Two fixture defects made it assert nothing
  // until 2026-09-22 (every Windows leg red, locally too):
  //
  // 1. the seeded profile had no updater UI on disk, so the scheduler's
  //    ensureUpdaterUi() tried to fetch updater-ui.zip from this fixture's
  //    file:// scratch base, failed, and exited BEFORE opening the tab;
  // 2. the manifest it was served declared `fx-folder: {hash:'', files:[]}`,
  //    which removes the very staleness the scenario exists to produce.
  //
  // Both are fixed in runHelperChecksumScenario (UI seeded from updater-ui.zip,
  // manifest served from the snapshot's own hashes.json), and the tab-open
  // proof now also accepts the shutdown-flushed pref when BiDi cannot enumerate
  // the trusted tab. What a headless CI run still cannot reach is elevation
  // itself — the helper's byte-level gate is covered deterministically by
  // test/unit/publish/branchPagesContract.test.mjs on every OS.
  const scenarios = opts.scenarios || ['1', '4', '5', '6', '7', '8', '9', '10'];

  const profiles = [];
  // Scenario 7 → 8 state hand-off (launch-reuse prototype). Populated by
  // step 7 when it runs; consumed (and cleared) by step 8 in the same pass.
  let handoff = null;
  // Scenario 4 → 5 state hand-off (same prototype): the no-tab legs re-seed
  // identical profiles, so step 5 can continue on step 4's.
  let noTabHandoff = null;

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
          // When 5 follows in the same selection, hand 4's end state to 5
          // (launch-reuse prototype): one profile, one GreD seed, one fewer
          // fresh-profile build. Scenario 4's standalone behavior and
          // assertions are unchanged.
          const state = await runNoTabScenario(counter, opts, snapshotDir, 'up-to-date', {
            skipUtils: false,
            skipConfig: false,
          });
          profiles.push(handoffProfileDir(state));
          // Only a FULL state carries the reuse fields; an early-exit string
          // (or partial object) leaves noTabHandoff null and step 5 seeds its
          // own profile instead of consuming undefined chromeUtils/prefs.
          noTabHandoff = fullHandoffState(state);
        },
      },
      {
        id: '5',
        run: async () => {
          const reuse = scenarios.includes('4') ? noTabHandoff : null;
          noTabHandoff = null;
          profiles.push(
            handoffProfileDir(
              await runNoTabScenario(
                counter,
                opts,
                snapshotDir,
                'skipped',
                {skipUtils: true, forceUtilsStale: true},
                reuse
              )
            )
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
          // When 8 follows in the same selection, hand 7's end state to 8
          // (launch-reuse prototype): one profile, one GreD seed, one fewer
          // full browser launch chain. Scenario 7's standalone behavior and
          // assertions are unchanged.
          const state = await runManualInstallScenario(
            counter,
            opts,
            snapshotDir,
            'manual-install-upgrade'
          );
          profiles.push(handoffProfileDir(state));
          // Full state only — same guard as scenario 4 (see fullHandoffState).
          handoff = fullHandoffState(state);
        },
      },
      {
        id: '8',
        run: async () => {
          const reuse = scenarios.includes('7') ? handoff : null;
          handoff = null;
          profiles.push(
            handoffProfileDir(
              await runManualInstallNoUiScenario(
                counter,
                opts,
                snapshotDir,
                'manual-install-no-ui',
                reuse
              )
            )
          );
        },
      },
      {
        id: '9',
        run: async () => {
          // Same startup-race retry as scenario 1: the tab-open proof waits on
          // the scheduler's first tick + Firefox's lazy prefs.js flush; on a
          // busy runner either can miss the window (observed locally 2026-09-22:
          // green → red → red on identical code). A fresh profile + relaunch
          // is the proven remedy.
          const failedBefore = counter.failed;
          // Both attempts' profiles are pushed for centralized cleanup — the
          // failed attempt's stays on disk until the run ends for post-mortem
          // (same contract as scenario 1's createdProfiles). The counter is
          // deliberately SHARED: attempt 1's failures stay in the tally, so a
          // retry can never turn a real regression green (docs/DEVELOPING.md).
          profiles.push(
            await runHelperChecksumScenario(counter, opts, snapshotDir, 'helper-checksum-win')
          );
          if (counter.failed > failedBefore) {
            console.log('  [diag] attempt 1 failed — retrying scenario 9 with a fresh profile');
            profiles.push(
              await runHelperChecksumScenario(counter, opts, snapshotDir, 'helper-checksum-win')
            );
          }
        },
      },
      {
        id: '10',
        run: async () => {
          // Timer regression (#292): the daily in-session re-check must fire.
          // No retry — a missed timer is deterministic (module-level bug), not
          // a startup race; a retry would only mask a real regression.
          await runTimerRegressionScenario(counter, opts, snapshotDir, 'daily-recheck-timer');
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
