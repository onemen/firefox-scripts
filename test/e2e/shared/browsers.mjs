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
import {listZipEntries, readZipEntry} from '../../shared/zipReader.mjs';

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
  const root = path.resolve(destDir);
  for (const entry of listZipEntries(buf)) {
    if (entry.name.endsWith('/')) continue;
    const parts = entry.name.split('/');
    if (parts.some(p => p === '..' || p === '.' || p === '')) continue;
    // Windows quirk: '..\\outside.txt' contains no '/', slips past the
    // segment check, and path.join would escape destDir. Verify containment
    // on the resolved path instead.
    const destPath = path.resolve(root, ...parts);
    if (destPath !== root && !destPath.startsWith(root + path.sep)) continue;
    fs.mkdirSync(path.dirname(destPath), {recursive: true});
    fs.writeFileSync(destPath, readZipEntry(buf, entry));
  }
  return destDir;
}

// ── Firefox-family binary discovery ─────────────────────────────────────────

/** RUNTIME_BROWSER env: force a specific browser to test. */
export function targetBrowserName() {
  return process.env.RUNTIME_BROWSER || process.env.FIREFOX_FAMILY || '';
}

/** Known Firefox-family browsers and their per-OS binary paths. */
export const BROWSERS = {
  'firefox': {
    win: ['Mozilla Firefox', 'firefox.exe'],
    mac: ['Firefox.app'],
    linux: ['firefox'],
    choco: 'firefox',
  },
  'firefox-dev': {
    win: ['Firefox Developer Edition', 'firefox.exe'],
    mac: ['Firefox Developer Edition.app'],
    linux: ['firefox-developer-edition'],
    choco: 'firefox-dev',
  },
  'waterfox': {
    win: ['Waterfox', 'waterfox.exe'],
    mac: ['Waterfox.app'],
    linux: ['waterfox'],
    choco: null, // manual install only
  },
  'zen': {
    win: ['Zen Browser', 'zen.exe'],
    mac: ['Zen Browser.app'],
    linux: ['zen-browser'],
    choco: null,
  },
  'librewolf': {
    win: ['LibreWolf', 'librewolf.exe'],
    mac: ['LibreWolf.app'],
    linux: ['librewolf'],
    choco: 'librewolf',
  },
  'floorp': {
    // The NSIS installer (winget Ablaze.Floorp, machine scope) installs to
    // 'C:\Program Files\Ablaze Floorp', not 'Floorp'.
    win: ['Ablaze Floorp', 'floorp.exe'],
    mac: ['Floorp.app'],
    linux: ['floorp'],
    choco: 'floorp',
  },
};

/** Auto-detect a Firefox-family binary for the current OS. */
export function discoverFirefoxBinary() {
  if (process.env.FIREFOX_BINARY && fs.existsSync(process.env.FIREFOX_BINARY)) {
    return process.env.FIREFOX_BINARY;
  }

  const target = targetBrowserName();

  if (process.platform === 'win32') {
    const candidates = [];
    for (const [key, b] of Object.entries(BROWSERS)) {
      if (target && key !== target) continue;
      const [dir, exe] = b.win;
      candidates.push(
        path.join(process.env.LOCALAPPDATA || '', dir, exe),
        path.join('C:\\Program Files', dir, exe),
        path.join('C:\\Program Files (x86)', dir, exe)
      );
    }
    return candidates.find(p => fs.existsSync(p)) || null;
  }
  if (process.platform === 'darwin') {
    const candidates = [];
    for (const [key, b] of Object.entries(BROWSERS)) {
      if (target && key !== target) continue;
      const [app] = b.mac; // e.g. 'Firefox.app' (b.mac is an array, like b.win)
      const name = app.replace('.app', '');
      candidates.push(
        `/Applications/${app}/Contents/MacOS/${name.toLowerCase()}`,
        `/Applications/${app}/Contents/MacOS/${name}`,
        `/Applications/${app}/Contents/MacOS/firefox`
      );
    }
    return candidates.find(p => fs.existsSync(p)) || null;
  }
  // Linux: /usr/bin is the typical symlink target.  Include legacy paths
  // (firefox-esr, snap) that were supported before the BROWSERS registry.
  const candidates = [];
  for (const [key, b] of Object.entries(BROWSERS)) {
    if (target && key !== target) continue;
    candidates.push(`/usr/bin/${b.linux}`, `/opt/${b.linux}/${b.linux}`);
  }
  // Fallback paths not covered by BROWSERS entries
  if (!target || target === 'firefox') {
    candidates.push('/usr/bin/firefox-esr', '/snap/bin/firefox');
  }
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

  // Linux /usr/bin/<browser> is usually a symlink into the real install dir
  // (e.g. /usr/bin/librewolf -> /usr/lib/librewolf/librewolf); GreD must be
  // derived from the RESOLVED path or installFxFolder would write config.js
  // into /usr/bin (wrong + permission-denied).
  let resolved = firefoxBin;
  if (process.platform === 'linux') {
    try {
      resolved = fs.realpathSync(firefoxBin);
    } catch {
      // binary may not exist yet (candidate probing, unit tests)
    }
  }
  // Check the ORIGINAL path too: realpathSync of /snap/bin/firefox may
  // resolve to a launcher outside /snap/ (e.g. under /usr/lib), which would
  // otherwise make Snap detection miss.
  if (process.platform === 'linux' && (/\/snap\//.test(firefoxBin) || /\/snap\//.test(resolved))) {
    return '/etc/firefox';
  }
  const binDir = path.dirname(resolved);
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
