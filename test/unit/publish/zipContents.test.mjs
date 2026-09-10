// test/unit/publish/zipContents.test.mjs — Publish integration test (issue
// #133, Part of #3): opens each produced package zip with a read-only
// central-directory reader and asserts its entries match
// `computeDirectoryHash().files` EXACTLY.
//
// Catches packaging drift the rest of the unit suite cannot see: a file
// present in the directory but missing from the zip (gitignore pattern
// mismatch, wrong extraFiles), an extra/stale zip entry, or a prefix/layout
// regression. The invariant — zip content == canonical manifest `files` list —
// is what the installer and updater hash against (ADR 0002).
//
// The reader is `test/shared/zipReader.mjs` (pure Node, parses the central
// directory directly) rather than the yauzl devDep the audit suggested: same
// read-only guarantee, zero new dependencies. The zips are built here through
// the REAL pipeline — the same createZip + loadSharedPatterns calls
// upload.mjs's buildPackages makes — into a temp dir, so the test runs in the
// plain unit suite (no dist/ snapshot, no network) and exercises the true
// packaging path, including the regenerated generated files.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// paths.js calls requireMode() at import time — same arrangement as
// createZip.test.mjs. Importing createZip.mjs also regenerates the gitignored
// generated files (updater-config.sys.mjs, updater.css) — a no-op write when
// they are already in sync.
process.argv.push('--mode=prod');

const {createZip, zipPrefixFor} = await import('../../../tools/publish/createZip.mjs');
const {computeDirectoryHash} = await import('../../../tools/publish/hashUtils.mjs');
const {loadSharedPatterns} = await import('../../../tools/publish/publishCommon.mjs');
const {PROFILE_PATH, REMOTE_UI_DIR} = await import('../../../tools/publish/paths.js');
const {listZipEntries} = await import('../../shared/zipReader.mjs');

const FX_FOLDER_SOURCE = path.join(PROFILE_PATH, 'fx-folder');
const UTILS_SOURCE = path.join(PROFILE_PATH, 'chrome', 'utils');

// Mirrors upload.mjs exactly: the package list, the generated extraFiles that
// ship despite being gitignored, and the obsolete-file exclusion shared by the
// zip and the hash (so the two can never disagree about it).
const PACKAGES = [
  {name: 'utils', dir: UTILS_SOURCE},
  {name: 'fx-folder', dir: FX_FOLDER_SOURCE},
  {name: 'updater-ui', dir: REMOTE_UI_DIR},
];
const GENERATED_UPDATER_CONFIG = {
  rel: 'updater/updater-config.sys.mjs',
  absPath: path.join(UTILS_SOURCE, 'updater', 'updater-config.sys.mjs'),
};
const GENERATED_UI_CSS = {
  rel: 'updater.css',
  absPath: path.join(REMOTE_UI_DIR, 'updater.css'),
};
const HASH_EXCLUDE = ['versionInfo.json'];

for (const {name, dir} of PACKAGES) {
  test(`zip central directory matches the manifest files list: ${name}`, async () => {
    const extraFiles =
      name === 'utils' ? [GENERATED_UPDATER_CONFIG]
      : name === 'updater-ui' ? [GENERATED_UI_CSS]
      : [];

    // The exact pattern sets buildPackages passes: the zip walks the shared
    // patterns unfiltered, the hash additionally excludes obsolete files.
    const zipPatterns = loadSharedPatterns(FX_FOLDER_SOURCE, []);
    const hashPatterns = loadSharedPatterns(FX_FOLDER_SOURCE, HASH_EXCLUDE);
    const {files} = computeDirectoryHash(dir, hashPatterns, extraFiles);

    // Build the package through the real pipeline into a temp dir.
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), `zip-contents-${name}-`));
    try {
      const zipPath = path.join(outDir, `${name}.zip`);
      await createZip(
        dir,
        zipPath,
        zipPatterns,
        zipPrefixFor(name),
        extraFiles.map(f => f.rel)
      );

      const entries = listZipEntries(fs.readFileSync(zipPath)).map(e => e.name);
      const prefix = zipPrefixFor(name);
      const stripped =
        prefix ?
          entries.map(n => {
            assert.ok(
              n === `${prefix}/` || n.startsWith(`${prefix}/`),
              `entry outside the ${prefix}/ prefix: ${n}`
            );
            return n === `${prefix}/` ? '' : n.slice(prefix.length + 1);
          })
        : entries;

      // No duplicates: a doubled entry renders as two files after extraction
      // and would break the installed-dir hash.
      const dupes = stripped.filter((n, i) => stripped.indexOf(n) !== i);
      assert.deepEqual(dupes, [], 'duplicate zip entries');

      // The invariant: central directory == canonical files list, exactly.
      assert.deepEqual(
        [...stripped].sort(),
        [...files].sort(),
        'zip central directory must match computeDirectoryHash().files exactly'
      );
    } finally {
      fs.rmSync(outDir, {recursive: true, force: true});
    }
  });
}
