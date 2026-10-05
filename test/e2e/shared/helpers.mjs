#!/usr/bin/env node
/** E2E shared helpers — puppeteer launch, assertions, screenshot, process utils. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {killProcessesByCmdline, waitForProcessesGone} from './processHygiene.mjs';
import {isFileLockError} from './downloads.mjs';

export const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

const OVERRIDE_PREFIX = 'extensions.firefox-scripts.override.';

/**
 * When the dev snapshot was built on another machine (cross-OS sharing), its
 * baked updater config points at the BUILDER's dist dir (file:// URLs), which
 * is unreachable here. Rather than rewrite the config — it ships inside
 * utils.zip and is part of the hashed file set, so rewriting it would flip the
 * package hash and break the staleness check — point the updater at THIS
 * machine's snapshot via pref overrides (scriptsUpdater.sys.mjs checks
 * extensions.firefox-scripts.override.<KEY> before the generated CONFIG).
 *
 * @param {string} chromeUtils profile's chrome/utils dir (post-extract)
 * @param {string} snapshotDir this machine's local snapshot dir
 * @returns {Record<string, string>} extra prefs, or {} when already consistent
 */
export function localConfigOverrides(chromeUtils, snapshotDir) {
  const cfg = path.join(chromeUtils, 'updater', 'updater-config.sys.mjs');
  if (!fs.existsSync(cfg)) {
    return {};
  }
  const text = fs.readFileSync(cfg, 'utf-8');
  const baked = text.match(/LOCAL_DIST_PATH:\s*'([^']*)'/)?.[1];
  if (!baked) {
    return {};
  }
  const local = snapshotDir.replace(/\\/g, '/');
  if (baked === local) {
    return {};
  }
  const base = pathToFileURL(local).href.replace(/\/$/, '');
  return {
    [OVERRIDE_PREFIX + 'HASHES_URL']: `${base}/hashes.json`,
    [OVERRIDE_PREFIX + 'ZIP_BASE_URL']: base,
    [OVERRIDE_PREFIX + 'UI_BASE_URL']: base,
    [OVERRIDE_PREFIX + 'HELPER_BASE_URL']: base,
  };
}

// ── Windows startup hygiene (issue #191) ─────────────────────────────────

/**
 * Prefs that keep a throwaway test browser out of the user's Windows Startup
 * apps. The HKCU Run value ("Mozilla-Firefox-<installHash>" = '"<exe>"
 * -os-autostart') is written by Firefox's launch-on-login AUTO-ENABLE, which
 * fires on the first run of a fresh profile of an official build — exactly what
 * every E2E leg launches (fresh %TEMP% install dir → a new Run name each time,
 * hence the accumulating debris on the dev machine; persistent-profile launches
 * never trigger it). Gates, best first: defaultEnabled — the Nimbus pref
 * DefaultLaunchOnLogin consults; a user pref here overrides any experiment
 * value alreadyApplied — skips the auto-enable entirely (also skips its Remote
 * Settings wait) winRegisterApplicationRestart — the Restart Manager
 * registration (invisible on the Startup page); off as a belt
 */
export const STARTUP_HYGIENE_PREFS = {
  'browser.startup.windowsLaunchOnLogin.defaultEnabled': false,
  'browser.startup.windowsLaunchOnLogin.alreadyApplied': true,
  'toolkit.winRegisterApplicationRestart': false,
};

const STARTUP_HYGIENE_MARKER = 'fxs-e2e startup hygiene';

/**
 * Write STARTUP_HYGIENE_PREFS into a profile's user.js — for launches that
 * bypass puppeteer (detached `--profile` spawns on fresh profile dirs, e.g. the
 * installer E2E's restart-scope bystander/target). Firefox applies user.js on
 * startup, before the first-run auto-enable could fire. Idempotent.
 *
 * @param {string} profileDir fresh profile directory (created if missing)
 */
