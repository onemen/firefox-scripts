// Build-time reader for src/utils/downloadsInfo.json (written by
// getDownloadsInfo.mjs). Missing file = the fetch step never ran — the page
// renders its static fallback links instead of failing the build.

import fs from "node:fs";

const GENERATED = "src/utils/downloadsInfo.json";

const EMPTY = {
  generatedAt: null,
  hashesUrl: "https://onemen.github.io/firefox-scripts/hashes.json",
  packages: {},
  releases: [],
};

let downloadsInfo = EMPTY;
try {
  downloadsInfo = JSON.parse(fs.readFileSync(GENERATED, "utf8"));
} catch {
  // No generated file (fetch skipped or failed) — keep the empty shape.
}

const { generatedAt, hashesUrl, packages, releases } = {
  ...EMPTY,
  ...downloadsInfo,
};

/**
 * The `latest` release, or null when the release list is unavailable.
 * @type {{tag: string, name: string, assets: Array<{name: string, href: string}>} | null}
 */
const latestRelease = releases.find((r) => r.tag === "latest") ?? null;

/**
 * The frozen releases a user can revert to, newest first: `core-<date>`
 * (package zips) then `installer-<date>` (binaries).
 */
const frozenReleases = releases.filter((r) => r.tag !== "latest");

/**
 * Direct download URL for one asset of a release, or null when the release list
 * is unavailable (the page then links to the releases page instead).
 * @param {string} tag release tag
 * @param {string} assetName asset file name
 * @returns {string | null}
 */
export function assetUrl(tag, assetName) {
  const release = releases.find((r) => r.tag === tag);
  return release?.assets.find((a) => a.name === assetName)?.href ?? null;
}

export {
  generatedAt,
  hashesUrl,
  packages,
  releases,
  latestRelease,
  frozenReleases,
};
