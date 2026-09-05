// test/e2e/shared/browserResolver.mjs — resilient browser version + installer
// resolution for the E2E matrix and the publish pre-flight.
//
// One module, two chains per browser (plan: docs/browser-downloads-resilience.local.md):
//
// - resolveBrowserVersion(browser) — "what is the current release?" Chain of
//   vendor version APIs; first source that answers wins. LibreWolf prefers the
//   Codeberg bsys6 releases API (sampled ~20× faster than the packages registry
//   that stalled the Sep 2026 publish), waterfox falls back to its CDN releases
//   index. Endpoint knowledge adapted from the maintainer's firefox-updater
//   project (not an import — see the plan doc, §4).
//
// - resolveInstallerUrl(browser, version?) — "where do I download it?" Chain of
//   installer hosts; first that answers wins. Ends with the temporary
//   `ci-downloads` release (the manual escape hatch — created on demand by
//   tools/ci/ciDownload.mjs, auto-deleted by CI after the consuming run) and
//   optionally a cached previous installer.
//
// Every JSON fetch goes through fetchJsonWithRetry (3 attempts, 5/10/15 s
// backoff — the same ladder the E2E installer downloads already use), so a
// single vendor stall no longer kills a watchdog run or blocks a publish.

import {execSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Backoff base between attempts — 5s in CI, override for unit tests. */
const backoffMs = () => {
  const n = Number(process.env.BROWSER_RESOLVER_BACKOFF_MS ?? 5000);
  return Number.isFinite(n) && n >= 0 ? n : 5000;
};

/**
 * Fetch a URL and parse the body, retrying with backoff.
 *
 * 3 attempts with 5s/10s/15s backoff (mirrors downloads.mjs's fetchWithRetry
 * ladder). Each attempt is bounded by `timeoutMs` so a stalled connection
 * cannot hang CI until the runner kills the job.
 *
 * @param {string} url
 * @param {{attempts?: number; timeoutMs?: number; as?: 'json' | 'text'}} [opts]
 * @returns {Promise<any>} parsed JSON body (or text when `as: 'text'`)
 */
async function fetchWithRetry(url, {attempts = 3, timeoutMs = 30_000, as = 'json'} = {}) {
  const total = Math.max(1, attempts);
  let lastErr;
  for (let i = 1; i <= total; i++) {
    try {
      const res = await fetch(url, {signal: AbortSignal.timeout(timeoutMs)});
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return as === 'json' ? await res.json() : await res.text();
    } catch (err) {
      lastErr = err;
      console.log(`  attempt ${i}/${total} failed for ${url}: ${err.message}`);
      if (i < total) {
        await new Promise(r => setTimeout(r, backoffMs() * i));
      }
    }
  }
  throw lastErr;
}

/**
 * Fetch + JSON-parse with the retry ladder. Exported for callers that need a
 * raw endpoint (and for unit tests of the ladder itself).
 *
 * @param {string} url
 * @param {{attempts?: number; timeoutMs?: number}} [opts]
 * @returns {Promise<any>}
 */
export function fetchJsonWithRetry(url, opts = {}) {
  return fetchWithRetry(url, opts);
}

// ── Version resolution ───────────────────────────────────────────────────────

/**
 * Codeberg bsys6 releases: LibreWolf's canonical source (used by the
 * maintainer's firefox-updater daily). Returns the tag (`155.0-1`) plus the
 * asset list, so the installer chain can reuse the URLs without templating.
 * Endpoint order: ① bsys6 releases API, ② the Gitea packages registry — both on
 * Codeberg, so a full outage still defeats the chain (accepted, plan §8).
 */
const LIBREWOLF_VERSION_CHAIN = [
  {
    source: 'codeberg-bsys6-releases',
    fetch: async () => {
      const release = await fetchJsonWithRetry(
        'https://codeberg.org/api/v1/repos/librewolf/bsys6/releases/latest'
      );
      return {version: release.tag_name, release};
    },
  },
  {
    source: 'codeberg-packages',
    fetch: async () => {
      const packages = await fetchJsonWithRetry('https://codeberg.org/api/v1/packages/librewolf');
      const pkg = packages.find(p => p.type === 'generic' && p.name === 'librewolf');
      return pkg ? {version: pkg.version} : null;
    },
  },
];

const VERSION_CHAINS = {
  'firefox': [
    {
      source: 'product-details',
      fetch: async () => ({
        version: (
          await fetchJsonWithRetry('https://product-details.mozilla.org/1.0/firefox_versions.json')
        ).LATEST_FIREFOX_VERSION,
      }),
    },
  ],
  'firefox-dev': [
    {
      source: 'product-details',
      fetch: async () => ({
        version: (
          await fetchJsonWithRetry('https://product-details.mozilla.org/1.0/firefox_versions.json')
        ).FIREFOX_DEVEDITION,
      }),
    },
  ],
  'floorp': [
    {
      source: 'github-releases',
      fetch: async () => ({
        version: (
          await fetchJsonWithRetry(
            'https://api.github.com/repos/Floorp-Projects/Floorp/releases/latest'
          )
        ).tag_name.replace(/^v/, ''),
      }),
    },
  ],
  'zen': [
    {
      source: 'github-releases',
      fetch: async () => ({
        version: (
          await fetchJsonWithRetry(
            'https://api.github.com/repos/zen-browser/desktop/releases/latest'
          )
        ).tag_name.replace(/^v/, ''),
      }),
    },
  ],
  'waterfox': [
    {
      // Waterfox publishes no release *assets* on GitHub — the tag is still
      // the display version (6.7.1.1); the installers live on the CDN.
      source: 'github-releases',
      fetch: async () => ({
        version: (
          await fetchJsonWithRetry(
            'https://api.github.com/repos/BrowserWorks/Waterfox/releases/latest'
          )
        ).tag_name.replace(/^v/, ''),
      }),
    },
    {
      // CDN releases index — the authoritative version list the site itself
      // serves from (adapted from firefox-updater's waterfoxUpdate.js). Lists
      // one directory per published build, including betas; pick the newest
      // non-beta entry.
      source: 'waterfox-cdn-index',
      fetch: async () => {
        const versions = await fetchWaterfoxCdnVersions();
        const releases = versions.filter(v => parseWaterfoxVersion(v)?.pre === null);
        if (releases.length === 0) return null;
        const newest = releases.sort(compareWaterfoxVersions).at(-1);
        return {version: newest};
      },
    },
  ],
  'librewolf': LIBREWOLF_VERSION_CHAIN,
};

/**
 * Resolve a browser's current release version by walking its version chain.
 *
 * @param {string} browser
 * @param {{pin?: string | null}} [opts] `pin` short-circuits the chain (the
 *   manual escape's single-browser dispatch pins the version explicitly).
 * @returns {Promise<{version: string; source: string}>} throws after every
 *   source in the chain failed
 */
export async function resolveBrowserVersion(browser, {pin = null} = {}) {
  // Manual escape: e2e.yml exports BROWSER_PIN_VERSION from the dispatch's
  // `version` input (empty on ordinary runs — no effect).
  pin ??= process.env.BROWSER_PIN_VERSION || null;
  if (pin) return {version: pin, source: 'pinned'};
  const chain = VERSION_CHAINS[browser];
  if (!chain) throw new Error(`no version chain for browser '${browser}'`);
  const errors = [];
  for (const link of chain) {
    try {
      const found = await link.fetch();
      if (found?.version) {
        const {version, ...rest} = found;
        return {version: String(version), source: link.source, ...rest};
      }
      console.log(`  ${link.source}: no version returned — trying next source`);
    } catch (err) {
      errors.push(`${link.source}: ${err.message}`);
      console.log(`  ${link.source} failed (${err.message}) — trying next source`);
    }
  }
  throw new Error(`all version sources failed for ${browser}: ${errors.join('; ')}`);
}

// ── Waterfox version parsing/compare (ported from firefox-updater) ──────────

/**
 * Waterfox display versions: 6.6.9, 6.7.1.1, 6.7.0-beta.1 (legacy
 * 6.5.0-beta-1). Anchored + bounded — the unsafe-regex warning is a false
 * positive.
 */
// eslint-disable-next-line security/detect-unsafe-regex
const WATERFOX_VERSION_REGEXP = /^\d+(?:\.\d+)*(?:-(?:beta|alpha)[.-]?\d+)?$/;

/**
 * Parse a Waterfox version into {numbers, pre, preNumber}, or null when it is
 * not a Waterfox display version (e.g. a firefox platform version).
 *
 * @param {string} version
 * @returns {{
 *   numbers: number[];
 *   pre: string | null;
 *   preNumber: number;
 * } | null}
 */
export function parseWaterfoxVersion(version) {
  // Anchored, bounded alternation over a version string — no catastrophic
  // backtracking possible (eslint-security false positive).
  // eslint-disable-next-line security/detect-unsafe-regex
  const match = version.match(/^(\d+(?:\.\d+)*)(?:-(beta|alpha)[.-]?(\d+))?$/);
  if (!match) return null;
  return {
    numbers: match[1].split('.').map(Number),
    pre: match[2] ?? null,
    preNumber: match[3] ? Number(match[3]) : 0,
  };
}

/**
 * Semver-style compare so 6.7.0-beta.3 < 6.7.0 but 6.7.0-beta.1 > 6.6.9.
 * Returns > 0 when a > b, < 0 when a < b, 0 when equal.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareWaterfoxVersions(a, b) {
  const pa = parseWaterfoxVersion(a);
  const pb = parseWaterfoxVersion(b);
  if (!pa || !pb)
    return (
      a === b ? 0
      : a > b ? 1
      : -1
    );
  const parts = Math.max(pa.numbers.length, pb.numbers.length);
  for (let i = 0; i < parts; i++) {
    const diff = (pa.numbers[i] ?? 0) - (pb.numbers[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  if (pa.pre !== pb.pre) {
    if (!pa.pre) return 1; // release > pre-release
    if (!pb.pre) return -1;
    return pa.pre < pb.pre ? -1 : 1;
  }
  return Math.sign(pa.preNumber - pb.preNumber);
}

/**
 * All version directory names from the CDN releases index
 * (https://cdn.waterfox.com/waterfox/releases/), non-version entries filtered.
 *
 * @returns {Promise<string[]>}
 */
export async function fetchWaterfoxCdnVersions() {
  const res = await fetchTextWithRetry('https://cdn.waterfox.com/waterfox/releases/');
  const versions = [];
  for (const match of res.matchAll(/href=["'][^"']*?waterfox\/releases\/([^/"']+?)\/?["']/g)) {
    const version = decodeURIComponent(match[1]);
    if (WATERFOX_VERSION_REGEXP.test(version) && !versions.includes(version)) {
      versions.push(version);
    }
  }
  return versions;
}

/** fetch + text with the retry ladder (the waterfox index is HTML, not JSON). */
function fetchTextWithRetry(url) {
  return fetchWithRetry(url, {as: 'text'});
}

// ── Installer resolution ─────────────────────────────────────────────────────

/**
 * The temporary manual-escape release (created/deleted by CI, see
 * ciDownload.mjs).
 */
export const CI_DOWNLOADS_TAG = 'ci-downloads';

/**
 * Check the temporary `ci-downloads` release for an asset with the expected
 * name. A missing release is the normal steady state — 404 resolves to null
 * silently (no warning, no retry). The release is probed once per process and
 * the asset map cached; a `null` cache entry means "no release".
 *
 * @param {string} assetName exact asset filename to look for
 * @returns {Promise<string | null>} asset download URL, or null
 */
export async function findCiDownloadsAsset(assetName) {
  if (ciDownloadsAssets === undefined) {
    ciDownloadsAssets = await probeCiDownloads();
  }
  const url = ciDownloadsAssets?.get(assetName) ?? null;
  if (url) console.log(`  ci-downloads: found ${assetName}`);
  return url;
}

/** Per-process memo: asset-name → download URL, or null when no release exists. */
let ciDownloadsAssets; // Map | null

/**
 * Forget the memoized ci-downloads probe — the release can appear (created by
 * `pnpm ci:download`) or disappear (`--clean`, CI cleanup) mid-process.
 */
export function resetCiDownloadsProbe() {
  ciDownloadsAssets = undefined;
}

async function probeCiDownloads() {
  try {
    const release = await fetchJsonWithRetry(
      `https://api.github.com/repos/${repoSlug()}/releases/tags/${CI_DOWNLOADS_TAG}`,
      {attempts: 1, timeoutMs: 15_000}
    );
    return new Map((release.assets || []).map(a => [a.name, a.browser_download_url]));
  } catch {
    // 404 / no release / API hiccup — the steady state; official mirrors and
    // the cached-installer fallback still apply.
    return null;
  }
}

/** owner/repo for the current checkout (CI env or git remote, cached). */
function repoSlug() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  repoSlugCache ??= (() => {
    try {
      const remote = execSync('git remote get-url origin', {encoding: 'utf8'}).trim();
      const m = remote.match(/github\.com[:/](.+?)(?:\.git)?$/);
      if (m) return m[1];
    } catch {
      // not a git checkout / no origin — treated as "no ci-downloads"
    }
    return null;
  })();
  return repoSlugCache;
}
let repoSlugCache;

/**
 * Verify a downloaded installer against the vendor's published `.sha256sum`
 * (adapted from firefox-updater's verifySha256). Throws on mismatch.
 *
 * @param {string} filePath downloaded installer
 * @param {string} sha256Url URL of the vendor's `.sha256sum` (first token = hex
 *   hash)
 * @returns {Promise<string>} the actual hex sha256 (verified)
 */
export async function verifySha256(filePath, sha256Url) {
  const shaFile = `${filePath}.sha256sum`;
  await downloadFile(sha256Url, shaFile);
  const expected = fs.readFileSync(shaFile, 'utf8').trim().split(/\s+/)[0].toLowerCase();
  const actual = createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  if (actual !== expected) {
    throw new Error(
      `sha256 mismatch for ${path.basename(filePath)}\n  expected: ${expected}\n  actual:   ${actual}`
    );
  }
  return actual;
}

/** Small streaming download helper (no retry — callers own the ladder). */
async function downloadFile(url, dest) {
  const res = await fetch(url, {signal: AbortSignal.timeout(300_000)});
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  fs.mkdirSync(path.dirname(dest), {recursive: true});
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  return dest;
}

/**
 * Installer sources per browser (win). Each source is tried in order; the first
 * that yields a URL wins. `ci-downloads` sits AFTER the official mirrors + the
 * bsys6 release asset and BEFORE the cached-previous-installer fallback
 * (upstream, fresher beats stale cache).
 */
const INSTALLER_CHAINS = {
  librewolf: {
    // ① librewolf.dev Gitea registry (version-embedded URL, current behavior)
    // ② dl.librewolf.net — the official CDN the website links (bsys6 output)
    // ③ the bsys6 release's own asset URL (redirects to ② today, kept for
    //    zero-cost self-updating redundancy) — resolved in resolveInstallerUrl
    //    from the release object the version chain fetched
    // ④ ci-downloads (manual escape)  ⑤ cached previous installer (caller)
    sources: [
      v =>
        `https://librewolf.dev/api/packages/librewolf/generic/librewolf/${v}/librewolf-${v}-windows-x86_64-setup.exe`,
      v => `https://dl.librewolf.net/librewolf/${v}/librewolf-${v}-windows-x86_64-setup.exe`,
    ],
    sha256: [
      v =>
        `https://dl.librewolf.net/librewolf/${v}/librewolf-${v}-windows-x86_64-setup.exe.sha256sum`,
    ],
    assetName: v => `librewolf-${v}-windows-x86_64-setup.exe`,
  },
  waterfox: {
    sources: [
      // Verified live: cdn.waterfox.com/waterfox/releases/<v>/WINNT_x86_64/
      // "Waterfox Setup <v>.exe" (adapted from firefox-updater).
      v =>
        `https://cdn.waterfox.com/waterfox/releases/${v}/WINNT_x86_64/${encodeURIComponent(`Waterfox Setup ${v}.exe`)}`,
    ],
    assetName: v => `waterfox-${v}-setup.exe`,
  },
  floorp: {
    sources: [
      () =>
        'https://github.com/Floorp-Projects/Floorp/releases/latest/download/floorp-windows-x86_64.installer.exe',
    ],
    assetName: v => `floorp-${v}-installer.exe`,
  },
  zen: {
    sources: [
      () => 'https://github.com/zen-browser/desktop/releases/latest/download/zen.installer.exe',
    ],
    assetName: v => `zen-${v}-installer.exe`,
  },
};

/**
 * The normalized asset filename a browser's installer carries inside the
 * temporary `ci-downloads` release (shared by ciDownload.mjs — which renames
 * the uploaded file to this name — and the resolver's lookup).
 *
 * @param {string} browser
 * @param {string} version
 * @returns {string}
 */
export function ciDownloadsAssetName(browser, version) {
  const chain = INSTALLER_CHAINS[browser];
  if (!chain) throw new Error(`no installer chain for browser '${browser}'`);
  return chain.assetName(version);
}

/**
 * Resolve the installer download URL for a browser, walking its source chain.
 * `version` pins the version-embedded sources; without it, the current version
 * is resolved first. The `ci-downloads` manual-escape release is probed by
 * expected filename after the official mirrors.
 *
 * @param {string} browser
 * @param {{version?: string | null}} [opts]
 * @returns {Promise<{
 *   url: string;
 *   source: string;
 *   sha256Url: string | null;
 *   version: string;
 * }>}
 *   `sha256Url` is set for LibreWolf (vendor publishes sums for every source).
 */
export async function resolveInstallerUrl(browser, {version = null} = {}) {
  const chain = INSTALLER_CHAINS[browser];
  if (!chain) throw new Error(`no installer chain for browser '${browser}'`);
  const resolved = await resolveBrowserVersion(browser, {pin: version});
  const v = resolved.version;

  // ① official mirrors (each source may be version-embedded)
  for (const build of chain.sources) {
    const url = build(v);
    // Cheap existence check: the version-embedded hosts 404 on a wrong guess,
    // the stable-latest URLs always answer. A 404 moves to the next source.
    if (await urlExists(url)) {
      // LibreWolf publishes a .sha256sum for every installer (dl.librewolf.net
      // mirrors it for all sources — same bytes, same sum).
      const sha256Url = chain.sha256 ? chain.sha256[0](v) : null;
      return {url, source: 'official', sha256Url, version: v};
    }
  }

  // ② the bsys6 release's own asset (the release object the version chain
  // fetched; today it redirects to dl.librewolf.net, kept for zero-cost
  // self-updating redundancy — if bsys6 re-homes its assets, the chain
  // follows without a code change).
  const bsys6Asset = resolved.release?.assets?.find(
    a =>
      typeof a?.browser_download_url === 'string' &&
      a.browser_download_url.endsWith(`/${chain.assetName(v)}`)
  );
  if (bsys6Asset && (await urlExists(bsys6Asset.browser_download_url))) {
    const sha256Url = chain.sha256 ? chain.sha256[0](v) : null;
    return {
      url: bsys6Asset.browser_download_url,
      source: 'codeberg-bsys6-asset',
      sha256Url,
      version: v,
    };
  }

  // ③ ci-downloads (manual escape hatch) — no vendor .sha256sum sibling;
  // accepted unverified (maintainer trust boundary, plan §8).
  const ciUrl = await findCiDownloadsAsset(chain.assetName(v));
  if (ciUrl) {
    return {url: ciUrl, source: CI_DOWNLOADS_TAG, sha256Url: null, version: v};
  }

  throw new Error(
    `no installer source answered for ${browser} ${v} (official mirrors + ${CI_DOWNLOADS_TAG})`
  );
}

/** HEAD a URL (1 fallback GET); true on 2xx/3xx. Bounded, non-retrying. */
async function urlExists(url) {
  try {
    const res = await fetch(url, {method: 'HEAD', signal: AbortSignal.timeout(15_000)});
    if (res.status === 405 || res.status === 501) {
      const get = await fetch(url, {
        headers: {Range: 'bytes=0-0'},
        signal: AbortSignal.timeout(15_000),
      });
      await get.body?.cancel().catch(() => {});
      return get.ok;
    }
    return res.ok;
  } catch {
    return false;
  }
}