export function seedStartupHygienePrefs(profileDir) {
  fs.mkdirSync(profileDir, {recursive: true});
  const userJs = path.join(profileDir, 'user.js');
  const existing = fs.existsSync(userJs) ? fs.readFileSync(userJs, 'utf-8') : '';
  if (existing.includes(STARTUP_HYGIENE_MARKER)) return;
  const lines = [
    `// ${STARTUP_HYGIENE_MARKER} (issue #191) — never register Windows startup entries`,
    ...Object.entries(STARTUP_HYGIENE_PREFS).map(
      ([name, value]) => `user_pref(${JSON.stringify(name)}, ${JSON.stringify(value)});`
    ),
    '',
  ];
  fs.appendFileSync(userJs, lines.join('\n'));
}

// ── Assertion counters ────────────────────────────────────────────────────

/** @returns {{passed: number; failed: number}} */
export function createCounter() {
  return {passed: 0, failed: 0};
}

/** @param {{passed: number; failed: number}} counter */
export function check(counter, ok, label, detail = '') {
  if (ok) {
    counter.passed++;
    console.log(`  PASS: ${label}`);
  } else {
    counter.failed++;
    console.error(`  FAIL: ${label}${detail ? ' — ' + detail : ''}`);
  }
}

/** Print summary line and return whether all checks passed. */
export function summary(counter) {
  const total = counter.passed + counter.failed;
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Results: ${counter.passed}/${total} passed`);
  console.log(`${'='.repeat(60)}`);
  return counter.failed === 0;
}

/**
 * Poll `fn` (sync or async) until it returns truthy or the timeout passes.
 *
 * Unlike a silent poll loop, per-attempt failures are VISIBLE: when `fn`
 * throws, the error is logged (throttled — first, then every ~10th attempt) so
 * a server that never comes up or keeps erroring shows _why_ in the job log
 * instead of surfacing as an opaque timeout at some later check. Returns the
 * first truthy value, or null on timeout.
 *
 * @param {() => Promise<unknown> | unknown} fn
 * @param {number} timeoutMs
 * @param {number} intervalMs
 * @param {string} [label] what is being waited for (error lines only)
 */
export async function pollUntil(fn, timeoutMs, intervalMs = 500, label = '') {
  const end = Date.now() + timeoutMs;
  let attempt = 0;
  let lastError;
  // Race each fn() against the remaining deadline: a callback that hangs
  // (fetch without a timeout, a wedged server) must not extend the poll past
  // its budget — the caller's own timeout then governs, and the poll returns
  // null on schedule instead of hanging the E2E run indefinitely.
  const withDeadline = async promise => {
    let timer;
    const cap = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`poll attempt exceeded the ${timeoutMs}ms budget`)),
        Math.max(1, end - Date.now())
      );
    });
    try {
      return await Promise.race([promise, cap]);
    } finally {
      clearTimeout(timer);
    }
  };
  for (;;) {
    attempt++;
    try {
      const v = await withDeadline(fn());
      if (v) return v;
    } catch (err) {
      lastError = err;
      if (attempt === 1 || attempt % 10 === 0) {
        const why = err instanceof Error ? err.message : String(err);
        console.warn(`  ⚠ poll #${attempt}${label ? ` (${label})` : ''}: ${why}`);
      }
    }
    if (Date.now() >= end) {
      if (lastError !== undefined) {
        const why = lastError instanceof Error ? lastError.message : String(lastError);
        console.warn(
          `  ⚠ poll timed out after ${timeoutMs}ms${label ? ` (${label})` : ''} — last error: ${why}`
        );
      }
      return null;
    }
    // Cap the inter-attempt sleep at the remaining budget so a late attempt
    // cannot push the next fn() past the deadline either.
    await new Promise(r => setTimeout(r, Math.min(intervalMs, Math.max(0, end - Date.now()))));
  }
}

// ── Puppeteer ──────────────────────────────────────────────────────────────

