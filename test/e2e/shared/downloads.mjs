#!/usr/bin/env node

/**
 * test/e2e/shared/downloads.mjs — official browser download/install map for the
 * E2E CI matrix.
 *
 * The workflow (e2e.yml) used to hard-code each browser's install commands per
 * OS; this module is the single source of truth: browser → per-OS install
 * recipe, plus a CLI that performs the install for the current OS and exports
 * the resolved binary path.
 *
 * CLI (used by e2e.yml, works locally too): node test/e2e/shared/downloads.mjs
 * <browser> [--os win|mac|linux] — installs and prints the binary path. With
 * --installed-version it instead prints the ALREADY-INSTALLED binary's version
 * (FIREFOX_BINARY or the install dirs) — ground truth of what an E2E leg
 * validated, since Mozilla's "latest" redirect URLs embed no version.
 *
 * On success the resolved binary path is printed to stdout and, when running
 * inside GitHub Actions ($GITHUB_ENV set), appended to $GITHUB_ENV as
 * FIREFOX_BINARY — the updater E2E (updater-e2e.mjs) reads that env var.
 *
 * Browsers without an automated recipe (manual install only) list their
 * official download page instead; the CLI fails with a clear message.
 */

import {execSync, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {resolveInstallerUrl, verifySha256} from './browserResolver.mjs';
import {discoverFirefoxBinary} from './browsers.mjs';

/**
 * Per-browser install recipes keyed by platform (win|mac|linux).
 *
 * - {url, args} → download the official installer from `url` (progress-aware
 *   streaming: a slow-but-advancing transfer is never aborted, only a stalled
 *   stream is) and run it with `args` (e.g. NSIS `/S` silent install), then
 *   resolve the binary from known install dirs.
 * - {url, app} → download the official dmg from `url`, mount it, and copy `app`
 *   into /Applications (macOS).
 * - {tarball, url} → download the official tarball and extract it; returns the
 *   binary path directly.
 * - {resolver: true, args} → version + mirror resolved by browserResolver.mjs
 *   (LibreWolf's bsys6-first chain, Waterfox's CDN); falls back to the
 *   temporary `ci-downloads` release and then the cached previous installer.
 * - `manual: true` → no automated install; `page` is the official download page
 *   (informational, for the manual legs).
 *
 * The E2E workflow installs what CI needs today (firefox, firefox-dev,
 * librewolf, floorp, zen, waterfox on Windows); the waterfox leg is advisory
 * during its soak period (ADR 0021).
 */
export const DOWNLOADS = {
  'firefox': {
    install: {
      // Official Mozilla "latest" redirects — stable URLs, so download
      // directly (fetchWithRetry) and silent-install ourselves instead of
      // delegating to a package manager.
      win: {
        url: 'https://download.mozilla.org/?product=firefox-latest&os=win64&lang=en-US',
        args: ['/S'], // NSIS silent install → Program Files\Mozilla Firefox
      },
      mac: {
        url: 'https://download.mozilla.org/?product=firefox-latest&os=osx&lang=en-US',
        app: 'Firefox.app', // dmg → copy into /Applications
      },
      // Mozilla official tarball — apt ships a Snap wrapper whose BiDi
      // connection fails, so CI installs the tarball instead.
      linux: {
        tarball: 'https://download.mozilla.org/?product=firefox-latest&os=linux64&lang=en-US',
      },
    },
  },
  'firefox-dev': {
    install: {
      // Same stable Mozilla "latest" redirect as Firefox stable, dev channel.
      // Required legs on ALL 3 OSes (#35): Dev Edition is first-party Mozilla,
      // so it is hard-gated like stable, unlike the forks.
      win: {
        url: 'https://download.mozilla.org/?product=firefox-devedition-latest&os=win64&lang=en-US',
        args: ['/S'], // NSIS silent install → %LOCALAPPDATA%\Firefox Developer Edition
      },
      mac: {
        url: 'https://download.mozilla.org/?product=firefox-devedition-latest&os=osx&lang=en-US',
        app: 'Firefox Developer Edition.app', // dmg → copy into /Applications
      },
      // Official tarball like stable — CI never uses the Snap wrapper (BiDi).
      linux: {
        tarball:
          'https://download.mozilla.org/?product=firefox-devedition-latest&os=linux64&lang=en-US',
      },
    },
    page: 'https://www.mozilla.org/firefox/developer/',
  },
  'waterfox': {
    install: {
      // Waterfox publishes no GitHub release assets, but its own CDN serves a
      // versioned NSIS installer (cdn.waterfox.com/waterfox/releases/<v>/
      // WINNT_x86_64/"Waterfox Setup <v>.exe" — pattern from the maintainer's
      // firefox-updater). resolveInstallerUrl walks the fallback chain
      // (CDN → ci-downloads manual escape → cached installer) and resolves
      // the version from the GitHub tag or the CDN releases index.
      win: {resolver: true, args: ['/S']}, // NSIS silent install → Program Files\Waterfox
    },
    page: 'https://www.waterfox.net/download/',
  },
  // Zen keeps a stable asset name across releases, so GitHub's
  // `/releases/latest/download/` redirect always resolves the newest installer.
  'zen': {
    install: {
      win: {
        url: 'https://github.com/zen-browser/desktop/releases/latest/download/zen.installer.exe',
        args: ['/S'], // NSIS silent install → %LOCALAPPDATA%\Zen Browser
      },
    },
    page: 'https://zen-browser.app/download/',
  },
  // LibreWolf embeds the version in the download URL, so the version and the
  // mirror are resolved by browserResolver.mjs: Codeberg bsys6 releases API →
  // Codeberg packages API for the version, then librewolf.dev →
  // dl.librewolf.net → bsys6 asset → ci-downloads → cached installer for the
  // download (the packages API stalled the Sep 2026 publish; bsys6 sampled
  // ~20× faster).
  'librewolf': {
    install: {
      win: {resolver: true, args: ['/S']}, // NSIS silent install → Program Files\LibreWolf
    },
  },
  // Floorp keeps a stable asset name across releases, so GitHub's
  // `/releases/latest/download/` redirect always resolves the newest installer
  // without a version lookup.
  'floorp': {
    install: {
      win: {
        url: 'https://github.com/Floorp-Projects/Floorp/releases/latest/download/floorp-windows-x86_64.installer.exe',
        args: ['/S'], // NSIS silent install → Program Files\Ablaze Floorp
      },
    },
  },
};

/** Map Node's process.platform to the recipe keys. */
export function platformKey(platform = process.platform) {
  if (platform === 'win32') return 'win';
  if (platform === 'darwin') return 'mac';
  return 'linux';
}

/**
 * Resolve a browser's binary after an installer run, mirroring the
 * candidate-dir search of discoverFirefoxBinary (real install dirs, never PATH
 * shims or app-execution aliases — their parent dir is not the browser's
 * GreD).
 */
export function resolveBinary(browser) {
  const prev = process.env.RUNTIME_BROWSER;
  process.env.RUNTIME_BROWSER = browser;
  try {
    return discoverFirefoxBinary();
  } finally {
    if (prev === undefined) delete process.env.RUNTIME_BROWSER;
    else process.env.RUNTIME_BROWSER = prev;
  }
}

/**
 * Directory for downloaded installers. The E2E workflow sets BROWSER_DL_DIR to
 * a path backed by actions/cache, so the ~100 MB Firefox downloads are restored
 * instead of re-downloaded on every run. Defaults to the OS temp dir for local
 * runs.
 */
export function downloadDir() {
  return process.env.BROWSER_DL_DIR || os.tmpdir();
}

/**
 * Resolve a browser's download URL for a platform (the recipe's tarball,
 * installer URL, or latest-resolved URL) — used to key the CI download cache,
 * since the URL embeds the release version. `latest` recipes query their
 * registry API, so this is async.
 *
 * @param {string} browser
 * @param {string} [platform] process.platform value (win32|darwin|linux)
 * @returns {Promise<string>}
 */
export async function resolveDownloadUrl(browser, platform = process.platform) {
  const key = platformKey(
    platform === 'win' ? 'win32'
    : platform === 'mac' ? 'darwin'
    : platform
  );
  const recipe = DOWNLOADS[browser]?.install?.[key];
  if (!recipe) {
    throw new Error(
      `${browser} has no automated install for ${key}` +
        (DOWNLOADS[browser]?.page ?
          ` — manual install only (official page: ${DOWNLOADS[browser].page})`
        : '')
    );
  }
  if (recipe.resolver) {
    const {url} = await resolveInstallerUrl(browser);
    return url;
  }
  return recipe.tarball || recipe.url;
}

/** Download an official Mozilla tarball and extract it; returns the binary path. */
async function installTarball(url, browser, dest = path.join(os.homedir(), 'firefox-app')) {
  const archive = path.join(downloadDir(), `firefox-${browser}.tar.xz`);
  fs.mkdirSync(dest, {recursive: true});

  await downloadTo(url, archive);

  // Extract next to existing content (tar xf, no strip): $HOME/firefox-app/firefox/
  execSync(`tar xf "${archive}" -C "${dest}"`, {stdio: 'inherit'});
  const binary = path.join(dest, 'firefox', 'firefox');
  if (!fs.existsSync(binary)) {
    throw new Error(`tarball extracted, but ${binary} not found`);
  }
  return binary;
}

// ── Progress-aware download ───────────────────────────────────────────────
//
// The installers are fetched from vendor CDNs whose speed varies wildly: the
// same 158 MB LibreWolf installer took 13 s from CI runners and 5.5 min over a
// home link (2026-09-06 measurements, issue #143). A wall-clock timeout kills
// such a healthy-but-slow transfer mid-stream (~130 MB in) and retries it from
// byte 0 — 5 attempts × 5 min + backoff ≈ 25 min of waste, then failure. So
// instead: stream to disk, abort only when NO bytes advance for the stall
// window (a 0.3 MB/s trickle delivers a chunk every ~2 s and is never killed),
// and resume interrupted attempts via a Range request instead of restarting.

const DEFAULT_STALL_MS = 60_000;
const DEFAULT_TOTAL_BUDGET_MS = 20 * 60_000;
const DEFAULT_RETRY_BACKOFF_MS = 5000;

/** Env override, for the unit tests (same pattern as the resolver's backoff). */
function envMs(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const stallTimeoutMs = () => envMs('DOWNLOAD_STALL_TIMEOUT_MS', DEFAULT_STALL_MS);
const totalBudgetMs = () => envMs('DOWNLOAD_TOTAL_BUDGET_MS', DEFAULT_TOTAL_BUDGET_MS);
const retryBackoffMs = () => envMs('DOWNLOAD_RETRY_BACKOFF_MS', DEFAULT_RETRY_BACKOFF_MS);

/**
 * A timer that can be cancelled — raced against chunk reads for stall
 * detection.
 */
function abortIn(ms, message) {
  let timer;
  const promise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return {promise, cancel: () => clearTimeout(timer)};
}

/**
 * One streaming download attempt. Aborts when no bytes arrive for the stall
 * window, when the attempt outlives its share of the total budget, or when the
 * final size disagrees with Content-Length. The partial file stays on disk so
 * the next attempt can resume it with a Range request.
 *
 * @param {string} url
 * @param {string} dest
 * @param {number} budgetEnd epoch ms — the attempt's wall-clock bound
 * @param {number} resumeFrom bytes already on disk to resume after (0 =
 *   restart)
 * @returns {Promise<number>} bytes written
 */
async function downloadAttempt(url, dest, budgetEnd, resumeFrom) {
  const headers = resumeFrom > 0 ? {Range: `bytes=${resumeFrom}-`} : {};
  const res = await fetch(url, {
    headers,
    redirect: 'follow',
    // Whole-attempt wall guard: fires on a hung connect/TTFB and enforces the
    // share of the total budget left for this attempt. Mid-body stalls abort
    // earlier via the per-chunk stall race below. The old code had a flat
    // 5-min attempt cap that killed healthy slow downloads — this only bounds
    // the TOTAL budget, so a 0.5 MB/s transfer of 158 MB (~5.5 min) completes.
    signal: AbortSignal.timeout(Math.max(1, budgetEnd - Date.now())),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const resuming = resumeFrom > 0 && res.status === 206;
  const expected = (resuming ? resumeFrom : 0) + (Number(res.headers.get('content-length')) || 0);
  const stream = fs.createWriteStream(dest, {flags: resuming ? 'a' : 'w'});
  let streamErr;
  stream.on('error', err => {
    streamErr = err;
  });
  let written = resuming ? resumeFrom : 0;
  let lastLogAt = Date.now();
  let lastLogBytes = written;
  if (!res.body) {
    if (expected === 0) return 0;
    throw new Error(`empty response body for ${url}`);
  }
  const reader = res.body.getReader();
  try {
    for (;;) {
      if (streamErr) throw streamErr;
      const stall = abortIn(
        stallTimeoutMs(),
        `download stalled: no bytes for ${stallTimeoutMs() / 1000}s`
      );
      let chunk;
      try {
        const result = await Promise.race([reader.read(), stall.promise]);
        if (result.done) break;
        chunk = result.value;
      } finally {
        stall.cancel();
      }
      written += chunk.length;
      if (!stream.write(Buffer.from(chunk))) {
        // Wait for drain — but never hang: if the stream errors while
        // backpressured (disk full, closed fd) the drain event never fires.
        // Race the two so the promise always settles; the error path rethrows
        // through the same catch that flushes and resumes.
        await new Promise((resolve, reject) => {
          const onDrain = () => {
            stream.off('error', onError);
            resolve();
          };
          const onError = err => {
            stream.off('drain', onDrain);
            reject(err);
          };
          stream.once('drain', onDrain);
          stream.once('error', onError);
        });
      }
      // Progress heartbeat — CI logs show the transfer is alive.
      if (written - lastLogBytes >= 10 * 1048576) {
        const rate = Math.round(
          (written - lastLogBytes) / 1024 / ((Date.now() - lastLogAt) / 1000)
        );
        console.log(`  ${Math.round(written / 1048576)} MB downloaded (${rate} KB/s)`);
        lastLogAt = Date.now();
        lastLogBytes = written;
      }
    }
    await new Promise((resolve, reject) => stream.end(err => (err ? reject(err) : resolve())));
  } catch (err) {
    reader.cancel().catch(() => {});
    // Flush whatever reached the WriteStream before closing, so the partial
    // file on disk matches `written` and the next attempt can resume from it.
    await new Promise(resolve => stream.end(resolve)).catch(() => {});
    throw err;
  }
  if (expected && written !== expected) {
    throw new Error(`download truncated: ${written} of ${expected} bytes`);
  }
  return written;
}

/**
 * Download a URL to a local file, streaming to disk with stall detection and
 * Range resume; returns the file path.
 *
 * A non-empty local file is reused when it matches the remote size (the
 * workflow restores downloads from the CI cache); a size mismatch means the
 * previous download was cut short, so it is re-fetched. Interrupted attempts
 * resume from the partial file via a Range request — a server without range
 * support answers 200 and the attempt restarts cleanly. Throws only after all
 * attempts fail (stall, budget, or HTTP error); the partial file is kept for
 * the next call.
 */
export async function downloadTo(url, dest) {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    try {
      const head = await fetch(url, {
        method: 'HEAD',
        signal: AbortSignal.timeout(15_000),
      });
      const expected = head.ok ? Number(head.headers.get('content-length')) : 0;
      if (expected && fs.statSync(dest).size === expected) {
        console.log(`  reusing cached ${path.basename(dest)}`);
        return dest;
      }
    } catch {
      // HEAD failed (flaky network) — reuse the local file rather than fail.
      console.log(`  HEAD failed; reusing cached ${path.basename(dest)}`);
      return dest;
    }
  }
  fs.mkdirSync(path.dirname(dest), {recursive: true});
  const attempts = 5;
  const budgetEnd = Date.now() + totalBudgetMs();
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    // Resume only from a partial file written by a previous attempt of THIS
    // call — a pre-existing wrong-size file (stale cache entry) was already
    // rejected by the HEAD check above and must never be appended to.
    const resumeFrom = attempt > 1 && fs.existsSync(dest) ? fs.statSync(dest).size : 0;
    try {
      await downloadAttempt(url, dest, budgetEnd, resumeFrom);
      return dest;
    } catch (err) {
      // Budget exhausted: no point burning the remaining attempts on
      // instant timeouts — surface the real reason.
      if (err.name === 'TimeoutError' && Date.now() >= budgetEnd - 1_000) {
        throw new Error(
          `download exceeded its ${Math.round(totalBudgetMs() / 60_000)} min budget: ${err.message}`,
          {cause: err}
        );
      }
      lastErr = err;
      console.log(`  download attempt ${attempt}/${attempts} failed: ${err.message}`);
      if (attempt < attempts) {
        // Backoff between attempts: the installer CDNs (e.g. librewolf.dev)
        // stall occasionally, and a fresh attempt right away usually fails
        // again. 5 s, 10 s, 15 s… — bounded, and well inside the job budget.
        await new Promise(r => setTimeout(r, retryBackoffMs() * attempt));
      }
    }
  }
  throw lastErr;
}

/**
 * Find a previously downloaded installer in the download dir (a prior run's
 * cache restore) — the fallback when a fresh download is impossible. The
 * browser-matrix legs are ADVISORY in the E2E gate, so testing an older release
 * beats failing the leg outright (and the gate still surfaces the warning).
 */
function findCachedInstaller(browser) {
  const dir = downloadDir();
  if (!fs.existsSync(dir)) return null;
  const prefix = `${browser}-setup`;
  const found = fs.readdirSync(dir).find(f => f.startsWith(prefix) && f.endsWith('.exe'));
  return found ? path.join(dir, found) : null;
}

/** Download an official installer and run it with args (e.g. NSIS `/S`). */
async function installInstaller(url, browser, args) {
  const exe = path.join(downloadDir(), `${browser}-setup.exe`);
  try {
    await downloadTo(url, exe);
  } catch (err) {
    const fallback = findCachedInstaller(browser);
    if (fallback) {
      console.log(
        `  ⚠ download failed (${err.message}); reusing previously downloaded ` +
          `installer ${path.basename(fallback)} (advisory leg — gate will warn)`
      );
      execSync(`"${fallback}" ${args.join(' ')}`, {stdio: 'inherit'});
      return;
    }
    throw err;
  }
  execSync(`"${exe}" ${args.join(' ')}`, {stdio: 'inherit'});
}

/** Download Firefox Release into a custom, non-registered directory. */
async function installPortableFirefox(url, platform) {
  const dest = process.env.PORTABLE_BROWSER_DIR;
  if (!dest) throw new Error('PORTABLE_BROWSER_DIR is required for portable Firefox');
  fs.mkdirSync(dest, {recursive: true});

  if (platform === 'linux') {
    const binary = await installTarball(url, 'firefox-portable', dest);
    return binary;
  }

  if (platform === 'win32') {
    const exe = path.join(downloadDir(), 'firefox-portable-setup.exe');
    await downloadTo(url, exe);
    // NSIS /D must be the final argument and uses a custom directory instead
    // of the registered Program Files location.
    // Pass the final /D= option directly to NSIS. PowerShell launches this
    // Node process with native Windows paths, and verbatim arguments prevent
    // MSYS/Git Bash path rewriting when the same helper is used locally.
    const result = spawnSync(exe, ['/S', `/D=${dest}`], {
      stdio: 'inherit',
      windowsVerbatimArguments: true,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`Firefox portable installer exited with code ${result.status}`);
    }
    const binary = path.join(dest, 'firefox.exe');
    if (!fs.existsSync(binary)) throw new Error(`portable Firefox binary not found: ${binary}`);
    return binary;
  }

  if (platform === 'darwin') {
    const dmg = path.join(downloadDir(), 'firefox-portable.dmg');
    await downloadTo(url, dmg);
    // Same hardened parse as installDmg below: the mount point is the last
    // column and may contain spaces, so take everything after `/Volumes/` on
    // matching lines and keep the device for cleanup.
    const out = execSync(`hdiutil attach -nobrowse -readonly "${dmg}"`).toString();
    const mounts = out
      .split('\n')
      .filter(line => line.includes('/Volumes/'))
      .map(line => line.slice(line.indexOf('/Volumes/')).trim());
    const mount = mounts[mounts.length - 1];
    const device = (out.match(/\/dev\/disk\S+/g) || [])[0];
    try {
      if (!mount) throw new Error(`cannot find Firefox DMG mount point: ${out}`);
      execSync(`cp -R "${mount}/Firefox.app" "${dest}/"`);
    } finally {
      if (device || mount) execSync(`hdiutil detach "${device || mount}"`);
    }
    const binary = path.join(dest, 'Firefox.app', 'Contents', 'MacOS', 'firefox');
    if (!fs.existsSync(binary)) throw new Error(`portable Firefox binary not found: ${binary}`);
    return binary;
  }

  throw new Error(`unsupported portable Firefox platform: ${platform}`);
}

/** Download an official dmg, mount it, and copy the app into /Applications. */
async function installDmg(url, appName) {
  const dmg = path.join(downloadDir(), `${appName.replace(/\.app$/, '')}.dmg`);
  await downloadTo(url, dmg);
  // hdiutil prints e.g. `/dev/disk4s1  Apple_HFS  /Volumes/Firefox` — but the
  // mount point is the LAST column and may contain spaces (the Dev Edition
  // image mounts at `/Volumes/Firefox Developer Edition`), so a `\S+` token
  // match truncates at the first space and the copy looks in the wrong dir.
  // Take everything after `/Volumes/` to the end of the line instead. Keep
  // the device too, so cleanup can detach even when this parse fails.
  const out = execSync(`hdiutil attach -nobrowse -readonly "${dmg}"`).toString();
  const mounts = out
    .split('\n')
    .filter(line => line.includes('/Volumes/'))
    .map(line => line.slice(line.indexOf('/Volumes/')).trim());
  const mountPoint = mounts[mounts.length - 1];
  const device = (out.match(/\/dev\/disk\S+/g) || [])[0];
  try {
    if (!mountPoint) {
      throw new Error(`cannot find mount point in hdiutil output: ${out}`);
    }
    execSync(`cp -R "${mountPoint}/${appName}" /Applications/`);
  } finally {
    // No `|| true`: a detach failure propagates (fail-fast) instead of
    // silently leaving the image mounted after a successful copy.
    if (device || mountPoint) {
      execSync(`hdiutil detach "${device || mountPoint}"`);
    }
  }
}

/** Export the resolved browser binary for GitHub Actions callers. */
export function exportBinaryPath(binary) {
  if (process.env.GITHUB_ENV) {
    fs.appendFileSync(process.env.GITHUB_ENV, `FIREFOX_BINARY=${binary}\n`);
  }
}

/**
 * Parse the version token from a Firefox-family binary's `--version` output
 * (e.g. "Mozilla Firefox 155.0.1", "Mozilla Firefox 156.0b3", "Mozilla Firefox
 * 128.0esr"). The branded product name is preferred; the fallback is the first
 * dotted-numeric token (some brandings phrase the line differently). Returns
 * null when no version token is found.
 *
 * @param {string} output combined stdout + stderr of `<binary> --version`
 * @returns {string | null}
 */
export function parseFirefoxVersion(output) {
  const branded = output.match(/Mozilla Firefox\s+([0-9][0-9A-Za-z._-]*)/);
  if (branded) return branded[1];
  const token = output.match(/(?:^|\s)([0-9]+\.[0-9]+[0-9A-Za-z._-]*)/);
  return token ? token[1] : null;
}

/**
 * Read the `Version=` line from an installed browser's application.ini. The ini
 * sits next to the binary on Windows/Linux (NSIS install dir, tarball dir); in
 * a .app bundle (macOS) the binary is at Contents/MacOS/firefox and the ini at
 * Contents/Resources/application.ini. Returns null when no candidate exists or
 * none carries a Version.
 *
 * @param {string} binary absolute path to the browser binary
 * @returns {string | null}
 */
function readApplicationIniVersion(binary) {
  const candidates = [
    path.join(path.dirname(binary), 'application.ini'),
    path.join(path.dirname(binary), '..', 'Resources', 'application.ini'),
  ];
  for (const ini of candidates) {
    try {
      const text = fs.readFileSync(ini, 'utf8');
      const match = text.match(/^Version\s*=\s*(\S+)\s*$/m);
      if (match) return match[1];
    } catch {
      // candidate missing/unreadable — try the next layout
    }
  }
  return null;
}

/**
 * The installed browser's actual version — ground truth of what an E2E leg
 * validated. Mozilla's "latest" redirect URLs embed no version, so the tested
 * release can only be read from the binary itself: `<binary> --version` first,
 * then the application.ini Version next to the binary (covers Windows
 * GUI-subsystem builds that write no console output).
 *
 * @param {string} browser
 * @returns {{
 *   version: string;
 *   source: '--version' | 'application.ini';
 *   binary: string;
 * }}
 */
export function readInstalledVersion(browser) {
  const binary = process.env.FIREFOX_BINARY || resolveBinary(browser);
  if (!binary) {
    throw new Error(
      `${browser}: cannot read installed version — no binary found (FIREFOX_BINARY ` +
        'unset and no install-dir match)'
    );
  }
  const res = spawnSync(binary, ['--version'], {encoding: 'utf8', timeout: 30_000});
  if (res.error) throw res.error;
  const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  const parsed = parseFirefoxVersion(output);
  if (parsed) return {version: parsed, source: '--version', binary};
  const ini = readApplicationIniVersion(binary);
  if (ini) return {version: ini, source: 'application.ini', binary};
  throw new Error(
    `${browser}: cannot determine installed version from ${binary} — '--version' gave ` +
      `${JSON.stringify(output.trim()) || '(no output)'} and no application.ini Version was found`
  );
}

/** resolveBinary + the same not-found guard the normal install paths apply. */
function requireBinary(browser) {
  const binary = resolveBinary(browser);
  if (!binary) {
    throw new Error(`${browser} cached installer ran, but no binary found in known install dirs`);
  }
  return binary;
}

/**
 * Install a browser for a platform and return the resolved binary path.
 *
 * @param {string} browser
 * @param {string} [platform] process.platform value (win32|darwin|linux)
 * @returns {Promise<string>} absolute path to the browser binary
 */
export async function installBrowser(browser, platform = process.platform) {
  const key = platformKey(platform);
  const def = DOWNLOADS[browser];
  if (!def) {
    throw new Error(`Unknown browser '${browser}' (known: ${Object.keys(DOWNLOADS).join(', ')})`);
  }
  const recipe = def.install?.[key];
  if (!recipe) {
    throw new Error(
      `${browser} has no automated install for ${key}` +
        (def.page ? ` — manual install only (official page: ${def.page})` : '')
    );
  }
  if (browser === 'firefox' && process.env.PORTABLE_BROWSER_DIR) {
    const url = recipe.tarball || recipe.url;
    const binary = await installPortableFirefox(
      url,
      key === 'win' ? 'win32'
      : key === 'mac' ? 'darwin'
      : 'linux'
    );
    console.log(`  ${browser} installed portably: ${binary}`);
    return binary;
  }
  if (recipe.tarball) {
    const binary = await installTarball(recipe.tarball, browser);
    console.log(`  ${browser} installed from official tarball: ${binary}`);
    return binary;
  }
  if (recipe.resolver && recipe.args) {
    // Version + mirror resolved by browserResolver.mjs (LibreWolf, Waterfox):
    // official mirrors first, then the temporary ci-downloads release, then
    // the cached previous installer (advisory legs warn instead of failing).
    let resolved;
    try {
      resolved = await resolveInstallerUrl(browser);
      console.log(`  ${browser} ${resolved.version} installer resolved from ${resolved.source}`);
    } catch (err) {
      const fallback = findCachedInstaller(browser);
      if (!fallback) throw err;
      console.log(
        `  ⚠ ${err.message}; reusing previously downloaded installer ` +
          `${path.basename(fallback)} (advisory leg — gate will warn)`
      );
      execSync(`"${fallback}" ${recipe.args.join(' ')}`, {stdio: 'inherit'});
      return requireBinary(browser);
    }
    const exe = path.join(
      downloadDir(),
      `${browser}-setup-${resolved.version}${path.extname(new URL(resolved.url).pathname) || '.exe'}`
    );
    try {
      await downloadTo(resolved.url, exe);
    } catch (err) {
      const fallback = findCachedInstaller(browser);
      if (!fallback) throw err;
      console.log(
        `  ⚠ download failed (${err.message}); reusing previously downloaded ` +
          `installer ${path.basename(fallback)} (advisory leg — gate will warn)`
      );
      execSync(`"${fallback}" ${recipe.args.join(' ')}`, {stdio: 'inherit'});
      return requireBinary(browser);
    }
    if (resolved.sha256Url) {
      console.log(`  verifying vendor sha256 for ${browser} ${resolved.version}`);
      await verifySha256(exe, resolved.sha256Url);
    }
    execSync(`"${exe}" ${recipe.args.join(' ')}`, {stdio: 'inherit'});
    const binary = resolveBinary(browser);
    if (!binary) {
      throw new Error(`${browser} installer ran, but no binary found in known install dirs`);
    }
    return binary;
  }
  if (recipe.url && recipe.args) {
    // Official installer (e.g. NSIS silent install on Windows).
    await installInstaller(recipe.url, browser, recipe.args);
    const binary = resolveBinary(browser);
    if (!binary) {
      throw new Error(`${browser} installer ran, but no binary found in known install dirs`);
    }
    return binary;
  }
  if (recipe.url && recipe.app) {
    // Official dmg → /Applications (macOS).
    await installDmg(recipe.url, recipe.app);
    const binary = resolveBinary(browser);
    if (!binary) {
      throw new Error(`${browser} dmg installed, but no binary found in known install dirs`);
    }
    return binary;
  }
  throw new Error(`${browser} has no install recipe for ${key}`);
}

async function main() {
  const args = process.argv.slice(2);
  const browser = args[0];
  if (!browser || args.includes('--help')) {
    console.log(`Usage: node test/e2e/shared/downloads.mjs <browser> [--os win|mac|linux] [--url|--installed-version]

Installs <browser> for the current OS (or --os) using its official download
recipe, then prints the resolved binary path and, in GitHub Actions, sets
FIREFOX_BINARY via $GITHUB_ENV. Set PORTABLE_BROWSER_DIR to install Firefox
Release into a custom directory instead of a system location. With --url,
prints the download URL instead (used to key the CI download cache). With
--installed-version, prints the version of the already-installed binary
(FIREFOX_BINARY or the install dirs) — ground truth for what an E2E leg
validated, since the "latest" redirect URLs embed no version.`);
    process.exit(browser ? 0 : 1);
  }
  const osIndex = args.indexOf('--os');
  const platform = osIndex !== -1 && args[osIndex + 1] ? args[osIndex + 1] : process.platform;
  const normalized =
    platform === 'win' ? 'win32'
    : platform === 'mac' ? 'darwin'
    : platform;

  if (args.includes('--url')) {
    // Print the exact download URL for this platform so the workflow can key
    // the CI download cache on it (the URL embeds the release version).
    console.log(await resolveDownloadUrl(browser, normalized));
    return;
  }

  if (args.includes('--installed-version')) {
    // Print the version of the binary this run already installed (or found in
    // the install dirs). The E2E updater legs use this to record exactly what
    // they validated — Mozilla's "latest" redirect URLs carry no version.
    console.log(readInstalledVersion(browser).version);
    return;
  }

  const binary = await installBrowser(browser, normalized);
  console.log(binary);
  exportBinaryPath(binary);
}

// Basename (not endsWith) so modules with a similar name — e.g.
// tools/check-browser-downloads.mjs — can import this file without tripping
// the CLI entry-point guard.
const isMain = process.argv[1] && path.basename(process.argv[1]) === 'downloads.mjs';
if (isMain) {
  main().catch(err => {
    console.error(`✗ Error: ${err.message}`);
    process.exit(1);
  });
}
