#!/usr/bin/env node

/**
 * generateUpdaterConfig.mjs — Regenerate the in-browser updater's config module
 * (core/chrome/utils/updater/updater-config.sys.mjs) from
 * config/installer.conf.
 *
 * Mirrors the C side: installer/Makefile generates installer/src/_config.h from
 * the same installer.conf, so a path/URL change by the developer propagates to
 * the C installer, the JS publish scripts (paths.js) AND the in-browser updater
 * (updater-config.sys.mjs), which ships inside utils.zip.
 *
 * Because the generated file lives in the utils source tree, changing
 * installer.conf changes the utils hash → the hash-based update detector shows
 * an update → the new config reaches installed profiles. This is by design: URL
 * changes are treated like any other code change.
 *
 * Usage: node tools/publish/generateUpdaterConfig.mjs # write the module node
 * tools/publish/generateUpdaterConfig.mjs --check # verify sync, exit != 0 if
 * stale
 *
 * createZip.mjs / upload.mjs call this before packaging so the zip, hash and
 * manifest always match installer.conf.
 */

import fs from 'fs';
import path from 'path';
import {fileURLToPath, pathToFileURL} from 'url';
import {DEV_BRANCH, LOCAL, MODE, localSnapshotDir} from './publishMode.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFIG_PATH = path.resolve(__dirname, '..', '..', 'config', 'installer.conf');
const OUT_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  'core',
  'chrome',
  'utils',
  'updater',
  'updater-config.sys.mjs'
);

function readConfig() {
  const config = {};
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`installer.conf not found at ${CONFIG_PATH}`);
  }
  const text = fs.readFileSync(CONFIG_PATH, 'utf-8');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const eq = trimmed.indexOf('=');
    config[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return config;
}

/**
 * applyDevOverrides — dev-mode values for every URL/name key shared with the C
 * side (configHeader in syncGeneratedFiles.mjs uses the same function).
 *
 * Dev deploys land on the per-run dev-build-<id> branch only — there is no
 * GitHub release for dev (every artifact is published through the git-data
 * branch: zips, hashes, helpers and installer binaries alike). That branch is
 * NOT a Pages site (GitHub serves one branch per repo), so every consumer goes
 * through jsDelivr's CORS-enabled proxy (`https://cdn.jsdelivr.net/gh/
 * <owner>/<repo>@<ref>`, ACAO: *). Files are published with the ASSET_SUFFIX
 * '-dev' (utils-dev.zip, updater-ui-dev.zip, installer_win-dev.exe,
 * helper_win-dev.exe); hashes.json keeps its plain name — it is consumed
 * exclusively through the URL below, never by hand.
 */
export function applyDevOverrides(config) {
  const owner = config.REPO_OWNER;
  const repo = config.ZIP_DOWNLOAD_REPO || config.REPO_NAME;
  if (!owner || !repo) {
    throw new Error('installer.conf is missing REPO_OWNER / ZIP_DOWNLOAD_REPO for dev mode');
  }
  const delivrBase = `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${DEV_BRANCH}`;
  return {
    RELEASE_NAME: 'dev-build',
    ZIP_BASE_URL: delivrBase,
    HASHES_URL: `${delivrBase}/hashes.json`,
    ZIP_PAGES_URL: delivrBase,
    HELPER_BASE_URL: delivrBase,
    ASSET_SUFFIX: '-dev',
  };
}

/**
 * applyInstallerLocalOverrides — redirect the C INSTALLER's
 * download/hash/helper URLs to its own HTTP server
 * (http://localhost:<DEFAULT_PORT>/). The local snapshot ships zips,
 * hashes.json and helper binaries at the branch root, and the installer serves
 * them from its own directory (http_server.c serve_local_file, enabled by
 * CFG_LOCAL), so upload:local installer builds install and hash-check with zero
 * GitHub traffic. The installer tab is HTTP-served, so it must keep http://
 * URLs.
 *
 * ASSET_SUFFIX is left untouched: prod-local stays '' and dev-local stays
 * '-dev'.
 */
export function applyInstallerLocalOverrides(config) {
  const base = `http://localhost:${config.DEFAULT_PORT || '8777'}`;
  return {
    ZIP_BASE_URL: base,
    HASHES_URL: `${base}/hashes.json`,
    ZIP_PAGES_URL: base,
    HELPER_BASE_URL: base,
  };
}

/**
 * applyUpdaterLocalOverrides — point the in-browser UPDATER (a privileged
 * chrome:// page that fetches the zips itself) at the local snapshot DIRECTORY
 * via file:// URLs. The updater runs days after the installer's HTTP server is
 * gone, so localhost URLs would be dead; reading utils.zip / hashes.json / the
 * helper straight from dist/<mode>-<branch>-<hash>/ keeps a --local install
 * self-contained and testable.
 */
export function applyUpdaterLocalOverrides() {
  const base = pathToFileURL(localSnapshotDir()).href.replace(/\/$/, '');
  return {
    ZIP_BASE_URL: base,
    HASHES_URL: `${base}/hashes.json`,
    HELPER_BASE_URL: base,
  };
}

/**
 * The effective config for the current mode (prod: as read from installer.conf;
 * dev: dev-branch overrides; local: overrides on top of either). `installer`
 * selects the C-installer variant (localhost in local mode); the default is the
 * in-browser updater variant (file:// in local mode).
 */