/**
 * Hard bound on the puppeteer launch handshake (process spawn + BiDi session
 * establishment), in ms. A 159 headless start under load can wedge inside the
 * handshake — neither puppeteer.launch nor the ProtocolError's own 45 s
 * protocolTimeout reliably fires — and the scenario then stalls instead of
 * reaching its retry (#384). Ported from the firefox-updater's
 * firefoxPuppeteer.js pattern: race the launch against this deadline, tag the
 * launch, kill the tagged tree on failure, retry once.
 */
const LAUNCH_DEADLINE_MS = 20_000;

/**
 * Race a puppeteer launch promise against a hard deadline. On deadline win,
 * kill every process whose command line carries `tag` (the whole browser tree —
 * killing only the launcher orphans its children) and reject with a tagged
 * error; the loser promise's late rejection is swallowed by the caller's
 * `launchPromise.catch(() => {})` so it cannot become an unhandled rejection
 * (same shape as firefoxPuppeteer.js).
 *
 * @param {Promise<import('puppeteer-core').Browser>} launchPromise
 * @param {number} deadlineMs
 * @param {string} tag unique per-launch tag (also present in the browser's
 *   argv)
 * @param {(msg: string) => void} log
 * @param {string} [profileDir] the attempt's userDataDir, swept as a second
 *   needle (the profile being free is what the retry needs)
 * @returns {Promise<import('puppeteer-core').Browser>}
 */
