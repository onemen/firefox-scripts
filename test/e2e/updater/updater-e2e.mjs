#!/usr/bin/env node
/**
 * Updater E2E test — puppeteer-core + WebDriver BiDi.
 *
 * Verifies the in-browser updater tab (chrome://firefox-scripts/content/ui/
 * updater.html) renders the correct state for every package-status combination
 * and all user actions work:
 *
 * Scenario 1 (variant session, merged per #197 and #309): ONE browser drives
 * every state-only variant — utils-stale → config-stale → both-stale →
 * up-to-date → skipped — by mutating the fixtures on disk and in prefs between
 * in-browser orchestrator calls (driver mode: the harness calls the exported
 * checkForUpdates() from a privileged page; see
 * test/e2e/shared/updaterDriver.mjs). The browser launch is kept for the
 * startup wiring itself (autoconfig → userChrome.js → observer →
 * initScriptsUpdater → the tab the stale seed asks for); every variant after
 * that asserts what ITS check did — the scheduler's tab-open decision, the
 * daily-gate write on the up-to-date path, and the card the resulting tab
 * renders (identity, all 8 buttons, checkbox wiring, skip checkbox, no
 * page/console errors, screenshot). The ids 4/5 (up-to-date, skipped) are
 * aliases of this session — they are its last two variants now, and where the
 * driver realm cannot come up the session falls back to the pre-#309 path for
 * each part: the stale trio re-renders in-tab (assertStaleTrioInTab), while
 * up-to-date/skipped run as their own launches (runNoTabScenario). Scenario 6
 * (install-applies): click btn-install and assert the packages are actually
 * copied to disk (issue #37); under Snap the config package is never offered
 * in-tab — the checkbox is hidden and the manual-install band shown, so the run
 * installs utils only and asserts the config files stay untouched Scenario 7
 * (manual-install-upgrade): a hand-installed utils.zip brings the updater — no
 * tab with a pre-updater utils, tab after replacing it (issue #53) Scenario 8
 * (manual-install-no-ui): a hand-installed utils.zip ships NO ui folder (the
 * tab UI lives in the separate updater-ui.zip); after a fresh check the
 * scheduler self-installs the ui (ensureUpdaterUi) and the tab is visible
 * (issue #102) Scenario 9 (helper-checksum-win, Windows-only): ACL-write-denies
 * GreD so the config install falls through to the elevated-copy helper, and
 * asserts the downloaded helper's checksum verification PASSES before the
 * (headless-doomed) elevation step — the PR #271 mojibake regression net.
 * Requires a user-owned GreD (CI's portable installs; skips on admin-owned dirs
 * like Program Files, which cannot be denied without elevation)
 *
 * Each remaining scenario: fresh temp profile → seed utils + fx-folder → modify
 * files to force desired state → launch Firefox → wait for tab (or assert none)
 * → run assertions → close. The variant session (scenario 1) keeps ONE session
 * across all five variants; a startup flake there would fail them all at once,
 * so it is wrapped in a retry-once-with-fresh-profile guard ([retry] logged
 * separately — a real regression still fails the leg).
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
  pollUntil,
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
  missingFirefoxMessage,
} from '../shared/browsers.mjs';
import {
  closeBrowser,
  killStrayProcesses,
  removeProfileCompatibilityIni,
} from '../shared/processHygiene.mjs';
import {
  UPDATER_URL,
  DRIVER_URL,
  installDriverPage,
  openDriverTab,
  attachDriver,
  findUpdaterPage,
} from '../shared/updaterDriver.mjs';
import {buildSession, mozLz4} from '../shared/sessionFile.mjs';

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
  // Unicode-safe writes: nsIFileOutputStream.write treats each JS char code as
  // ONE byte, so any char above U+00FF arrives mangled (em-dash U+2014 became
  // byte 0x14 on CI, 2026-09-23) and breaks allowlist matching on
  // assertion-critical lines. Every line goes through UTF-8 first, so non-ASCII
  // in updater messages survives the mirror and the harness reads back the
  // exact text. TextEncoder with a manual UTF-8 fallback (the autoconfig
  // sandbox exposes it on every supported channel — ESR 140 floor — but the
  // fallback keeps the probe runnable on anything exotic).
  const utf8Bytes =
    typeof TextEncoder === 'function' ?
      s => new TextEncoder().encode(s)
    : s => {
        const out = [];
        for (let i = 0; i < s.length; i++) {
          let c = s.charCodeAt(i);
          if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
            const lo = s.charCodeAt(i + 1);
            if (lo >= 0xdc00 && lo <= 0xdfff) {
              c = 0x10000 + ((c - 0xd800) << 10) + (lo - 0xdc00);
              i++;
            }
          }
          if (c < 0x80) out.push(c);
          else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
          else if (c < 0x10000)
            out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
          else
            out.push(
              0xf0 | (c >> 18),
              0x80 | ((c >> 12) & 63),
              0x80 | ((c >> 6) & 63),
              0x80 | (c & 63)
            );
        }
        return Uint8Array.from(out);
      };
  const bos = Cc['@mozilla.org/binaryoutputstream;1'].createInstance(
    Ci.nsIBinaryOutputStream
  );
  bos.setOutputStream(fos);
  // writeByteArray, NOT writeBytes: writeBytes' IDL takes an opaque string
  // (one char = one byte — the exact char-code trap this fixes), while
  // writeByteArray takes [array,size_is] in uint8_t — a plain number Array.
  // (A Uint8Array through writeBytes throws "String does not have as many
  // characters" — proven in the autoconfig sandbox, 2026-09-23.)
  const writeUtf8 = s => {
    const bytes = utf8Bytes(s);
    bos.writeByteArray(Array.from(bytes), bytes.length);
  };
  writeUtf8('MIRROR-OPEN' + String.fromCharCode(10));
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
        writeUtf8(out);
      } catch (e) {}
    },
  });
  // SessionStore's restore notifications, mirrored so a scenario can assert the
  // module's event-driven twin guard has a real trigger on this engine (it
  // reacts to sessionstore-one-or-no-tab-restored; the old implementation
  // polled). Purely observational here — the module observes the same topics
  // itself, in its own module scope.
  try {
    const obsSvc = Cc['@mozilla.org/observer-service;1'].getService(Ci.nsIObserverService);
    const obsSentinel = {observe: (subject, topic) => writeUtf8('SS-NOTIFY ' + topic + '\\n')};
    obsSvc.addObserver(obsSentinel, 'sessionstore-one-or-no-tab-restored');
    obsSvc.addObserver(obsSentinel, 'sessionstore-windows-restored');
  } catch (e) {}
  // Watch for the updater tab and record the moment it appears — WebDriver
  // BiDi cannot reliably enumerate trusted chrome:// tabs on CI.
  let polls = 0;
  let lastCount = 0;
  let tabSeen = false;
  let lastTabSet = '';
  let engineDone = false;
  const watcher = Cc['@mozilla.org/timer;1'].createInstance(Ci.nsITimer);
  watcher.initWithCallback(
    {
      notify() {
        try {
          // Long-lived watch (4 min of 1 s polls): scenario 11 awaits up to
          // 45 s + 30 s of mirror lines while the restore settles. The probe
          // dies with the browser either way; the scenario's own timeouts
          // govern.
          if (++polls > 240) {
            watcher.cancel();
            return;
          }
          // All windows (#384): a restored session can hold the updater tab
          // in a NON-focused window, which a most-recent-window scan never
          // sees. WINDOW-COUNT on change is the both-windows-restored proof
          // the session-restore scenario (11) asserts.
          let wcount = 0;
          const wins = Services.wm.getEnumerator('navigator:browser');
          const updaterSpecs = [];
          while (wins.hasMoreElements()) {
            wcount++;
            const w = wins.getNext();
            for (const tab of w?.gBrowser?.tabs || []) {
              const spec = tab.linkedBrowser?.currentURI?.spec || '';
              if (spec.startsWith('chrome://firefox-scripts/content/ui/')) {
                // '*' = scheduler-marked startup tab — the TAB_SET lines then
                // say WHICH tab survived a twin race, not just how many.
                updaterSpecs.push(tab._scriptsUpdateTab ? spec + '*' : spec);
              }
            }
          }
          if (wcount !== lastCount) {
            lastCount = wcount;
            writeUtf8('WINDOW-COUNT ' + wcount + '\\n');
          }
          // The whole updater-tab SET on every change (not a once-only
          // "opened" flag): the session-restore scenario asserts a FINAL state
          // of exactly one tab, and the road there can legitimately include a
          // transient twin (restored tab materializing after the guard's
          // scan, then removed on SessionStore's per-restored-tab notice).
          const tabSet = updaterSpecs.join(' | ') || '(none)';
          if (tabSet !== lastTabSet) {
            lastTabSet = tabSet;
            writeUtf8('TAB_SET ' + new Date().toISOString() + ' ' + tabSet + '\\n');
          }
          if (updaterSpecs.length > 0 && !tabSeen) {
            tabSeen = true;
            // First-seen marker (scenario 1/12's fast tab proof and
            // mirrorSaysTabOpened's BiDi-grace decision still read it).
            writeUtf8(
              'TAB_OPENED ' +
                new Date().toISOString() +
                ' ' +
                updaterSpecs.join(' | ') +
                '\\n'
            );
          }
          // The tab ENGINE's re-check (updater.js engineInit) writes the daily
          // pref once its check completes — that lands AFTER the tab appears,
          // so this probe must run on EVERY poll, not only the first-seen one
          // (a first-poll-only check would never see the late write, and every
          // ENGINE-DONE await would run its full 30 s for nothing). Mirror it
          // as ENGINE-DONE so scenario 11 awaits the engine instead of
          // guessing a sleep (the pref only reaches prefs.js
          // at the shutdown flush, so the LIVE value is the only timely
          // signal). The watcher keeps polling after it (once per engine, not
          // once per poll): scenario 11 asserts the FINAL tab set, which can
          // still change after the engine — a late twin materializing and the
          // guard removing it on the next notice both land after ENGINE-DONE,
          // and a cancelled watcher would freeze the last TAB_SET and hide
          // exactly the race under test (2026-10-01 ESR 140 CI run).
          try {
            const shownDay = Services.prefs.getCharPref(
              'extensions.firefox-scripts.lastScriptsCheckDate',
              ''
            );
            if (shownDay && !engineDone) {
              engineDone = true;
              writeUtf8('ENGINE-DONE ' + shownDay + String.fromCharCode(10));
            }
          } catch (e) {}
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
        'Usage: node updater-e2e.mjs --firefox <path> --snapshot <dir> [--scenario 1,6,9] [--repeat 2]\n' +
          '  Scenarios: 1 variant session (stale trio + up-to-date + skipped; 4/5 are aliases),\n' +
          '             6 install-applies, 7 manual-install-upgrade, 8 manual-install-no-ui,\n' +
          '             9 helper-checksum-win, 10 daily-recheck-timer,\n' +
          '             11 session-restore (#384).'
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
    // A single empty-string seed clears the daily gate on every launch (the
    // pref is re-applied from the launch set, overriding anything the profile
    // persisted) — a reused profile re-runs the check instead of inheriting a
    // previous session's rate limit.
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
 * the launch-reuse hand-off of the fallback path (up-to-date → skipped): launch
 * prefs re-inject on every start, so a reused profile needs the same pref
 * deltas a fresh seed would have written, sourced from the same manifest.
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

/**
 * Assert the snapshot's generated identity is a LOCAL build. The snapshot is
 * produced by `pnpm snapshot:dev` (a --local build), whose entire contract is
 * self-containment: file:// URLs into the snapshot dir. If the generated
 * updater-config.sys.mjs instead bakes the GitHub URLs (IS_LOCAL false), the
 * build pipeline lost its mode flags somewhere — the 2026-09-25 regression,
 * where the Makefile's dates rule re-baked _config.h as prod after `config` had
 * written the local variant. Previously log-only ([diag]); a prod-baked
 * snapshot passed every leg because localConfigOverrides then re-pointed the
 * updater at this runner's copy, masking the wrong identity.
 */
