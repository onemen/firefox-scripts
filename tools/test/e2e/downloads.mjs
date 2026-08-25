#!/usr/bin/env node

/**
 * tools/test/e2e/downloads.mjs — official browser download/install map for the
 * E2E CI matrix.
 *
 * The workflow (e2e.yml) used to hard-code each browser's install commands per
 * OS; this module is the single source of truth: browser → per-OS install
 * recipe, plus a CLI that performs the install for the current OS and exports
 * the resolved binary path.
 *
 * CLI (used by e2e.yml, works locally too): node tools/test/e2e/downloads.mjs
 * <browser> [--os win|mac|linux]
 *
 * On success the resolved binary path is printed to stdout and, when running
 * inside GitHub Actions ($GITHUB_ENV set), appended to $GITHUB_ENV as
 * FIREFOX_BINARY — the updater E2E (updater-e2e.mjs) reads that env var.
 *
 * Browsers without an automated recipe (manual install only) list their
 * official download page instead; the CLI fails with a clear message.
 */

import {execSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {discoverFirefoxBinary} from './browsers.mjs';

/**
 * Per-browser install recipes keyed by platform (win|mac|linux).
 *
 * - {url, args} → download the official installer from `url` (fetchWithRetry, so
 *   transient 5xx are retried) and run it with `args` (e.g. NSIS `/S` silent
 *   install), then resolve the binary from known install dirs.
 * - {url, app} → download the official dmg from `url`, mount it, and copy `app`
 *   into /Applications (macOS).
 * - {tarball, url} → download the official tarball and extract it; returns the
 *   binary path directly.
 * - {manager, args} → run a package manager (choco/winget/brew), then resolve the
 *   binary from the browser's known install dirs. Only used where the browser
 *   publishes no stable "latest" installer URL (forks whose release asset names
 *   embed the version). Retried 3× because third-party mirrors (e.g.
 *   librewolf.dev) 502 transiently.
 * - `manual: true` → no automated install; `page` is the official download page
 *   (informational, for the manual legs).
 *
 * The E2E workflow installs only what CI needs today (firefox, librewolf,
 * floorp); the other forks are documented here so adding a leg is a one-line
 * change, and they have no stable unattended install.
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
    manual: true,
    page: 'https://www.mozilla.org/firefox/developer/',
  },
  'waterfox': {
    manual: true,
    page: 'https://www.waterfox.net/download/',
  },
  'zen': {
    manual: true,
    page: 'https://zen-browser.app/download/',
  },
  'librewolf': {
    install: {
      win: {
        manager: 'winget',
        args: [
          'install',
          'LibreWolf.LibreWolf',
          '--accept-package-agreements',
          '--accept-source-agreements',
        ],
      },
    },
  },
  'floorp': {
    install: {
      win: {
        manager: 'winget',
        args: [
          'install',
          'Ablaze.Floorp',
          '--accept-package-agreements',
          '--accept-source-agreements',
        ],
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
 * Resolve a browser's binary after a package-manager install, mirroring the
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
 * Resolve a browser's download URL for a platform (the recipe's tarball or
 * installer URL) — used to key the CI download cache, since the URL embeds the
 * release version. Package-manager recipes have no download URL.
 *
 * @param {string} browser
 * @param {string} [platform] process.platform value (win32|darwin|linux)
 * @returns {string}
 */
export function resolveDownloadUrl(browser, platform = process.platform) {
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
  const url = recipe.tarball || recipe.url;
  if (!url) {
    throw new Error(`${browser} installs via a package manager — no download URL to cache`);
  }
  return url;
}

/** Download an official Mozilla tarball and extract it; returns the binary path. */
async function installTarball(url, browser) {
  const dest = path.join(os.homedir(), 'firefox-app');
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

async function fetchWithRetry(url, attempts, timeoutMs = 300_000) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      // Bound each attempt: a stalled connection would otherwise hang CI until
      // the runner kills the job. Timeout failures flow through the retry
      // path below like any other fetch error.
      const res = await fetch(url, {signal: AbortSignal.timeout(timeoutMs)});
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return res;
    } catch (err) {
      lastErr = err;
      console.log(`  download attempt ${i}/${attempts} failed: ${err.message}`);
      if (i < attempts) await new Promise(r => setTimeout(r, 5000));
    }
  }
  throw lastErr;
}

