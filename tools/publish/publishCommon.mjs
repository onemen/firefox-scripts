#!/usr/bin/env node

// Helpers shared by the publish scripts (upload.mjs): publish-mode gating,
// GitHub token access, git-derived commit dates, and gitignore pattern loading.

import {execSync} from 'child_process';
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
import {Octokit} from '@octokit/rest';
import {loadAllGitignorePatterns, getAllFiles} from './gitignoreUtils.mjs';
import {GITHUB_TOKEN_VAR, PUBLISH_MODE} from './paths.js';
import {detail} from './log.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const REPO_ROOT = path.resolve(__dirname, '..', '..');
const REPO_GITIGNORE = path.join(REPO_ROOT, '.gitignore');

export function getGitHubToken() {
  return process.env[GITHUB_TOKEN_VAR] || '';
}

// @octokit/rest ships a request-log plugin that prints one line per API call
// ("GET /repos/… - 200 with id … in 123ms"). It fires on every request and is
// noise for a CLI publish tool — the scripts already log their own, intented
// messages. Silence it here so all callers construct a quiet client.
const noLog = () => {};

/** Build an Octokit client whose per-request telemetry is suppressed. */
export function createOctokit(token) {
  return new Octokit({auth: token, log: {debug: noLog, info: noLog, warn: noLog, error: noLog}});
}

/**
 * Last commit date (YYYY-MM-DD) touching any of the hashed files under `dir`,
 * used as the manifest's `date` field. Falls back to today when the dir has no
 * files or git cannot be consulted.
 */
export function getLatestCommitDate(dir, patterns) {
  try {
    const files = getAllFiles(dir, patterns, dir);
    if (files.length === 0) {
      return new Date().toISOString().split('T')[0];
    }

    const relativePaths = files
      .map(f => path.relative(REPO_ROOT, f).replace(/\\/g, '/'))
      .join('\n');

    const date = execSync(
      `git log -1 --format=%as -- ${relativePaths
        .split('\n')
        .map(p => `"${p}"`)
        .join(' ')}`,
      {
        encoding: 'utf-8',
        cwd: REPO_ROOT,
      }
    ).trim();
    return date;
  } catch {
    return new Date().toISOString().split('T')[0];
  }
}

// Both publish scripts call loadSharedPatterns twice (zip + hash variants,
// installer + helper variants); the "Loading gitignore files" block must print
// once, not per call.
/** Loading gitignore files usually prints; make it print once. */
let gitignorePrinted = false;

/** Load the repo's root .gitignore plus any custom patterns. */
export function loadSharedPatterns(sourceDir, customPatterns) {
  const gitignoreFiles = [];
  if (fs.existsSync(REPO_GITIGNORE)) gitignoreFiles.push(REPO_GITIGNORE);

  const patterns = loadAllGitignorePatterns(sourceDir, gitignoreFiles, customPatterns);

  if (!gitignorePrinted) {
    gitignorePrinted = true;
    if (gitignoreFiles.length > 0) {
      detail('Loading gitignore files:');
      for (const f of gitignoreFiles) {
        if (fs.existsSync(f)) detail(`  ✓ ${f}`);
      }
      detail(`Total patterns: ${patterns.length}`);
    }
  }
  return patterns;
}

/**
 * Fail fast when a prod publish runs off 'main'. --mode=prod → latest release
 *
 * - gh-pages are the authoritative, user-facing artifacts and must ONLY be
 *   written from the main branch — there is no --branch escape hatch any more.
 *   dev mode is exempt: a dev-build-<id> branch is disposable and isolated.
 *   Enabled only when the run actually publishes (not local snapshots).
 */
export function enforcePublishBranch({enabled}) {
  if (!enabled) return;
  if (PUBLISH_MODE === 'dev') return;

  let branch;
  try {
    branch = execSync('git rev-parse --abbrev-ref HEAD', {
      encoding: 'utf-8',
      cwd: REPO_ROOT,
    }).trim();
  } catch {
    branch = '(unknown)';
  }
  if (branch === 'HEAD') {
    throw new Error(`Detached HEAD — --mode=prod requires branch 'main'. Checkout 'main'.`);
  }
  if (branch !== 'main') {
    throw new Error(
      `--mode=prod only publishes from 'main', but HEAD is on '${branch}'. ` +
        `Use --mode=dev for disposable dev-build-<id> deploys from any branch.`
    );
  }
}
