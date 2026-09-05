#!/usr/bin/env node

/**
 * tools/ci/ciDownload.mjs — the manual escape hatch (ADR 0021, plan:
 * docs/browser-downloads-resilience.local.md §5 PR A.5).
 *
 * When every vendor mirror for a browser's installer is down (or a version must
 * be tested before its release is visible to the resolver), the maintainer
 * pushes the installer file directly to GitHub:
 *
 * pnpm ci:download -- librewolf-155.0-1-windows-x86_64-setup.exe pnpm
 * ci:download -- "Waterfox Setup 6.7.1.1.exe" --version 6.7.1.1
 *
 * The script:
 *
 * 1. infers browser + version from the filename (same patterns the resolver uses;
 *    `--browser` / `--version` override);
 * 2. creates the fixed-tag `ci-downloads` release on demand (body marks it
 *    temporary + creation date) — the steady state is "release absent";
 * 3. uploads the asset renamed to the resolver's expected asset name (`--clobber`
 *    so a re-upload replaces it);
 * 4. dispatches `e2e.yml` with `browser` (+ `version` when given) — a
 *    single-browser run that consumes the asset. CI's cleanup-ci-downloads job
 *    deletes the asset afterwards, and the release once empty.
 *
 * Flags: `--browser <name>`, `--version <v>` (inference overrides),
 * `--no-dispatch` (upload only), `--clean` (delete release + tag, no upload).
 *
 * Requires gh CLI auth with repo scope. The installer is typically the one the
 * maintainer's firefox-updater already downloaded (.local.downloads/).
 */

import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {CI_DOWNLOADS_TAG, ciDownloadsAssetName} from '../../test/e2e/shared/browserResolver.mjs';

/**
 * Browsers with a ci-downloads fallback (floorp/zen use stable GitHub URLs but
 * still support the escape).
 */
const KNOWN_BROWSERS = ['librewolf', 'waterfox', 'floorp', 'zen'];

/**
 * Infer {browser, version} from an installer filename using the same shapes the
 * resolver's asset names and the vendors' release files use. Exported for unit
 * tests.
 *
 * Input is a single path basename (bounded), so each anchored pattern below is
 * backtrack-safe — the eslint-security unsafe-regex warnings are false
 * positives for this shape.
 *
 * @param {string} filename
 * @returns {{browser: string; version: string} | null} null when nothing
 *   matches
 */
export function inferBrowserVersion(filename) {
  const base = path.basename(filename);
  const patterns = [
    // librewolf-155.0-1-windows-x86_64-setup.exe (our asset name + vendor shape)
    // eslint-disable-next-line security/detect-unsafe-regex
    [/^librewolf-(\d+(?:\.\d+)*-\d+)-/, 'librewolf'],
    // waterfox: "Waterfox Setup 6.7.1.1.exe" / waterfox-6.7.1.1-setup.exe
    // eslint-disable-next-line security/detect-unsafe-regex
    [/^waterfox[- ]setup[- ](\d+(?:\.\d+)*(?:-beta[.-]?\d+)?)\.exe$/i, 'waterfox'],
    // eslint-disable-next-line security/detect-unsafe-regex
    [/^waterfox[-.](\d+(?:\.\d+)*(?:-beta[.-]?\d+)?)[.-]/i, 'waterfox'],
    // floorp-12.17.2-installer.exe / floorp-windows-x86_64.installer.exe (no version)
    // eslint-disable-next-line security/detect-unsafe-regex
    [/^floorp[-.](\d+(?:\.\d+)*(?:b\d+)?)[.-]/i, 'floorp'],
    // zen: zen-1.21.16b-installer.exe / zen.installer.exe (no version)
    // eslint-disable-next-line security/detect-unsafe-regex
    [/^zen[-.](\d+(?:\.\d+)*[a-z]?)[.-]/i, 'zen'],
  ];
  for (const [re, browser] of patterns) {
    const m = re.exec(base);
    if (m) return {browser, version: m[1]};
  }
  return null;
}

