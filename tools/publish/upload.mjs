#!/usr/bin/env node

// tools/publish/upload.mjs — unified publish entry point.
//
// Replaces checkAndUpload.mjs + buildAndUpload.mjs with one command that checks
// source hashes, rebuilds what changed (always in --mode=dev), and publishes
// everything — the package zips (utils, fx-folder, updater-ui), the installer
// and helper binaries, and the hash manifest — to GitHub (release + Pages
// branch) or, with --local, to a complete snapshot under
// dist/<mode>-<branch>-<hash>/.
//
// Usage:
//   pnpm upload -- --mode=prod            # check hashes, build changed, upload to GitHub
//   pnpm upload -- --mode=dev             # same, but ALWAYS rebuild + upload
//   pnpm upload:local -- --mode=prod      # offline snapshot: dist/prod-<branch>-<hash>/
//
// Flags:
//   --local            write a complete snapshot to dist/<mode>-<branch>-<hash>/
//                      instead of GitHub (offline; no token, no network).
//                      Unchanged binaries are reused from the newest snapshot.
//   --keep-copy        (GitHub runs only) also keep a dist/<mode>-copy-<branch>-<hash>/
//                      copy of what was uploaded, instead of leaving dist/ empty.
//   --force            rebuild + re-upload even when hashes are unchanged
//                      (prod only — dev always behaves this way).
//   --ref=<branch|commit>  build a specific branch/commit in a temporary
//                      detached worktree (your checkout is left untouched).
//   --ci               build binaries for all platforms (default: current OS).
//   --platform=win|linux|mac (repeatable)  explicit binary platform set.
//   --verbose          per-file zip listings and other detail lines.
//   --quiet            suppress progress output (errors still print).
//
// Dev mode never touches the latest release/gh-pages — everything goes to the
// dev-build-<id> branch.  The generated files (_config.h, resources.h,
// updater-config.sys.mjs) are untracked: the Makefile and createZip.mjs
// regenerate them on demand with the current mode's URLs, and the package /
// installer hashes cover their true sources (see buildPackages/buildBinaries).
// At the end of every run they are removed from disk (cleanGenerated) so the
// working tree matches a fresh clone — no mode-baked files are left behind.

import {execSync, spawnSync} from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  collectDirEntries,
  computeDirectoryHash,
  computeFileSetHash,
  findLatestSnapshot,
  getStoredHashes,
  HASHES_FILE,
} from './hashUtils.mjs';
import {
  ASSET_SUFFIX,
  BUILD_ROOT,
  DEV_BRANCH,
  DIST_ROOT,
  GITHUB_TOKEN_VAR,
  INSTALLER_DIST,
  PROFILE_PATH,
  PUBLISH_MODE,
  RELEASE_NAME,
  REMOTE_UI_DIR,
  REPO_NAME,
  REPO_OWNER,
  SCRIPTS_DIST,
  snapshotDirName,
  ZIP_PAGES_BRANCH,
} from './paths.js';
import {
  createOctokit,
  enforcePublishBranch,
  getGitHubToken,
  getLatestCommitDate,
  loadSharedPatterns,
  REPO_ROOT,
} from './publishCommon.mjs';
import {pagesIndex, uploadFilesToPages} from './uploadToPages.mjs';
import {
  bold,
  detail,
  dim,
  error,
  green,
  info,
  section,
  shortHash,
  success,
  warn,
  yellow,
} from './log.mjs';
import {
  deleteExistingAsset,
  getOrCreateRelease,
  getRelease,
  uploadAsset,
} from './uploadUtilsZip.mjs';
import {REF_NAME, REF_SHA} from './publishMode.mjs';
import {assertCleanWorktree} from './gitUtils.mjs';
import {cleanGenerated} from './syncGeneratedFiles.mjs';

