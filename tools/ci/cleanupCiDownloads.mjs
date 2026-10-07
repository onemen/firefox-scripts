#!/usr/bin/env node

/**
 * tools/ci/cleanupCiDownloads.mjs — CI-side cleanup of the temporary
 * `ci-downloads` manual-escape release (ADR 0021).
 *
 * Called by the e2e.yml `cleanup-ci-downloads` job after a single-browser
 * manual-escape run. Deletes the asset the run consumed — matched by the
 * resolver's exact expected asset name for inputs.browser + inputs.version
 * (`pnpm ci:download` always dispatches with the version pinned, so the name is
 * deterministic; no version, no deletion — we never guess), then deletes the
 * release + tag when no assets remain — the steady state is "the ci-downloads
 * release does not exist".
 *
 * Never deletes an asset it cannot attribute to the dispatched browser, and
 * never touches any other release.
 */

import {execFileSync} from 'node:child_process';
import {ciDownloadsAssetName} from '../../test/e2e/shared/browserResolver.mjs';

function runGh(args) {
  return execFileSync('gh', args, {encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']});
}

/**
 * Run the cleanup against an injected `gh` runner (the CLI passes `runGh`;
 * tests pass a fixture-backed recorder, so every delete path here is driven
 * against fixtures — never a real repository or release).
 *
 * Returns the step's exit code: 0 = cleaned or nothing to clean, 1 = BROWSER
 * unset. Unexpected `gh` failures throw; the CLI wrapper below turns those into
 * exit 1.
 *
 * @param {{
 *   browser?: string;
 *   version?: string;
 *   gh?: (args: string[]) => string;
 *   log?: (...data: any[]) => void;
 * }} [opts]
 * @returns {number}
 */
export function cleanupCiDownloads({
  browser = '',
  version = '',
  gh = runGh,
  log = console.log,
} = {}) {
  if (!browser) {
    console.error('✗ BROWSER env not set — nothing to clean');
    return 1;
  }

  let release;
  try {
    release = JSON.parse(gh(['release', 'view', 'ci-downloads', '--json', 'assets']));
  } catch {
    log('ci-downloads release absent — nothing to clean');
    return 0;
  }

  const assets = release.assets || [];
  // Match only by the resolver's exact expected asset name (browser + pinned
  // version — ciDownload always dispatches with one). Guessing ("newest
  // matching asset") could delete an asset the run never consumed, e.g. when
  // the resolver answered from an official mirror before reaching ci-downloads.
  const target =
    version ? (assets.find(a => a.name === ciDownloadsAssetName(browser, version)) ?? null) : null;

  if (target) {
    log(`deleting consumed asset: ${target.name}`);
    gh(['release', 'delete-asset', 'ci-downloads', target.name, '--yes']);
  } else {
    log(`no ${browser} asset found in ci-downloads — leaving the release untouched`);
  }

  // Delete the release + tag once no assets remain (steady state: absent).
  const after = JSON.parse(gh(['release', 'view', 'ci-downloads', '--json', 'assets']));
  if ((after.assets || []).length === 0) {
    log('no assets remain — deleting the ci-downloads release + tag');
    gh(['release', 'delete', 'ci-downloads', '--yes', '--cleanup-tag']);
    log('✓ ci-downloads release deleted');
  } else {
    log(`${after.assets.length} asset(s) remain (another escape in flight) — release kept`);
  }
  return 0;
}

const isMain =
  process.argv[1] &&
  process.argv[1]
    .replace(/[\\/]$/, '')
    .split(/[\\/]/)
    .pop() === 'cleanupCiDownloads.mjs';
if (isMain) {
  try {
    process.exitCode = cleanupCiDownloads({
      browser: process.env.BROWSER || '',
      version: process.env.VERSION || '',
    });
  } catch (err) {
    console.error(`✗ Error: ${err.message}`);
    process.exit(1);
  }
}
