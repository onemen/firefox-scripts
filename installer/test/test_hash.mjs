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
 * The canonical `files` list per package comes from the newest snapshot's
 * manifest (dist/prod-<branch>-<hash>/ or dist/dev-<branch>-<hash>/hashes.json,
 * either mode works — the file set is identical). If none exists it is
 * generated via `upload:local --mode=prod` (which writes one without touching
 * GitHub), so the test always reflects the current source set.
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
import os from 'os';
import path from 'path';
import {fileURLToPath} from 'url';

// publishCommon/paths.mjs (in both import chains below) demand a --mode at
// import time; the branch-agnostic prod default matches the reference
// implementation the C twin is cross-checked against. Same pattern as the
// test/unit zip tests. Static imports would hoist above this push and crash,
// so both are dynamic.
process.argv.push('--mode=prod');
const [{generateModule, readConfig}, {compareCaseInsensitive, computeFileSetHash}] =
  await Promise.all([
    import('../../tools/publish/generateUpdaterConfig.mjs'),
    import('../../tools/publish/hashUtils.mjs'),
  ]);

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

/** Newest prod- or dev- snapshot dir with a manifest (either mode works). */
function findSnapshot() {
  const distRoot = path.join(REPO_ROOT, 'dist');
  if (!fs.existsSync(distRoot)) return null;
  let best = null;
  let bestMtime = 0;
  for (const entry of fs.readdirSync(distRoot, {withFileTypes: true})) {
    if (!entry.isDirectory() || !/^(prod|dev)-/.test(entry.name)) continue;
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
  else name = process.arch === 'arm64' ? 'installer_linux_aarch64' : 'installer_linux';
  // Dev snapshots name binaries installer_win-dev.exe; prod keeps the plain
  // name.  Accept either so a dev snapshot from CI's publish gate works.
  const plain = path.join(snapshotDir, `${name}${ext}`);
  if (fs.existsSync(plain)) return plain;
  return path.join(snapshotDir, `${name}-dev${ext}`);
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
  // The --mode=prod pushed above for the publish-chain imports is not a
  // positional argument of this test.
  const args = process.argv.slice(2).filter(a => !a.startsWith('--mode='));

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

  allPassed = adversarialComparatorProbe(INSTALLER) && allPassed;

  process.exit(allPassed ? 0 : 1);
}

/**
 * Adversarial-path parity probe: pin the hash-order contract between the C
 * comparator (cmp_path_ci in detect_browser.c) and the JS one
 * (compareCaseInsensitive in tools/publish/hashUtils.mjs) on paths where naive
 * sort orders disagree — case adjacency, digit vs letter, '_'/'-'/'.'/ ' ~'
 * punctuation, extension shells, and the case-collision pairs that are
 * order-stable only under a total comparator. Sorted orders must match
 * element-for-element, and the C hash of a synthetic tree must equal the JS
 * hash of the same tree byte-for-byte.
 */
function adversarialComparatorProbe(installerBinary) {
  let ok = true;

  // 1. Order parity on adversarial pairs (JS comparator only — pure ordering).
  const pairs = [
    ['A.txt', 'a.txt'], // folds equal — the raw-byte tie-break must order this
    ['AB.js', 'Ab.js'],
    ['A.txt', 'a!.txt'],
    ['Beta.js', 'alpha.js'],
    ['file_1.txt', 'file-1.txt'],
    ['file.txt', 'file.txt.bak'],
    ['config2.js', 'config10.js'],
    ['config.js', 'configX.js'],
    ['Zebra.js', 'apple.js'],
    ['utils.d.ts', 'utils.js'],
    ['x.js', 'x~.js'],
    ['ARM/', 'a.txt'],
    ['b/', 'B.txt'],
  ];
  let orderMismatches = 0;
  for (const [p1, p2] of pairs) {
    const a = [p1, p2].sort(compareCaseInsensitive);
    const b = [p2, p1].sort(compareCaseInsensitive);
    if (a[0] !== b[0] || a[1] !== b[1]) {
      console.error(
        `FAIL comparator: not order-stable for ${JSON.stringify(p1)} vs ${JSON.stringify(p2)}`
      );
      orderMismatches++;
    }
  }
  if (orderMismatches > 0) {
    console.error(`FAIL comparator: ${orderMismatches}/${pairs.length} adversarial pairs unstable`);
    ok = false;
  } else {
    console.log(`PASS comparator: ${pairs.length}/${pairs.length} adversarial pairs order-stable`);
  }

  // 2. Byte-parity on a synthetic adversarial tree: C hash must equal JS hash.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-'));
  const rels = [
    'B.txt',
    'a!.txt',
    'A.txt',
    'a.txt',
    'b/c.d.ts',
    'b/c.js',
    'B/d.txt',
    'config2.js',
    'config10.js',
    'Zebra.js',
    'apple.js',
    'x~.js',
    'x.js',
  ];
  const contents = {
    'B.txt': 'bravo',
    'a!.txt': 'alpha bang',
    'A.txt': 'alpha upper',
    'a.txt': 'alpha lower',
    'b/c.d.ts': 'declaration',
    'b/c.js': 'script',
    'B/d.txt': 'bravo dir',
    'config2.js': 'two',
    'config10.js': 'ten',
    'Zebra.js': 'zebra',
    'apple.js': 'apple',
    'x~.js': 'tilde',
    'x.js': 'plain',
  };
  try {
    for (const rel of rels) {
      const abs = path.join(tmp, ...rel.split('/'));
      fs.mkdirSync(path.dirname(abs), {recursive: true});
      fs.writeFileSync(abs, contents[rel]);
    }
    const entries = rels.map(rel => ({rel, absPath: path.join(tmp, ...rel.split('/'))}));
    const {hash: jsHash} = computeFileSetHash(entries);

    // C side: drive --test-hash with a minimal manifest whose files list is
    // exactly the synthetic rels (shuffled in the manifest; the sort must
    // normalize both sides regardless of input order).
    const shuffled = [...rels];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = (i * 7 + 3) % (i + 1); // deterministic shuffle
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const manifestPath = path.join(tmp, 'probe-manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({utils: {hash: '', date: '', files: shuffled}}));
    const cHash = execSync(
      `"${installerBinary}" --test-hash utils "${tmp}" --manifest "${manifestPath}"`,
      {
        encoding: 'utf-8',
      }
    ).trim();
    if (jsHash !== cHash) {
      console.error(`FAIL comparator: C=${cHash} != JS=${jsHash} on adversarial tree`);
      ok = false;
    } else {
      console.log(`PASS comparator: C hash == JS hash on ${rels.length}-file adversarial tree`);
    }
  } finally {
    fs.rmSync(tmp, {recursive: true, force: true});
  }
  return ok;
}

main();