const LOCAL = process.argv.includes('--local');
const FORCE = process.argv.includes('--force');
// --ref=<branch|commit>: build a specific ref in a temporary detached
// worktree (see runRefBuild below) instead of the current checkout.
const REF = (() => {
  const arg = process.argv.find(a => a.startsWith('--ref='));
  return arg ? arg.slice('--ref='.length) : null;
})();
// GitHub runs normally leave nothing in dist/; --keep-copy additionally writes
// a prod-copy-<branch>-<hash>/ (or dev-copy-…) snapshot before cleanup.
const KEEP_COPY = process.argv.includes('--keep-copy');
// Removed flags fail loudly: an old --dry-run / --packages-only /
// --binaries-only invocation must never silently turn into a real upload.
// The offline check is now `--local` (upload:local).
const REMOVED_FLAGS = ['--dry-run', '--packages-only', '--binaries-only'].filter(f =>
  process.argv.includes(f)
);
if (REMOVED_FLAGS.length > 0) {
  throw new Error(
    `Unknown flag ${REMOVED_FLAGS.join(', ')} — the offline check is now ` +
      `'upload:local' (node tools/publish/upload.mjs --local --mode=prod|dev).`
  );
}
// --mode=dev always rebuilds + re-uploads; a hash match never suppresses it.
const ALWAYS = PUBLISH_MODE === 'dev' || FORCE;
// Explicit --ci only (never ambient env): local shells often export CI=true,
// which must not widen a local run beyond the current OS.
const IS_CI = process.argv.includes('--ci');
const PLATFORMS = process.argv
  .filter(a => a.startsWith('--platform='))
  .map(a => a.slice('--platform='.length));

const INSTALLER_DIR = path.join(REPO_ROOT, 'installer');
const INSTALLER_SRC = path.join(INSTALLER_DIR, 'src');
const INSTALLER_WEB = path.join(INSTALLER_DIR, 'web');
const HELPER_SRC = path.join(INSTALLER_SRC, 'helper');
const UTILS_SOURCE = path.join(PROFILE_PATH, 'chrome', 'utils');
const FX_FOLDER_SOURCE = path.join(PROFILE_PATH, 'fx-folder');
const UI_SOURCE = REMOTE_UI_DIR;

// The generated updater config ships inside utils.zip (and is hashed + listed
// in the manifest) even though it is untracked/gitignored.  createZip.mjs
// regenerates it (with the current mode's URLs) before this module hashes it.
const GENERATED_UPDATER_CONFIG = {
  rel: 'updater/updater-config.sys.mjs',
  absPath: path.join(UTILS_SOURCE, 'updater', 'updater-config.sys.mjs'),
};

// The generated updater stylesheet ships inside updater-ui.zip (and is hashed
// + listed in the manifest) even though it is untracked/gitignored.
// createZip.mjs regenerates it before this module hashes it.
const GENERATED_UI_CSS = {
  rel: 'updater.css',
  absPath: path.join(UI_SOURCE, 'updater.css'),
};

// Obsolete files: excluded from the zips and from the published hash / manifest
// `files` list, so the zip content always equals the canonical list.  The
// installer removes historically installed copies (installer/src/obsolete_files.h).
const HASH_EXCLUDE = ['versionInfo.json'];

const PACKAGES = [
  {name: 'utils', dir: UTILS_SOURCE},
  {name: 'fx-folder', dir: FX_FOLDER_SOURCE},
  {name: 'updater-ui', dir: UI_SOURCE},
];

const PLATFORM = {
  win: {makeInstaller: 'dist_win', makeHelper: 'helper_win', ext: 'exe'},
  linux: {makeInstaller: 'dist_linux', makeHelper: 'helper_linux', ext: ''},
  mac: {makeInstaller: 'dist_mac', makeHelper: 'helper_mac', ext: ''},
};
const VALID_PLATFORMS = new Set(Object.keys(PLATFORM));

