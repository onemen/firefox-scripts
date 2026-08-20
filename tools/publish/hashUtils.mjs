#!/usr/bin/env node

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {getAllFiles} from './gitignoreUtils.mjs';
import {
  DIST_ROOT,
  GITHUB_TOKEN_VAR,
  REPO_OWNER,
  ZIP_PAGES_REPO,
  ZIP_PAGES_BRANCH,
} from './paths.js';
import {MODE} from './publishMode.mjs';
import {createOctokit} from './publishCommon.mjs';
import {warn} from './log.mjs';

export const HASHES_FILE = 'hashes.json';

/**
 * Newest completed snapshot dir for the current mode (`prod-*`/`prod-copy-*` in
 * prod, `dev-*`/`dev-copy-*` in dev). This is the local change-detection
 * baseline: every snapshot carries its own hashes.json, so the old dist/hashes/
 * staging file is gone. Returns null before the first run.
 */
export function findLatestSnapshot(mode = MODE) {
  if (!fs.existsSync(DIST_ROOT)) return null;
  const prefix = `${mode}-`;
  let best = null;
  let bestMtime = 0;
  for (const entry of fs.readdirSync(DIST_ROOT, {withFileTypes: true})) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    const dir = path.join(DIST_ROOT, entry.name);
    if (!fs.existsSync(path.join(dir, HASHES_FILE))) continue;
    const mtime = fs.statSync(dir).mtimeMs;
    if (mtime > bestMtime) {
      bestMtime = mtime;
      best = dir;
    }
  }
  return best;
}

function getGistToken() {
  return process.env[GITHUB_TOKEN_VAR] || '';
}

/**
 * Compute a sha256 hash of all file contents in a directory (respecting
 * gitignore). Files are sorted by relative path for determinism.
 *
 * `extraFiles` (optional) adds on-disk files that gitignore would otherwise
 * exclude (e.g. the generated updater-config.sys.mjs, which ships inside
 * utils.zip but is untracked). Each entry is {rel, absPath} — `rel` is the path
 * relative to `dirPath` (what ships in the zip / what the installer and updater
 * hash against the installed dir).
 *
 * Returns { hash, files } where `hash` is the hex digest and `files` is the
 * sorted list of relative paths that were hashed. `files` is the canonical file
 * list published in the manifest — the installer hashes the same set.
 */
export function computeDirectoryHash(dirPath, patterns, extraFiles = []) {
  // The gitignore loader matches patterns relative to the scanned dir (plus
  // file names), so root-relative .gitignore entries for the generated files
  // are NOT honored here.  Drop them from the disk scan explicitly (by rel,
  // so a fresh clone and a dev machine hash identically) and re-add them via
  // extraFiles below — this also prevents double-hashing a file that exists
  // both on disk and in extraFiles.
  const extraRels = new Set(extraFiles.map(e => e.rel));
  const files = getAllFiles(dirPath, patterns, dirPath)
    .map(f => path.relative(dirPath, f).replace(/\\/g, '/'))
    .filter(rel => !extraRels.has(rel));
  const sorted = [
    ...files.map(rel => ({relative: rel, fullPath: path.join(dirPath, rel)})),
    ...extraFiles.map(e => ({relative: e.rel, fullPath: e.absPath})),
  ].sort((a, b) => a.relative.localeCompare(b.relative));

  const hash = crypto.createHash('sha256');

  for (const {relative, fullPath} of sorted) {
    hash.update(relative + '\n');
    hash.update(fs.readFileSync(fullPath));
  }

  return {hash: hash.digest('hex'), files: sorted.map(f => f.relative)};
}

/**
 * Collect a directory's gitignore-filtered files as labeled hash entries.
 * `prefix` is prepended to each relative path so files from multiple roots can
 * be hashed together without collisions.
 *
 * `exclude` (optional) drops files by their baseDir-relative path — used to
 * skip the generated _config.h / resources.h in the installer hash so the
 * result is deterministic whether or not they exist on disk (they are build
 * products; their true sources are hashed instead).
 */
export function collectDirEntries(dirPath, patterns, prefix, baseDir = dirPath, exclude = []) {
  const ex = new Set(exclude);
  return getAllFiles(dirPath, patterns, baseDir)
    .filter(f => !ex.has(path.relative(baseDir, f).replace(/\\/g, '/')))
    .map(f => ({
      rel: `${prefix}/${path.relative(baseDir, f).replace(/\\/g, '/')}`,
      absPath: f,
    }));
}

/**
 * Compute a sha256 hash over an explicit, labeled set of files (see
 * collectDirEntries). Files are sorted by label for determinism.
 *
 * Used for the installer binary hash, whose inputs span installer/src,
 * installer/web and config/installer.conf — the generated _config.h /
 * resources.h are gitignored build products (regenerated on demand) and are
 * represented here by their true sources instead, so any UI/config change still
 * bumps the installer hash and triggers a rebuild.
 */
export function computeFileSetHash(entries) {
  const sorted = [...entries].sort((a, b) => a.rel.localeCompare(b.rel));
  const hash = crypto.createHash('sha256');
  for (const {rel, absPath} of sorted) {
    hash.update(rel + '\n');
    hash.update(fs.readFileSync(absPath));
  }
  return {hash: hash.digest('hex'), files: sorted.map(e => e.rel)};
}

/** Read the manifest from the gh-pages branch of the firefox-scripts repo. */
async function readFromPages() {
  const token = getGistToken();
  if (!token) {
    warn(`${GITHUB_TOKEN_VAR} not set, treating all hashes as new`);
    return null;
  }

  const octokit = createOctokit(token);
  try {
    const {data} = await octokit.repos.getContent({
      owner: REPO_OWNER,
      repo: ZIP_PAGES_REPO,
      path: HASHES_FILE,
      ref: ZIP_PAGES_BRANCH,
    });
    return Buffer.from(data.content, 'base64').toString('utf-8');
  } catch (error) {
    if (error.status === 404) {
      warn(`${ZIP_PAGES_REPO}@${ZIP_PAGES_BRANCH} has no ${HASHES_FILE} yet, starting fresh`);
      return null;
    }
    throw error;
  }
}

/**
 * Read the last known local snapshot (the local-mode change-detection baseline,
 * taken from the newest completed snapshot dir).
 */
function readLocalSnapshot() {
  const dir = findLatestSnapshot();
  if (!dir) return null;
  try {
    return fs.readFileSync(path.join(dir, HASHES_FILE), 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Get stored hashes from the gh-pages branch (or, in local mode, the local
 * snapshot).
 *
 * @param {object} [options]
 * @param {boolean} [options.localOnly=false] - Read only the last local
 *   snapshot and never hit the network (upload:local). A real publish run must
 *   NOT do this: a matching local snapshot would suppress the first publish and
 *   the manifest would never be created on gh-pages. A missing remote manifest
 *   in a real run means "fresh" — publish everything. Default is `false`
 */
export async function getStoredHashes({localOnly = false} = {}) {
  const remote = localOnly ? null : await readFromPages();
  const text = remote ?? (localOnly ? readLocalSnapshot() : null);
  if (text == null) return {};
  try {
    return JSON.parse(text);
  } catch {
    warn(`${HASHES_FILE} on Pages is not valid JSON, starting fresh`);
    return {};
  }
}
