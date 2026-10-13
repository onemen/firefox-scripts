// Builds src/utils/downloadsInfo.json, the data behind /download.
//
// Two sources, both read-only and both public:
//
//   1. hashes.json from the Pages branch, the SAME manifest the installer and
//      the in-browser updater hash-compare against, so the per-package dates
//      shown here are the dates the updater offers (issue #202: "from the same
//      release data the updater already consumes").
//   2. the GitHub releases API, the moving `latest` release plus the frozen
//      `core-<date>` (package zips) and `installer-<date>` (binaries) tags,
//      which is what a user needs in order to revert a package.
//
// Never hard-fails: a network hiccup must not break the docs deploy. The
// failure is reported loudly on stderr and the page falls back to plain links
// to the releases page (see getDownloadsInfoSync.mjs), so stale-or-missing
// data is visible instead of silent.
//
// Usage: node src/utils/getDownloadsInfo.mjs
// Env:   HASHES_URL (default the live Pages manifest), GITHUB_TOKEN_VAR, the
//        repo-wide fixed name the publish tooling also reads (optional: the
//        unauthenticated API allows 60 requests/hour, enough for a build).

import fs from 'node:fs/promises';
import path from 'node:path';

const OWNER = 'onemen';
const REPO = 'firefox-scripts';
const HASHES_URL = process.env.HASHES_URL || `https://onemen.github.io/${REPO}/hashes.json`;
const API = `https://api.github.com/repos/${OWNER}/${REPO}`;

/** The packages the Download page shows. Keep in sync with download.mdx. */
const PACKAGES = ['utils', 'fx-folder'];

const token = process.env.GITHUB_TOKEN_VAR || process.env.GITHUB_TOKEN || '';

async function fetchJson(url, {headers = {}} = {}) {
  const response = await fetch(url, {
    headers: {
      'accept': 'application/vnd.github+json',
      'user-agent': `${REPO}-docs-site`,
      'x-github-api-version': '2022-11-28',
      ...(token ? {authorization: `Bearer ${token}`} : {}),
      ...headers,
    },
  });
  if (!response.ok) {
    throw new Error(`GET ${url} → HTTP ${response.status}`);
  }
  return response.json();
}

/**
 * Per-package publish dates + file lists from the live hash manifest.
 *
 * @returns {Promise<Record<string, {date: string; files: string[]}>>}
 */
async function getPackages() {
  const manifest = await fetchJson(HASHES_URL);
  const packages = {};
  for (const name of PACKAGES) {
    const entry = manifest[name];
    if (!entry) {
      throw new Error(`hashes.json has no "${name}" package`);
    }
    packages[name] = {
      // The binaries (installer/helper) have no `files` list. They ship as
      // single artifacts, so only the package zips are listed here.
      date: entry.date,
      files: entry.files ?? [],
      hash: entry.hash,
    };
  }
  return packages;
}

/**
 * The release list the download page links to.
 *
 * @returns {Promise<
 *   {
 *     tag: string;
 *     name: string;
 *     publishedAt: string;
 *     date: string;
 *     assets: {name: string; size: number; href: string}[];
 *   }[]
 * >}
 */
async function getReleases() {
  const releases = await fetchJson(`${API}/releases?per_page=100`);
  return releases
    .filter(r => r.tag_name === 'latest' || /^(core|installer)-\d{4}-\d{2}-\d{2}$/.test(r.tag_name))
    .map(release => ({
      tag: release.tag_name,
      name: release.name || release.tag_name,
      publishedAt: release.published_at,
      // The tag carries the package date; `latest` does not, so its own date
      // is read from the manifest by the page instead.
      date: release.tag_name.replace(/^[^-]+-/, ''),
      draft: release.draft,
      prerelease: release.prerelease,
      htmlUrl: release.html_url,
      assets: release.assets.map(asset => ({
        name: asset.name,
        size: asset.size,
        href: asset.browser_download_url,
      })),
    }));
}

const outputPath = path.join(process.cwd(), 'src/utils/downloadsInfo.json');

const result = {
  generatedAt: new Date().toISOString(),
  hashesUrl: HASHES_URL,
  packages: {},
  releases: [],
};

try {
  result.packages = await getPackages();
} catch (error) {
  console.warn(`[docs] WARNING: package dates unavailable (${error.message})`);
}
try {
  result.releases = await getReleases();
} catch (error) {
  console.warn(`[docs] WARNING: release list unavailable (${error.message})`);
}

await fs.writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
console.log(
  `[docs] downloadsInfo.json written (${Object.keys(result.packages).length} packages, ` +
    `${result.releases.length} releases)`
);