const zipFileName = name => `${name}${ASSET_SUFFIX}.zip`;
const zipPath = name => path.join(SCRIPTS_DIST, zipFileName(name));
// linux/mac binaries have no extension (Makefile: `installer_linux$(ASSET_SUFFIX)`);
// only win carries `.exe` — no trailing dot for the others.
const withExt = (base, p) =>
  `${base}${ASSET_SUFFIX}${PLATFORM[p].ext ? `.${PLATFORM[p].ext}` : ''}`;
const installerAssetName = p => withExt(`installer_${p}`, p);
const helperAssetName = p => withExt(`helper_${p}`, p);
const installerPath = p => path.join(INSTALLER_DIST, installerAssetName(p));
const helperPath = p => path.join(INSTALLER_DIST, helperAssetName(p));

/** Expand the effective build platform set: explicit list > --ci > native. */
function resolvePlatforms() {
  if (PLATFORMS.length > 0) {
    for (const p of PLATFORMS) {
      if (!VALID_PLATFORMS.has(p)) {
        throw new Error(`Unknown platform '${p}' (expected win|linux|mac)`);
      }
    }
    return PLATFORMS;
  }
  if (IS_CI) return ['win', 'linux', 'mac'];
  switch (process.platform) {
    case 'win32':
      return ['win'];
    case 'darwin':
      return ['mac'];
    default:
      return ['linux'];
  }
}

/** Run a make target in the installer dir, streaming output. */
function runMake(target) {
  // MODE=dev makes the Makefile regenerate _config.h with dev URLs/names
  // (node tools/publish/syncGeneratedFiles.mjs --mode=dev); empty in prod.
  // LOCAL=1 additionally bakes localhost URLs + enables the local file server.
  // The generated headers are untracked — the Makefile regenerates them on
  // every build, so no stale committed copy can leak into the binary.
  const modeVar = PUBLISH_MODE === 'dev' ? ' MODE=dev' : '';
  const localVar = LOCAL ? ' LOCAL=1' : '';
  const genVar = ` CONFIG_GENERATOR=${path.join(REPO_ROOT, 'tools', 'publish', 'syncGeneratedFiles.mjs')}`;
  // Redirect the Makefile's hardcoded ../dist/installer into the transient
  // staging tree, so dist/ never accumulates a persistent installer/ dir.
  const distVar = ' DIST_DIR=' + path.posix.join('..', 'dist', '.build', 'installer');
  // The Makefile's $(MKDIR) probe falls back to cmd's `mkdir` under a Windows
  // spawn, which cannot create the two-level ../dist/.build/installer path (no
  // parent creation).  Pre-create it from Node so the link step always has a
  // destination, regardless of which shell make picks for its recipes.
  fs.mkdirSync(INSTALLER_DIST, {recursive: true});
  info(`\n  ${bold(`Building ${target}`)} ${dim('(make -s)')}`);
  try {
    // -s suppresses make's per-recipe command echo; the only stdout left is the
    // generator/embed chatter (regenerated-file notices), which we capture and
    // show only under --verbose. stderr stays inherited so gcc errors surface.
    const out = execSync(`make -s ${target}${modeVar}${localVar}${genVar}${distVar}`, {
      cwd: INSTALLER_DIR,
      stdio: ['inherit', 'pipe', 'inherit'],
      encoding: 'utf-8',
    });
    if (out.trim()) detail(out.trimEnd());
  } catch (error) {
    if (error.stdout?.trim()) process.stdout.write(error.stdout);
    throw new Error(`make ${target} failed: ${error.message}`, {cause: error});
  }
}