/**
 * Download a URL to a local file (retrying), returning the file path.
 *
 * A non-empty local file is reused when it matches the remote size (the
 * workflow restores downloads from the CI cache); a size mismatch means the
 * previous download was cut short, so it is re-fetched.
 */
export async function downloadTo(url, dest) {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    try {
      const head = await fetch(url, {method: 'HEAD', signal: AbortSignal.timeout(15_000)});
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
  const res = await fetchWithRetry(url, 3);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  return dest;
}

/** Download an official installer and run it with args (e.g. NSIS `/S`). */
async function installInstaller(url, browser, args) {
  const exe = path.join(downloadDir(), `${browser}-setup.exe`);
  await downloadTo(url, exe);
  execSync(`"${exe}" ${args.join(' ')}`, {stdio: 'inherit'});
}

/** Download an official dmg, mount it, and copy the app into /Applications. */
async function installDmg(url, appName) {
  const dmg = path.join(downloadDir(), `${appName.replace(/\.app$/, '')}.dmg`);
  await downloadTo(url, dmg);
  // hdiutil prints e.g. `/dev/disk4s1  Apple_HFS  /Volumes/Firefox`. Keep the
  // device too, so cleanup can detach even when the mount-point parse fails.
  const out = execSync(`hdiutil attach -nobrowse -readonly "${dmg}"`).toString();
  const mountPoint = (out.match(/\/Volumes\/\S+/g) || []).pop();
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

function runManager(manager, args) {
  // Package-manager installs hit third-party mirrors that can 502 transiently
  // (e.g. librewolf.dev). Retry the whole install so a one-off upstream hiccup
  // does not fail CI; browsers are idempotent to reinstall.
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // execSync goes through the platform shell, so choco.bat / winget.exe /
      // brew work the same on every OS.
      execSync(`${manager} ${args.join(' ')}`, {stdio: 'inherit'});
      return;
    } catch (err) {
      lastErr = err;
      console.log(`  ${manager} attempt ${attempt}/3 failed: ${err.message}`);
      if (attempt < 3) {
        console.log('  retrying in 15s…');
        // execSync blocks the event loop; sleep via node so it works on pwsh.
        execSync('node -e "setTimeout(() => {}, 15000)"', {stdio: 'inherit'});
      }
    }
  }
  throw lastErr;
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
  if (recipe.tarball) {
    const binary = await installTarball(recipe.tarball, browser);
    console.log(`  ${browser} installed from official tarball: ${binary}`);
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
  runManager(recipe.manager, recipe.args);
  const binary = resolveBinary(browser);
  if (!binary) {
    throw new Error(
      `${browser} installed via ${recipe.manager}, but no binary found in known install dirs`
    );
  }
  return binary;
}

async function main() {
  const args = process.argv.slice(2);
  const browser = args[0];
  if (!browser || args.includes('--help')) {
    console.log(`Usage: node tools/test/e2e/downloads.mjs <browser> [--os win|mac|linux] [--url]

Installs <browser> for the current OS (or --os) using its official download
recipe, then prints the resolved binary path and, in GitHub Actions, sets
FIREFOX_BINARY via $GITHUB_ENV. With --url, prints the download URL instead
(used to key the CI download cache).`);
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
    console.log(resolveDownloadUrl(browser, normalized));
    return;
  }

  const binary = await installBrowser(browser, normalized);
  console.log(binary);
  if (process.env.GITHUB_ENV) {
    fs.appendFileSync(process.env.GITHUB_ENV, `FIREFOX_BINARY=${binary}\n`);
  }
}

const isMain = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('downloads.mjs');
if (isMain) {
  main().catch(err => {
    console.error(`✗ Error: ${err.message}`);
    process.exit(1);
  });
}
