#!/usr/bin/env node

/**
 * tools/ci/browserStore.mjs — the durable browser-installer store (#465).
 *
 * A permanent release, tag `ci-browser-cache`, holding one asset per watched
 * browser installer. Release assets dodge every limit that made the
 * alternatives unusable: 2 GiB per asset, no total-size or bandwidth cap on a
 * public repo, and no Actions-cache LRU eviction (#462) — so the bytes the
 * watchdog already downloads in full for its SHA-256 verification (and used to
 * throw away) become the backing layer under the evictable Actions caches.
 *
 * Deliberately NOT the temporary `ci-downloads` release (ADR 0021): that one is
 * created on demand for a manual escape and deleted — assets after the pinned
 * run consumes them, release when empty — by cleanupCiDownloads.mjs. Reusing it
 * would make the cleaner delete the cache. `ci-browser-cache` is never touched
 * by that cleanup, and av-watchdog never scans it (it watches only the `latest`
 * and `installer-YYYY-MM-DD` tags, tools/ci/avLedger.mjs).
 *
 * Shape (mirrors the cache prune's keep-one policy):
 *
 * - Asset name = `<browser>--<installer>-win64<ext>` where `<installer>` is the
 *   resolver's normalized installer filename (ciDownloadsAssetName), e.g.
 *   `firefox--firefox-157.0.1-setup.exe-win64`. The double dash is the
 *   browser/asset separator: a plain prefix would be ambiguous (`firefox-` also
 *   matches `firefox-dev-…`; ESR names start `firefox-` too), and the roll rule
 *   must never delete a sibling browser's asset.
 * - One asset per browser — a new version's upload REPLACES the old asset (delete
 *
 *   - upload), so the store cannot grow: it holds exactly the newest verified
 *       installer per browser, the same keep-1 rule prune-caches.mjs applies to
 *       the release-keyed cache families.
 * - The release body records version + byte size + SHA-256 per asset (the
 *   watchdog computed both during verification) — a provenance ledger a reader
 *   can check against.
 *
 * Failure semantics: every step here is BEST-EFFORT. A store upload that fails
 * must never fail the watchdog run (or the E2E leg) — the vendor URL and the
 * Actions cache remain the primary paths; the store is the durable fallback.
 * Seeding returns null instead of throwing.
 */

import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';

/** The permanent release tag backing the store. */
export const BROWSER_STORE_TAG = 'ci-browser-cache';

/**
 * The store asset name for a browser's installer.
 *
 * @param {string} browser canonical browser key ('firefox', 'firefox-dev',
 *   'librewolf', …) — the store's roll namespace
 * @param {string} installerName resolver-normalized installer filename
 * @returns {string} `<browser>--<installer minus ext>-win64<ext>`
 */
export function storeAssetName(browser, installerName) {
  const dot = installerName.lastIndexOf('.');
  const base = dot === -1 ? installerName : installerName.slice(0, dot);
  const ext = dot === -1 ? '' : installerName.slice(dot);
  return `${browser}--${base}-win64${ext}`;
}

/** Run `gh`, capturing output; throws on failure. */
function runGh(args, {input} = {}) {
  return execFileSync('gh', args, {encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe']});
}

/**
 * The store release's metadata, or null when it does not exist yet (the steady
 * state before the first seed).
 *
 * @param {{gh?: typeof runGh}} [opts]
 * @returns {{
 *   id: number;
 *   body: string;
 *   assets: {name: string; size: number}[];
 * } | null}
 */
export function storeRelease({gh = runGh} = {}) {
  try {
    const release = JSON.parse(
      gh(['release', 'view', BROWSER_STORE_TAG, '--json', 'id,body,assets'])
    );
    return {
      id: release.id,
      body: release.body ?? '',
      assets: (release.assets ?? []).map(a => ({name: a.name, size: a.size})),
    };
  } catch {
    return null;
  }
}

/**
 * Parse the `- `<asset>`: sha256=<hex>` ledger lines out of the release body.
 *
 * @param {string} body
 * @returns {Map<string, string>} asset name → lowercase hex sha256
 */
export function parseStoreLedger(body) {
  const ledger = new Map();
  for (const m of body.matchAll(/^\s*- `([^`]+)`: sha256=([0-9a-fA-F]{64})$/gm)) {
    ledger.set(m[1], m[2].toLowerCase());
  }
  return ledger;
}

/**
 * Render the release body from the ledger map (sorted for stable diffs).
 *
 * @param {Map<string, string>} ledger asset name → sha256
 * @returns {string}
 */
export function renderStoreBody(ledger) {
  const lines = [
    'Durable browser-installer store (#465). One asset per watched browser:',
    'the newest installer the url-watchdog fully downloaded and SHA-256-verified.',
    'Read by the resolver as the fallback under the vendor mirrors; NOT the',
    'temporary ci-downloads escape (ADR 0021) — never deleted by cleanup.',
    '',
    '- Assets:',
  ];
  for (const [name, sha] of [...ledger].sort(([a], [b]) => (a < b ? -1 : 1))) {
    lines.push(`  - \`${name}\`: sha256=${sha}`);
  }
  return lines.join('\n');
}