async function raceLaunchDeadline(launchPromise, deadlineMs, tag, log, profileDir) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`puppeteer launch timed out after ${deadlineMs / 1000}s (${tag})`)),
      deadlineMs
    );
  });
  try {
    return await Promise.race([launchPromise, deadline]);
  } catch (err) {
    if (!/launch timed out/.test(String(err?.message))) throw err;
    log(
      `  [launch] start exceeded ${deadlineMs / 1000}s — killing the wedged browser tree (${tag})`
    );
    killProcessesByCmdline(tag, {log, label: 'process(es) from the timed-out launch attempt'});
    // Also sweep by the profile the attempt was launched with: the tag kill is
    // one needle, and "the profile is free" is what the retry needs.
    if (profileDir) {
      killProcessesByCmdline(profileDir, {
        log,
        label: 'process(es) from the timed-out launch attempt holding the profile',
      });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Launch Firefox via puppeteer-core + WebDriver BiDi.
 *
 * Bounded (#384): the handshake is raced against LAUNCH_DEADLINE_MS; a wedged
 * start is killed BY TAG (the whole process tree) and the launch retried once.
 * A wedged start is transient (load-sensitive), so the retry usually connects;
 * if it wedges too, the tagged error surfaces to the scenario's own retry-once.
 * protocolTimeout (45 s per protocol command) is intentionally UNCHANGED — this
 * bounds only the launch phase. Same defensive shape as the firefox-updater's
 * firefoxPuppeteer.js (deadline race + per-launch tag + taskkill by tag +
 * late-rejection swallow).
 *
 * @param {string} binary - absolute path to Firefox executable
 * @param {string} profileDir - userDataDir (temp profile)
 * @param {{
 *   headless?: boolean;
 *   endpointTimeoutMs?: number;
 *   launchDeadlineMs?: number;
 *   protocolTimeoutMs?: number;
 * }} opts
 * @returns {Promise<import('puppeteer-core').Browser>}
 */
export async function launchFirefox(
  binary,
  profileDir,
  {
    headless = false,
    extraPrefsFirefox = {},
    launchDeadlineMs = LAUNCH_DEADLINE_MS,
    protocolTimeoutMs,
    // Puppeteer's own `timeout`: how long to wait for Firefox to print the
    // WebDriver BiDi WS endpoint on stdout. It DEFAULTS TO 30 s and is a
    // SEPARATE bound from launchDeadlineMs and protocolTimeout — raising the
    // other two does not raise it, so a start that legitimately takes longer
    // still fails here. Callers pass this when the browser is slow to reach the
    // endpoint because something in its own startup is slow (the core
    // delayed-registration scenario holds the loader for 30 s during startup,
    // #30). Omitted = puppeteer's default, i.e. every existing caller is
    // unaffected.
    endpointTimeoutMs,
  } = {}
) {
  const puppeteer = await import('puppeteer-core');
  // Unique per-launch tag, embedded in the browser argv: the deadline's kill
  // step matches it in the process command lines, so the wedged tree dies
  // completely instead of leaking orphans (firefoxPuppeteer.js pattern).
  const tag = `--fxs-e2e-puppeteer-${Date.now()}`;

  const launchOnce = async () => {
    const launchPromise = puppeteer.launch({
      browser: 'firefox',
      executablePath: binary,
      userDataDir: profileDir,
      headless,
      protocol: 'webDriverBiDi',
      // Default is 180 s per protocol command; session.new can hang that long
      // when a Firefox start wedges (observed 2026-09-22, reuse-path
      // measurement). Cap it so a wedged start surfaces as an error the
      // scenario can retry instead of stalling the whole leg.
      protocolTimeout: protocolTimeoutMs || 45_000,
      ...(endpointTimeoutMs ? {timeout: endpointTimeoutMs} : {}),
      // Puppeteer overwrites user.js with its own preferences before launch
      // (createProfile -> syncPreferences), so any prefs the caller needs must
      // be injected through this option — a caller-written user.js would be
      // silently replaced and never reach Firefox.
      extraPrefsFirefox: {
        // Never let a throwaway test install appear in the user's Windows
        // Startup apps — see STARTUP_HYGIENE_PREFS. Callers can still override
        // for a test that needs the real behavior.
        ...STARTUP_HYGIENE_PREFS,
        ...extraPrefsFirefox,
      },
      env: {
        // Firefox 159 (Bug 2054896, landed on nightly 2026-09-29) removed the
        // -remote-allow-system-access CLI argument and requires privileged
        // remote-agent calls to be allowed via the ENVIRONMENT — which is why
        // the updater E2E nightly legs failed on 2026-09-30 with
        //   RemoteError: unsupported operation System access is required. Start
        //   Firefox with the "MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1" environment
        //   variable set to enable it.
        // Harmless on Firefox <= 158 (where the flag still works) and required
        // on 159+ (the gate follows the Gecko base, so every browser leg needs
        // it once its base rebases past 158).
        ...process.env,
        MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1',
      },
      args: ['-remote-allow-system-access', '--new-instance', tag],
    });
    // A rejection after the deadline won the race must not become an unhandled
    // rejection (it would crash the harness) — firefoxPuppeteer.js shape.
    launchPromise.catch(() => {});
    // Callers may extend the deadline (not shorten it) for a start that is
    // legitimately heavier than a plain launch; the stock bound is the
    // default and the deadline exists to bound a wedged start, not to assert
    // performance.
    const deadline = Math.max(launchDeadlineMs, LAUNCH_DEADLINE_MS);
    return raceLaunchDeadline(launchPromise, deadline, tag, console.log, profileDir);
  };

  try {
    return await launchOnce();
  } catch (err) {
    // One fast retry: a wedged start is load-sensitive and transient; a
    // relaunch almost always connects (issue #384). Sweep the first attempt's
    // tree by tag BEFORE relaunching — the deadline kill only ran on the
    // deadline path, but a protocolTimeout on session.new (or any other
    // first-attempt rejection) can leave a browser holding the profileDir, and
    // the retry's --new-instance would then die on the profile lock instead of
    // the transient wedge (review on #343, 2026-10-01). The retry shares the
    // tag — a deadline kill on it sweeps both trees either way. The 45 s
    // protocolTimeout is intentionally UNCHANGED — this bounds the launch
    // phase, not protocol commands.
    killProcessesByCmdline(tag, {
      log: console.log,
      label: 'leftover process(es) from the wedged launch attempt',
    });
    // The profile dir is the second needle because the tag kill has two ways to
    // miss — the POSIX pattern form (fixed in killProcessesByCmdline, but a
    // needle only works when the process really carries it) and a tree that
    // outlived its argv — and because "the profile is free" is the property the
    // retry actually needs: `--new-instance` starts against the SAME
    // userDataDir, so a survivor makes the retry wedge on the profile the first
    // attempt still holds (macOS nightly 2026-10-02: both attempts died at the
    // 20 s deadline, and the runner had to terminate orphan browser processes
    // afterwards).
    killProcessesByCmdline(profileDir, {
      log: console.log,
      label: 'wedged process(es) holding the profile',
    });
    // ...and then WAIT for the tree to actually unwind: pkill signals and
    // returns while the browser takes seconds to release the profile lock.
    if (
      !(await waitForProcessesGone(profileDir, {
        log: console.log,
        label: 'wedged browser still holding the profile',
      }))
    ) {
      console.log('  [launch] the profile is still held — the retry may wedge on the profile lock');
    }
    console.log(`  [launch] wedged (${err?.message}) — retrying once`);
    try {
      return await launchOnce();
    } catch (retryErr) {
      // The retry's own tree must not outlive its failure either: the caller's
      // `finally { closeBrowser(browser) }` has no Browser to close when the
      // launch rejected (browser was never assigned), so a failed second
      // attempt would leak a browser still holding the profileDir — and on
      // Windows the next leg's profile lock (CodeRabbit on #343, 2026-10-02).
      killProcessesByCmdline(tag, {
        log: console.log,
        label: 'process(es) from the failed retry launch attempt',
      });
      throw retryErr;
    }
  }
  // closeBrowser's startup sweep keys off this (puppeteer's Browser keeps no
  // executable path of its own).
}

/**
 * Mirror the Firefox process stdout/stderr into the test log — autoconfig and
 * startup JS errors surface there.
 */
export function attachProcessLogging(browser, label = 'ff') {
  const proc = browser.process?.();
  if (!proc?.stdout || !proc?.stderr) return;
  const pipe = (stream, name) => {
    stream.setEncoding('utf8');
    let buf = '';
    stream.on('data', chunk => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (line.trim()) console.log(`  [${label}:${name}] ${line}`);
      }
    });
  };
  pipe(proc.stdout, 'out');
  pipe(proc.stderr, 'err');
}

/**
 * Poll browser.pages() for a page whose url starts with `prefix`.
 *
 * @param {import('puppeteer-core').Browser} browser
 * @param {string} prefix - URL prefix to match
 * @param {number} [timeoutMs=15000] — the updater scheduler runs at startup, so
 *   a tab that has not appeared in ~15 s will not appear. Default is `15000`
 * @returns {Promise<import('puppeteer-core').Page | null>}
 */
export async function findPageByUrl(browser, prefix, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastProgressLog = 0;
  while (Date.now() < deadline) {
    try {
      const pages = await browser.pages();
      if (Date.now() - lastProgressLog > 15_000) {
        console.log(
          `  [diag] polling pages: ${pages.length} open [${pages.map(p => p.url()).join(' | ')}]`
        );
        lastProgressLog = Date.now();
      }
      const page = pages.find(p => {
        try {
          return p.url().startsWith(prefix);
        } catch {
          return false;
        }
      });
      if (page) return page;
    } catch (err) {
      // browser not ready yet — but log repeated attach failures
      if (Date.now() - lastProgressLog > 15_000) {
        console.log(`  [diag] pages() threw: ${err.message}`);
        lastProgressLog = Date.now();
      }
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return null;
}

/**
 * Poll `page.evaluate(condition)` until it returns true or timeout.
 *
 * @param {import('puppeteer-core').Page} page
 * @param {() => boolean} condition
 * @param {number} timeoutMs
 * @param {string} label
 * @returns {Promise<boolean>}
 */
export async function waitForCondition(page, condition, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await page.evaluate(condition)) return true;
    } catch {
      // page mid-navigation
    }
    await new Promise(r => setTimeout(r, 500));
  }
  console.warn(`  ⚠ timed out waiting for: ${label}`);
  return false;
}

