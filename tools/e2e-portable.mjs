#!/usr/bin/env node

/**
 * tools/e2e-portable.mjs — install a browser into a user-owned directory for
 * the local E2E runs.
 *
 * Why this exists: every updater scenario copies fx-folder's `config.js` into
 * the browser's install dir (the scheduler only runs from there). CI's runners
 * are admins and can write `Program Files` / `/Applications`; a normal account
 * cannot, and the scenarios then fail with `EPERM` — so a local run needs a
 * browser the account owns. On Windows the official setup exe is downloaded and
 * UNPACKED with 7z (its `core` folder is the install dir) — the installer is
 * never executed, so nothing is registered: no Add/Remove Programs entry, no
 * `Mozilla` registry keys. Linux/macOS install the tarball/DMG into a directory
 * you own. The script then prints the `FIREFOX_BINARY` line the harness reads.
 *
 * Usage (see the README section in docs/DEVELOPING.md for the full recipe):
 *
 * pnpm e2e:portable pnpm e2e:portable firefox-dev pnpm e2e:portable nightly
 * --dir /c/tmp/portable-nightly
 *
 * It prints the `FIREFOX_BINARY` value to export before the E2E run.
 *
 * `browser` is a `test/e2e/shared/downloads.mjs` key (firefox, firefox-dev,
 * nightly, firefox-esr-<major>; the forks install portably on Windows too). An
 * ESR key extracts like the official builds (its installer ignores `/D=`, so
 * the forks' route left an empty directory). Re-running is cheap: an existing
 * portable dir is reused instead of re-downloaded. The installer itself lands
 * in the OS temp dir (`BROWSER_DL_DIR` overrides) as downloads.mjs does for
 * every other browser; those files are pruned after a week
 * (`pruneStaleDownloadCache`). The install destination must NOT be inside the
 * OS temp dir (`--allow-temp-dir` overrides) — a browser there is never
 * reclaimed. Point `PORTABLE_BROWSER_DIR` at the repo's gitignored
 * `dist/portable/<browser>` if you want it next to the checkout.
 */

import os from 'node:os';
import path from 'node:path';

import {installBrowser} from '../test/e2e/shared/downloads.mjs';

const USAGE = `Usage: pnpm e2e:portable [browser] [--dir <path>]

  browser        downloads.mjs key — firefox, firefox-dev, nightly, a fork,
                 firefox-esr-<major> (default: nightly)
  --dir <path>   install destination (default: see defaultPortableDir)
  --allow-temp-dir
                 permit a destination inside the OS temp dir (refused by
                 default: a ~400 MB browser there is never reclaimed)

Installs the browser's OFFICIAL build into a directory this account owns, so the
updater E2E can seed config.js into its GreD. Prints the FIREFOX_BINARY to use.`;

/**
 * Where a portable browser lands when `--dir` is not given.
 *
 * Windows keeps the maintainer's layout
 * (`Documents/FireFox/portable/<browser>`, next to the other hand-installed
 * Firefox copies); other platforms get an XDG-ish cache dir. Pure, so it is
 * unit-tested.
 *
 * @param {string} browser downloads.mjs browser key
 * @param {string} [platform]
 * @param {string} [home]
 * @returns {string}
 */
export function defaultPortableDir(browser, platform = process.platform, home = os.homedir()) {
  return platform === 'win32' ?
      path.join(home, 'Documents', 'FireFox', 'portable', browser)
    : path.join(home, '.cache', 'firefox-scripts-e2e', browser);
}

/**
 * @param {string[]} argv
 * @returns {{
 *   help?: boolean;
 *   browser?: string;
 *   dir?: string;
 *   allowTempDir?: boolean;
 * }}
 */
export function parseArgs(argv) {
  const opts = {browser: '', dir: '', allowTempDir: false};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return {help: true};
    if (arg === '--allow-temp-dir') {
      opts.allowTempDir = true;
      continue;
    }
    if (arg === '--dir') {
      opts.dir = argv[++i] || '';
      if (!opts.dir) throw new Error('--dir needs a path');
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
    if (opts.browser) throw new Error(`unexpected extra argument: ${arg}`);
    opts.browser = arg;
  }
  return opts;
}

/**
 * Is `dir` inside the OS temp dir?
 *
 * A portable browser is ~400 MB that nothing ever cleans: pointed at the OS
 * temp dir it becomes permanent litter (one `fxs-portable` copy, 365 MB, was
 * still there on 2026-10-02). Pure so unit tests can pin the rule.
 *
 * @param {string} dir absolute path
 * @param {string} [tmp] temp root (os.tmpdir())
 * @returns {boolean}
 */
export function isInsideTempDir(dir, tmp = os.tmpdir()) {
  const root = path.resolve(tmp);
  const target = path.resolve(dir);
  if (target === root) return true;
  const rel = path.relative(root, target);
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(USAGE);
    return;
  }

  const browser = opts.browser || 'nightly';
  const dest = path.resolve(opts.dir || defaultPortableDir(browser));

  // The temp dir is not a storage location: nothing reclaims a browser left
  // there, and the OS only prunes files after ~30 days. Point at the repo's
  // gitignored dist/ (or the default under Documents) instead.
  if (!opts.allowTempDir && isInsideTempDir(dest)) {
    throw new Error(
      `refusing to install a browser into the OS temp dir: ${dest}\n` +
        '  Use a persistent dir (the default, or --dir <repo>/dist/portable/' +
        browser +
        '), or pass --allow-temp-dir if you really mean it.'
    );
  }

  // installBrowser() reads this to pick the portable route (the 7z extract
  // path on Windows, the tarball/DMG elsewhere) instead of the system location.
  process.env.PORTABLE_BROWSER_DIR = dest;

  console.log(`Installing ${browser} into ${dest}`);
  console.log('(official build, user-owned dir — reused on later runs)\n');

  const binary = await installBrowser(browser, process.platform);
  console.log(`\n✓ ${browser} ready: ${binary}\n`);
  console.log('Run the updater E2E against it:');
  console.log(`  export FIREFOX_BINARY="${binary}"`);
  console.log('  pnpm test:e2e:updater -- --no-branch-check');
  if (process.platform === 'win32') {
    console.log('\n(Single scenario — the helper/ACL path:)');
    console.log(`  node test/e2e/updater/updater-e2e.mjs --scenario 9 --firefox "${binary}"`);
  }
}

// Basename (not endsWith) so unit tests can import the pure helpers above
// without triggering an install — the same guard downloads.mjs uses.
const isMain = process.argv[1] && path.basename(process.argv[1]) === 'e2e-portable.mjs';
if (isMain) {
  main().catch(err => {
    console.error(`\n✗ portable browser install failed: ${err.message}`);
    process.exit(1);
  });
}