/** Current git branch + short sha, used for snapshot folder naming. */
function gitRef() {
  // --ref builds: the detached worktree reports branch "HEAD"; honor the ref
  // identity the parent passed via env so the snapshot dir names the real ref.
  if (REF_NAME) {
    return {branch: REF_NAME, sha: REF_SHA || 'dirty'};
  }
  let branch = 'unknown';
  let sha = 'dirty';
  try {
    branch = execSync('git rev-parse --abbrev-ref HEAD', {
      encoding: 'utf-8',
      cwd: REPO_ROOT,
    }).trim();
  } catch {
    /* keep fallback */
  }
  try {
    sha = execSync('git rev-parse --short=7 HEAD', {encoding: 'utf-8', cwd: REPO_ROOT}).trim();
  } catch {
    /* keep fallback */
  }
  return {branch, sha};
}

/** Snapshot dir: dist/<mode>[-copy]-<branch>-<hash>/ (gitignored). */
function snapshotDir(copy = false) {
  const {branch, sha} = gitRef();
  return path.join(DIST_ROOT, snapshotDirName({mode: PUBLISH_MODE, branch, sha, copy}));
}

/**
 * Hash both package sources, rebuild changed zips, return updated manifest
 * entries.
 */
async function buildPackages(createZip, storedHashes, zipPatterns, hashPatterns) {
  const updated = {};
  const built = [];

  for (const {name, dir} of PACKAGES) {
    // Generated files that ship inside the zip but are gitignored on disk are
    // re-added here so the zip content, hash and canonical `files` list all
    // include them explicitly.
    const extraFiles =
      name === 'utils' ? [GENERATED_UPDATER_CONFIG]
      : name === 'updater-ui' ? [GENERATED_UI_CSS]
      : [];
    const {hash, files} = computeDirectoryHash(dir, hashPatterns, extraFiles);
    const date = getLatestCommitDate(dir, hashPatterns);
    const stored = storedHashes[name];
    const hashChanged = stored?.hash !== hash;
    // A stored entry without a `files` list is the pre-`files` manifest format;
    // refresh it even when the hash is unchanged so the new format propagates.
    const manifestRefresh = !stored || !Array.isArray(stored.files);
    const needsZip = LOCAL || ALWAYS || hashChanged || manifestRefresh;
    const reason =
      hashChanged ? 'hash changed'
      : ALWAYS ? 'always rebuild'
      : manifestRefresh ? 'manifest refresh'
      : LOCAL ? 'local snapshot'
      : '';

    info(
      `  ${bold(name.padEnd(10))} ${needsZip ? yellow('rebuild') : dim('up to date')}  ` +
        `${dim(shortHash(hash))}${reason ? `  ${dim(reason)}` : ''}`
    );

    if (needsZip) {
      await createZip.createZip(
        dir,
        zipPath(name),
        zipPatterns,
        createZip.zipPrefixFor(name),
        extraFiles.map(f => f.rel)
      );
      built.push(name);
    }

    updated[name] = {hash, files, date};
  }

  return {updated, built};
}

/**
 * Hash the binary source trees, rebuild changed binaries, return manifest
 * entries.
 */
