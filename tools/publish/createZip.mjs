#!/usr/bin/env node

import {ZipArchive} from 'archiver';
import fs, {createWriteStream} from 'fs';
import path from 'path';
import {getAllFiles, loadAllGitignorePatterns as loadPatterns} from './gitignoreUtils.mjs';
import {PROFILE_PATH, REMOTE_UI_DIR, SCRIPTS_DIST} from './paths.js';
import {detail, success} from './log.mjs';
import {
  generateModule as generateUpdaterConfig,
  readConfig as readUpdaterConfig,
} from './generateUpdaterConfig.mjs';
import {buildRemoteUiCss} from './syncGeneratedFiles.mjs';

// Regenerate the in-browser updater's config from config/installer.conf so the
// zips always ship URLs/paths that match the current installer.conf.
{
  const config = readUpdaterConfig();
  const generated = generateUpdaterConfig(config);
  const target = path.join(PROFILE_PATH, 'chrome', 'utils', 'updater', 'updater-config.sys.mjs');
  if (!fs.existsSync(target) || fs.readFileSync(target, 'utf-8') !== generated) {
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.writeFileSync(target, generated);
    console.log('✓ Regenerated updater-config.sys.mjs from installer.conf');
  }
}

// Regenerate the updater tab stylesheet (installer/web/style.css + the
// updater-only tail) so updater-ui.zip ships the current CSS.  The file is
// gitignored; the zip and manifest hash add it back explicitly (extraFiles).
{
  const css = buildRemoteUiCss();
  const cssPath = path.join(REMOTE_UI_DIR, 'updater.css');
  if (!fs.existsSync(cssPath) || fs.readFileSync(cssPath, 'utf-8') !== css) {
    fs.writeFileSync(cssPath, css);
    console.log('✓ Regenerated remote-ui/updater.css');
  }
}

/**
 * Zip creation helpers — library only, driven by upload.mjs. On import this
 * module also regenerates the two generated files that ship inside the zips
 * (updater-config.sys.mjs into utils.zip, updater.css into updater-ui.zip) so
 * the zips always ship in sync with installer.conf / the shared stylesheet.
 */

const OUTPUT_DIR = SCRIPTS_DIST;

const FX_FOLDER_SOURCE = path.join(PROFILE_PATH, 'fx-folder');
const UTILS_SOURCE = path.join(PROFILE_PATH, 'chrome', 'utils');
const CHROME_DIR = path.join(UTILS_SOURCE, '..');
const CHROME_GITIGNORE = path.join(CHROME_DIR, '.gitignore');
const UTILS_GITIGNORE = path.join(UTILS_SOURCE, '.gitignore');
const FX_FOLDER_GITIGNORE = path.join(FX_FOLDER_SOURCE, '.gitignore');

// Obsolete file: versionInfo.json previously shipped (consumed by an
// update-checker outside this project) and no longer does.  The pattern also
// guards against reintroduction; historically-installed copies are cleaned by
// installer/src/obsolete_files.h after install.
const CUSTOM_IGNORE_PATTERNS = ['versionInfo.json'];

/** Load gitignore patterns for a given source directory */
export function loadAllGitignorePatterns(sourceDir) {
  const gitignoreFiles = [];

  if (sourceDir === UTILS_SOURCE) {
    if (fs.existsSync(CHROME_GITIGNORE)) gitignoreFiles.push(CHROME_GITIGNORE);
    if (fs.existsSync(UTILS_GITIGNORE)) gitignoreFiles.push(UTILS_GITIGNORE);
  } else if (sourceDir === FX_FOLDER_SOURCE) {
    if (fs.existsSync(FX_FOLDER_GITIGNORE)) gitignoreFiles.push(FX_FOLDER_GITIGNORE);
  }

  if (gitignoreFiles.length > 0) {
    console.log('Loading gitignore files:');
    for (const f of gitignoreFiles) {
      if (fs.existsSync(f)) console.log(`  ✓ ${f}`);
    }
  }

  const patterns = loadPatterns(sourceDir, gitignoreFiles, CUSTOM_IGNORE_PATTERNS);
  console.log(`\nTotal patterns: ${patterns.length}\n`);
  return patterns;
}

/**
 * Zip prefix for a package. fx-folder.zip wraps its files under a top-level
 * 'fx-folder' directory so a manual download unzips into an fx-folder folder
 * (how it has worked for years); utils.zip and updater-ui.zip stay flat.
 */
export function zipPrefixFor(name) {
  return name === 'fx-folder' ? 'fx-folder' : null;
}

/**
 * Create the zip file
 *
 * @param {string[]} [extraFiles] - relative paths to add back after gitignore
 *   filtering (e.g. 'updater/updater-config.sys.mjs' for utils — the generated
 *   updater config is untracked/gitignored but MUST ship inside utils.zip and
 *   appear in the manifest `files` list so the hash check stays consistent).
 */
export async function createZip(sourceDir, outputPath, patterns, prefix = null, extraFiles = []) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(OUTPUT_DIR)) {
      fs.mkdirSync(OUTPUT_DIR, {recursive: true});
    }

    const files = getAllFiles(sourceDir, patterns, sourceDir);
    for (const rel of extraFiles) {
      const p = path.join(sourceDir, rel);
      if (fs.existsSync(p) && !files.includes(p)) {
        files.push(p);
      }
    }

    detail(`Found ${files.length} files to zip:`);
    for (const file of files) {
      const relativePath = path.relative(sourceDir, file).replace(/\\/g, '/');
      detail(`  • ${prefix ? prefix + '/' + relativePath : relativePath}`);
    }

    const output = createWriteStream(outputPath);
    const archive = new ZipArchive('zip', {zlib: {level: 9}});

    output.on('close', () => {
      const size = (archive.pointer() / 1024).toFixed(1);
      success(`  ✓ ${path.basename(outputPath)}  ${files.length} files, ${size} KB`);
      resolve();
    });

    archive.on('error', reject);
    output.on('error', reject);

    archive.pipe(output);

    for (const file of files) {
      const relativePath = path.relative(sourceDir, file).replace(/\\/g, '/');
      archive.file(file, {name: prefix ? `${prefix}/${relativePath}` : relativePath});
    }

    archive.finalize();
  });
}