/**
 * Take a screenshot of a chrome:// page via drawWindow (BiDi cannot capture
 * privileged contexts via captureScreenshot).
 *
 * @param {import('puppeteer-core').Page} page
 * @param {string} outPath - absolute path to write PNG
 * @returns {Promise<boolean>} success
 */
export async function screenshotPrivileged(page, outPath) {
  try {
    const dataUrl = await page.evaluate(() => {
      const win = window;
      const canvas = win.document.createElementNS('http://www.w3.org/1999/xhtml', 'canvas');
      canvas.width = win.innerWidth;
      canvas.height = win.innerHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawWindow(win, 0, 0, win.innerWidth, win.innerHeight, 'rgb(255,255,255)');
      return canvas.toDataURL('image/png');
    });
    fs.mkdirSync(path.dirname(outPath), {recursive: true});
    fs.writeFileSync(outPath, Buffer.from(dataUrl.split(',')[1], 'base64'));
    return true;
  } catch (err) {
    console.warn(`  (screenshot unavailable: ${err.message})`);
    return false;
  }
}

// ── Process / temp helpers ─────────────────────────────────────────────────

/**
 * Every temp root this process created and has not removed yet. The E2E legs
 * mkdtemp a ~50 MB Firefox profile per scenario into the OS temp dir, and the
 * per-scenario `finally` blocks only cover the SUCCESS path: a Ctrl-C, an agent
 * timeout, a `process.exit()` on a failed check or a machine crash all strand
 * one (on 2026-10-02 the user's Temp held 11 of them, 412 MB). The registry
 * plus the exit/signal sweep below reclaims them however the run ends; the
 * age-based prune is the backstop for whatever escapes it.
 */