/**
 * Seed (or replace) one browser's installer in the store. Creates the release
 * on first use; a new version's upload deletes the old assets for the same
 * browser first (keep-1: the store never grows). The file is uploaded under the
 * store asset name (a temp copy — `gh release upload` keeps the basename).
 * Best-effort — returns the stored asset name on success, null on any failure
 * (logged, never thrown).
 *
 * @param {{
 *   browser: string;
 *   file: string;
 *   installerName: string;
 *   sha256?: string | null;
 *   gh?: typeof runGh;
 *   log?: (...data: unknown[]) => void;
 * }} opts
 *   `file` is the fully downloaded installer on disk (deleted after the upload —
 *   the watchdog used to discard it here anyway); `installerName` the
 *   resolver-normalized name.
 * @returns {Promise<string | null>} the stored asset name, or null
 */
export async function seedBrowserStore({
  browser,
  file,
  installerName,
  sha256 = null,
  gh = runGh,
  log = console.log,
}) {
  const name = storeAssetName(browser, installerName);
  // gh release upload keeps the file's BASENAME, so the staged copy must be
  // named exactly `name` — a prefixed temp filename would land as a wrong
  // asset name. The per-process temp dir holds it.
  const stagingDir = path.join(os.tmpdir(), `browser-store-${process.pid}`);
  const staging = path.join(stagingDir, name);
  try {
    if (!fs.existsSync(file)) throw new Error(`installer file missing: ${file}`);
    const hash = sha256 ?? (await sha256File(file));

    let release = storeRelease({gh});
    if (!release) {
      log(`  store: creating ${BROWSER_STORE_TAG} release`);
      gh([
        'release',
        'create',
        BROWSER_STORE_TAG,
        '--title',
        'Durable browser-installer store (CI)',
        '--notes',
        'Managed by tools/ci/browserStore.mjs — see the asset ledger below.',
      ]);
      release = storeRelease({gh});
      if (!release) throw new Error('release create did not land');
    }

    // Keep-1: drop the previous version's asset for THIS browser (the
    // `--` separator keeps sibling browsers — firefox-dev, the ESR keys —
    // out of the namespace).
    for (const old of release.assets.filter(
      a => a.name.startsWith(`${browser}--`) && a.name !== name
    )) {
      log(`  store: rolling superseded asset ${old.name}`);
      gh(['release', 'delete-asset', BROWSER_STORE_TAG, old.name, '--yes']);
    }
    if (release.assets.some(a => a.name === name)) {
      gh(['release', 'delete-asset', BROWSER_STORE_TAG, name, '--yes']);
    }

    // Upload under the store name: stage a copy (see stagingDir above).
    fs.mkdirSync(stagingDir, {recursive: true});
    fs.copyFileSync(file, staging);
    try {
      gh(['release', 'upload', BROWSER_STORE_TAG, staging, '--clobber']);
    } finally {
      fs.rmSync(staging, {force: true});
      fs.rmSync(stagingDir, {recursive: true, force: true});
    }

    const kept = storeRelease({gh});
    if (!kept?.assets.some(a => a.name === name)) throw new Error('upload did not land');

    // Update the ledger in the body.
    const ledger = parseStoreLedger(kept.body);
    for (const stale of [...ledger.keys()]) {
      if (stale.startsWith(`${browser}--`) && stale !== name) ledger.delete(stale);
    }
    ledger.set(name, hash);
    const body = renderStoreBody(ledger);
    if (body !== kept.body) {
      gh(['release', 'edit', BROWSER_STORE_TAG, '--notes', body]);
    }
    log(`  store: seeded ${name}`);
    return name;
  } catch (err) {
    fs.rmSync(stagingDir, {recursive: true, force: true});
    log(`  store: seed failed (non-fatal, vendor/cache paths unaffected): ${err.message}`);
    return null;
  }
}

/** Stream-hash a file (lowercase hex). */
async function sha256File(file) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  return hash.digest('hex');
}

const isMain =
  process.argv[1] &&
  process.argv[1]
    .replace(/[\\/]$/, '')
    .split(/[\\/]/)
    .pop() === 'browserStore.mjs';
if (isMain) {
  // Manual inspection helper: print the current store's state.
  try {
    const release = storeRelease();
    if (!release) {
      console.log(`no ${BROWSER_STORE_TAG} release yet`);
    } else {
      console.log(`${BROWSER_STORE_TAG}: ${release.assets.length} asset(s)`);
      const ledger = parseStoreLedger(release.body);
      for (const a of release.assets) {
        const sha = ledger.get(a.name);
        console.log(
          `  ${a.name}  ${(a.size / 1e6).toFixed(1)} MB  ${sha ? `sha256=${sha}` : '(not in ledger)'}`
        );
      }
    }
    process.exitCode = 0;
  } catch (err) {
    console.error(`✗ Error: ${err.message}`);
    process.exit(1);
  }
}
