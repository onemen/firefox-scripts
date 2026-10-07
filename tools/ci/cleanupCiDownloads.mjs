#!/usr/bin/env node

/**
 * CI-side cleanup of the temporary `ci-downloads` manual-escape release (ADR
 * 0021), run by the e2e.yml `cleanup-ci-downloads` job. Deletes the asset the
 * run consumed — matched by the resolver's exact expected name for browser +
 * pinned version — then the release + tag once no assets remain. Never touches
 * any other release.
 */

import {execFileSync} from 'node:child_process';
import {ciDownloadsAssetName} from '../../test/e2e/shared/browserResolver.mjs';

function runGh(args) {
  return execFileSync('gh', args, {encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']});
}

/**
 * Unexpected `gh` failures throw; the CLI wrapper turns those into exit 1.
 *
 * @param {{
 *   browser?: string;
 *   version?: string;
 *   gh?: (args: string[]) => string;
 *   log?: (...data: any[]) => void;
 * }} [opts]
 * @returns {number} 0 = cleaned or nothing to clean, 1 = BROWSER unset
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
  // Match only by exact expected name for browser + pinned version — guessing
  // ("newest matching asset") could delete an asset the run never consumed.
  const target =
    version ? (assets.find(a => a.name === ciDownloadsAssetName(browser, version)) ?? null) : null;

  if (target) {
    log(`deleting consumed asset: ${target.name}`);
    gh(['release', 'delete-asset', 'ci-downloads', target.name, '--yes']);
  } else {
    log(`no ${browser} asset found in ci-downloads — leaving the release untouched`);
  }

  // Delete the release + tag once no assets remain.
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