const liveTempRoots = new Set();

/**
 * Starts-with prefixes of every OS-temp directory this harness creates (the
 * mkdtemp call appends `-XXXXXX`). `pruneStaleTempRoots` sweeps exactly these
 * and nothing else — the user's Temp belongs to every other tool on the box.
 */
export const E2E_TEMP_PREFIXES = [
  'fxs-e2e',
  'fxs-installer',
  'fxs-installer-ui',
  'fxs-installer-surface',
  'fxs-fx',
  'fxs-ident',
  'fxs-cfg',
  'fxs-release',
  'fxs-helper',
  'fxs-legacy',
];

const HOUR_MS = 60 * 60 * 1000;

/** Breadcrumb file for roots that survived the sweep (gitignored, inside dist/). */
function leakedRootsPath() {
  return path.join(REPO_ROOT, 'dist', 'e2e-leaked-temp.txt');
}

/**
 * Record a temp root the sweep could not remove, so a human can see what was
 * stranded (and the next run's prune clears it once it ages out). Best-effort:
 * never throws, never affects the run.
 *
 * @param {string} dir absolute path
 */
export function noteLeakedTempRoot(dir) {
  try {
    fs.mkdirSync(path.dirname(leakedRootsPath()), {recursive: true});
    fs.appendFileSync(leakedRootsPath(), `${new Date().toISOString()} ${dir}\n`);
  } catch {
    // ignore
  }
}

// ── Windows lock-tolerant file I/O ─────────────────────────────────────────
//
// The updater E2E reads and writes files a RUNNING browser also holds: the
// profile's chrome/utils tree the in-tab install copies into and re-hashes,
// GreD's config.js the browser rewrote at startup, and the driver page the
// harness drops next to the updater module mid-session. Windows denies the
// access with EBUSY ("resource busy or locked") — or EPERM while a scanner
// holds the file — and a bare readFileSync/writeFileSync then reds a leg even
// though the install itself succeeded (floorp portable leg, 2026-10-02: an
// uncaught EBUSY out of computeInstalledHash). These wrappers ride out a
// transient hold with bounded exponential backoff; only a PERSISTENT lock
// rethrows. The lock signature stays in downloads.mjs, next to the installer
// retry that first needed it, so the harness keeps ONE lock predicate.