export function effectiveConfig(config, {installer = false} = {}) {
  let eff = config;
  if (MODE === 'dev') eff = {...eff, ...applyDevOverrides(eff)};
  if (LOCAL) {
    eff = {
      ...eff,
      ...(installer ? applyInstallerLocalOverrides(eff) : applyUpdaterLocalOverrides()),
    };
  }
  return eff;
}

function generateModule(config) {
  const eff = effectiveConfig(config);
  const {REPO_OWNER, ZIP_DOWNLOAD_REPO, RELEASE_NAME} = eff;
  if (!REPO_OWNER || !ZIP_DOWNLOAD_REPO || !RELEASE_NAME || !eff.HASHES_URL) {
    throw new Error(
      'installer.conf is missing required keys (REPO_OWNER, ZIP_DOWNLOAD_REPO, RELEASE_NAME, HASHES_URL)'
    );
  }
  // Emit `KEY: 'value',` — or the wrapped spell prettier demands when the
  // single line would exceed printWidth (long raw URLs).  The generated
  // module is itself run through prettier's --check (config/.prettierignore
  // does not exempt it), so over-long values MUST use the wrapped form or
  // the gate fails.
  const urlLine = (key, value) => {
    const lit = JSON.stringify(value).replace(/"/g, "'");
    return key.length + 5 + lit.length > 100 ? `  ${key}:\n    ${lit},` : `  ${key}: ${lit},`;
  };
  // Where the privileged engine downloads the package zips.  Defaults to the
  // release download URL derived from RELEASE_NAME; an explicit ZIP_BASE_URL
  // wins when it is a literal (no ${VAR} template — installer.conf's own
  // value is a template, expanded on the C side).  Dev overrides it with the
  // dev-build-<id> branch base (via jsDelivr), since dev publishes no release.
  const zipBase =
    eff.ZIP_BASE_URL && !eff.ZIP_BASE_URL.includes('${') ?
      eff.ZIP_BASE_URL
    : `https://github.com/${REPO_OWNER}/${ZIP_DOWNLOAD_REPO}/releases/download/${RELEASE_NAME}`;
  // Helper binaries are published on the same channel as the zips
  // (gh-pages in prod, the dev-build-<id> branch via jsDelivr in dev).
  // Prefer an explicit HELPER_BASE_URL in installer.conf; otherwise derive it
  // from this repo's gh-pages URL.
  const helperBase =
    eff.HELPER_BASE_URL ||
    `https://${REPO_OWNER}.github.io/${config.REPO_NAME || 'firefox-scripts'}`;

  return `'use strict';

/**
 * Firefox Scripts - Updater Configuration (AUTO-GENERATED)
 *
 * Generated by tools/publish/generateUpdaterConfig.mjs from
 * config/installer.conf (single source of truth, shared with the C installer
 * and the JS publish scripts). DO NOT EDIT BY HAND — edit installer.conf and
 * re-run the generator.
 *
 * Ships inside utils.zip; a change here changes the utils hash, which is what
 * makes a URL/path update propagate to installed profiles through the
 * hash-based update detector.
 */

export const CONFIG = {
  // Hash manifest (published to the gh-pages branch, or the dev-build-<id>
  // branch in dev mode)
${urlLine('HASHES_URL', eff.HASHES_URL)}

  // Where package zips are published
${urlLine('ZIP_BASE_URL', zipBase)}

  // Where the standalone elevated-copy helper binary is published
${urlLine('HELPER_BASE_URL', helperBase)}

  // Artifact name suffix appended to downloaded files: '' in prod
  // (utils.zip, installer_win.exe), '-dev' in dev mode (utils-dev.zip,
  // updater-ui-dev.zip, installer_win-dev.exe, helper_win-dev.exe).
${urlLine('ASSET_SUFFIX', eff.ASSET_SUFFIX || '')}

  // Test/dev identity: the updater tab shows a "test build" banner when either
  // is true (see tools/publish/remote-ui/updater-ui.js).
  IS_DEV: ${MODE === 'dev' ? 'true' : 'false'},
  IS_LOCAL: ${LOCAL ? 'true' : 'false'},

  // Absolute path of the local snapshot directory (--local builds only; empty
  // otherwise).  The file:// URLs above point into it.
${urlLine('LOCAL_DIST_PATH', LOCAL ? localSnapshotDir().replace(/\\/g, '/') : '')}

  // The dev-build branch this run publishes to (dev mode only).
${urlLine('DEV_BRANCH', DEV_BRANCH)}
};
`;
}

function main() {
  const checkOnly = process.argv.includes('--check');
  const config = readConfig();
  const moduleText = generateModule(config);

  if (checkOnly) {
    let current = '';
    try {
      current = fs.readFileSync(OUT_PATH, 'utf-8');
    } catch {
      console.error(`✗ updater-config.sys.mjs missing — run generateUpdaterConfig.mjs`);
      process.exit(1);
    }
    if (current === moduleText) {
      console.log('✓ updater-config.sys.mjs is up to date with installer.conf');
      process.exit(0);
    }
    console.error(
      `✗ updater-config.sys.mjs is OUT OF SYNC with installer.conf — run generateUpdaterConfig.mjs`
    );
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(OUT_PATH), {recursive: true});
  fs.writeFileSync(OUT_PATH, moduleText);
  console.log(`✓ Wrote ${path.relative(process.cwd(), OUT_PATH)}`);
}

const isMainModule =
  process.argv[1] === __filename || process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  main();
}

export {generateModule, OUT_PATH, readConfig};
