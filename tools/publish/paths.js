// Configurable paths for firefox-scripts publish scripts
// Shared constants are read from config/installer.conf (single source of truth
// used by both the C installer and JavaScript publish scripts).
// Secrets (GitHub token) come from environment variables / .env file only.

import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
// Publish mode (--mode=prod|dev, required) + dev-run identity.  Imported first
// so the mode requirement fails fast even before the config file is touched.
import {
  ASSET_SUFFIX,
  DEV_BRANCH,
  DEV_BUILD_ID,
  MODE as PUBLISH_MODE,
  requireMode,
} from './publishMode.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---- Shared configuration (from config/installer.conf) ----

const CONFIG_PATH = path.resolve(__dirname, '..', '..', 'config', 'installer.conf');
const config = {};
try {
  const text = fs.readFileSync(CONFIG_PATH, 'utf-8');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const eq = trimmed.indexOf('=');
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    config[key] = val;
  }
} catch {
  console.warn('Warning: config/installer.conf not found, using defaults');
}

const cfg = (key, fallback) => config[key] || process.env[key] || fallback;

// ---- Publish mode (required, see publishMode.mjs) ----
// Throws with a usage hint when --mode=prod|dev is missing or invalid.
requireMode();

/**
 * Mode-aware config: 'prod' reads the shared installer.conf (fallbacks), 'dev'
 * ignores the conf (which pins the production values) and uses dev defaults. In
 * BOTH modes an explicit environment variable wins — used by CI for its own run
 * ids (DEV_BUILD_ID) or override targets.
 */
const cfgMode = (key, prodFallback, devFallback) =>
  process.env[key] || (PUBLISH_MODE === 'dev' ? devFallback : config[key] || prodFallback);

// Path to the firefox-scripts repo root (where core/ lives)
export const PROFILE_PATH = path.resolve(__dirname, '..', '..', 'core');

// Source directory of the updater-ui package (updater-ui.zip): the tab UI page,
// its privileged engine/client scripts and the brand logos.  updater.css is
// generated here at publish time (see syncGeneratedFiles.mjs buildRemoteUiCss).
export const REMOTE_UI_DIR = path.resolve(__dirname, 'remote-ui');

// Release tag name for GitHub releases: prod → 'latest' (installer.conf),
// dev → 'dev-build'.  Env-overridable in both modes.
export const RELEASE_NAME = cfgMode('RELEASE_NAME', 'latest', 'dev-build');

// Env var that holds the GitHub token (read via getGitHubToken()).
// Fixed name — no indirection; .env-example documents it.
export const GITHUB_TOKEN_VAR = 'GITHUB_TOKEN_VAR';

// GitHub repository info
export const REPO_OWNER = cfg('REPO_OWNER', 'onemen');
export const REPO_NAME = cfg('REPO_NAME', 'firefox-scripts');

// GitHub Pages deployment target for the installer package zips, helper
// binaries and the hash manifest (ZIP_PAGES_URL in config/installer.conf).
// Pages sends CORS headers, so the installer UI tab can fetch the zips and
// the manifest from here.
// prod → 'gh-pages' (installer.conf); dev → the per-run 'dev-build-<id>'
// branch, which is NOT a Pages site — dev URLs point at jsDelivr instead
// (see generateUpdaterConfig.mjs).
export const ZIP_PAGES_REPO = cfg('ZIP_PAGES_REPO', 'firefox-scripts');
export const ZIP_PAGES_BRANCH = cfgMode('ZIP_PAGES_BRANCH', 'gh-pages', DEV_BRANCH);

// Dev artifact name suffix: '-dev' in dev mode, '' in prod.  Zips, installer
// binaries and helper binaries are published as e.g. utils-dev.zip,
// installer_win-dev.exe, helper_win-dev.exe.
export {ASSET_SUFFIX, DEV_BUILD_ID, DEV_BRANCH};
export {PUBLISH_MODE};

// ---- Unified build-output root (dist/ at the repo top level) ----
// dist/ is gitignored. The ONLY durable contents are per-run snapshots:
//   dist/prod-<branch>-<hash>/           (upload:local --mode=prod)
//   dist/dev-<branch>-<hash>/            (upload:local --mode=dev)
//   dist/prod-copy-<branch>-<hash>/      (upload --mode=prod --keep-copy)
//   dist/dev-copy-<branch>-<hash>/       (upload --mode=dev --keep-copy)
// Build products (zips + binaries) are written to a transient dist/.build/
// staging tree that upload.mjs removes at the end of every run, so a plain
// GitHub upload leaves nothing behind and dist/ only ever holds snapshots.
export const DIST_ROOT = path.resolve(__dirname, '..', '..', 'dist');
export const BUILD_ROOT = path.join(DIST_ROOT, '.build');
export const INSTALLER_DIST = path.join(BUILD_ROOT, 'installer');
export const SCRIPTS_DIST = path.join(BUILD_ROOT, 'scripts');

/** dist/<mode>[-copy]-<branch>-<hash>/ folder name for a snapshot. */
export function snapshotDirName({mode, branch, sha, copy = false}) {
  const safeBranch = branch.replace(/[^\w.-]+/g, '-');
  return `${mode}${copy ? '-copy' : ''}-${safeBranch}-${sha}`;
}
