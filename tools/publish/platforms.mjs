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
} /**
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

/**
 * Artifact integrity check for freshly built/reused binaries (issue #233):
 * Defender real-time protection on a local Windows host intermittently holds a
 * write lock on the output while ld is finishing, which leaves a truncated or
 * empty artifact behind a _failed_ link — but the failure mode that matters
 * here is subtler: a build step that "succeeded" earlier in a session that hit
 * the race can leave a partial file that a later pass then hashes and ships.
 * Every PE must start with the bytes 'MZ'; ELF with 0x7f 'E' 'L' 'F'; Mach-O
 * with one of the mach_header magics or the fat-wrapper magic (Apple cctools
 * mach-o/loader.h + fat.h; the cigam variants are byte-identical to their magic
 * twins — they differ only in the reader's byte-order interpretation). Anything
 * else is a truncated artifact — throw.
 *
 * `access` indirection keeps this pure: tests pass a fake name→Buffer map.
 */
const MAGIC = {
  win: [0x4d, 0x5a], // "MZ"
  linux: [0x7f, 0x45, 0x4c, 0x46], // ELF
  aarch64: [0x7f, 0x45, 0x4c, 0x46], // ELF (arm64)
  mac: [0xcf, 0xfa, 0xed, 0xfe], // MH_MAGIC_64 as stored in an x86_64/arm64 file
};
const MACHO_EXTRA = [
  [0xce, 0xfa, 0xed, 0xfe], // MH_MAGIC / MH_CIGAM (32-bit arch)
  [0xca, 0xfe, 0xba, 0xbe], // FAT_MAGIC / FAT_CIGAM (universal wrapper)
  [0xca, 0xfe, 0xba, 0xbf], // FAT_MAGIC_64 / FAT_CIGAM_64
];
// Floor for "this is a binary, not a header-only stub": larger than any
// header the formats define (a real installer/helper is hundreds of KB).
const MIN_BYTES = {win: 0x200, linux: 0x80, aarch64: 0x80, mac: 0x80};

export function verifyStagedBinaries(files, access) {
  const bad = [];
  for (const [name, p] of Object.entries(files)) {
    const buf = access(name);
    if (!looksLikeExecutable(buf, p)) bad.push(name);
  }
  return bad;
}

/**
 * Structural check behind verifyStagedBinaries: the platform's header magic
 * must match AND the file must be long enough to be more than a header — a bare
 * `MZ` (or any header-only stub) is exactly the truncation the check exists to
 * catch.
 */
function looksLikeExecutable(buf, p) {
  const magic = MAGIC[p];
  if (!magic) return true; // unknown platform — naming tests cover the registry
  if (!buf || buf.length < MIN_BYTES[p]) return false;
  const magicOk =
    magic.every((b, i) => buf[i] === b) ||
    (p === 'mac' && MACHO_EXTRA.some(m => m.every((b, i) => buf[i] === b)));
  if (!magicOk) return false;
  if (p === 'win') {
    // PE: e_lfanew (DOS header offset 0x3c, little-endian uint32) must point
    // at the "PE\0\0" signature inside the file.
    const peOffset = buf.readUInt32LE(0x3c);
    if (peOffset < 0 || peOffset + 4 > buf.length) return false;
    if (!(
      buf[peOffset] === 0x50 &&
      buf[peOffset + 1] === 0x45 &&
      buf[peOffset + 2] === 0 &&
      buf[peOffset + 3] === 0
    ))
      return false;
  }
  return true;
}