/** Synchronous sleep — the repo's retry idiom (see runInstallerWithRetry). */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run `fn`, retrying ONLY the Windows file-lock signature (isFileLockError)
 * with exponential backoff. Any other error is rethrown at once, and a lock
 * that outlives every attempt is rethrown as-is. Default 5 attempts / 300 ms
 * base = ~4.5 s of patience, enough for a browser-exit flush or an AV scan to
 * release a file without stretching a polling caller's deadline.
 *
 * @template T
 * @param {() => T} fn
 * @param {object} [opts]
 * @param {number} [opts.attempts] Total tries (default 5)
 * @param {number} [opts.delayMs] First backoff, doubling each retry (default
 *   300)
 * @param {(ms: number) => void} [opts.sleep] Test seam
 * @param {string} [opts.platform] Test seam (defaults to process.platform)
 * @returns {T}
 */
export function withLockRetrySync(
  fn,
  {attempts = 5, delayMs = 300, sleep = sleepSync, platform} = {}
) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return fn();
    } catch (err) {
      lastErr = err;
      if (!isFileLockError(err, platform ? {platform} : {}) || attempt === attempts) throw err;
      sleep(delayMs * 2 ** (attempt - 1));
    }
  }
  throw lastErr;
}

/**
 * readFileSync with the lock retry (see withLockRetrySync).
 *
 * @param {string} file
 * @param {BufferEncoding | {encoding?: BufferEncoding; flag?: string}} [options]
 * @returns {string | Buffer}
 */
export function readFileSyncWithRetry(file, options) {
  return withLockRetrySync(() => fs.readFileSync(file, options));
}

/**
 * writeFileSync with the lock retry (see withLockRetrySync).
 *
 * @param {string} file
 * @param {string | Buffer} data
 * @param {BufferEncoding | {encoding?: BufferEncoding; flag?: string; mode?: number}} [options]
 * @returns {void}
 */
export function writeFileSyncWithRetry(file, data, options) {
  withLockRetrySync(() => fs.writeFileSync(file, data, options));
}

