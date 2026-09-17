// publishScope.mjs — which artifact roles a publish run covers (`--skip=…`).
//
// Why this exists (issue #157): the Windows binaries are unsigned, stripped
// MinGW PEs whose AV verdict is effectively per-hash — a rebuild can land in
// Microsoft's ML detection pocket while the package zips (plain JS/text) never
// do. Without a way to hold back a single role, one flagged binary freezes
// EVERY delivery, including the script updates the in-browser updater
// consumes. A partial publish keeps the scripts flowing (`utils.zip`,
// `fx-folder.zip`, `updater-ui.zip`, `hashes.json`) while the flagged role is
// withheld.
//
// A skipped role is NOT built, NOT hashed, NOT scanned and NOT uploaded, and
// its `hashes.json` entry stays frozen at the last published value. That last
// part is the trap this module exists to prevent: bumping a hash without
// uploading the artifact would make the installer/updater chase bytes that are
// not on the branch (a permanent "update available" that can never converge).
//
// Roles:
//   packages  → utils.zip / fx-folder.zip / updater-ui.zip + their hashes
//   installer → installer_<platform> binaries (release + Pages mirror)
//   helper    → helper_<platform> binaries + .sha256 sidecars (Pages only)
//
// Dependency-free on purpose (no paths.js/publishMode argv chain): the parser
// and the scope decision are unit-tested directly (publishScope.test.mjs).

/** Roles that may be held back from a run. */
export const SKIP_ROLES = ['packages', 'installer', 'helper'];

/**
 * Parse every `--skip=<role>[,<role>]` occurrence in argv.
 *
 * @param {string[]} [argv] argv to scan (defaults to the live process argv)
 * @returns {Set<string>} skipped roles (empty set = a full publish)
 */
export function parseSkip(argv = process.argv) {
  const roles = new Set();
  for (const arg of argv) {
    if (!arg.startsWith('--skip=')) continue;
    const value = arg.slice('--skip='.length).trim();
    if (value === '') {
      throw new Error(
        `--skip= needs at least one role (expected ${SKIP_ROLES.join('|')}, comma-separated)`
      );
    }
    for (const raw of value.split(',')) {
      const role = raw.trim();
      if (!SKIP_ROLES.includes(role)) {
        throw new Error(`Unknown --skip role '${role}' (expected ${SKIP_ROLES.join('|')})`);
      }
      roles.add(role);
    }
  }
  return roles;
}

/**
 * Role → in-scope flag. A role is in scope unless it was skipped.
 *
 * @param {Set<string>} [skip] skipped roles
 * @returns {{packages: boolean; installer: boolean; helper: boolean}}
 */
export function scopeFor(skip = new Set()) {
  return {
    packages: !skip.has('packages'),
    installer: !skip.has('installer'),
    helper: !skip.has('helper'),
  };
}

/** True when no binary role is in scope (nothing for the AV/VT gates to scan). */
export function noBinaryScope(scope) {
  return !scope.installer && !scope.helper;
}

/**
 * The loud multi-line banner printed for any partial publish, so a held-back
 * run is never mistaken for a full one in a CI log.
 *
 * @param {Set<string>} skip skipped roles (may be empty)
 * @param {{mode?: string; local?: boolean}} [opts]
 * @returns {string} banner text (empty string for a full publish)
 */
export function skipBanner(skip, {mode, local = false} = {}) {
  if (skip.size === 0) return '';
  const held = [...skip];
  const tail =
    local ?
      ['(--local: the snapshot simply omits the held-back roles.)']
    : [
        'Intended for the issue #157 AV holdback (the zips keep flowing',
        'while a flagged binary is withheld) — see docs/DEVELOPING.md.',
      ];
  const lines = [
    '============================================================',
    `  PARTIAL ${mode ? `${mode.toUpperCase()} ` : ''}PUBLISH — held back: ${held.join(', ')}`,
    '============================================================',
    'The role(s) above are not built, scanned or uploaded, and their',
    'hashes.json entries stay frozen at the last published values —',
    'installed copies keep pointing at the binaries already on the',
    'branch. Everything else publishes as usual.',
    ...tail,
    '============================================================',
  ];
  return lines.join('\n');
}
