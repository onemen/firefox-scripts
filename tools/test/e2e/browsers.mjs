#!/usr/bin/env node
/**
 * Browser + snapshot discovery shared by the E2E tests.
 *
 * GreD derivation follows the install docs (tabmixplus-docs installation page):
 * config.js + config-prefs.js land in the browser's GreD directory, which
 * differs per OS and per install type (Snap vs tarball vs system).
 */

import fs from 'node:fs';
import path from 'node:path';
import {execSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {listZipEntries, readZipEntry} from '../unit/zipReader.mjs';

export const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

// ── Git identity ───────────────────────────────────────────────────────────

/** Current branch + short sha via git (never throws; fallbacks). */
export function gitBranchAndSha() {
  const get = arg => {
    try {
      return execSync(`git ${arg}`, {encoding: 'utf-8', cwd: REPO_ROOT}).trim();
    } catch {
      return '';
    }
  };
  return {branch: get('rev-parse --abbrev-ref HEAD'), sha: get('rev-parse --short=7 HEAD')};
}

// ── Snapshot discovery ──────────────────────────────────────────────────────

/**
 * Find a snapshot dir under dist/ containing a utils zip.
 *
 * @param {{override?: string; branchCheck?: boolean}} opts
 * @returns {{
 *   dir: string;
 *   mode: string;
 *   branch: string;
 *   sha: string;
 *   matches: boolean;
 * } | null}
 */
export function findSnapshot({override = '', branchCheck = true} = {}) {
  if (override) {
    if (!fs.existsSync(override)) throw new Error(`--snapshot dir not found: ${override}`);
    return {dir: override, mode: '', branch: '', sha: '', matches: true};
  }

  const distDir = path.join(REPO_ROOT, 'dist');
  if (!fs.existsSync(distDir)) return null;

  const snapshots = fs
    .readdirSync(distDir)
    .filter(d => /^(dev|prod)-/.test(d))
    .map(d => ({
      dir: path.join(distDir, d),
      name: d,
      time: fs.statSync(path.join(distDir, d)).mtimeMs,
    }))
    .sort((a, b) => b.time - a.time);

  const {branch, sha} = gitBranchAndSha();
  const expected = branch && sha ? `${branch.replace(/[^\w.-]+/g, '-')}-${sha}` : '';

  for (const snap of snapshots) {
    if (!findZip(snap.dir, ['utils-dev.zip', 'utils.zip'])) continue;
    const mode = snap.name.startsWith('dev-') ? 'dev' : 'prod';
    const rest = snap.name.slice(mode.length + 1); // <branch>-<sha>
    const matches = Boolean(expected) && rest === expected;
    if (branchCheck && !matches) continue; // strict: only the current branch's snapshot
    return {dir: snap.dir, mode, branch: rest.replace(/-[0-9a-f]{7,}$/, ''), sha, matches};
  }
  return null;
}

// ── Zip helpers (pure Node, reuses the unit-test zip reader) ───────────────

/** Find the first existing file among `names` inside `snapshotDir`. */
export function findZip(snapshotDir, names) {
  for (const name of names) {
    const p = path.join(snapshotDir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** Extract a zip (flat) into destDir. Returns the destDir. */
export function extractZip(zipPath, destDir) {
  const buf = fs.readFileSync(zipPath);
  fs.mkdirSync(destDir, {recursive: true});
  for (const entry of listZipEntries(buf)) {
    if (entry.name.endsWith('/')) continue;
    const parts = entry.name.split('/');
    if (parts.some(p => p === '..' || p === '.' || p === '')) continue;
    const destPath = path.join(destDir, ...parts);
    fs.mkdirSync(path.dirname(destPath), {recursive: true});
    fs.writeFileSync(destPath, readZipEntry(buf, entry));
  }
  return destDir;
}

// ── Firefox binary discovery ───────────────────────────────────────────────

/** Auto-detect a Firefox-family binary for the current OS. */
export function discoverFirefoxBinary() {
  if (process.env.FIREFOX_BINARY && fs.existsSync(process.env.FIREFOX_BINARY)) {
    return process.env.FIREFOX_BINARY;
  }
  if (process.platform === 'win32') {
    const candidates = [
      path.join(process.env.LOCALAPPDATA || '', 'Mozilla Firefox', 'firefox.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Firefox Developer Edition', 'firefox.exe'),
      'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
      'C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe',
    ];
    return candidates.find(p => fs.existsSync(p)) || null;
  }
  if (process.platform === 'darwin') {
    const candidates = [
      '/Applications/Firefox.app/Contents/MacOS/firefox',
      '/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox',
    ];
    return candidates.find(p => fs.existsSync(p)) || null;
  }
  const candidates = [
    '/usr/bin/firefox',
    '/usr/bin/firefox-esr',
    '/snap/bin/firefox',
    '/opt/firefox/firefox',
  ];
  return candidates.find(p => fs.existsSync(p)) || null;
}

/**
 * GreD (the dir Firefox autoconfig reads config.js from) for a binary path.
 * Follows the install docs:
 *
 * - Windows: the dir containing firefox.exe
 * - macOS: <Firefox.app>/Contents/Resources
 * - Linux tarball/system: dir containing application.ini (tarball dir, else
 *   /usr/lib/firefox)
 * - Linux Snap: /etc/firefox (the user-writable config location)
 */
export function findGreDir(firefoxBin) {
  // .../Contents/MacOS/firefox -> .../Contents/Resources
  // Pure string rewrite so unit tests run on every platform.
  const macOSResources = firefoxBin.replace(/\/Contents\/MacOS\/[^/]+$/, '/Contents/Resources');
  if (macOSResources !== firefoxBin) return macOSResources;

  if (process.platform === 'linux' && /\/snap\//.test(firefoxBin)) {
    return '/etc/firefox';
  }
  const binDir = path.dirname(firefoxBin);
  if (fs.existsSync(path.join(binDir, 'application.ini'))) {
    return binDir; // tarball / portable
  }
  if (process.platform === 'linux' && fs.existsSync('/usr/lib/firefox/application.ini')) {
    return '/usr/lib/firefox'; // system package (apt), wrapper binary
  }
  return binDir;
}

/** The location of config-prefs.js inside GreD (both project + docs agree). */
export function grePrefsDir(greDir) {
  return path.join(greDir, 'defaults', 'pref');
}

/** Is this binary a Snap install? (Linux Snap stores config under /etc). */
export function isSnapBinary(firefoxBin) {
  return process.platform === 'linux' && /\/snap\//.test(firefoxBin);
}