function assertBakedLocalIdentity(snapshotDir) {
  const staging = tempDir('fxs-ident');
  try {
    const utilsZip = findZip(snapshotDir, ['utils.zip', 'utils-dev.zip']);
    if (!utilsZip) throw new Error('no utils zip in snapshot');
    extractZip(utilsZip, staging);
    const cfgPath = path.join(staging, 'updater', 'updater-config.sys.mjs');
    if (!fs.existsSync(cfgPath)) throw new Error('updater-config.sys.mjs not in utils zip');
    const cfg = fs.readFileSync(cfgPath, 'utf-8');
    const isLocal = /^\s*IS_LOCAL: true,/m.test(cfg);
    // Whitespace-tolerant: the generator wraps `KEY: 'value',` onto two lines
    // once the line passes prettier's printWidth (long snapshot paths), so the
    // single-line spelling is not the only legal rendering (helpers.mjs's
    // localConfigOverrides already reads it this way).
    const localPath = cfg.match(/LOCAL_DIST_PATH:\s*'([^']*)'/)?.[1] || '';
    // The baked path must name THIS snapshot, not just any local one — a stale
    // generator run bakes a valid-looking but foreign dist path (review:batch
    // finding, PR #329). Basename-only: cross-OS legs see a different parent.
    const bakedBasename = path.basename(localPath.replace(/\/$/, ''));
    const wantBasename = path.basename(snapshotDir);
    if (!isLocal || !localPath || bakedBasename !== wantBasename) {
      throw new Error(
        'snapshot utils.zip carries a NON-local or FOREIGN baked updater config ' +
          `(IS_LOCAL: ${isLocal}, LOCAL_DIST_PATH: '${localPath}', ` +
          `expected basename '${wantBasename}') — the build lost or mismatched its ` +
          '--local identity (2026-09-25 regression class). Fix the generator flag ' +
          'passthrough (installer/Makefile CONFIG_GENERATOR rules), not this test.'
      );
    }
    console.log(`  [ident] baked local identity OK (LOCAL_DIST_PATH=${localPath})`);
  } finally {
    rmDir(staging);
  }
}

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
 * A lastScriptsCheckDate=today pref proves the scheduler ran — it either tried
 * to show the tab (pending update) or verified everything up to date; an empty
 * dump means the autoconfig/loader never ran at all.
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
  return readMirror(profileDir).includes(marker);
}

/** True when the probe's watcher has recorded TAB_OPENED in the mirror log. */
function mirrorSaysTabOpened(profileDir) {
  return mirrorHasMarker(profileDir, 'TAB_OPENED');
}

/**
 * BiDi keeps polling this long after the mirror proves the tab before giving
 * up. The probe's watcher polls once a second, so the mirror routinely reaches
 * the harness BEFORE BiDi enumerates the trusted tab: at 2 s the variant
 * session lost its page handle to that race often enough to fall back to "BiDi
 * cannot attach" (observed locally 2026-09-27 — the same session attached on
 * the next run). The wait is still bounded by the caller's deadline, and the
 * mirror only proves the tab exists — the handle is what the card assertions
 * and the #309 driver need, so the grace buys their assertions for a couple of
 * seconds of bounded waiting.
 */
const TAB_OPEN_BIDI_GRACE_MS = 2_000;
const DRIVER_BIDI_GRACE_MS = 15_000;

/**
 * Shared tab-open wait for the scenarios that poll BiDi AND the probe's
 * TAB_OPENED mirror line (install-applies, manual-install,
 * manual-install-no-ui).
 *
 * One iteration is a BiDi pages() enumeration plus a 500 ms tick; the wait ends
 * the moment the updater page handle is enumerable. When the mirror proves the
 * tab first, BiDi gets a short grace window (it may enumerate the chrome tab
 * late on headed local runs) and then the wait returns null — the caller falls
 * back to its disk/pref activation proof instead of burning the remaining
 * deadline. This replaces the shape where the sticky TAB_OPENED marker made
 * every remaining iteration take the 2 s late branch + tick, so the loop always
 * ran its full 30 s on CI (where BiDi never attaches to a trusted chrome://
 * tab): ~25 s of dead air per scenario (2026-09-23 leg data).
 *
 * @param {import('puppeteer-core').Browser} browser
 * @param {string} profileDir - seeded profile dir (probe mirror log location)
 * @param {number} deadlineMs - epoch ms bounding the whole wait
 * @param {number} [graceMs] - how long BiDi keeps looking after the mirror
 *   signal (default TAB_OPEN_BIDI_GRACE_MS; the driver session passes the
 *   longer DRIVER_BIDI_GRACE_MS because it cannot run without the page handle)
 * @returns {Promise<import('puppeteer-core').Page | null>} the updater page
 *   once BiDi enumerates it, or null when only the mirror proved the tab (or
 *   nothing did) — callers treat null as "use the disk/pref proof"
 */
async function waitForUpdaterTabOpen(
  browser,
  profileDir,
  deadlineMs,
  graceMs = TAB_OPEN_BIDI_GRACE_MS
) {
  let mirrorAt = 0;
  while (Date.now() < deadlineMs) {
    try {
      const page = (await browser.pages()).find(p => {
        try {
          return p.url().startsWith(UPDATER_URL);
        } catch {
          return false;
        }
      });
      if (page) return page;
    } catch {
      /* browser not ready yet */
    }
    if (!mirrorAt && mirrorSaysTabOpened(profileDir)) {
      mirrorAt = Date.now();
      console.log(
        '  [diag] mirror recorded TAB_OPENED — polling BiDi for a short grace window only'
      );
    }
    if (mirrorAt && Date.now() - mirrorAt >= graceMs) {
      console.log(
        `  [diag] BiDi did not attach within ${graceMs / 1000}s of the mirror ` +
          'signal — ending the wait; the scenario falls back to its disk/pref activation proof'
      );
      return null;
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return null;
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
    //
    // logError additionally routes through Services.console.logStringMessage
    // (#292 fix): those lines carry NO source and NO level marker — plain
    // "<ISO> Firefox Scripts updater: <msg>". Count them as hits too (they are
    // updater-tab errors by definition); the allowlist exemption below then
    // decides per-scenario whether the line is expected.
    const srcMatch = / \[(chrome:\/\/[^\]:]+[^\]]*?):\d+\]/.exec(rest);
    const source = srcMatch ? srcMatch[1] : '';
    const level = levelMatch ? levelMatch[1] : '';
    const routed = /^\S+ Firefox Scripts updater: /.test(line);
    const hit = routed || source.includes('chrome://firefox-scripts');
    if (!hit) continue;
    // Allowlist matches the FULL line (source AND message): scenario 9's
    // expected headless-elevation failure IS a chrome://firefox-scripts
    // logError and must be exemptable without masking any other error.
    if (allows.some(re => re.test(line))) continue;
    hits.push({line: line.trim(), level, source});
  }
  return hits;
}

/**
 * Assert the console mirror recorded zero errors from the updater scripts. Two
 * line shapes count as ours (2026-09-23):
 *
 * - script errors sourced from chrome://firefox-scripts/.../updater/* (the engine
 *   module and the tab's updater.js/updater-ui.js), and
 * - the logStringMessage-routed logError lines (#292 fix) — ConsoleAPI
 *   (console.error) never reaches the console service, so the tab's logError
 *   now also emits a plain "Firefox Scripts updater: <msg>" line that carries
 *   no source; the stable prefix is the marker. The 2026-09-20 manual session
 *   caught TWO shipped bugs as console errors (helper checksum mojibake,
 *   CSP-blocked inline style) that green CI never saw — every updater scenario
 *   now closes the net.
 *
 * Allow patterns match the FULL mirror line: other components legitimately
 * error (e.g. blocked processes under the harness), and scenarios that
 * deliberately drive logError (elevation cancelled, helper failure) exempt
 * those exact expected messages — only chrome://firefox-scripts sources and the
 * routed updater prefix are ours.
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
 * True when prefs.js records lastScriptsCheckDate = today — the single daily
 * pref (ADR 0012). On a pending-update day the TAB writes it once shown, so it
 * still proves the tab was opened even when WebDriver BiDi cannot enumerate
 * trusted chrome:// tabs. (On an up-to-date day the scheduler writes it instead
 * — the scenario decides which meaning applies.)
 */
function greShownToday(profileDir) {
  try {
    const prefs = fs.readFileSync(path.join(profileDir, 'prefs.js'), 'utf-8');
    const match = prefs.match(
      /user_pref\("extensions\.firefox-scripts\.lastScriptsCheckDate", "([^"]*)"\)/
    );
    return match?.[1] === new Date().toISOString().slice(0, 10);
  } catch {
    return false;
  }
}

/**
 * Every variant the driver session drives (#309): the DISK fixture applied
 * before the check, and the tab state the resulting UI must render.
 *
 * The two differ for `skipped`: the disk is genuinely stale (that is what the
 * skip pref has to suppress), while the UI — which renders the check's
 * decision, not the disk — must show both packages OK.
 *
 * @type {Record<
 *   string,
 *   {
 *     disk: {utilsStale: boolean; configStale: boolean};
 *     ui: {utilsStale: boolean; configStale: boolean};
 *     skipUtils: boolean;
 *   }
 * >}
 */
const VARIANT_SPECS = {
  'utils-stale': {
    disk: {utilsStale: true, configStale: false},
    ui: {utilsStale: true, configStale: false},
    skipUtils: false,
  },
  'config-stale': {
    disk: {utilsStale: false, configStale: true},
    ui: {utilsStale: false, configStale: true},
    skipUtils: false,
  },
  'both-stale': {
    disk: {utilsStale: true, configStale: true},
    ui: {utilsStale: true, configStale: true},
    skipUtils: false,
  },
  'up-to-date': {
    disk: {utilsStale: false, configStale: false},
    ui: {utilsStale: false, configStale: false},
    skipUtils: false,
  },
  'skipped': {
    disk: {utilsStale: true, configStale: false},
    ui: {utilsStale: false, configStale: false},
    skipUtils: true,
  },
};

/** The three disk-stale variants — the part of the session driver mode drives. */
const STALE_VARIANTS = ['utils-stale', 'config-stale', 'both-stale'];

/**
 * @param {string} variant
 * @returns {{
 *   disk: {utilsStale: boolean; configStale: boolean};
 *   ui: {utilsStale: boolean; configStale: boolean};
 *   skipUtils: boolean;
 * }}
 */
function variantSpec(variant) {
  const spec = VARIANT_SPECS[variant];
  if (!spec) throw new Error(`unknown variant: ${variant}`);
  return spec;
}

/**
 * One variant's tab state as the UI must show it.
 *
 * @returns {{utilsStale: boolean; configStale: boolean}}
 */
