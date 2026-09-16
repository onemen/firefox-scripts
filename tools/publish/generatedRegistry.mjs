#!/usr/bin/env node

/**
 * generatedRegistry.mjs — the single list of this repo's four generated files
 * and how they enter the publish hashes and the zips (ADR 0008: generated files
 * are untracked, so the publish hashes must cover their TRUE sources — see the
 * ADR's stated trap: adding/removing a generated file without updating the hash
 * inputs silently stops updates propagating).
 *
 * This module is the ONE authoritative registry. Before it existed, that
 * mapping lived as parallel hand-maintained literals in three modules
 * (syncGeneratedFiles.mjs GENERATED/PREVIEW, upload.mjs
 * GENERATED_UPDATER_CONFIG/GENERATED_UI_CSS/HASH_EXCLUDE/collectDirEntries
 * exclude list) — exactly the hand-maintained coupling ADR 0008 warns about,
 * and the reason the 2026-09-15 audit asked for a registry ↔ hash-inputs test.
 * The test/unit/generatedRegistry.test.mjs assertions now mechanically close
 * the trap:
 *
 * 1. every {rel, absPath} entry the publish hashing adds back (extraFiles) is a
 *    registry `ships: true` file's rel inside its package root;
 * 2. every registry file that ships in a package is either hashed with the package
 *    or — for build products that must NOT be hashed — is excluded from the
 *    installer hash's collectDirEntries list;
 * 3. every gitignored generated file is excluded from every package's gitignore
 *    scan (so no double-hash) via upload.mjs's per-package HASH_EXCLUDE list;
 * 4. every zip-entry extraFile (createZip re-add after gitignore) matches the hash
 *    extraFiles for the same package (zip content = manifest list);
 * 5. the two hash-side rel labels used by the installer-fileset hash match the
 *    registry's declared labels.
 *
 * Dependency-free by design: syncGeneratedFiles.mjs (which the installer
 * Makefile runs with MODE=dev) imports this module, and the Makefile also
 * invokes syncGeneratedFiles with --touch; neither path may pull in
 * paths.js/publishMode beyond what already loads. The module only reads its own
 * constants — no fs, no git, no argv — so importing it can never write or
 * regenerate anything.
 */

import path from 'path';
import {fileURLToPath} from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Repo root (tools/publish/..). */
export const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** One generated file. See the module docblock for the field meanings. */
export const GENERATED_FILES = [
  {
    rel: 'core/chrome/utils/updater/updater-config.sys.mjs',
    generatedBy: 'generateUpdaterConfig.mjs (from config/installer.conf)',
    // Ships inside utils.zip at its own rel (updater/updater-config.sys.mjs
    // relative to the utils root core/chrome/utils), so the utils hash adds it
    // back explicitly: its true source is config/installer.conf.
    shipsIn: {utils: 'updater/updater-config.sys.mjs'},
  },
  {
    rel: 'tools/publish/remote-ui/updater.css',
    generatedBy: 'buildRemoteUiCss() (from installer/web/style.css + tools/publish/updater.css)',
    // Ships inside updater-ui.zip at the UI root (updater.css relative to
    // tools/publish/remote-ui).
    shipsIn: {'updater-ui': 'updater.css'},
  },
  {
    rel: 'installer/src/_config.h',
    generatedBy: 'configHeader() (from config/installer.conf)',
    // Build product of the installer Makefile — never hashed; the installer
    // hash covers its true source config/installer.conf instead. It must be
    // excluded from the installer hash's collectDirEntries list, and (already
    // gitignored) from the zip gitignore scans.
    shipsIn: {},
  },
  {
    rel: 'installer/src/resources.h',
    generatedBy: 'installer/embed.mjs (from installer/web/*)',
    shipsIn: {},
  },
];

/**
 * Gitignored files that must be dropped from the package gitignore scans (hash
 *
 * - zip alike): the generated files that live INSIDE package source trees.
 *   Without the exclusion, a gitignore-filtered scan would double-hash a
 *   generated file that extraFiles re-adds (hashUtils.computeDirectoryHash
 *   guards against this too, by rel). Keys are package names; rels are relative
 *   to each package's source root (util root / remote-ui root).
 */
export const PACKAGE_SCAN_EXCLUDE = {
  'utils': ['updater/updater-config.sys.mjs'],
  'updater-ui': ['updater.css'],
  'fx-folder': [],
};

/**
 * The installer binary's hash inputs must EXCLUDE the generated headers (they
 * are build products; their sources — installer.conf, installer/web/* — are
 * hashed instead). Single source for upload.mjs's collectDirEntries exclude
 * list.
 */
export const INSTALLER_HASH_EXCLUDE = ['_config.h', 'resources.h'];

/**
 * Obsolete files: excluded from zips and from the published hash / manifest
 * `files` list so the zip content always equals the canonical list (the
 * installer removes historically installed copies —
 * installer/src/obsolete_files.h).
 */
export const OBSOLETE_FILES = ['versionInfo.json'];

/** Package names and their source roots (upload.mjs's PACKAGES). */
export const PACKAGE_ROOTS = {
  'utils': 'core/chrome/utils',
  'fx-folder': 'core/fx-folder',
  'updater-ui': 'tools/publish/remote-ui',
};

/** Absolute path of a generated file (or of any repo-root-relative rel). */
export function generatedPath(rel) {
  return path.join(REPO_ROOT, rel);
}

/** Absolute path of a package's source root. */
export function packageRoot(name) {
  const rel = PACKAGE_ROOTS[name];
  if (!rel)
    throw new Error(
      `Unknown package '${name}' (expected ${Object.keys(PACKAGE_ROOTS).join(', ')})`
    );
  return generatedPath(rel);
}

/**
 * The hash extraFiles ({rel, absPath}) for a package: one entry per generated
 * file that ships in that package. `rel` is the zip/manifest rel INSIDE the
 * package; the same array is passed to createZip (zip re-add) and to
 * computeDirectoryHash (hash re-add), so the zip content and the canonical
 * `files` list can never diverge.
 *
 * @param {string} name package name
 * @returns {{rel: string; absPath: string}[]}
 */
export function packageExtraFiles(name) {
  return Object.entries(GENERATED_FILES)
    .map(([, file]) => file)
    .filter(file => name in file.shipsIn)
    .map(file => ({rel: file.shipsIn[name], absPath: generatedPath(file.rel)}));
}

/** All files a package ships: the gitignore-filtered scan plus the extraFiles. */
export function packageShipsFiles(name) {
  return packageExtraFiles(name).map(e => e.rel);
}
