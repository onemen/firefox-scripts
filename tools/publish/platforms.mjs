// platforms.mjs — the build-platform registry for the publish binaries flow.
//
// Dependency-free on purpose (no publishMode import → no argv coupling): the
// platform set, asset naming, and the linux→aarch64 expansion are pure data +
// functions, so unit tests can import this module directly.
//
// Asset naming rule: `installer_<assetPlatform><suffix>[.exe]` must match the
// file the Makefile target writes — dist_linux_aarch64 produces
// installer_linux_aarch64, NOT installer_aarch64 — and the names the updater
// downloads (INSTALLER_FILENAMES / HELPER_FILENAMES_AARCH64 in updater.js).

/** make targets + asset extension per platform key. */
export const PLATFORM = {
  win: {makeInstaller: 'dist_win', makeHelper: 'helper_win', ext: 'exe'},
  linux: {makeInstaller: 'dist_linux', makeHelper: 'helper_linux', ext: ''},
  // ARM64 Linux twin: cross-compiled (aarch64-linux-gnu-gcc, AARCH64_CC
  // override) in the same job as linux — published as its own asset so arm64
  // users get runnable binaries. assetPlatform feeds the asset NAME (the
  // make target already spells the full name).
  aarch64: {
    makeInstaller: 'dist_linux_aarch64',
    makeHelper: 'helper_linux_aarch64',
    assetPlatform: 'linux_aarch64',
    ext: '',
  },
  mac: {makeInstaller: 'dist_mac', makeHelper: 'helper_mac', ext: ''},
};

/**
 * A 'linux' selection always implies the aarch64 twin (same sources, one
 * toolchain install); explicit '--platform=aarch64' builds the twin alone.
 */
export const PLATFORM_LINUX_EXTRA = {linux: 'aarch64'};

/**
 * Expand a selected platform list: dedupe entries, append the linux→aarch64
 * twin, and throw on an unknown key. Order is preserved (first occurrence).
 */
export function expandPlatforms(selected) {
  const expanded = [];
  for (const p of selected) {
    if (!PLATFORM[p]) {
      throw new Error(`Unknown platform '${p}' (expected ${Object.keys(PLATFORM).join('|')})`);
    }
    if (!expanded.includes(p)) expanded.push(p);
    const extra = PLATFORM_LINUX_EXTRA[p];
    if (extra && !expanded.includes(extra)) expanded.push(extra);
  }
  return expanded;
}

const assetPlatform = p => PLATFORM[p].assetPlatform || p;

/**
 * linux/mac binaries have no extension (Makefile:
 * `installer_linux$(ASSET_SUFFIX)`); only win carries `.exe` — no trailing dot
 * for the others.
 */
function withExt(base, p, suffix) {
  return `${base}${suffix}${PLATFORM[p].ext ? `.${PLATFORM[p].ext}` : ''}`;
}

/** Release/branch asset name of the installer binary for platform p. */
export function installerAssetName(p, suffix = '') {
  return withExt(`installer_${assetPlatform(p)}`, p, suffix);
}

/** Pages-branch asset name of the elevated-copy helper for platform p. */
export function helperAssetName(p, suffix = '') {
  return withExt(`helper_${assetPlatform(p)}`, p, suffix);
}

/**
 * Name of the checksum sidecar published next to each helper
 * (`helper_<platform>.sha256`, hex SHA-256 of the binary). The updater tab
 * verifies the freshly downloaded helper against it before executing — the
 * helper is the one artifact that runs outside the browser sandbox (issue
 * #33).
 */
export function helperShaAssetName(p, suffix = '') {
  // Derived from the helper's own name (including the .exe extension on win)
  // — the updater fetches `<helperFilename()>.sha256`, so the sidecar must be
  // the full binary name + .sha256, never a re-derivation from the base.
  return `${helperAssetName(p, suffix)}.sha256`;
}
