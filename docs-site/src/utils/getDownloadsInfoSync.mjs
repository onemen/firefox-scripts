// Build-time reader for src/utils/downloadsInfo.json (written by
// getDownloadsInfo.mjs). Missing file means the fetch step never ran. The page
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
  // No generated file (fetch skipped or failed). Keep the empty shape.
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

/**
 * One dropdown per release family, newest first (the releases API returns
 * newest first, and frozenReleases preserves that order). Kept here and not
 * in download.mdx: MDX top-level statements cannot contain `{` object
 * literals, so the page imports these ready-made.
 */
const installerReleases = frozenReleases.filter((r) =>
  r.tag.startsWith("installer-")
);
const coreReleases = frozenReleases.filter((r) => r.tag.startsWith("core-"));
const latestAssets = latestRelease ? latestRelease.assets : [];

/** The files each dropdown offers, with the per-OS / per-package labels. */
const INSTALLER_FILES = [
  { name: "installer_win.exe", label: "Windows" },
  { name: "installer_linux", label: "Linux x86_64" },
  { name: "installer_linux_aarch64", label: "Linux ARM64" },
  { name: "installer_mac", label: "macOS (Intel + Apple Silicon)" },
];
const SCRIPT_FILES = [
  {
    name: "utils.zip",
    label: "chrome scripts → profile chrome/utils/",
  },
  {
    name: "fx-folder.zip",
    label: "config files → browser installation directory",
  },
];

export {
  generatedAt,
  hashesUrl,
  packages,
  releases,
  latestRelease,
  frozenReleases,
  installerReleases,
  coreReleases,
  latestAssets,
  INSTALLER_FILES,
  SCRIPT_FILES,
};