async function buildBinaries(platforms, storedHashes) {
  const installerPatterns = loadSharedPatterns(INSTALLER_SRC, ['helper/**']);
  const helperPatterns = loadSharedPatterns(HELPER_SRC, []);
  const webPatterns = loadSharedPatterns(INSTALLER_WEB, []);
  // Installer hash covers the true sources of the installer binary.  The
  // generated _config.h / resources.h are gitignored build products; instead of
  // hashing them (which would make the hash depend on their on-disk state),
  // hash what they are derived from: installer/src (minus helper/ and the two
  // generated headers), installer/web/* and config/installer.conf — so a UI or
  // config change still bumps the hash and triggers a rebuild.
  const {hash: installerHash} = computeFileSetHash([
    ...collectDirEntries(INSTALLER_SRC, installerPatterns, 'installer', INSTALLER_SRC, [
      '_config.h',
      'resources.h',
    ]),
    ...collectDirEntries(INSTALLER_WEB, webPatterns, 'web'),
    {rel: 'config/installer.conf', absPath: path.join(REPO_ROOT, 'config', 'installer.conf')},
  ]);
  const {hash: helperHash} = computeDirectoryHash(HELPER_SRC, helperPatterns);
  const installerDate = getLatestCommitDate(INSTALLER_SRC, installerPatterns);
  const helperDate = getLatestCommitDate(HELPER_SRC, helperPatterns);

  const installerChanged = ALWAYS || storedHashes.installer?.hash !== installerHash;
  const helperChanged = ALWAYS || storedHashes.helper?.hash !== helperHash;
  info(
    `  ${bold('installer'.padEnd(10))} ${installerChanged ? yellow('rebuild') : dim('up to date')}  ` +
      `${dim(shortHash(installerHash))}`
  );
  info(
    `  ${bold('helper'.padEnd(10))} ${helperChanged ? yellow('rebuild') : dim('up to date')}  ` +
      `${dim(shortHash(helperHash))}`
  );

  const builtInstallers = [];
  const builtHelpers = [];
  // Staging is emptied on every run, so in local mode unchanged binaries are
  // reused from the newest existing snapshot (the continuity baseline) instead
  // of being recompiled.
  const prevSnapshot = LOCAL ? findLatestSnapshot() : null;
  const reuseBinary = (assetName, changed) => {
    if (changed || !prevSnapshot) return null;
    const src = path.join(prevSnapshot, assetName);
    return fs.existsSync(src) ? src : null;
  };

  for (const p of platforms) {
    const instAsset = installerAssetName(p);
    const reusedInst = reuseBinary(instAsset, installerChanged);
    if (installerChanged || (LOCAL && !reusedInst)) {
      runMake(PLATFORM[p].makeInstaller);
      builtInstallers.push(p);
    } else if (reusedInst) {
      fs.mkdirSync(path.dirname(installerPath(p)), {recursive: true});
      fs.copyFileSync(reusedInst, installerPath(p));
    }

    const helperAsset = helperAssetName(p);
    const reusedHelper = reuseBinary(helperAsset, helperChanged);
    if (helperChanged || (LOCAL && !reusedHelper)) {
      runMake(PLATFORM[p].makeHelper);
      builtHelpers.push(p);
    } else if (reusedHelper) {
      fs.mkdirSync(path.dirname(helperPath(p)), {recursive: true});
      fs.copyFileSync(reusedHelper, helperPath(p));
    }
  }

  const updated = {};
  if (installerChanged) updated.installer = {hash: installerHash, date: installerDate};
  if (helperChanged) updated.helper = {hash: helperHash, date: helperDate};
  return {updated, builtInstallers, builtHelpers};
}

/**
 * Dev-mode release: 'dev-build-<id>' with a body linking the dev branch. Called
 * only AFTER uploadFilesToPages has pushed the dev-build branch, and the tag
 * points at that branch — GitHub refuses to create a tag for a commit it has
 * never seen (e.g. a local-only HEAD), so target_commitish must be an
 * already-pushed ref.
 */
async function getOrCreateDevRelease(octokit) {
  const body = [
    'Development build for testing',
    '',
    `Files are on the [${DEV_BRANCH}](https://github.com/${REPO_OWNER}/${REPO_NAME}/tree/${DEV_BRANCH}) branch.`,
  ].join('\n');
  return getOrCreateRelease(octokit, DEV_BRANCH, {
    name: DEV_BRANCH,
    body,
    commitish: DEV_BRANCH,
    // A dev build is a pre-release: it is never the stable download.
    prerelease: true,
  });
}