function expectedStaleState(variant) {
  return variantSpec(variant).ui;
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
  const {utilsStale, configStale} = variantSpec(variant).disk;
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
 * Run the full variant card assertions against one live updater tab. Shared by
 * every variant of the driver session (the stale trio, up-to-date and skipped —
 * each in the tab its own check produced or the driver opened) and by the
 * fallback launches; the assertion set is the same everywhere (per-variant
 * labels keep the output attributable). `pageErrors` is owned by the caller
 * (attached before the render it belongs to) and only read here.
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
 * One variant of the driver session: apply the disk fixture and the skip-pref
 * input, run the production check once, assert the decision (tab opened or not,
 * the day recorded), then assert the card in an updater tab.
 *
 * The card surface is the scheduler's OWN tab for the stale variants (that is
 * the production path: addTrustedTab → the tab's engineInit → the rendered
 * card), and a driver-opened tab when the decision was "nothing to do" (the UI
 * must still render the decision's truth — both packages OK, no skip toggles).
 *
 * @param {{passed: number; failed: number}} counter
 * @param {{
 *   driver: object;
 *   browser: object;
 *   firefoxBin: string;
 *   seeded: object;
 *   variant: string;
 *   expectTab: boolean;
 *   pristineConfig: Buffer;
 *   utilsHash: string;
 * }} ctx
 * @returns {Promise<boolean>} false when the variant failed (stop the session)
 */
async function runOneVariant(
  counter,
  {driver, browser, firefoxBin, seeded, variant, expectTab, pristineConfig, utilsHash}
) {
  const {skipUtils} = variantSpec(variant);
  const today = new Date().toISOString().slice(0, 10);

  // The realm can die between variants (the same mid-session death the folded
  // phases degrade on). Probe BEFORE mutating the fixture: a gone realm is the
  // caller's signal to defer what is left, never this variant's failure.
  if (!(await driverAlive(driver))) {
    throw new DriverLostError(`variant ${variant}: pre-check`);
  }

  try {
    applyStaleVariantOnDisk(firefoxBin, seeded, variant, pristineConfig);
  } catch (err) {
    // Disk mutation failed (e.g. GreD became unwritable): record it as the
    // variant's failed check with a readable message and stop the session — the
    // harness still fails fast, so the remaining scenarios are skipped.
    check(counter, false, `variant fixture update (${variant})`, err.message);
    return false;
  }

  // The other input this variant differs in: the per-package skip pref. '' means
  // "no skip" for the check (getCharPref(prefix, '') → falsy).
  await driverCall(driver, `${variant}: setSkip`, () =>
    driver.setSkip('utils', skipUtils ? utilsHash : '')
  );

  const result = await driverCall(driver, `${variant}: check`, () => driver.check());
  if (expectTab) {
    check(
      counter,
      result.opened === 1,
      `${variant}: the check opens the updater tab`,
      JSON.stringify(result)
    );
  } else {
    check(
      counter,
      result.opened === 0,
      `${variant}: the check opens no tab`,
      JSON.stringify(result)
    );
    // The up-to-date path's only writer (#333): a COMPLETED check that found
    // nothing to do records the day. Asserted here, before the card tab below
    // writes it too, so only the scheduler's own write can satisfy it.
    check(
      counter,
      result.gate === today,
      `${variant}: the completed check records the day (#333)`,
      `expected ${today}, got ${JSON.stringify(result.gate)}`
    );
  }

  if (!expectTab) {
    // No tab was opened (correctly): render the card in a tab the harness opens,
    // so the decision is asserted through the real UI, not only through prefs.
    await driverCall(driver, `${variant}: open tab`, () => driver.openUpdaterTab());
  }
  const page = await findUpdaterPage(browser, 15_000);
  if (!page) {
    check(counter, false, `card tab available (${variant})`, 'no updater page was enumerable');
    return false;
  }

  // Errors are collected for the tab that renders this variant's state.
  const pageErrors = [];
  const onErr = err => pageErrors.push(err.message);
  page.on('pageerror', onErr);
  let ok = false;
  try {
    ok = await assertStaleCard(counter, page, variant, pageErrors);
  } catch (err) {
    // A card assertion that throws (evaluate failure, page torn down mid-poll)
    // is this variant's failure, not a harness crash that aborts the run.
    check(counter, false, `card assertions (${variant})`, err.message);
  } finally {
    page.off('pageerror', onErr);
  }

  // Leave no updater tab behind: the next variant's count must measure what its
  // own check opened. Best-effort on a realm that just died: the variant's
  // assertions are already in the tally, and the degrade path re-seeds a fresh
  // profile anyway — swallowing the sentinel here keeps the completed variant
  // completed instead of deferring it a second time. The driverCall wrapper is
  // what PRODUCES that sentinel: a bare call on a dead realm rejects with a raw
  // protocol error (no .driverLost), which would rethrow, escape the session
  // and abort the leg — the exact opposite of the degrade this path exists for
  // (CodeRabbit on #343, 2026-09-30).
  await driverCall(driver, `${variant}: close tabs`, () => driver.closeUpdaterTabs()).catch(err => {
    if (!err?.driverLost) throw err;
  });
  return ok;
}

/**
 * The stale trio as the pre-#309 session asserted it, against the tab the
 * startup check opened: apply the variant's disk fixture → re-render through
 * the engine's own re-check entry point → assert the card.
 *
 * Fallback for a host where BiDi CAN evaluate the updater tab but the driver
 * page's realm never came up (the driver tab did not commit, its script did not
 * run), or for a realm that died after some driver variants already ran: in
 * both cases driver mode cannot drive the orchestrator, so the trio keeps
 * exactly the coverage it had before #309 — which is the point. The coverage
 * collapse is a structure/speed win and must never drop a variant; `variants`
 * names the subset that still needs asserting (defaults to the whole trio).
 *
 * @param {{passed: number; failed: number}} counter
 * @param {{
 *   page: import('puppeteer-core').Page;
 *   firefoxBin: string;
 *   seeded: object;
 *   pristineConfig: Buffer;
 *   variants?: string[];
 * }} ctx
 * @returns {Promise<boolean>} false when a variant failed (stop the trio)
 */
async function assertStaleTrioInTab(counter, {page, firefoxBin, seeded, pristineConfig, variants}) {
  for (const variant of variants ?? STALE_VARIANTS) {
    // Errors are collected per variant, attached BEFORE the reload that
    // triggers this variant's render (same net as the driver path).
    const pageErrors = [];
    const onErr = err => pageErrors.push(err.message);
    page.on('pageerror', onErr);
    try {
      applyStaleVariantOnDisk(firefoxBin, seeded, variant, pristineConfig);
      // Re-render through the production path: UpdaterEngine.init() re-runs the
      // fresh hash check (manifest fetch + local re-hash) and pushes state
      // in-document. A page.reload() was tried first — BiDi cannot observe
      // chrome:// navigations (its waiter times out and the evaluation channel
      // wedges), so the engine's own re-check entry point is the reliable
      // in-document equivalent.
      await page.evaluate(() => window.UpdaterEngine.init());
      if (!(await assertStaleCard(counter, page, variant, pageErrors))) return false;
    } catch (err) {
      // The startup tab's frame can be torn down mid-assertion when the driver
      // realm died with it ("Attempted to use detached Frame" — the tab's own
      // session, not the driver page, is the dead peer in this degrade path).
      // The assertions are NOT lost: this variant goes back to the launch path
      // with the up-to-date/skipped decisions, so a false failure is impossible
      // — record it as a degrade, not a card failure.
      if (/detached Frame/i.test(String(err?.message))) {
        console.log(
          `  [driver] the startup tab's frame died with the realm (${variant}) — deferring to its launch path`
        );
        return false;
      }
      // Disk mutation failed (e.g. GreD became unwritable): this variant's
      // failure, not a harness crash.
      check(counter, false, `card assertions (${variant})`, err.message);
      return false;
    } finally {
      page.off('pageerror', onErr);
    }
  }
  return true;
}

/**
 * The state-only scenarios that used to pay their own browser launch, folded
 * into this session (#309 follow-up): install-applies (#37) and
 * manual-install-no-ui (#102).
 *
 * Both differ from the five variants only in fixture state — a disk flip (stale
 * markers, a removed ui dir) plus, for the no-ui case, the release topology
 * expressed as override prefs — and neither changes the module graph, so
 * neither needs its own process. The driver page drives them exactly as it
 * drives a variant: clear the gate, call the exported checkForUpdates(), assert
 * the decision and the card.
 *
 * Isolation is preserved where it matters: install-applies MUTATES the seeded
 * trees and the GreD config, so it runs AFTER the five variants (which assert
 * those trees), and the no-ui phase re-establishes its own fixture (utils
 * re-staled, ui removed) instead of inheriting the install's fresh state.
 *
 * helper-checksum-win (#271) deliberately stays a separate launch, and run()
 * still runs it as one: it only runs on Windows, where the CI legs cannot
 * attach BiDi to the trusted tab — driver mode is unavailable there, so the
 * session falls back and folding it would save nothing in CI while dragging a
 * scratch-snapshot stand-in helper into every variant's wiring.
 *
 * @param {{passed: number; failed: number}} counter
 * @param {{
 *   driver: object;
 *   browser: object;
 *   firefoxBin: string;
 *   seeded: object;
 *   snapshotDir: string;
 *   greDir: string;
 *   pristineConfig: Buffer;
 * }} ctx
 * @returns {Promise<{ok: boolean}>} false when a folded scenario failed (stop
 *   the session — the failure is deterministic, like a variant failure)
 */
/** Sentinel: the driver realm died mid-session — a degrade, not a test failure. */
class DriverLostError extends Error {
  constructor(where) {
    super(`driver realm unavailable (${where})`);
    this.name = 'DriverLostError';
    this.driverLost = true;
  }
}

/**
 * Liveness probe for the driver realm. Cheap (one evaluate) and BOUNDED: a dead
 * realm, a torn-down tab or a wedged BiDi session all answer `false` instead of
 * hanging the leg for the protocol timeout.
 */
async function driverAlive(driver, timeoutMs = 3_000) {
  let timer;
  try {
    const probe = driver.page
      .evaluate(() => window.UpdaterE2EDriver?.ready() === true)
      .then(
        v => v === true,
        () => false
      );
    const cap = new Promise(resolve => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    return await Promise.race([probe, cap]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run a driver command, converting a realm that is gone — before the call or
 * during it — into a DriverLostError. Any other error propagates: a real bug
 * must still fail the leg.
 */
async function driverCall(driver, where, fn) {
  if (!(await driverAlive(driver))) throw new DriverLostError(where);
  try {
    return await fn();
  } catch (err) {
    if (await driverAlive(driver)) throw err;
    throw new DriverLostError(`${where}: realm died`);
  }
}

/** Bounded poll on an in-page condition (the tab's own re-render is async). */
async function foldedUiCondition(page, fn, what) {
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
}

/**
 * The folded state-only scenarios, in the order they run. Shared with run()'s
 * launch fallback: whatever this list still holds when the session ends is run
 * as its own launch, so the collapse is a speed win, never a coverage trade.
 */
const FOLDED_SCENARIOS = ['install-applies', 'manual-install-no-ui'];

/**
 * Coordinator for the folded scenarios: clear their inputs, run each phase in
 * the session's browser, and DEGRADE instead of failing when the driver realm
 * dies half-way through. A realm that is gone before a phase, or that dies
 * during one, hands that phase (and every phase after it) back to run()'s
 * launch path via `remaining` — the launched scenario seeds its own profile, so
 * a half-applied in-session fixture cannot corrupt it.
 *
 * Assertion failures are NOT degraded: they land in the counter exactly as they
 * did before and fail the leg.
 *
 * @returns {Promise<{
 *   driverLost: boolean;
 *   completed: string[];
 *   remaining: string[];
 * }>}
 */
async function runSessionExtras(counter, ctx) {
  const completed = [];
  try {
    if (!(await driverAlive(ctx.driver))) {
      console.log(
        '  [driver] the realm is already gone — deferring the folded scenarios to their launch path'
      );
      return {driverLost: true, completed, remaining: [...FOLDED_SCENARIOS]};
    }

    // The last variant of the plan is `skipped`, which SET the per-package skip
    // pref (that is how it suppresses the tab). It must not leak into the folded
    // scenarios: the scheduler treats a skipped package as not-update-needed, so
    // with the pref left on, install-applies would silently install config only
    // and the no-ui check would decide "up to date" (reproduced 2026-09-30).
    await driverCall(ctx.driver, 'clear skip prefs', async () => {
      await ctx.driver.setSkip('utils', '');
      // The config package's key is `fx-folder` (addSkipPrefs writes
      // skippedHash.fx-folder; the shipped scheduler reads the same key) —
      // 'config' here would write an unused pref and never clear the real
      // config skip (CodeRabbit on #343, 2026-09-30).
      await ctx.driver.setSkip('fx-folder', '');
    });

    await runFoldedInstallApplies(counter, ctx);
    completed.push('install-applies');
    await runFoldedNoUi(counter, ctx);
    completed.push('manual-install-no-ui');
    return {driverLost: false, completed, remaining: []};
  } catch (err) {
    if (!err?.driverLost) throw err;
    const remaining = FOLDED_SCENARIOS.filter(scenario => !completed.includes(scenario));
    console.log(
      `  [driver] ${err.message} — deferring ${remaining.join(', ') || 'nothing'} to its launch path`
    );
    return {driverLost: true, completed, remaining};
  }
}

/** Folded #37 — install-applies, in the session's browser. */
async function runFoldedInstallApplies(counter, ctx) {
  const {driver, browser, firefoxBin, seeded, snapshotDir, greDir, pristineConfig} = ctx;
  // Snap (strict confinement): the config package lives in /etc/firefox and the
  // confined browser can never write it, so the UI hides the config checkbox
  // and shows the manual-install band — Update installs utils only.
  const isSnap = firefoxBin.includes('/snap/');
  const manifest = JSON.parse(fs.readFileSync(path.join(snapshotDir, 'hashes.json'), 'utf-8'));
  const utilsHash = manifest.utils?.hash;
  const utilsFiles = manifest.utils?.files;
  const configHash = manifest['fx-folder']?.hash;
  const configFiles = manifest['fx-folder']?.files;
  if (!utilsHash || !Array.isArray(utilsFiles) || !configHash || !Array.isArray(configFiles)) {
    check(counter, false, 'manifest has both package hashes+files (folded scenarios)');
    return;
  }

  // ── Folded: install-applies (#37) ────────────────────────────────────────
  // Both packages stale → the tab's Update button copies config then utils and
  // the installed trees re-hash to the manifest. The fixture is the variant
  // session's own (utils marker + GreD probe).
  console.log('\n  ── folded in-session: install-applies (#37) ──');
  try {
    applyStaleVariantOnDisk(firefoxBin, seeded, 'both-stale', pristineConfig);
  } catch (err) {
    check(counter, false, 'install-applies fixture update', err.message);
    return;
  }
  check(
    counter,
    computeInstalledHash(utilsFiles, seeded.chromeUtils) !== utilsHash,
    'pre-install utils hash differs from manifest (install-applies)'
  );
  check(
    counter,
    computeInstalledHash(configFiles, greDir) !== configHash,
    'pre-install config hash differs from manifest (install-applies)'
  );

  await driverCall(driver, 'install-applies: close tabs', () => driver.closeUpdaterTabs());
  const installCheck = await driverCall(driver, 'install-applies: check', () => driver.check());
  check(
    counter,
    installCheck.opened === 1,
    'install-applies: the check opens the updater tab',
    JSON.stringify(installCheck)
  );
  const page = await findUpdaterPage(browser, 15_000);
  if (!page) {
    check(counter, false, 'install-applies: card tab available', 'no updater page enumerable');
    return;
  }
  const cardRendered = await waitForCondition(
    page,
    () => Boolean(document.getElementById('card-title')?.textContent),
    15_000,
    'card rendered'
  );
  check(counter, cardRendered, 'install-applies: card rendered');
  if (!cardRendered) return;

  if (isSnap) {
    // Snap: config never offered in-tab — the checkbox is hidden and the amber
    // manual band explains the manual paths instead.
    const cfg = await page.evaluate(() => {
      const chk = document.getElementById('chk-config');
      const band = document.getElementById('config-manual');
      return {
        configCheckboxHidden: chk ? chk.hidden : null,
        bandShown: band ? !band.hidden : false,
        utilsCheckbox: Boolean(document.getElementById('chk-utils')),
      };
    });
    check(
      counter,
      cfg.configCheckboxHidden === true,
      'install-applies: config checkbox hidden (snap)'
    );
    check(counter, cfg.bandShown, 'install-applies: manual guidance band shown (snap)');
    check(counter, cfg.utilsCheckbox, 'install-applies: utils checkbox present (snap)');

    const clicked = await page.evaluate(() => {
      const cb = document.getElementById('chk-utils');
      const btn = document.getElementById('btn-install');
      if (!cb || !btn) return false;
      if (!cb.checked) cb.click();
      if (btn.disabled) return false;
      btn.click();
      return true;
    });
    check(counter, clicked, 'install-applies: install clicked (utils only, snap)');
    const completed = await waitForTreeHash(utilsFiles, seeded.chromeUtils, utilsHash, 30_000);
    check(counter, completed, 'install-applies: utils install completes in tab (snap)');
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
      'install-applies: config still manual (snap)'
    );
    check(
      counter,
      configManualStill.successBannerHidden !== false,
      'install-applies: success banner hidden while config pending (snap)'
    );
  } else {
    // Standard install: check BOTH checkboxes (utils + config stale), click
    // install. handleInstallCommand installs config first, then utils.
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
    check(counter, clicked, 'install-applies: install clicked');
    // Disk hash is the completion ground truth: both installed trees must
    // re-hash to the manifest (config first, then utils).
    const completed =
      (await waitForTreeHash(utilsFiles, seeded.chromeUtils, utilsHash, 30_000)) &&
      (await waitForTreeHash(configFiles, greDir, configHash, 30_000));
    check(counter, completed, 'install-applies: install completes in tab');
    if (!completed) {
      const dom = await page
        .evaluate(() => {
          const prog = document.getElementById('card-progress');
          const err = document.getElementById('card-progress-error');
          return {
            progress: prog?.textContent?.trim() ?? null,
            progressError: err?.textContent?.trim() ?? null,
          };
        })
        .catch(() => null);
      console.log(`  [diag:install-applies] tab at completion timeout: ${JSON.stringify(dom)}`);
      dumpConsoleLog(seeded.profileDir);
    }
    // The realm can also die between the copies and this assertion. A dead realm
    // is a deferral, not a failed render — probe first, or the evaluates below
    // fail, the conditions read false, and the leg fails on a false negative.
    if (!(await driverAlive(driver))) throw new DriverLostError('install-applies: UI reflection');

    // UI reflection: poll, don't read once — the tab's refreshPackageState runs
    // after the last copy.
    const successShown = await foldedUiCondition(
      page,
      () => !document.getElementById('success-banner')?.hidden,
      'success banner'
    );
    check(counter, successShown, 'install-applies: success banner shown after install');
    const badgesOk = await foldedUiCondition(
      page,
      () => {
        const ok = id => {
          const el = document.getElementById(id);
          return Boolean(el && !el.hidden);
        };
        return ok('utils-badge-ok') && ok('config-badge-ok');
      },
      'badges OK'
    );
    check(counter, badgesOk, 'install-applies: badges show OK after install');
  }

  // ── install-applies: on-disk assertions (node side) ──
  const staleFile = path.join(seeded.chromeUtils, FORCE_UTILS_STALE);
  check(
    counter,
    fs.existsSync(staleFile) &&
      !fs.readFileSync(staleFile, 'utf-8').includes(FORCE_UTILS_STALE_MARKER),
    'install-applies: stale marker replaced by install'
  );
  check(
    counter,
    computeInstalledHash(utilsFiles, seeded.chromeUtils) === utilsHash,
    'install-applies: installed utils re-hashes to the manifest'
  );
  const greConfig = path.join(greDir, 'config.js');
  if (isSnap) {
    check(
      counter,
      fs.existsSync(greConfig) && fs.readFileSync(greConfig, 'utf-8').includes('e2e-test probe'),
      'install-applies: config probe NOT replaced (snap manual)'
    );
    check(
      counter,
      computeInstalledHash(configFiles, greDir) !== configHash,
      'install-applies: config dir still differs from the manifest (snap manual)'
    );
  } else {
    check(
      counter,
      fs.existsSync(greConfig) && !fs.readFileSync(greConfig, 'utf-8').includes('e2e-test probe'),
      'install-applies: config probe replaced by install'
    );
    check(
      counter,
      computeInstalledHash(configFiles, greDir) === configHash,
      'install-applies: installed config re-hashes to the manifest'
    );
  }
  rmDir(path.join(seeded.chromeUtils, 'updater', 'ui'));
  await driverCall(driver, 'install-applies: close tabs', () => driver.closeUpdaterTabs());
}

/** Folded #102 — manual-install-no-ui, in the session's browser. */
async function runFoldedNoUi(counter, ctx) {
  const {driver, browser, seeded, snapshotDir} = ctx;

  // ── Folded: manual-install-no-ui (#102) ──────────────────────────────────
  // The release topology: ZIP_BASE_URL points at a dir with NO updater-ui.zip
  // (the released state this scenario must catch); the ui zip comes from the
  // manifest's own host (UI_BASE_URL = the snapshot). A pre-fix scheduler
  // fetched it from ZIP_BASE_URL and 404'd silently — exactly what fails here.
  console.log('\n  ── folded in-session: manual-install-no-ui (#102) ──');
  const uiDir = path.join(seeded.chromeUtils, 'updater', 'ui');
  let releaseDir;
  try {
    releaseDir = buildReleaseLayout(snapshotDir);
    const base = pathToFileURL(releaseDir).href.replace(/\/$/, '');
    await driverCall(driver, 'no-ui: set release topology', async () => {
      await driver.setPref('extensions.firefox-scripts.override.ZIP_BASE_URL', base);
      await driver.setPref('extensions.firefox-scripts.override.HELPER_BASE_URL', base);
    });

    // The user modified a utils file by hand and this profile has no ui on disk
    // (install-applies replaced the trees, so re-stale utils explicitly).
    fs.appendFileSync(path.join(seeded.chromeUtils, FORCE_UTILS_STALE), FORCE_UTILS_STALE_MARKER);
    check(
      counter,
      !fs.existsSync(path.join(uiDir, 'updater.html')),
      'no-ui: no ui folder on disk before the check'
    );

    await driverCall(driver, 'no-ui: close tabs', () => driver.closeUpdaterTabs());
    const uiCheck = await driverCall(driver, 'no-ui: check', () => driver.check());
    check(
      counter,
      uiCheck.opened === 1,
      'no-ui: the check opens the updater tab',
      JSON.stringify(uiCheck)
    );

    // Disk proof (survives a BiDi-missed chrome tab): ensureUpdaterUi extracted
    // updater-ui.zip into chrome/utils/updater/ui.
    check(
      counter,
      fs.existsSync(path.join(uiDir, 'updater.html')),
      'no-ui: ui folder auto-installed',
      'ensureUpdaterUi never extracted updater-ui.zip into chrome/utils/updater/ui'
    );
    const uiPage = await findUpdaterPage(browser, 15_000);
    check(
      counter,
      Boolean(uiPage),
      'no-ui: ui tab opened (card rendered from the re-installed ui)'
    );
    if (uiPage) {
      const rendered = await waitForCondition(
        uiPage,
        () => Boolean(document.getElementById('card-title')?.textContent),
        15_000,
        'card rendered'
      );
      check(counter, rendered, 'no-ui: card rendered');
    }
  } finally {
    // Restore the baked topology so nothing downstream inherits the override.
    // Best effort, and only while the realm answers: these overrides live in
    // the running browser (never user.js), so a realm that died here needs no
    // unwinding — the session's browser is about to close anyway.
    if (await driverAlive(driver)) {
      await driver.clearPref('extensions.firefox-scripts.override.ZIP_BASE_URL').catch(() => {});
      await driver.clearPref('extensions.firefox-scripts.override.HELPER_BASE_URL').catch(() => {});
    }
    if (releaseDir) rmDir(releaseDir);
  }

  await driverCall(driver, 'no-ui: close tabs', () => driver.closeUpdaterTabs());
}

/**
 * The variant session — driver mode (#309, formerly scenarios 1 + 4 + 5).
 *
 * ONE browser covers five variants that differ only in seed state: the stale
 * trio (utils-stale / config-stale / both-stale), up-to-date, and skipped. The
 * harness seeds a stale profile (utils stale + the GreD probe, which is what
 * makes the startup check open the tab), launches once, and from there drives
 * the production orchestrator in-browser through the #309 driver page
 * (test/e2e/shared/updaterDriver.mjs):
 *
 * mutate the disk fixture (+ skip pref) → clear the daily gate → call the
 * exported checkForUpdates() → assert what it did (tab opened or not, the day
 * recorded, the cards the tab renders).
 *
 * The launcher count is what this buys: variants no longer pay a browser start
 * (the step where the flake class lives — the TargetCloseError retry machinery
 * exists only to survive it), and each stale variant now asserts the
 * SCHEDULER's own decision (addTrustedTab + a fresh engineInit) instead of a
 * harness-forced re-render of the startup tab.
 *
 * What stays launch-driven: the startup wiring itself (autoconfig →
 * userChrome.js → observer → initScriptsUpdater → the tab the seed asked for)
 * and the startup-race retry, unchanged. Where driver mode cannot run, the
 * session degrades by capability, never by coverage: BiDi can still evaluate
 * the updater tab → the stale trio runs the pre-#309 in-tab re-render loop
 * (assertStaleTrioInTab); BiDi cannot attach to the trusted tab at all → only
 * the tab-open proof is observable there, which is exactly what the pre-#309
 * session could assert in that environment too. Either way the caller
 * additionally runs up-to-date / skipped as their own launches with the local
 * manifest server (see run()'s scenarioSteps).
 *
 * The folded scenarios degrade the same way when the realm dies MID-session:
 * runSessionExtras re-probes before every phase, and whatever it could not
 * finish is reported back in `extrasRemaining` so the caller launches exactly
 * those, and a phase that already passed is never run twice. The VARIANT loop
 * has the same contract: every runOneVariant driver command goes through
 * driverCall, a sentinel between variants re-asserts the deferred STALE cards
 * in-tab (the engine re-checks on init() — no driver needed), and whatever
 * still could not run is reported in `variantsRemaining` for run() to launch.
 *
 * Wrapped in the same retry-once guard as before: a browser-internal startup
 * race (observed live on waterfox, run 35460461221 — NS_ERROR_NOT_INITIALIZED
 * from the URL-classifier service) would otherwise fail every variant at once.
 * The retry is logged on its own [retry] lines so a real regression cannot hide
 * behind it; a second failure fails the leg.
 *
 * @returns {Promise<{
 *   profiles: string[];
 *   driverAvailable: boolean;
 *   extrasRemaining?: string[];
 *   variantsRemaining?: string[];
 * }>}
 *   the created profiles (centralized cleanup), whether the in-browser driver
 *   came up in this environment, and the work the caller still has to launch:
 *   `extrasRemaining` (the folded scenarios) plus `variantsRemaining`
 *   (up-to-date / skipped, and the stale variants whose in-tab re-assertion
 *   could not run either) — present only when driver mode is unavailable or the
 *   realm died mid-session
 */
async function runVariantSession(counter, opts, snapshotDir) {
  const label = 'variants';
  console.log(
    `\n## Scenario: variant session (${[...STALE_VARIANTS, 'up-to-date', 'skipped'].join(', ')})` +
      ' — one browser (#309)'
  );
  const firefoxBin = opts.firefox || discoverFirefoxBinary();
  if (!firefoxBin) throw new Error(missingFirefoxMessage());

  const t0 = Date.now();
  const phases = {};
  // Every profile this function creates (attempt 1 + optional retry) is
  // returned for run()'s centralized cleanup; a retry's first profile also
  // stays on disk until then for post-mortem.
  const createdProfiles = [];
  let driverAvailable = false;

  /** Seed a profile + GreD for one attempt (shared by attempt 1 and the retry). */
  const seedAttempt = () => {
    const state = seedProfile(snapshotDir, {forceUtilsStale: true});
    createdProfiles.push(state.profileDir);
    // The driver page goes into the profile's chrome/utils/updater dir (the
    // chrome.manifest content root) BEFORE launch, so the realm is loadable the
    // moment the harness needs it. Hash-invisible: only manifest-listed files
    // are hashed, so the seeded utils state stays byte-identical to the fixture.
    installDriverPage(state.chromeUtils);
    return state;
  };

  // Seed: first variant's state (utils stale; config stale comes from the GreD
  // probe, which is installed for every variant — the marker toggles it).
  let seeded = seedAttempt();
  phases.seed = Date.now() - t0;

  const greDir = findGreDir(firefoxBin);
  const greSeed = installFxFolder(snapshotDir, greDir);
  check(counter, greSeed.ok, `seed GreD (${label})`, greSeed.error);
  if (!greSeed.ok) return {profiles: createdProfiles, driverAvailable};

  // Capture the pristine config.js BEFORE the probe lands on it — the variants
  // whose config must be OK restore exactly these bytes.
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
        // post-mortem; seedAttempt makes a new temp dir each call.
        seeded = seedAttempt();
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

      // Wait on both channels: BiDi page enumeration (the driver needs the page
      // handle, and so does every card assertion) and the probe's TAB_OPENED
      // mirror line (fast, BiDi-independent). waitForUpdaterTabOpen() gives BiDi
      // a grace window after the mirror signal: the probe polls every second and
      // routinely beats browsingContext enumeration to it, so breaking on the
      // mirror alone degraded whole sessions to "BiDi cannot attach" — losing
      // every card assertion to a race the mirror was only meant to bound.
      const page = await waitForUpdaterTabOpen(
        browser,
        seeded.profileDir,
        Date.now() + 30_000,
        DRIVER_BIDI_GRACE_MS
      );
      const viaPref = greShownToday(seeded.profileDir);
      const sawMirrorLine = mirrorSaysTabOpened(seeded.profileDir);
      const tabOpened = Boolean(page) || viaPref || sawMirrorLine;

      if (!page && tabOpened) {
        // Tab opened (probe mirror / persisted pref) but BiDi cannot attach to
        // the trusted chrome:// tab in this environment — a deterministic
        // limitation on some CI runners (observed on Windows), not a startup
        // race, so a retry cannot help. Record the tab-open proof with the
        // limitation spelled out in the label (the historical CI contract for
        // these legs, previously silent); full card assertions run where BiDi
        // attaches (locally, other runners). Coverage parity with the pre-#309
        // session: with no tab handle it could not assert a card either — here
        // the trio's observable is the tab-open proof above, and the caller
        // still runs the up-to-date / skipped decisions as their own launches.
        check(
          counter,
          true,
          `tab opens (${attemptLabel}; no card assertions — BiDi cannot attach to the trusted tab in this environment)`
        );
        console.log('  [diag] probe/pref verified the tab; BiDi missed the handle');
        return {profiles: createdProfiles, driverAvailable};
      }

      if (!tabOpened) {
        // Scheduler never opened the tab: the startup-race case the retry
        // exists for. Only the FINAL attempt records the verdict — a FAIL is
        // permanent in the counter (fail-fast would skip the remaining
        // scenarios even if attempt 2 succeeded).
        if (attempted < 2) {
          console.log(
            `  [diag] tab never opened within the startup window (attempt ${attempted}) — retrying with a fresh profile`
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
      check(counter, true, `startup check opens the updater tab (${attemptLabel})`);

      // ── Bootstrap driver mode (#309) ──
      // The startup tab is the only privileged realm reachable here (a content
      // tab cannot be navigated to chrome://), so the driver tab is opened FROM
      // it; from there the harness drives the orchestrator directly.
      await openDriverTab(page, DRIVER_URL);
      const driver = await attachDriver(browser);
      if (!driver) {
        // The driver realm never came up (the driver tab did not commit, or its
        // script did not run) while BiDi CAN evaluate the updater tab. A retry
        // cannot help — this is a host property. The trio must not lose its
        // coverage to the #309 collapse, so assert it the pre-#309 way, in the
        // tab the startup check already opened; only the up-to-date / skipped
        // DECISIONS need their own launches, which run() then performs.
        check(
          counter,
          true,
          `driver mode unavailable (${attemptLabel}; stale trio via the pre-#309 in-tab re-render loop)`
        );
        console.log(
          '  [driver] unavailable — the stale trio falls back to the in-tab re-render loop;' +
            ' up-to-date/skipped keep their own launches'
        );
        const trioOk = await assertStaleTrioInTab(counter, {
          page,
          firefoxBin,
          seeded,
          pristineConfig,
        });
        if (trioOk) {
          // The trio re-rendered the real card through the engine's init():
          // close the net — no console errors from the updater scripts.
          assertNoUpdaterConsoleErrors(counter, seeded.profileDir, attemptLabel);
        } else {
          console.log('  [driver] the in-tab trio assertions failed — deterministic, not retrying');
        }
        await dumpPages(browser);
        return {
          profiles: createdProfiles,
          driverAvailable: false,
          extrasRemaining: [...FOLDED_SCENARIOS],
          variantsRemaining: ['up-to-date', 'skipped'],
        };
      }
      driverAvailable = true;

      // Chrome ES modules are per-global: the driver page's own
      // scriptsUpdater instance starts uninitialized (no gWindow), so the
      // driver initializes it exactly the way BootstrapLoader.js initializes
      // the browser's — same entry point, same production code path.
      // A realm death HERE (before any variant ran) degrades like every other
      // realm death: hand ALL the work back to run()'s launch path instead of
      // failing the leg — the contract is "degrades by capability, never by
      // coverage" (review on #343, 2026-10-01).
      try {
        await driverCall(driver, `${attemptLabel}: init scheduler`, () => driver.initScheduler());

        // The startup tab was the proof, not a fixture: close it so every count
        // below measures what THAT variant's check opened (the scheduler's own
        // addTrustedTab decision), never something inherited from the seed.
        await driverCall(driver, `${attemptLabel}: close startup tabs`, () =>
          driver.closeUpdaterTabs()
        );
        check(
          counter,
          (await driver.updaterTabCount().catch(() => -1)) === 0,
          `driver governs the updater tabs (${attemptLabel})`
        );
      } catch (err) {
        if (!err?.driverLost) throw err;
        console.log(
          `  [driver] ${err.message} at bootstrap — the whole session degrades to the launch paths`
        );
        assertNoUpdaterConsoleErrors(counter, seeded.profileDir, attemptLabel);
        phases.total = Date.now() - t0;
        logScenarioTime(attemptLabel, t0, phases);
        return {
          profiles: createdProfiles,
          driverAvailable,
          extrasRemaining: [...FOLDED_SCENARIOS],
          variantsRemaining: [...STALE_VARIANTS, 'up-to-date', 'skipped'],
        };
      }

      const manifest = JSON.parse(fs.readFileSync(path.join(snapshotDir, 'hashes.json'), 'utf-8'));
      const utilsHash = manifest.utils?.hash || '';
      if (!utilsHash) {
        check(counter, false, `manifest has a utils hash (${label})`);
        return {profiles: createdProfiles, driverAvailable};
      }

      // ── One launch, five variants: flip the inputs → run → assert ──
      const plan = [
        ...STALE_VARIANTS.map(variant => ({variant, expectTab: true})),
        {variant: 'up-to-date', expectTab: false},
        {variant: 'skipped', expectTab: false},
      ];
      let variantFailure = false;
      let variantsRun = 0;
      let remainingVariants = [];
      try {
        for (const {variant, expectTab} of plan) {
          const ok = await runOneVariant(counter, {
            driver,
            browser,
            firefoxBin,
            seeded,
            variant,
            expectTab,
            pristineConfig,
            utilsHash,
          });
          variantsRun++;
          if (!ok) {
            variantFailure = true;
            break;
          }
        }
      } catch (err) {
        if (!err?.driverLost) throw err;
        // The realm died between variants (the same mid-session death the
        // folded phases degrade on): the variants that already ran keep their
        // assertions in the tally; everything else is deferrable. The stale
        // variants among the remainder are re-asserted IN THIS TAB below (the
        // pre-#309 shape — the engine re-checks on init(), no driver needed);
        // the up-to-date/skipped decisions and the folded phases go to run()'s
        // launch path. A realm death is a speed loss, never a coverage loss
        // and never a false failure.
        remainingVariants = plan.slice(variantsRun).map(entry => entry.variant);
        console.log(
          `  [driver] ${err.message} — the remaining variants (${remainingVariants.join(', ')}) fall back to the in-tab / launch paths`
        );
      }

      if (!variantFailure) {
        // The deferred stale variants keep their launch path: the startup tab
        // was closed before the variant loop, so there is no in-tab frame left
        // to re-assert them in (a realm death took that frame with it — the
        // launch path is the only coverage left, and run()'s dispatch runs
        // every remaining variant name).
        const staleLeft = remainingVariants.filter(v => STALE_VARIANTS.includes(v));
        if (staleLeft.length > 0) {
          console.log(
            `  [driver] the deferred stale variants (${staleLeft.join(', ')}) keep their launch path`
          );
        }

        // ── Folded state-only scenarios (#309 follow-up) ──
        // install-applies + manual-install-no-ui run in THIS browser, after the
        // variants: they mutate the seeded trees and the GreD config, so they
        // must run last (the variants assert those trees). A failure here is
        // deterministic — fail the session, never retry it.
        const extras = await runSessionExtras(counter, {
          driver,
          browser,
          firefoxBin,
          seeded,
          snapshotDir,
          greDir,
          pristineConfig,
        });
        if (extras.driverLost) {
          // Degrade, never fail (#309 follow-up): the folded phases that did not
          // finish are handed back to run()'s launch path, which runs them as
          // their own launches. The variants that DID run keep their assertions
          // in the tally, so this is a speed regression at worst — never
          // missing coverage, and never a false failure.
          assertNoUpdaterConsoleErrors(counter, seeded.profileDir, attemptLabel);
          phases.total = Date.now() - t0;
          logScenarioTime(attemptLabel, t0, phases);
          return {
            profiles: createdProfiles,
            driverAvailable,
            extrasRemaining: extras.remaining,
            variantsRemaining: remainingVariants,
          };
        }
        // Every variant and folded scenario ran the production orchestrator
        // against the real tab: close the net — no console errors from the
        // updater scripts for the whole session.
        assertNoUpdaterConsoleErrors(counter, seeded.profileDir, attemptLabel);
        phases.total = Date.now() - t0;
        logScenarioTime(attemptLabel, t0, phases);
        return {profiles: createdProfiles, driverAvailable, extrasRun: true};
      }
      // A realm death was degraded in-session; the deferred work goes to
      // run()'s launch path. Stale variants keep their name in
      // variantsRemaining when (and only when) the in-tab re-assertion could
      // not run — their tab died with the realm — so the caller launches them.
      const staleDeferred = remainingVariants.filter(v => STALE_VARIANTS.includes(v));
      if (staleDeferred.length > 0) {
        console.log(
          `  [driver] deferring the stale variants (${staleDeferred.join(', ')}) to their launch path`
        );
      }
      if (remainingVariants.length > 0) {
        assertNoUpdaterConsoleErrors(counter, seeded.profileDir, attemptLabel);
        phases.total = Date.now() - t0;
        logScenarioTime(attemptLabel, t0, phases);
        return {
          profiles: createdProfiles,
          driverAvailable,
          extrasRemaining: [...FOLDED_SCENARIOS],
          variantsRemaining: remainingVariants,
        };
      }

      // Assertion failure: retry only makes sense for startup-shaped failures;
      // a card/decision assertion failure is deterministic (bad fixture/code),
      // so do not burn the retry on it — fail fast.
      console.log(
        `  [retry] variant assertions failed on attempt ${attempted} — deterministic, not retrying`
      );
      break;
    }
    return {profiles: createdProfiles, driverAvailable};
  } finally {
    try {
      await closeBrowser(browser);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Launch ONE stale variant the pre-#309 way: seed the profile, launch, and wait
 * for the tab the startup check opens — the same observable the in-session
 * driver path asserts, used when a mid-session realm death defers a stale
 * variant and its startup tab is gone with it.
 *
 * Returns the profile dir for run()'s centralized cleanup.
 *
 * @param {{passed: number; failed: number}} counter
 * @param {object} opts
 * @param {string} snapshotDir
 * @param {string} variant - a member of STALE_VARIANTS
 * @returns {Promise<string>} the created profile dir
 */
async function runLaunchedStaleVariantScenario(counter, opts, snapshotDir, variant) {
  const label = variant;
  console.log(`\n## Scenario: ${label} (deferred by the dead driver realm)`);
  const firefoxBin = opts.firefox || discoverFirefoxBinary();
  if (!firefoxBin) throw new Error(missingFirefoxMessage());

  // Per-variant staleness — NOT the blanket "both stale": utils-stale must
  // ship a PRISTINE config and config-stale a pristine utils tree, or the card
  // shows one badge more than the variant expects (reproduced 2026-09-30).
  const want = expectedStaleState(variant);
  const seeded = seedProfile(snapshotDir, {forceUtilsStale: want.utilsStale});
  const greDir = findGreDir(firefoxBin);
  const greSeed = installFxFolder(snapshotDir, greDir);
  check(counter, greSeed.ok, `seed GreD (${label})`, greSeed.error);
  if (!greSeed.ok) return seeded.profileDir;
  if (want.configStale) {
    check(counter, appendConfigProbe(greDir), `config probe appended (${label})`);
  }

  let browser;
  try {
    browser = await launchFirefox(firefoxBin, seeded.profileDir, {
      headless: opts.headless,
      extraPrefsFirefox: seeded.prefs,
    });
    attachProcessLogging(browser, label);
    const page = await waitForUpdaterTabOpen(browser, seeded.profileDir, Date.now() + 30_000);
    const viaPref = greShownToday(seeded.profileDir);
    const sawMirror = mirrorSaysTabOpened(seeded.profileDir);
    check(
      counter,
      Boolean(page) || viaPref || sawMirror,
      `tab opens (${label})`,
      'scheduler never reached addTrustedTab'
    );
    // Card assertions need a BiDi handle; where BiDi cannot attach, the tab-open
    // proof above is the same observable the pre-#309 session had.
    if (page) {
      const pageErrors = [];
      const onErr = err => pageErrors.push(err.message);
      page.on('pageerror', onErr);
      try {
        await assertStaleCard(counter, page, variant, pageErrors);
      } catch (err) {
        check(counter, false, `card assertions (${label})`, err.message);
      } finally {
        page.off('pageerror', onErr);
      }
      assertNoUpdaterConsoleErrors(counter, seeded.profileDir, label);
    }
  } finally {
    try {
      await closeBrowser(browser);
    } catch {
      /* ignore */
    }
    if (!opts.keepProfile) rmDir(seeded.profileDir);
    else console.log(`  [keep] profile: ${seeded.profileDir}`);
  }
  return seeded.profileDir;
}

/**
 * Launch Firefox with both packages up to date (or skipped), assert the updater
 * tab does NOT open within the timeout.
 *
 * The pre-#309 shape of the up-to-date / skipped variants, kept as the fallback
 * for environments where driver mode cannot run (BiDi cannot evaluate inside a
 * privileged page, so the harness cannot call the orchestrator in-browser) —
 * see run()'s scenarioSteps. In-session, the same decisions are asserted from
 * the driver page instead (runOneVariant).
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
  if (!firefoxBin) throw new Error(missingFirefoxMessage());

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
    // Launch-reuse hand-off (fallback up-to-date → skipped): the profile already
    // holds the seeded utils + GreD state; the skipped variant's deltas are
    // applied on top —
    // (a) forceUtilsStale is the disk marker below, (b) skipUtils is a launch
    // pref (addSkipPrefs — extraPrefsFirefox re-injects every start, so no
    // user.js write), (c) the GreD is re-seeded for byte-identical state.
    // The daily gate is already cleared by the seeded prefs on every launch.
    console.log(
      '  [reuse] continuing on the up-to-date profile (profile + utils state reused; GreD re-seeded for byte-identical state)'
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
    // The up-to-date session MUST have recorded the day (the scheduler's
    // rate-limit write — the point of #333) while the tab itself stayed closed
    // (asserted via BiDi above). The persisted pref is the flush-proof that the
    // up-to-date path ran to its write.
    const shown = greShownToday(seeded.profileDir);
    check(
      counter,
      shown,
      `up-to-date check recorded the day (${label})`,
      'lastScriptsCheckDate was not persisted — the up-to-date path never reached its write'
    );
  }

  // Launch-reuse hand-off: return the full seeded state so the skipped variant
  // can continue on this profile. `chromeUtils` + `prefs` are what the reuse
  // path mutates (stale marker, skip prefs); the daily-gate clears stay in
  // `prefs` so the second launch re-runs the check. The `'profileDir' in state`
  // unwrap in run() still routes the profile into `profiles` for centralized
  // cleanup.
  return {
    profileDir: seeded.profileDir,
    chromeUtils: seeded.chromeUtils,
    prefs: seeded.prefs,
  };
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
  if (!firefoxBin) throw new Error(missingFirefoxMessage());
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
    // back to the persisted lastScriptsCheckDate pref — checked after the clean
    // close, so the lazy prefs.js flush is covered without extra dead air.
    page = await waitForUpdaterTabOpen(browser, seeded.profileDir, Date.now() + 30_000);
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
          '(verified via lastScriptsCheckDate; BiDi could not enumerate the chrome tab)'
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
 * updater ACTIVATES on the next launch (tab opens, the daily pref set by the
 * shown tab).
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
  if (!firefoxBin) throw new Error(missingFirefoxMessage());

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
          !/TargetCloseError|ProtocolError|Protocol error|timed out/i.test(String(err?.message))
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

  // Assigned by waitForUpdaterTabOpen inside the try; read only after the
  // try/finally completes (an exception skips those reads), so no initializer.
  let page;
  try {
    browser = await launchFirefox(firefoxBin, seeded.profileDir, {
      headless: opts.headless,
      extraPrefsFirefox: seeded.prefs,
    });
    attachProcessLogging(browser, label);
    const browserReady = await waitForFirstPage(browser, 20_000);
    check(counter, browserReady, `upgraded-utils browser ready (${label})`);
    page = await waitForUpdaterTabOpen(browser, seeded.profileDir, Date.now() + 30_000);
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
  if (!firefoxBin) throw new Error(missingFirefoxMessage());

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

  // Assigned by waitForUpdaterTabOpen inside the try; read only after the
  // try/finally completes (an exception skips those reads), so no initializer.
  let page;
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
          !/TargetCloseError|ProtocolError|Protocol error|timed out/i.test(String(err?.message))
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
    page = await waitForUpdaterTabOpen(browser, seeded.profileDir, Date.now() + 30_000);
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
  // ACTIVATION PROOF (not just the pref): the tab writes the shown-day pref in
  // memory (engineInit) but its prefs.js flush at close can race the harness
  // read (greShownToday), which occasionally fails the check even though the
  // ui WAS extracted by the same call chain. The extracted ui dir +
  // utils-stale marker are the same-class disk proof the other scenarios
  // accept, so the OR accepts it too.
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
    viaPref && !page ? '(verified via lastScriptsCheckDate; BiDi missed the chrome tab)'
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
 * Scenario 9's third expected headless terminal mode: the stand-in helper's
 * spawn itself failing. CI Windows runners refuse CreateProcess on the fake
 * helper bytes before it ever runs (Subprocess.call throws "Failed to create
 * process"; observed on every Windows leg 2026-09-23) — locally the spawn gets
 * as far as the exit-code paths above. The routed line is "<ISO> Firefox
 * Scripts updater: install config - Failed to create process"; the pattern pins
 * BOTH the install-config context and the spawn-failure tail, so no other
 * install-config failure is masked (net no-masking rule).
 *
 * Separator history: logError originally joined msg and detail with an em-dash,
 * which the mirror probe's per-byte nsIFileOutputStream.write mangled to byte
 * 0x14 ("^T" in the harness output) — the CI lines could never contain a
 * literal em-dash. updater.js now uses ASCII " - "; the middle group stays
 * permissive so an older packaged snapshot's mangled or exact-em-dash rendering
 * still matches.
 *
 * @type {string[]}
 */
const HELPER_SPAWN_ALLOW = [
  /Firefox Scripts updater: install config ([\s\S]*)Failed to create process/.source,
];

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
  if (!firefoxBin) throw new Error(missingFirefoxMessage());

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
      // every leg of 2026-09-21). The tab writes lastScriptsCheckDate to
      // prefs.js once shown, so the pref is the always-available proof; the
      // mirror and the BiDi handle add detail where the environment allows it.
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
        // lastScriptsCheckDate=<today> once their browsers had closed, while
        // the in-run poll had timed out on both). Close the browser and read
        // the flush: the tab writes that pref in its init only, so it is exact
        // proof, and the remaining assertions (ACL deny, no copy) need no live
        // page.
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
          ...HELPER_SPAWN_ALLOW,
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
          ...HELPER_SPAWN_ALLOW,
          // These also match the logStringMessage-routed duplicates (#292):
          // the routed line embeds the same tail — "Firefox Scripts updater:
          // install config - <expected tail>" — so no broader routed entry is
          // needed (a bare "install config" prefix would mask every other
          // install-config failure, violating the net's no-masking rule).
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
      // was cancelled" (real helper + declined UAC), "Admin copy helper
      // failed (exit code N)" (the helper ran and failed), or the stand-in's
      // CreateProcess itself failing (Subprocess.call throws; CI Windows
      // runners, 2026-09-23) — all via logError('install config'). Expected.
      assertNoUpdaterConsoleErrors(counter, seeded.profileDir, label, [
        'Elevation was cancelled',
        'Admin copy helper failed',
        ...HELPER_SPAWN_ALLOW,
        // These also match the logStringMessage-routed duplicates (#292):
        // the routed line embeds the same tail — "Firefox Scripts updater:
        // install config - <expected tail>" — so no broader routed entry is
        // needed (a bare "install config" prefix would mask every other
        // install-config failure, violating the net's no-masking rule).
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
  if (!firefoxBin) throw new Error(missingFirefoxMessage());

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

    // Serve a manifest built from the PATCHED tree with one byte flipped in a
    // comment marker file: every check finds a pending utils update, so the
    // up-to-date write can never rate-limit the timer away — the fetch counter
    // isolates the timer itself, which is the thing scenario 10 exists to prove
    // (#292). The pending-update day is ALSO pref-silent: the tree manifest
    // ships an empty updater-ui entry and this profile has no installed UI, so
    // ensureUpdaterUi returns false on every tick and checkForUpdates exits
    // before the tab-open — no tab, and under the single daily pref (ADR 0012)
    // no pref write either (the tab's shown-day write lives behind that exit).
    // (Pre-#333 this served an UP-TO-DATE manifest: the fetch counter was
    // then the only observable. Since the up-to-date path now rate-limits
    // itself to once per day, an up-to-date manifest would make the timer
    // gate fetchless and this scenario would report the NEW correct behavior
    // as the old bug.)
    const staleTreeDir = fs.mkdtempSync(path.join(REPO_ROOT, 'dist', 'fxs-timer-stale-'));
    const utilsZipPath = findZip(snapshotDir, ['utils.zip', 'utils-dev.zip']);
    if (!utilsZipPath) throw new Error(`no utils zip found in ${snapshotDir}`);
    extractZip(utilsZipPath, staleTreeDir);
    const staleMarker = path.join(staleTreeDir, 'zz-timer-stale-marker.js');
    fs.writeFileSync(staleMarker, '// makes the local utils hash differ from its manifest\n');
    const server = await startLocalManifestServer(snapshotDir, seeded.chromeUtils, {
      multiRequest: true,
      manifestOverride: buildTreeManifest(staleTreeDir),
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

      // Observation: WAIT for the third fetch (the startup one plus the 2 the
      // 4s timer owes us) instead of sleeping a fixed window and sampling once.
      // The old fixed 9 s was only ~2.25 timer intervals, so a slow launch lost
      // a fire and the scenario reported the very regression it exists to
      // detect — zen leg, 2026-09-23: "got 2" while every other updater leg
      // passed the same scenario. 30 s is ~7 intervals: far past launch jitter,
      // bounded, and the poll returns as soon as the third fetch lands, so a
      // healthy leg is not slowed down. A timer that never fires still fails
      // below, with the final count.
      const served =
        (await pollUntil(
          () => {
            const count = server.servedCount();
            return count >= 3 ? count : null;
          },
          30_000,
          500,
          label
        )) ?? server.servedCount();
      check(
        counter,
        served >= 3,
        `daily re-check timer fires (startup + >=2 re-fetches, got ${served}, ${label})`,
        served < 3 ?
          'manifest fetched only ' + served + 'x — the in-session re-check did not run'
        : ''
      );

      // The re-check must stay pref-gated. The manifest here is STALE (see
      // above) and the tab path exits silently before any write, so NO daily
      // pref is ever set — which is what keeps the timer fetches observable.
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

/**
 * Read the console mirror written by the config probe (empty when absent),
 * scoped to the CURRENT browser session: the probe opens the file append-only
 * and writes a `MIRROR-OPEN` marker the moment config.js runs, so the text from
 * the LAST marker on is exactly this launch's output.
 *
 * Without the scope a launch the harness KILLED leaves its lines behind for the
 * next launch in the same profile. The wedged-attempt retry (#384) then reads
 * the dead attempt's state: on the 2026-10-02 firefox-dev Windows leg the
 * killed attempt's ENGINE-DONE satisfied the engine wait — the retry's engine
 * was never actually awaited, its pref never reached prefs.js, and the scenario
 * failed an assertion the killed run had already passed in memory. Every
 * mirror-based poll (WINDOW-COUNT, TAB_SET, ENGINE-DONE, TAB_OPENED, SS-NOTIFY)
 * inherits the scope through this one reader.
 */
function readMirror(profileDir) {
  let text;
  try {
    text = fs.readFileSync(path.join(profileDir, 'e2e-console.log'), 'utf-8');
  } catch {
    return '';
  }
  const at = text.lastIndexOf('MIRROR-OPEN');
  return at === -1 ? text : text.slice(at);
}

/** lastScriptsCheckDate persisted in prefs.js, or ''. */
function readPrefsGate(profileDir) {
  try {
    // prefs.js is CRLF on Windows: normalize before splitting, or every line
    // ends with a stray \r and the $-anchored match below never fires.
    const line = fs
      .readFileSync(path.join(profileDir, 'prefs.js'), 'utf-8')
      .replace(/\r\n/g, '\n')
      .split('\n')
      .find(l => l.includes('extensions.firefox-scripts.lastScriptsCheckDate'));
    const m = line && line.match(/"([^"]*)"\);$/);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

/**
 * TEMP diagnostic (#384 follow-up): breadcrumb the seeded profile's updater.js
 * engineInit — engine entry, twin-tab outcome, and the checkCompleted value it
 * gates the shown-day write on. logStringMessage routes through the console
 * service into the mirror (console.* from the page would not).
 *
 * @param {string} chromeUtils - the seeded profile's chrome/utils dir
 */
/**
 * TEMP diagnostic for the session-restore scenario: breadcrumb the seeded
 * profile updater UI. Inserted code NEVER contains a backslash escape (the
 * previous attempt produced "invalid escape sequence" SyntaxErrors in the page,
 * which killed the whole updater.js/updater-ui.js parse) — line breaks come
 * from String.fromCharCode(10) at page runtime.
 *
 * @param {string} chromeUtils - the seeded profile chrome/utils dir
 */

/**
 * Overwrite the seeded profile's scheduler with the CURRENT source (the
 * snapshot's utils.zip may predate an in-review fix — scenario 10 sets the same
 * precedent). Fails loudly when the source file is missing.
 *
 * @param {string} chromeUtils - the seeded profile's chrome/utils dir
 */
function overwriteSchedulerFromSource(chromeUtils) {
  const repoSched = path.join(
    REPO_ROOT,
    'core',
    'chrome',
    'utils',
    'updater',
    'scriptsUpdater.sys.mjs'
  );
  fs.copyFileSync(repoSched, path.join(chromeUtils, 'updater', 'scriptsUpdater.sys.mjs'));
}

/**
 * Tree manifest over the extracted utils with one stale marker byte flipped:
 * every check sees a pending utils update (shared by the new scenarios).
 */
function buildStaleUtilsManifest(snapshotDir, staleTreeDir) {
  const utilsZipPath = findZip(snapshotDir, ['utils.zip', 'utils-dev.zip']);
  if (!utilsZipPath) throw new Error(`no utils zip found in ${snapshotDir}`);
  extractZip(utilsZipPath, staleTreeDir);
  const stale = path.join(staleTreeDir, FORCE_UTILS_STALE);
  fs.appendFileSync(stale, FORCE_UTILS_STALE_MARKER);
  // The snapshot manifest keeps its REAL fx-folder/updater-ui entries and only
  // the utils entry is re-hashed over the staled tree. Both user-facing
  // packages then compare on every check, so the updater tab engine re-check
  // is allowed to own the day (ADR 0012) — buildTreeManifest's empty
  // fx-folder entry would make that re-check correctly pref-silent.
  const manifestPath = path.join(snapshotDir, 'hashes.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  manifest['utils'] = buildTreeManifest(staleTreeDir)['utils'];
  return manifest;
}

/**
 * The session-restore scenario (#384 follow-up): relaunch on a profile whose
 * previous session (generated at runtime by sessionFile.mjs) holds the updater
 * tab in a NON-selected window, backgrounded inside that window, with a
 * different window selected — the exact restore shape the all-windows twin-tab
 * guard must survive.
 *
 * Assertions: both windows restore (WINDOW-COUNT), exactly ONE updater tab
 * exists across all windows (the guard found the restored one instead of
 * opening a duplicate into the active window), the restored tab's engine
 * re-checked (lastScriptsCheckDate), and no AsyncTabSwitcher schemeIs error
 * (the deferred-selection contract). Stale-utils manifest ⇒ a pending update ⇒
 * the restored tab's re-check is real, not a no-op.
 *
 * The payload: 2 windows, selectedWindow 2, updater tab backgrounded in window
 *
 * 1. Its privileged entry carries the serialized system principal — what a real
 *    updater entry stores — so the restored chrome:// tab is actually LOADABLE;
 *    without it SessionStore restores the entry from a null principal and the
 *    chrome:// load is blocked (a shape the fixture used to replay by accident,
 *    see sessionFile.SERIALIZED_SYSTEM_PRINCIPAL). FXS_E2E_SESSION_FILE
 *    overrides the generated payload with any Firefox-authored file.
 */
/**
 * The generated session file: buildSession's payload (2 windows, updater tab
 * backgrounded in the non-selected one) wrapped in the mozLz4 container with
 * the same `version: ['sessionrestore', 1]` array shape a real Firefox write
 * carries — every watched engine parses it (the esr-140 probe connects in ~2 s
 * with this payload vs never with the 159-authored fixture).
 *
 * @returns {Buffer} sessionstore.jsonlz4 bytes
 */
function buildSessionBuffer() {
  const session = buildSession({
    windows: 2,
    updaterInWindow: 1,
    updaterUrl: UPDATER_URL,
  });
  session.version = ['sessionrestore', 1];
  return mozLz4(session);
}

async function runSessionRestoreScenario(counter, opts, snapshotDir, label) {
  console.log(`\n## Scenario: ${label}`);
  const firefoxBin = opts.firefox || discoverFirefoxBinary();
  if (!firefoxBin) throw new Error(missingFirefoxMessage());
  const t0 = Date.now();
  // The session is GENERATED at runtime (sessionFile.mjs), not checked in:
  // the original hand-authored fixture came from a Firefox 159 profile, and
  // its 159-era fields (isAIWindow, splitViews, zIndex, …) wedge ESR 140's
  // SessionStore at startup — the launch never completed (puppeteer
  // handshake timed out, twice, esr-140 Windows 2026-10-01). The generated
  // payload carries only long-stable session fields, so every engine from
  // the oldest watched ESR to Nightly parses it. FXS_E2E_SESSION_FILE still
  // overrides it with any Firefox-authored file for a hand-shaped session.
  const fixture = process.env.FXS_E2E_SESSION_FILE || '';
  if (fixture && !fs.existsSync(fixture)) {
    check(counter, false, `session fixture exists (${label})`, `missing: ${fixture}`);
    return null;
  }
  const seeded = seedProfile(snapshotDir, {forceUtilsStale: true});
  const greDir11 = findGreDir(firefoxBin);
  const greSeed11 = installFxFolder(snapshotDir, greDir11);
  check(counter, greSeed11.ok, `seed GreD (${label})`, greSeed11.error);
  appendConfigProbe(greDir11);
  // SessionStore reads previous.jsonlz4 for "Restore previous session"; the
  // root copy covers the legacy-migration read path. Seeded BEFORE launch:
  // startup.page=3 makes restore-on-startup read it at init. The generated
  // session (below) mirrors the reported shape: the updater tab in a
  // NON-active window and NOT that window's selected tab.
  fs.mkdirSync(path.join(seeded.profileDir, 'sessionstore-backups'), {recursive: true});
  const sessionBytes = fixture ? fs.readFileSync(fixture) : buildSessionBuffer();
  fs.writeFileSync(
    path.join(seeded.profileDir, 'sessionstore-backups', 'previous.jsonlz4'),
    sessionBytes
  );
  fs.writeFileSync(path.join(seeded.profileDir, 'sessionstore.jsonlz4'), sessionBytes);
  overwriteSchedulerFromSource(seeded.chromeUtils);
  // Seed the updater UI from the snapshot (self-consistent with the
  // manifest): the scenario asserts the engine re-check on a RESTORED tab,
  // not a ensureUpdaterUi download. Also gives the breadcrumb patch a file
  // to work on.
  const uiZip11 = findZip(snapshotDir, ['updater-ui.zip', 'updater-ui-dev.zip']);
  if (uiZip11) {
    extractZip(uiZip11, path.join(seeded.chromeUtils, 'updater', 'ui'));
  }
  // The snapshot's tab UI predates the PR's updater.js edits (Xray-safe twin
  // guard). Overwrite it with the worktree source, exactly like
  // overwriteSchedulerFromSource does for the scheduler — the scenario tests
  // THIS branch's behavior on every engine.
  fs.copyFileSync(
    path.join(REPO_ROOT, 'tools', 'publish', 'remote-ui', 'updater.js'),
    path.join(seeded.chromeUtils, 'updater', 'ui', 'updater.js')
  );
  const staleTreeDir = fs.mkdtempSync(path.join(REPO_ROOT, 'dist', 'fxs-session-stale-'));
  const server = await startLocalManifestServer(snapshotDir, seeded.chromeUtils, {
    multiRequest: true,
    manifestOverride: buildStaleUtilsManifest(snapshotDir, staleTreeDir),
  });
  Object.assign(seeded.prefs, serverOverridePrefs(server.url));
  // Restore the authored session at startup, eagerly (restore_on_demand=false
  // loads background tabs too — the restored updater tab is NOT selected in
  // its window, so lazy restore would leave a placeholder with no engine).
  seeded.prefs['browser.startup.page'] = 3;
  seeded.prefs['browser.sessionstore.resume_session_once'] = true;
  seeded.prefs['browser.sessionstore.restore_on_demand'] = false;
  let browser;
  try {
    browser = await launchFirefox(firefoxBin, seeded.profileDir, {
      headless: opts.headless,
      extraPrefsFirefox: seeded.prefs,
      // Restoring a 2-window session with EAGER background tabs is the heaviest
      // startup any scenario launches, so the stock 20 s handshake deadline is
      // not the right bound here: on a busy runner the start can outlive it
      // (esr-140 Windows 2026-10-01 — attempt AND retry both killed at exactly
      // 20 s; firefox-dev Windows 2026-10-02 — attempt killed at 20 s), and the
      // failure then lands on whatever the killed attempt left behind instead
      // of on the assertions. These bounds were added for that reason and were
      // dropped by accident in the #384 rework; restored, and pinned by
      // test/unit/e2e/launchPrefs.test.mjs so it cannot happen silently again.
      launchDeadlineMs: 60_000,
      protocolTimeoutMs: 120_000,
    });
    attachProcessLogging(browser, label);
    const restoredWindows = await pollUntil(
      () => {
        const counts = [...readMirror(seeded.profileDir).matchAll(/WINDOW-COUNT (\d+)/g)].map(m =>
          Number(m[1])
        );
        return counts.some(c => c >= 2) ? Math.max(...counts) : null;
      },
      45_000,
      500,
      label
    );
    check(
      counter,
      (restoredWindows ?? 0) >= 2,
      `both windows restored (WINDOW-COUNT ${restoredWindows ?? 0}, ${label})`,
      restoredWindows ? '' : 'the session fixture never restored a second window'
    );
    // Wait for the engine FIRST, then assert the FINAL tab set: asserting the
    // first recorded set would false-fail on a transient twin the guard removes
    // moments later AND false-pass when a twin appears after the check (review
    // on #343, 2026-10-01). The fresh tab's engine re-check needs wall time after
    // the tab opens, and its pref only reaches prefs.js at the shutdown flush —
    // closing on WINDOW-COUNT would assert the harness's haste, not the engine
    // (the same trap scenario 12 hit before its ENGINE-DONE wait: the 8/9 run
    // of 2026-10-01 closed the browser ~4 s in, before a healthy engine under
    // the operator's concurrent load had finished). The probe watcher mirrors
    // ENGINE-DONE the moment the pref goes non-empty (live Services.prefs
    // read); bounded, so a wedged engine still fails the gate assertion below
    // instead of hanging the scenario.
    await pollUntil(
      () => {
        const line = readMirror(seeded.profileDir)
          .split('\n')
          .find(l => l.includes('ENGINE-DONE'));
        return line || null;
      },
      30_000,
      500,
      label
    );
    // The set must then stay at exactly one tab for TAB_SET_QUIET_MS before it
    // is called final: the module's guard removes a late twin a moment after
    // SessionStore announces it, and that removal RESETS the set — asserting
    // the first post-ENGINE-DONE line would pass over a twin that lands a
    // second later (or fail on one that landed a second earlier and is removed
    // right after). The watcher records a TAB_SET line on every change, so "the
    // line is quiet" is exactly "no tab appeared or disappeared".
    const TAB_SET_QUIET_MS = 6000;
    const readFinalTabSet = () => {
      const line = readMirror(seeded.profileDir)
        .split('\n')
        .filter(l => l.includes('TAB_SET'))
        .pop();
      if (!line) {
        return null;
      }
      const stamp = Date.parse(line.slice('TAB_SET '.length, line.indexOf('Z') + 1));
      return {line, ageMs: Number.isFinite(stamp) ? Date.now() - stamp : TAB_SET_QUIET_MS};
    };
    const finalTabSet = await pollUntil(
      () => {
        const set = readFinalTabSet();
        return set && set.ageMs >= TAB_SET_QUIET_MS ? set : null;
      },
      30_000,
      500,
      label
    );
    check(
      counter,
      Boolean(finalTabSet) && !finalTabSet.line.includes(' | '),
      `final updater-tab set is exactly one, stable for ${TAB_SET_QUIET_MS / 1000}s (always-fresh guard; transient twins tolerated) (${label})`,
      finalTabSet?.line.includes(' | ') ?
        `a SECOND updater tab SURVIVED the guard (stable ${(finalTabSet.ageMs / 1000).toFixed(1)}s): ${finalTabSet.line}`
      : 'no updater tab was ever seen after restore'
    );
    // The twin guard is event-driven: it reacts to SessionStore's per-restored-
    // tab notification. That topic firing AFTER the attach is the whole point
    // (observed on ESR 140: the fresh tab opened, then the restore kept
    // notifying) — if an engine ever stops emitting it, the guard silently
    // degrades to the attach block's scan alone, so assert the trigger exists.
    const restoreNotices = readMirror(seeded.profileDir)
      .split('\n')
      .filter(l => l.includes('SS-NOTIFY sessionstore-one-or-no-tab-restored')).length;
    check(
      counter,
      restoreNotices >= 1,
      `SessionStore fired its per-restored-tab notification (${restoreNotices}, ${label})`,
      'the event-driven twin guard would have no trigger on this engine'
    );
    const schemeIs = readMirror(seeded.profileDir).includes('schemeIs');
    check(
      counter,
      !schemeIs,
      `restore produced no AsyncTabSwitcher schemeIs crash (#384) (${label})`,
      'the selection race (#384) fired during restore'
    );
    console.log(`  [timing] ${label} wall: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } finally {
    try {
      await closeBrowser(browser);
    } catch {
      /* ignore */
    }
    await server.close().catch(() => {});
    try {
      fs.rmSync(staleTreeDir, {recursive: true, force: true});
    } catch {
      /* ignore */
    }
  }
  // The daily pref is flushed to prefs.js at shutdown (lazy while live), and
  // the flush can land a moment AFTER the browser process exits — read through
  // it with a short poll instead of a single racy read (the ziOHlE run wrote
  // the pref ~100 ms after the first read saw the old value).
  const today = new Date().toISOString().slice(0, 10);
  let gate = '';
  await pollUntil(
    () => {
      gate = readPrefsGate(seeded.profileDir);
      return gate === today || null;
    },
    10_000,
    500,
    label
  );
  check(
    counter,
    gate === today,
    `restored tab engine re-checked (lastScriptsCheckDate=${gate || '(none)'}, ${label})`
  );
  if (!opts.keepProfile) {
    rmDir(seeded.profileDir);
  } else {
    console.log(`  [keep] profile: ${seeded.profileDir}`);
  }
  return null;
}

async function run() {
  const opts = parseArgs();
  const counter = createCounter();

  const snapshotDir = opts.snapshot || findSnapshot({branchCheck: false})?.dir;
  if (!snapshotDir) {
    console.error('No snapshot found. Run `pnpm snapshot:dev` first.');
    process.exit(1);
  }
  console.log(`Updater E2E\n  snapshot: ${snapshotDir}`);
  if (!fs.existsSync(path.join(snapshotDir, 'hashes.json'))) {
    console.error(
      `Snapshot ${snapshotDir} has no hashes.json — rebuild it with ` + '`pnpm snapshot:dev`.'
    );
    process.exit(1);
  }
  logBakedConfig(snapshotDir);
  assertBakedLocalIdentity(snapshotDir);

  // Process hygiene (issue #130): a cancelled or crashed previous run can
  // leave the detached installer holding port 8777 and BiDi browsers holding
  // temp profiles — kill them before anything waits on that port.
  await killStrayProcesses();

  const firefoxBin = opts.firefox || discoverFirefoxBinary();
  if (!firefoxBin) {
    console.error(missingFirefoxMessage());
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
  // Default selection. The state-only families are ONE step now (#309 + the
  // fold): step 1 carries the stale trio, the up-to-date/skipped decisions and
  // the folded install-applies / manual-install-no-ui scenarios, and the ids
  // 4/5/6/8 are its aliases (--scenario 6 still runs the whole session). The
  // default list names them only for back-compat with existing invocations.
  const scenarios = opts.scenarios || ['1', '6', '7', '8', '9', '10', '11'];

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
        // The variant session (#309, formerly the separate steps 1/4/5, and the
        // home of the folded install-applies / manual-install-no-ui): the stale
        // trio, up-to-date and skipped, and the two state-only scenarios, in ONE
        // browser. `--scenario 4` / `5` / `6` / `8` still select it (the variants
        // are no longer separable: they share the session).
        alias: ['4', '5', '6', '8'],
        run: async () => {
          const session = await runVariantSession(counter, opts, snapshotDir);
          profiles.push(...session.profiles);

          if (session.driverAvailable) {
            // A realm death was degraded in-session (the stale cards the dead
            // realm deferred were re-asserted in-tab; see runVariantSession):
            // only the decisions + folded phases it could not finish need a
            // launch. Coverage is complete either way — this is the degraded
            // shape, not a failed leg.
            const remaining = session.extrasRemaining ?? [];
            const remainingVariants = session.variantsRemaining ?? [];
            if (remaining.length === 0 && remainingVariants.length === 0) return;
            console.log(
              `\n  [driver] resuming out-of-session: ${[...remainingVariants, ...remaining].join(', ')}`
            );
            if (remaining.includes('install-applies')) {
              profiles.push(
                await runInstallAppliesScenario(counter, opts, snapshotDir, 'install-applies')
              );
            }
            if (remaining.includes('manual-install-no-ui')) {
              profiles.push(
                await runManualInstallNoUiScenario(
                  counter,
                  opts,
                  snapshotDir,
                  'manual-install-no-ui'
                )
              );
            }
            // Stale variants the dead realm deferred (its in-tab re-assertion
            // could not run either): they launch in the trio order, each its
            // own scenario — the pre-#309 shape for exactly those variants.
            const staleToLaunch = remainingVariants.filter(v => STALE_VARIANTS.includes(v));
            for (const variant of staleToLaunch) {
              profiles.push(
                await runLaunchedStaleVariantScenario(counter, opts, snapshotDir, variant)
              );
            }
            if (remainingVariants.includes('up-to-date')) {
              const upToDate = await runNoTabScenario(counter, opts, snapshotDir, 'up-to-date', {
                skipUtils: false,
                skipConfig: false,
              });
              profiles.push(handoffProfileDir(upToDate));
              // Only a FULL state carries the reuse fields; an early-exit string
              // (or partial object) leaves the reuse null and the skipped step
              // seeds its own profile instead of consuming undefined chromeUtils.
              if (remainingVariants.includes('skipped')) {
                const reuse = fullHandoffState(upToDate);
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
              }
            } else if (remainingVariants.includes('skipped')) {
              // skipped without up-to-date: no reuse source, seed fresh.
              profiles.push(
                handoffProfileDir(
                  await runNoTabScenario(counter, opts, snapshotDir, 'skipped', {
                    skipUtils: true,
                    forceUtilsStale: true,
                  })
                )
              );
            }
            return;
          }

          // Driver mode is unavailable in this environment (BiDi cannot evaluate
          // inside a privileged page — a limitation, not a startup race): run the
          // folded scenarios AND the up-to-date/skipped decisions as their own
          // launches, the pre-#309 way. The collapse is a structure/speed win,
          // never a coverage trade.
          console.log(
            '\n  [driver] falling back to the launch-per-scenario path for install-applies,' +
              ' manual-install-no-ui, up-to-date/skipped'
          );
          profiles.push(
            await runInstallAppliesScenario(counter, opts, snapshotDir, 'install-applies')
          );
          profiles.push(
            await runManualInstallNoUiScenario(counter, opts, snapshotDir, 'manual-install-no-ui')
          );
          const upToDate = await runNoTabScenario(counter, opts, snapshotDir, 'up-to-date', {
            skipUtils: false,
            skipConfig: false,
          });
          profiles.push(handoffProfileDir(upToDate));
          // Only a FULL state carries the reuse fields; an early-exit string
          // (or partial object) leaves the reuse null and the skipped step
          // seeds its own profile instead of consuming undefined chromeUtils.
          const reuse = fullHandoffState(upToDate);
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
        id: '7',
        run: async () => {
          // Phases 1 + 2 of issue #53 in two launches — the one scenario whose
          // restart is the point (a hand-installed utils.zip needs a fresh
          // browser to register its chrome mapping), so it keeps both.
          const state = await runManualInstallScenario(
            counter,
            opts,
            snapshotDir,
            'manual-install-upgrade'
          );
          profiles.push(handoffProfileDir(state));
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
      {
        id: '11',
        run: async () => {
          // Session restore across windows (#384 follow-up): the checked-in,
          // Firefox-authored fixture restores the updater tab in a NON-focused
          // window, backgrounded inside that window. The all-windows twin-tab
          // guard must keep the restored tab (no duplicate) and its engine
          // must re-check. FXS_E2E_SESSION_FILE overrides the fixture with
          // any Firefox-authored sessionstore.jsonlz4.
          await runSessionRestoreScenario(counter, opts, snapshotDir, 'session-restore');
        },
      },
    ];

    // --repeat <n> re-runs the whole scenario selection (fresh profile per
    // scenario per pass) — the deterministic repeat-run proof of #130.
    const repeat = opts.repeat ?? 1;
    for (let pass = 1; pass <= repeat; pass++) {
      if (repeat > 1) console.log(`\n===== repeat pass ${pass}/${repeat} =====`);

      for (const step of scenarioSteps) {
        const selected =
          scenarios.includes(step.id) || (step.alias || []).some(id => scenarios.includes(id));
        if (!selected) continue;
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