/** Run gh, throwing with the captured stderr on failure. */
function gh(args, {input} = {}) {
  return execFileSync('gh', args, {encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe']});
}

function usage(code = 1) {
  console.log(`Usage: pnpm ci:download -- <installer-file> [--browser <name>] [--version <v>]
                 [--no-dispatch] [--clean]

  <installer-file>   path to the installer (e.g. from firefox-updater's .local.downloads/)
  --browser <name>   override browser inference (librewolf|waterfox|floorp|zen)
  --version <v>      override version inference (also pins the E2E dispatch)
  --no-dispatch      upload only — do not dispatch the E2E run
  --clean            delete the ci-downloads release + tag and exit`);
  process.exit(code);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) usage(0);
  const clean = args.includes('--clean');
  const dispatch = !args.includes('--no-dispatch');
  const flag = name => {
    const i = args.indexOf(name);
    if (i === -1) return null;
    const v = args[i + 1];
    if (v === undefined || v.startsWith('--')) {
      console.error(`✗ ${name} given without a value`);
      usage();
    }
    return v;
  };
  const browserFlag = flag('--browser');
  const versionFlag = flag('--version');
  const excluded = new Set([browserFlag, versionFlag].filter(v => v !== null));
  const file = args.find(a => !a.startsWith('--') && !excluded.has(a));

  if (clean) {
    console.log(`deleting ${CI_DOWNLOADS_TAG} release (if present)…`);
    try {
      gh(['release', 'delete', CI_DOWNLOADS_TAG, '--yes', '--cleanup-tag']);
      console.log(`✓ ${CI_DOWNLOADS_TAG} release + tag deleted`);
    } catch (err) {
      if (!/Not Found|HTTP 404/i.test(String(err.message))) throw err;
      console.log(`✓ ${CI_DOWNLOADS_TAG} release does not exist — nothing to clean`);
    }
    return;
  }

  if (!file) {
    console.error('✗ no installer file given');
    usage();
  }
  if (!fs.existsSync(file)) {
    console.error(`✗ installer not found: ${file}`);
    process.exit(1);
  }

  const inferred = inferBrowserVersion(file);
  const browser = browserFlag || inferred?.browser;
  const version = versionFlag || inferred?.version;
  if (!browser || !KNOWN_BROWSERS.includes(browser)) {
    console.error(
      `✗ cannot infer browser from '${path.basename(file)}' — pass --browser (${KNOWN_BROWSERS.join('|')})`
    );
    process.exit(1);
  }
  if (!version) {
    console.error(
      `✗ cannot infer version from '${path.basename(file)}' — pass --version (it pins the E2E run)`
    );
    process.exit(1);
  }

  const assetName = ciDownloadsAssetName(browser, version);
  console.log(`browser: ${browser} · version: ${version} · asset: ${assetName}`);

  // ① create the temporary release on demand
  const existing = (() => {
    try {
      return gh(['release', 'view', CI_DOWNLOADS_TAG, '--json', 'assets']);
    } catch (err) {
      if (!/Not Found|HTTP 404/i.test(String(err.message))) throw err;
      return null;
    }
  })();
  if (!existing) {
    console.log(`creating temporary ${CI_DOWNLOADS_TAG} release…`);
    gh([
      'release',
      'create',
      CI_DOWNLOADS_TAG,
      '--target',
      'main',
      '--title',
      'Temporary CI installer stash',
      '--notes',
      `Manual-escape stash for the E2E browser matrix (ADR 0021).\n\n` +
        `Created ${new Date().toISOString()} by pnpm ci:download. CI deletes this ` +
        `release automatically after the consuming run; do not pin workflows to it.`,
    ]);
  } else {
    console.log(`${CI_DOWNLOADS_TAG} release exists — uploading with --clobber`);
  }

  // ② upload the asset under the resolver's expected name. A renamed copy is
  // staged in a fresh temp dir (never next to the user's file — the file may
  // sit in a shared cache dir such as firefox-updater's .local.downloads/).
  const renamed = path.basename(file) !== assetName;
  let tmpAsset = null;
  try {
    let uploadPath = path.resolve(file);
    if (renamed) {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-download-'));
      tmpAsset = path.join(tmpDir, assetName);
      fs.copyFileSync(file, tmpAsset);
      uploadPath = tmpAsset;
    }
    try {
      gh(['release', 'upload', CI_DOWNLOADS_TAG, uploadPath, '--clobber']);
      console.log(`✓ uploaded ${assetName}`);
    } finally {
      if (tmpAsset) fs.rmSync(path.dirname(tmpAsset), {recursive: true, force: true});
    }
  } catch (err) {
    err.message = `upload failed: ${err.message}`;
    throw err;
  }

  if (!dispatch) {
    console.log('✓ done (--no-dispatch — run the E2E leg manually when ready)');
    return;
  }

  // ③ dispatch the single-browser E2E run (CI cleans the asset afterwards).
  // Always pass the version: the cleanup job matches the consumed asset by
  // exact expected name, which only works with the pinned version.
  console.log('dispatching e2e.yml…');
  gh(['workflow', 'run', 'e2e.yml', '-f', `browser=${browser}`, '-f', `version=${version}`]);
  console.log(
    `✓ dispatched: gh run watch --workflow=e2e.yml — the cleanup job deletes ` +
      `${assetName} (and the release when empty) after the leg finishes`
  );
}

const isMain = process.argv[1] && path.basename(process.argv[1]) === 'ciDownload.mjs';
if (isMain) {
  main().catch(err => {
    console.error(`✗ Error: ${err.message}`);
    process.exit(1);
  });
}