/** GitHub sink: release assets (prod) / dev branch, Pages zips + manifest + UI. */
async function publishToGitHub({
  octokit,
  builtZips,
  builtInstallers,
  builtHelpers,
  merged,
  manifestChanged,
}) {
  // Prod: upload to the 'latest' release (the manual-download link).  Dev:
  // the release is created AFTER the branch push below, so its tag can point
  // at the just-pushed dev-build branch (a tag needs a commit GitHub knows).
  const release = PUBLISH_MODE === 'prod' ? await getRelease(octokit) : null;
  if (PUBLISH_MODE === 'prod' && !release) {
    warn(
      `Release '${RELEASE_NAME}' not found — skipping release-asset uploads ` +
        `(artifacts still reach Pages; hashes stay unchanged so the next run rebuilds them)`
    );
  }

  // One Pages commit carries every changed artifact: zips, installer/helper
  // binaries, and the hash manifest.  uploadFilesToPages content-addresses
  // each blob, so unchanged files are skipped and an idle run creates no
  // commit at all.
  const pagesFiles = {};
  // Landing page for the Pages site root (static index.html — the branch's
  // .nojekyll disables the Jekyll README fallback). Content-addressed
  // downstream: skipped when unchanged.
  pagesFiles['index.html'] = pagesIndex();

  if (PUBLISH_MODE === 'dev') {
    for (const name of builtZips) pagesFiles[zipFileName(name)] = fs.readFileSync(zipPath(name));
    for (const p of builtInstallers)
      pagesFiles[installerAssetName(p)] = fs.readFileSync(installerPath(p));
  } else {
    // Prod: zips go to the release AND Pages (the installer fetches zips from
    // Pages); installers are release-only; helpers are Pages-only.
    for (const name of builtZips) {
      pagesFiles[zipFileName(name)] = fs.readFileSync(zipPath(name));
      // updater-ui is internal: the updater downloads and updates it from the
      // Pages branch itself — never a release asset (mirrors the dev path).
      if (name === 'updater-ui') continue;
      if (release) {
        await deleteExistingAsset(octokit, release.id, zipFileName(name));
        await uploadAsset(octokit, release.id, zipPath(name), zipFileName(name));
      }
    }
    for (const p of builtInstallers) {
      if (release) {
        await deleteExistingAsset(octokit, release.id, installerAssetName(p));
        await uploadAsset(octokit, release.id, installerPath(p), installerAssetName(p));
      }
    }
  }
  for (const p of builtHelpers) pagesFiles[helperAssetName(p)] = fs.readFileSync(helperPath(p));

  if (manifestChanged) {
    pagesFiles[HASHES_FILE] = Buffer.from(JSON.stringify(merged, null, 2) + '\n', 'utf-8');
  }

  await uploadFilesToPages(octokit, pagesFiles, {
    message: `chore: publish ${PUBLISH_MODE} artifacts (${new Date().toISOString().slice(0, 10)})`,
  });

  // Dev release assets (manual download/testing) — after the push above, so
  // the release tag can be created at the now-existing dev-build branch.  Only
  // the two manual-download packages (utils + fx-folder zips) and the installer
  // binary are attached: updater-ui is fetched by the updater itself and the
  // helpers are branch-only, so neither belongs on the release.  All artifacts
  // stay on the branch (the installer/updater fetch from there via jsDelivr).
  if (PUBLISH_MODE === 'dev') {
    const devRelease = await getOrCreateDevRelease(octokit);
    // Only the two manual-download packages (utils + fx-folder zips) and the
    // installer binary are attached.  updater-ui is fetched by the updater
    // itself and helpers are branch-only, so both are skipped — and any copy a
    // previous run attached is removed so the release stays clean.
    for (const name of builtZips) {
      if (name === 'updater-ui') {
        await deleteExistingAsset(octokit, devRelease.id, zipFileName(name));
        continue;
      }
      await deleteExistingAsset(octokit, devRelease.id, zipFileName(name));
      await uploadAsset(octokit, devRelease.id, zipPath(name), zipFileName(name));
    }
    for (const p of builtInstallers) {
      await deleteExistingAsset(octokit, devRelease.id, installerAssetName(p));
      await uploadAsset(octokit, devRelease.id, installerPath(p), installerAssetName(p));
    }
    for (const p of builtHelpers) {
      await deleteExistingAsset(octokit, devRelease.id, helperAssetName(p));
    }
  }
}

