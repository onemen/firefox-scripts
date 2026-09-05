#!/usr/bin/env node

/**
 * tools/ci/cleanupCiDownloads.mjs — CI-side cleanup of the temporary
 * `ci-downloads` manual-escape release (ADR 0021).
 *
 * Called by the e2e.yml `cleanup-ci-downloads` job after a single-browser
 * manual-escape run. Deletes the asset the run consumed (matched by the
 * resolver's expected asset name for inputs.browser + inputs.version — the
 * version falls back to the newest asset's parsed version when the dispatch
 * pinned none), then deletes the release + tag when no assets remain — the
 * steady state is "the ci-downloads release does not exist".
 *
 * Never deletes an asset it cannot attribute to the dispatched browser, and
 * never touches any other release.
 */

import {execFileSync} from 'node:child_process';
import {ciDownloadsAssetName} from '../../test/e2e/shared/browserResolver.mjs';
import {inferBrowserVersion} from './ciDownload.mjs';

function gh(args) {
  return execFileSync('gh', args, {encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']});
}

async function main() {
  const browser = process.env.BROWSER || '';
  const version = process.env.VERSION || '';
  if (!browser) {
    console.error('✗ BROWSER env not set — nothing to clean');
    process.exit(1);
  }

  let release;
  try {
    release = JSON.parse(gh(['release', 'view', 'ci-downloads', '--json', 'assets']));
  } catch {
    console.log('ci-downloads release absent — nothing to clean');
    return;
  }

  const assets = release.assets || [];
  // Match by the resolver's expected asset name; without a pinned version,
  // fall back to the newest asset that parses as this browser's installer.
  let target = version ? assets.find(a => a.name === ciDownloadsAssetName(browser, version)) : null;
  if (!target && assets.length > 0) {
    const candidates = assets
      .map(a => ({...a, parsed: inferBrowserVersion(a.name)}))
      .filter(a => a.parsed?.browser === browser)
      .sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1));
    target = candidates[0] ?? null;
  }

  if (target) {
    console.log(`deleting consumed asset: ${target.name}`);
    gh(['release', 'delete-asset', 'ci-downloads', target.name, '--yes']);
  } else {
    console.log(`no ${browser} asset found in ci-downloads — leaving the release untouched`);
  }

  // Delete the release + tag once no assets remain (steady state: absent).
  const after = JSON.parse(gh(['release', 'view', 'ci-downloads', '--json', 'assets']));
  if ((after.assets || []).length === 0) {
    console.log('no assets remain — deleting the ci-downloads release + tag');
    gh(['release', 'delete', 'ci-downloads', '--yes', '--cleanup-tag']);
    console.log('✓ ci-downloads release deleted');
  } else {
    console.log(`${after.assets.length} asset(s) remain (another escape in flight) — release kept`);
  }
}

const isMain =
  process.argv[1] &&
  process.argv[1]
    .replace(/[\\/]$/, '')
    .split(/[\\/]/)
    .pop() === 'cleanupCiDownloads.mjs';
if (isMain) {
  main().catch(err => {
    console.error(`✗ Error: ${err.message}`);
    process.exit(1);
  });
}