/** rm a tree, reporting whether it is gone. Never throws. */
function removeTree(dir) {
  try {
    fs.rmSync(dir, {recursive: true, force: true, maxRetries: 3, retryDelay: 50});
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove every root still registered, whatever killed the run. Safe to call
 * more than once; a root that will not go is recorded, not retried forever.
 *
 * @returns {number} roots removed
 */
export function sweepLiveTempRoots() {
  let removed = 0;
  for (const dir of [...liveTempRoots]) {
    if (removeTree(dir)) {
      liveTempRoots.delete(dir);
      removed += 1;
    } else {
      noteLeakedTempRoot(dir);
    }
  }
  return removed;
}

let sweepInstalled = false;

/**
 * Sweep on the ways a run can end without unwinding: exit, the interactive
 * signals, and the two crash paths. Each handler sweeps and then reproduces
 * Node's default disposition (`process.exit` with the conventional 128+signal
 * code, or 1 for an uncaught error) so exit codes and stack traces are
 * unchanged — the only new behaviour is that temp roots do not survive.
 * Installed at most once per process.
 *
 * Windows caveat: a parent's `child.kill()` is TerminateProcess, which Node
 * cannot intercept — no handler runs and only `pruneStaleTempRoots` can reclaim
 * what it leaves. A real console Ctrl-C does deliver SIGINT and sweeps.
 */
function installTempSweep() {
  if (sweepInstalled) return;
  sweepInstalled = true;
  process.on('exit', () => sweepLiveTempRoots());
  for (const [signal, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
    ['SIGHUP', 129],
  ]) {
    process.on(signal, () => {
      sweepLiveTempRoots();
      process.exit(code);
    });
  }
  for (const event of ['uncaughtException', 'unhandledRejection']) {
    process.on(event, err => {
      sweepLiveTempRoots();
      console.error(err);
      process.exit(1);
    });
  }
}

/** Create a temp directory and return its path (registered for the sweep). */
export function tempDir(prefix = 'fxs-e2e') {
  installTempSweep();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-'));
  liveTempRoots.add(dir);
  return dir;
}

/**
 * Delete a directory tree recursively (best-effort, no throw).
 *
 * Only roots THIS process created are tracked: an owned tree that refuses to go
 * stays registered for the exit sweep's second try and is then recorded in
 * dist/e2e-leaked-temp.txt. rmDir() also gets called on trees the harness did
 * not create here (a caller's own scratch dir), and those must not be reported
 * as ours — the breadcrumb file exists to name OUR litter.
 */
export function rmDir(dir) {
  const owned = liveTempRoots.has(dir);
  if (removeTree(dir)) {
    liveTempRoots.delete(dir);
  } else if (owned) {
    noteLeakedTempRoot(dir);
  }
}

/**
 * Reclaim OS-temp roots stranded by earlier runs. Age is the whole liveness
 * signal: a live leg's profile was created seconds ago, while every stranded
 * root is older than the threshold — a stale `.parentlock` (which a killed run
 * leaves behind) is exactly the case we WANT to reclaim, so it must not be read
 * as "in use". Roots this process still holds are never touched.
 *
 * Called once per E2E invocation (test/e2e/shared/run.mjs and each suite's
 * main), before the first profile is seeded.
 *
 * @param {{
 *   minAgeMs?: number;
 *   prefixes?: string[];
 *   tmp?: string;
 *   now?: number;
 *   log?: (msg: string) => void;
 * }} [opts]
 * @returns {{removed: string[]; kept: string[]}}
 */
export function pruneStaleTempRoots({
  minAgeMs = 6 * HOUR_MS,
  prefixes = E2E_TEMP_PREFIXES,
  tmp = os.tmpdir(),
  now = Date.now(),
  log = console.log,
} = {}) {
  let entries;
  try {
    entries = fs.readdirSync(tmp, {withFileTypes: true});
  } catch {
    return {removed: [], kept: []};
  }
  const removed = [];
  const kept = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !prefixes.some(p => entry.name.startsWith(p))) continue;
    const full = path.join(tmp, entry.name);
    if (liveTempRoots.has(full)) {
      kept.push(full);
      continue;
    }
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (now - stat.mtimeMs < minAgeMs) {
      kept.push(full);
      continue;
    }
    if (removeTree(full)) removed.push(full);
    else kept.push(full);
  }
  if (removed.length) {
    log(
      `  [temp] pruned ${removed.length} stranded E2E temp root(s) ` +
        `(>${Math.round(minAgeMs / HOUR_MS)}h old): ${removed.map(d => path.basename(d)).join(', ')}`
    );
  }
  return {removed, kept};
}

/**
 * Live `fxs-installer-*` scratch roots in the OS temp dir. The C installer
 * creates one per process and removes it when the install reaches a terminal
 * state, so a dir that survives a completed install is residue. Snapshot the
 * set before an install and diff it afterwards: unrelated strays from an
 * earlier killed run must not fail an unrelated check.
 *
 * @param {string} [tmp] temp dir to scan
 * @returns {string[]} absolute paths
 */
export function installerWorkDirStrays(tmp = os.tmpdir()) {
  try {
    return fs
      .readdirSync(tmp, {withFileTypes: true})
      .filter(e => e.isDirectory() && e.name.startsWith('fxs-installer'))
      .map(e => path.join(tmp, e.name));
  } catch {
    return [];
  }
}

/** Wait for process exit with a timeout; returns exit info or null. */
export function waitForProcessExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      // Try to get current status before timeout
      if (child.exitCode !== null) {
        resolve({code: child.exitCode, signal: child.signalCode});
      } else {
        reject(new Error('Process did not exit within timeout'));
      }
    }, timeoutMs);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({code, signal});
    });
    child.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