/** Assemble a complete snapshot dir: zips + binaries + UI + manifest. */
function writeSnapshot({merged, platforms, dir, label}) {
  // Any artifact this run didn't rebuild (an unchanged zip or binary) is
  // reused from the newest previous snapshot so the folder is complete. Local
  // mode always rebuilds zips, so this mainly fills in --keep-copy runs.
  const prev = findLatestSnapshot();
  const reuse = (asset, dst) => {
    if (!prev || fs.existsSync(dst)) return;
    const src = path.join(prev, asset);
    if (fs.existsSync(src)) {
      fs.mkdirSync(path.dirname(dst), {recursive: true});
      fs.copyFileSync(src, dst);
    }
  };
  for (const {name} of PACKAGES) reuse(zipFileName(name), zipPath(name));
  for (const p of platforms) {
    reuse(installerAssetName(p), installerPath(p));
    reuse(helperAssetName(p), helperPath(p));
  }

  fs.mkdirSync(dir, {recursive: true});
  info(`\n  ${bold(label)} → ${path.relative(process.cwd(), dir)}/`);

  // Package zips.
  for (const {name} of PACKAGES) {
    const src = zipPath(name);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(dir, zipFileName(name)));
      info(`    ${green('+')} ${zipFileName(name)}`);
    }
  }

  // Binaries for the in-scope platforms.
  for (const p of platforms) {
    for (const [asset, src] of [
      [installerAssetName(p), installerPath(p)],
      [helperAssetName(p), helperPath(p)],
    ]) {
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(dir, asset));
        info(`    ${green('+')} ${asset}`);
      }
    }
  }

  // Manifest — mirrors the Pages layout (hashes.json at the branch root).
  const manifest = JSON.stringify(merged, null, 2) + '\n';
  fs.writeFileSync(path.join(dir, HASHES_FILE), manifest);
  info(`    ${green('+')} ${HASHES_FILE}`);

  success(`\n✓ ${label} ready: ${path.relative(process.cwd(), dir)}`);
}

/**
 * Build a specific branch/commit without touching the current checkout: create
 * a temporary detached worktree at the ref, re-execute this same upload command
 * inside it (so the ref's own tooling builds its own source), then remove the
 * worktree. The child names its snapshot/dev-branch/release after the ref via
 * FIREFOX_SCRIPTS_REF_* (see publishMode.mjs). Returns the child exit code.
 */
function runRefBuild(ref) {
  const resolve = spawnSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
  });
  if (resolve.status !== 0) {
    throw new Error(`--ref '${ref}' does not resolve to a commit`, {
      cause: new Error((resolve.stderr || '').trim()),
    });
  }
  const sha = resolve.stdout.trim();
  const short = spawnSync('git', ['rev-parse', '--short=7', sha], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
  }).stdout.trim();

  const worktree = path.join(os.tmpdir(), `firefox-scripts-ref-${short}-${Date.now()}`);
  info(`\nBuilding --ref=${ref} (${short}) in a temporary worktree…`);

  const add = spawnSync('git', ['worktree', 'add', '--detach', worktree, sha], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
  if (add.status !== 0) {
    throw new Error(`git worktree add failed (exit ${add.status})`);
  }

  // Re-exec the worktree's own copy of this tool, so an old ref is built by
  // its own compatible publish scripts.  `--ref` is stripped (already applied);
  // the ref identity is passed via env for the snapshot/dev-branch naming.
  const args = process.argv.slice(2).filter(a => a !== `--ref=${ref}`);
  const env = {
    ...process.env,
    FIREFOX_SCRIPTS_REF_NAME: ref,
    FIREFOX_SCRIPTS_REF_SHA: short,
  };

  try {
    const res = spawnSync(process.execPath, ['tools/publish/upload.mjs', ...args], {
      cwd: worktree,
      env,
      stdio: 'inherit',
    });
    return res.status ?? 1;
  } finally {
    const remove = spawnSync('git', ['worktree', 'remove', '--force', worktree], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    });
    if (remove.status !== 0) {
      spawnSync('git', ['worktree', 'prune'], {cwd: REPO_ROOT, stdio: 'inherit'});
    }
  }
}

