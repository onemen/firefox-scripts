// installer/test/snapshotProvenance.mjs — shared snapshot-provenance guard for
// the binary-in-the-loop tests (2026-09-18 audit, finding T1).
//
// Both suites (test_hash.mjs, test_self_update.mjs) run whatever binary sits
// in the newest snapshot dir under dist/. A snapshot built from older sources
// turns every failure into a false report about `main` — and a stale binary
// that happens to agree proves nothing. hashes.json records the source-tree
// hash the installer was built from; this module recomputes it from the
// current sources and refuses to continue on drift.
//
// test_self_update.mjs carried this guard inline since the 2026-09-15 audit;
// the 2026-09-18 audit found test_hash.mjs had no such check (T1) — this
// module is the shared helper both now call.

import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';

const {computeFileSetHash, collectDirEntries} = await import(
  new URL('../../tools/publish/hashUtils.mjs', import.meta.url).href
);
const {loadSharedPatterns} = await import(
  new URL('../../tools/publish/publishCommon.mjs', import.meta.url).href
);
const {INSTALLER_HASH_EXCLUDE} = await import(
  new URL('../../tools/publish/generatedRegistry.mjs', import.meta.url).href
);

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * Recompute the installer's SOURCE-tree hash exactly the way the publish flow
 * does (upload.mjs buildBinaries): installer/src minus helper/ and the
 * generated build products (INSTALLER_HASH_EXCLUDE — the generated headers and
 * the script.built.js gate artifact), installer/web, config/installer.conf.
 *
 * @param {string} repoRoot absolute path to the repository root
 * @returns {string} hex-encoded SHA-256 of the installer source set
 */
export function computeInstallerSourceHash(repoRoot) {
  const installerSrc = path.join(repoRoot, 'installer', 'src');
  const installerWeb = path.join(repoRoot, 'installer', 'web');
  const srcPatterns = loadSharedPatterns(installerSrc, ['helper/**']);
  const webPatterns = loadSharedPatterns(installerWeb, []);
  return computeFileSetHash([
    ...collectDirEntries(
      installerSrc,
      srcPatterns,
      'installer',
      installerSrc,
      INSTALLER_HASH_EXCLUDE
    ),
    ...collectDirEntries(installerWeb, webPatterns, 'web'),
    {rel: 'config/installer.conf', absPath: path.join(repoRoot, 'config', 'installer.conf')},
  ]).hash;
}

/**
 * Refuse to run a binary-in-the-loop suite against a snapshot whose installer
 * was not built from the current sources. Exits the process with a clear
 * message on drift (fail-fast house pattern); prints a one-line confirmation
 * with the verified hash and build date when it passes.
 *
 * @param {{
 *   snapshotDir: string;
 *   repoRoot?: string;
 *   exit?: (code: number) => never;
 * }} opts
 *   snapshotDir is required; repoRoot defaults to this repo; `exit` is the
 *   injectable process.exit seam (unit tests must not kill the runner).
 * @returns {{
 *   sourceHash: string;
 *   storedHash: string | null;
 *   date: string | null;
 * }}
 *   the verified provenance, for the caller's log lines
 */
export function requireFreshSnapshot({
  snapshotDir,
  repoRoot = path.resolve(THIS_DIR, '../..'),
  exit = code => process.exit(code),
}) {
  const manifestPath = path.join(snapshotDir, 'hashes.json');
  let stored;
  try {
    stored = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    console.error(`Unreadable hashes.json in ${snapshotDir} — regenerate the snapshot.`);
    exit(1);
  }
  const storedHash = stored.installer?.hash ?? null;
  const sourceHash = computeInstallerSourceHash(repoRoot);
  if (storedHash !== sourceHash) {
    console.error(
      `STALE SNAPSHOT: ${snapshotDir}\n` +
        `  its installer was built from sources with hash ${storedHash ?? '(none recorded)'},\n` +
        `  but the current sources hash to           ${sourceHash}.\n` +
        `  (snapshot installer date: ${stored.installer?.date ?? 'unknown'})\n` +
        `Refusing to run the suite against binary provenance it cannot trust —\n` +
        `failures would misreport as regressions on main.\n` +
        `Regenerate: pnpm snapshot:prod   (or snapshot:dev for a local snapshot).`
    );
    exit(1);
  }
  console.log(
    `Snapshot provenance verified: installer built from current sources (${sourceHash.slice(0, 12)}, date ${stored.installer?.date ?? '?'})`
  );
  return {sourceHash, storedHash, date: stored.installer?.date ?? null};
}
