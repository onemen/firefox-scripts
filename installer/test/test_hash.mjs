#!/usr/bin/env node

/**
 * test_hash.mjs — Verify that the C installer's hash computation matches the JS
 * reference algorithm (from tools/publish/hashUtils.mjs).
 *
 * Usage (from repo root): node installer/test/test_hash.mjs [utils_dir]
 * [fx-folder_dir]
 *
 * If no directories are given, defaults to: core/chrome/utils core/fx-folder
 *
 * The canonical `files` list per package comes from the newest prod-*
 * snapshot's manifest (dist/prod-<branch>-<hash>/hashes.json). If none exists
 * it is generated via `upload:local --mode=prod` (which writes one without
 * touching GitHub), so the test always reflects the current source set.
 *
 * This test does NOT depend on @octokit/rest (only available in the publish
 * environment). It replicates the core hash algorithm inline.
 *
 * Hash algorithm: For each file (sorted by relative path, case-insensitive):
 * hash.update(relative_path + "\n") hash.update(file_contents)
 *
 * Exit code: 0 if all tests pass, 1 if any fail.
 */

import {execSync} from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
import {generateModule, readConfig} from '../../tools/publish/generateUpdaterConfig.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Compute SHA256 hash matching the reference algorithm.
 *
 * @param {string} dirPath - Absolute path to the directory containing the files
 * @param {string[]} relFiles - Relative paths of files to hash
 * @returns {string} Hex-encoded SHA256 digest
 */
function computeDirectoryHash(dirPath, relFiles) {
  const sorted = [...relFiles].sort((a, b) => a.localeCompare(b));
  const hash = crypto.createHash('sha256');
  for (const rel of sorted) {
    hash.update(rel + '\n');
    hash.update(fs.readFileSync(path.join(dirPath, rel)));
  }
  return hash.digest('hex');
}

/** Newest prod-* snapshot dir (dist/prod-<branch>-<hash>/) with a manifest. */
function findSnapshot() {
  const distRoot = path.join(REPO_ROOT, 'dist');
  if (!fs.existsSync(distRoot)) return null;
  let best = null;
  let bestMtime = 0;
  for (const entry of fs.readdirSync(distRoot, {withFileTypes: true})) {
    if (!entry.isDirectory() || !entry.name.startsWith('prod-')) continue;
    const dir = path.join(distRoot, entry.name);
    if (!fs.existsSync(path.join(dir, 'hashes.json'))) continue;
    const mtime = fs.statSync(dir).mtimeMs;
    if (mtime > bestMtime) {
      bestMtime = mtime;
      best = dir;
    }
  }
  return best;
}

/** Resolve a prod snapshot, generating one via upload:local when none exists. */
function requireSnapshot() {
  let dir = findSnapshot();
  if (!dir) {
    console.log('No prod snapshot found — generating via upload:local...');
    execSync('node tools/publish/upload.mjs --local --mode=prod', {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    });
    dir = findSnapshot();
  }
  if (!dir) {
    console.error('Failed to find or generate a prod-* snapshot under dist/');
    process.exit(1);
  }
  return dir;
}

function getInstallerPath(snapshotDir) {
  const ext = process.platform === 'win32' ? '.exe' : '';
  let name;
  if (process.platform === 'win32') name = 'installer_win';
  else if (process.platform === 'darwin') name = 'installer_mac';
  else name = 'installer_linux';
  return path.join(snapshotDir, `${name}${ext}`);
}

/** Read the canonical `files` list for a package from the snapshot manifest. */
function getManifestFiles(type, snapshotDir) {
  const manifestPath = path.join(snapshotDir, 'hashes.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  const files = manifest[type]?.files;
  if (!Array.isArray(files) || files.length === 0) {
    console.error(`Manifest has no 'files' list for package '${type}'`);
    process.exit(1);
  }
  return files;
}

const TESTS = [
  {type: 'utils', dir: 'core/chrome/utils'},
  {type: 'fx-folder', dir: 'core/fx-folder'},
];

function main() {
  const args = process.argv.slice(2);

  // Accept zero or two positional arguments
  if (args.length === 2) {
    TESTS[0].dir = args[0];
    TESTS[1].dir = args[1];
  } else if (args.length !== 0) {
    console.error('Usage: node installer/test/test_hash.mjs [utils_dir fx-folder_dir]');
    process.exit(1);
  }

  const snapshotDir = requireSnapshot();
  const MANIFEST_PATH = path.join(snapshotDir, 'hashes.json');
  const INSTALLER = getInstallerPath(snapshotDir);

  // The utils `files` list includes the generated updater-config.sys.mjs, which
  // upload.mjs deletes at the end of its run. Regenerate it (prod, matching
  // the manifest) so both the JS and C hashes can read it from disk.
  const updaterConfigPath = path.join(
    REPO_ROOT,
    'core',
    'chrome',
    'utils',
    'updater',
    'updater-config.sys.mjs'
  );
  fs.mkdirSync(path.dirname(updaterConfigPath), {recursive: true});
  fs.writeFileSync(updaterConfigPath, generateModule(readConfig()));

  // Verify the C installer binary exists
  if (!fs.existsSync(INSTALLER)) {
    console.error(`C installer not found at ${INSTALLER}`);
    console.error('Run `node tools/publish/upload.mjs --local --mode=prod` first.');
    process.exit(1);
  }

  let allPassed = true;

  for (const {type, dir} of TESTS) {
    const absDir = path.resolve(dir);
    const files = getManifestFiles(type, snapshotDir);

    if (!fs.existsSync(absDir)) {
      console.error(`FAIL ${type}: directory not found "${absDir}"`);
      allPassed = false;
      continue;
    }

    // Compute JS hash
    let jsHash, cHash;
    try {
      jsHash = computeDirectoryHash(absDir, files);
    } catch (e) {
      console.error(`FAIL ${type}: JS hash computation error: ${e.message}`);
      allPassed = false;
      continue;
    }

    // Compute C hash
    try {
      cHash = execSync(
        `"${INSTALLER}" --test-hash ${type} "${absDir}" --manifest "${MANIFEST_PATH}"`,
        {encoding: 'utf-8'}
      ).trim();
    } catch (e) {
      console.error(`FAIL ${type}: C hash command failed: ${e.message}`);
      allPassed = false;
      continue;
    }

    const ok = jsHash === cHash;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${type} (${files.length} files): JS=${jsHash} C=${cHash}`);
    if (!ok) allPassed = false;
  }

  process.exit(allPassed ? 0 : 1);
}

main();