async function main() {
  try {
    // --ref builds happen in a detached worktree, so the current checkout may
    // stay dirty; the worktree itself starts clean.
    if (REF) {
      process.exitCode = runRefBuild(REF);
      return;
    }

    // Every run requires a committed tree: the publish decision (and the
    // dev-build-<id> branch identity) is commit-based, and the generated files
    // are untracked so a clean tree means the sources are in their committed
    // state.
    assertCleanWorktree();

    const platforms = resolvePlatforms();

    // Fail fast: publishing without a token would silently skip every upload.
    // --local works without one.
    if (!LOCAL) {
      if (!getGitHubToken()) {
        error(
          `${GITHUB_TOKEN_VAR} is not set — cannot publish.\n` +
            `  Create a root .env (copy .env-example) with "${GITHUB_TOKEN_VAR}=your_token",\n` +
            `  or export ${GITHUB_TOKEN_VAR} in the shell, then re-run "upload".`
        );
        process.exitCode = 1;
        return;
      }
      enforcePublishBranch({enabled: true});
    }

    section(`firefox-scripts publish — ${PUBLISH_MODE} mode`);
    info(
      dim(
        `  sink=${LOCAL ? 'local snapshot' : 'GitHub'}  ` +
          `release=${RELEASE_NAME}  pages=${ZIP_PAGES_BRANCH}`
      )
    );

    // Load createZip.mjs: its top-level block regenerates the untracked
    // updater-config.sys.mjs from installer.conf (with this run's mode URLs),
    // so the utils hash/files list below reflect the current config.
    const createZip = await import('./createZip.mjs');

    const zipPatterns = loadSharedPatterns(FX_FOLDER_SOURCE, []);
    const hashPatterns = loadSharedPatterns(FX_FOLDER_SOURCE, HASH_EXCLUDE);

    const storedHashes = await getStoredHashes({localOnly: LOCAL});

    section('Packages');
    const {updated: zipUpdated, built: builtZips} = await buildPackages(
      createZip,
      storedHashes,
      zipPatterns,
      hashPatterns
    );

    section('Binaries');
    const {
      updated: binUpdated,
      builtInstallers,
      builtHelpers,
    } = await buildBinaries(platforms, storedHashes);

    const merged = {...storedHashes, ...zipUpdated, ...binUpdated};
    const manifestChanged =
      ALWAYS ||
      ['utils', 'fx-folder', 'updater-ui', 'installer', 'helper'].some(
        k => JSON.stringify(merged[k]) !== JSON.stringify(storedHashes[k])
      );

    if (LOCAL) {
      writeSnapshot({merged, platforms, dir: snapshotDir(false), label: 'Snapshot'});
    } else {
      section('Publishing');
      const octokit = createOctokit(getGitHubToken());
      await publishToGitHub({
        octokit,
        builtZips,
        builtInstallers,
        builtHelpers,
        merged,
        manifestChanged,
      });
      if (KEEP_COPY) {
        writeSnapshot({merged, platforms, dir: snapshotDir(true), label: 'Keep copy'});
      }
    }

    success('\n✓ Done');
  } catch (err) {
    error('✗ Error:', err.message);
    process.exitCode = 1;
  } finally {
    // Leave the working tree like a fresh clone: the run regenerated the
    // untracked generated files with this mode's URLs; delete them so no
    // localhost/dev-baked copies linger (all regenerable on demand). Also
    // remove the transient staging tree so dist/ holds only snapshots.
    cleanGenerated();
    fs.rmSync(BUILD_ROOT, {recursive: true, force: true});
  }
}

main();
