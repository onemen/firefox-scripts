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
 * - {manager, args} → run a package manager (choco/brew/winget), then resolve the
 *   binary from the browser's known install dirs (see resolveBinary).
 * - {tarball, url} → download the official tarball and extract it; returns the
 *   binary path directly.
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
      win: {manager: 'choco', args: ['install', 'firefox', '-y', '--no-progress']},
      mac: {manager: 'brew', args: ['install', '--cask', 'firefox']},
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
      win: {manager: 'choco', args: ['install', 'librewolf', '-y', '--no-progress']},
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

/** Download an official Mozilla tarball and extract it; returns the binary path. */
async function installTarball(url, browser) {
  const dest = path.join(os.homedir(), 'firefox-app');
  const archive = path.join(os.tmpdir(), `firefox-${browser}.tar.xz`);
  fs.mkdirSync(dest, {recursive: true});

  // Retry the download up to 3 times (transient network flakiness on CI).
  const res = await fetchWithRetry(url, 3);
  fs.writeFileSync(archive, Buffer.from(await res.arrayBuffer()));

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

function runManager(manager, args) {
  // execSync goes through the platform shell, so choco.bat / winget.exe /
  // brew work the same on every OS.
  execSync(`${manager} ${args.join(' ')}`, {stdio: 'inherit'});
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
    console.log(`Usage: node tools/test/e2e/downloads.mjs <browser> [--os win|mac|linux]

Installs <browser> for the current OS (or --os) using its official download
recipe, then prints the resolved binary path and, in GitHub Actions, sets
FIREFOX_BINARY via $GITHUB_ENV.`);
    process.exit(browser ? 0 : 1);
  }
  const osIndex = args.indexOf('--os');
  const platform = osIndex !== -1 && args[osIndex + 1] ? args[osIndex + 1] : process.platform;
  const normalized =
    platform === 'win' ? 'win32'
    : platform === 'mac' ? 'darwin'
    : platform;

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
