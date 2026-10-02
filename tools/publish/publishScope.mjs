// publishScope.mjs — which artifact roles a publish run covers (`--include=…`).
//
// Why this exists (issue #157): the Windows binaries are unsigned, stripped
// MinGW PEs whose AV verdict is effectively per-hash — a rebuild can land in
// Microsoft's ML detection pocket while the package zips (plain JS/text) never
// do. Without a way to ship a single role, one flagged binary freezes
// EVERY delivery, including the script updates the in-browser updater
// consumes. A partial publish keeps the scripts flowing (`utils.zip`,
// `fx-folder.zip`, `updater-ui.zip`, `hashes.json`) while the flagged role
// stays unpublished.
//
// OPT-IN, not opt-out: a run publishes exactly the roles it names
// (`--include=<role>[,<role>]` — required on every invocation). `all` is the
// explicit full-publish spelling. Roles left out are NOT built, NOT hashed,
// NOT scanned and NOT uploaded, and their `hashes.json` entries stay frozen at
// the last published value. That last part is the trap this module exists to
// prevent: bumping a hash without uploading the artifact would make the
// installer/updater chase bytes that are not on the branch (a permanent
// "update available" that can never converge).
//
// Roles:
//   packages  → utils.zip / fx-folder.zip / updater-ui.zip + their hashes
//   updater-ui→ updater-ui.zip + its hash entry alone (the update tab, hotfixable
//               without touching the two manual-download zips — issue #383)
//   installer → installer_<platform> binaries + .sha256 sidecars (release +
//               Pages mirror)
//   helper    → helper_<platform> binaries + .sha256 sidecars (Pages only)
//
// Dependency-free on purpose (no paths.js/publishMode argv chain): the parser
// and the scope decision are unit-tested directly (publishScope.test.mjs).

/** Roles a run may publish, plus the `all` shorthand for every one of them. */
export const INCLUDE_ROLES = ['packages', 'updater-ui', 'installer', 'helper'];
export const INCLUDE_ALL = 'all';

/**
 * Parse the required `--include=<role>[,<role>|all]` from argv.
 *
 * Every publish invocation must state its scope — there is no implicit default,
 * so a missing or empty flag fails loudly instead of silently publishing
 * something the operator did not choose.
 *
 * @param {string[]} [argv] argv to scan (defaults to the live process argv)
 * @returns {Set<string>} roles to publish (subset of INCLUDE_ROLES;
 *   `--include=all` yields all of them)
 * @throws when the flag is missing, empty, or names an unknown role
 */
export function parseInclude(argv = process.argv) {
  const roles = new Set();
  let seen = false;
  for (const arg of argv) {
    if (!arg.startsWith('--include=')) continue;
    seen = true;
    const value = arg.slice('--include='.length).trim();
    if (value === '') {
      throw new Error(
        `--include= needs at least one role (expected ${INCLUDE_ROLES.join('|')}|all, comma-separated)`
      );
    }
    if (value === INCLUDE_ALL) {
      for (const role of INCLUDE_ROLES) roles.add(role);
      continue;
    }
    for (const raw of value.split(',')) {
      const role = raw.trim();
      // `all` is accepted anywhere in the list and expands to every role.
      if (role === INCLUDE_ALL) {
        for (const r of INCLUDE_ROLES) roles.add(r);
        continue;
      }
      if (!INCLUDE_ROLES.includes(role)) {
        throw new Error(
          `Unknown --include role '${role}' (expected ${INCLUDE_ROLES.join('|')}|all)`
        );
      }
      roles.add(role);
    }
  }
  if (!seen) {
    throw new Error(
      `Missing --include=<roles> — state what this run publishes ` +
        `(${INCLUDE_ROLES.join('|')}, comma-separated, or all)`
    );
  }
  return roles;
}

/**
 * Role → in-scope flag: a role is in scope only when included.
 *
 * @param {Set<string>} include roles to publish
 * @returns {{
 *   packages: boolean;
 *   updaterUi: boolean;
 *   installer: boolean;
 *   helper: boolean;
 * }}
 */
export function scopeFor(include = new Set()) {
  return {
    packages: include.has('packages'),
    updaterUi: include.has('updater-ui'),
    installer: include.has('installer'),
    helper: include.has('helper'),
  };
}

/**
 * Is this package zip in scope? `packages` covers all three; the `updater-ui`
 * role covers the tab alone, which is what makes a tab-only hotfix possible
 * (issue #383) — utils.zip / fx-folder.zip stay frozen and are not rebuilt,
 * re-uploaded or re-staged. Keyed by the manifest/package name, not the role
 * name, so the two never drift.
 *
 * @param {{packages: boolean; updaterUi: boolean}} scope
 * @param {string} name package name ('utils' | 'fx-folder' | 'updater-ui')
 * @returns {boolean}
 */
export function packageInScope(scope, name) {
  if (name === 'updater-ui') return Boolean(scope.packages || scope.updaterUi);
  return Boolean(scope.packages);
}

/** True when no binary role is in scope (nothing for the AV/VT gates to scan). */
export function noBinaryScope(scope) {
  return !scope.installer && !scope.helper;
}

/**
 * Human label of the run's scope for the Pages commit message: a full publish
 * is "artifacts" (the historical wording), a partial one names exactly the
 * roles it ships ("packages", "installer+helper"), so the branch history shows
 * what each commit published (issue #261). Role order is normalized to the
 * INCLUDE_ROLES order so the same set always yields the same label.
 *
 * @param {Set<string>} include roles to publish
 * @returns {string} 'artifacts' or the role names joined with '+'
 */
export function scopeLabel(include = new Set()) {
  if (include.size === INCLUDE_ROLES.length) return 'artifacts';
  const ordered = [...include].sort((a, b) => INCLUDE_ROLES.indexOf(a) - INCLUDE_ROLES.indexOf(b));
  return ordered.join('+');
}

/**
 * The Pages commit message for a run, assembled from mode + role scope + the
 * platforms actually pushed — the branch history reads as a publish log (issue
 * #261). The disposable dev branch's id is part of the message so it survives
 * the branch's later deletion.
 *
 * ```text
 * chore: publish prod artifacts (2026-09-20)                        # full
 * chore: publish prod packages (2026-09-20)                          # --include=packages
 * chore: publish prod installer+helper (win, 2026-09-20)             # CI per-OS job
 * chore: publish dev artifacts (dev-build-main-abc1, 2026-09-20)     # dev
 * ```
 *
 * @param {{
 *   mode: string;
 *   include: Set<string>;
 *   platforms?: string[];
 *   devBranch?: string;
 *   date: string;
 * }} run
 *   publish-run facts
 * @returns {string} the commit subject line
 */
export function pagesCommitMessage({mode, include, platforms = [], devBranch = '', date}) {
  const parts = [];
  if (mode === 'dev' && devBranch) parts.push(devBranch);
  const plat = [...new Set(platforms)].filter(Boolean);
  if (plat.length > 0) parts.push(plat.join('+'));
  parts.push(date);
  return `chore: publish ${mode} ${scopeLabel(include)} (${parts.join(', ')})`;
}

/**
 * The loud multi-line banner printed for any partial publish, so a held-back
 * run is never mistaken for a full one in a CI log.
 *
 * @param {Set<string>} include roles to publish (a full set prints nothing)
 * @param {{mode?: string; local?: boolean}} [opts]
 * @returns {string} banner text (empty string for a full publish)
 */
export function includeBanner(include, {mode, local = false} = {}) {
  if (include.size === INCLUDE_ROLES.length) return '';
  // Held back at ARTIFACT granularity, not role granularity: `updater-ui` names
  // the same zip `packages` covers, so it is only really withheld when no
  // package role is in scope. Naming it as held back next to a packages run
  // would be false — the tab ships with it.
  const heldBack = INCLUDE_ROLES.filter(role => {
    if (include.has(role)) return false;
    if (role === 'updater-ui' && include.has('packages')) return false;
    return true;
  });
  const tail =
    local ?
      ['(--local: the snapshot simply omits the held-back roles.)']
    : [
        'Intended for the issue #157 AV holdback (the zips keep flowing',
        'while a flagged binary is withheld) — see docs/DEVELOPING.md.',
      ];
  const lines = [
    '============================================================',
    `  PARTIAL ${mode ? `${mode.toUpperCase()} ` : ''}PUBLISH — publishing: ${[...include].join(', ')}`,
    '============================================================',
    `Held back (not built, scanned or uploaded): ${heldBack.join(', ')}.`,
    'Their hashes.json entries stay frozen at the last published',
    'values — installed copies keep pointing at the binaries already',
    'on the branch. Everything included publishes as usual.',
    ...tail,
    '============================================================',
  ];
  return lines.join('\n');
}

/**
 * The extra caution a DEV publish needs when `packages` is held back: a dev
 * branch ships the zips AND their manifest entries together, and the Pages
 * upload never deletes. On an existing branch the prior zips keep serving under
 * the frozen entries, so the run stays consistent — but a run that CREATES its
 * dev-build branch births a manifest naming zips the branch has never carried:
 * installed dev builds then report "update available" forever and the installer
 * 404s on the zips (the exact stranding the frozen-entry rule exists to
 * prevent). Prod never warns: its zips stay on the existing `latest` release +
 * gh-pages regardless.
 *
 * @param {Set<string>} include roles to publish
 * @param {{branchExists?: boolean | null}} [opts] whether the target branch
 *   already exists; null (or an omitted probe) when the caller could not tell
 * @returns {string} warning text ('' when nothing applies)
 */
export function devBranchStrandWarning(include, {branchExists = null} = {}) {
  // `updater-ui` counts as a package role: it puts a zip on the branch, so it
  // is never the "no zips at all" shape this warning is about.
  if (include.has('packages') || include.has('updater-ui')) return '';
  const flag = '--include=installer,helper';
  if (branchExists === false) {
    return [
      `WARNING: ${flag} on a dev publish that CREATES its dev-build branch.`,
      'The branch is born with a hashes.json naming zips it has never carried —',
      'dev-channel browsers will report "update available" forever and the',
      `installer will 404 on the zips. Re-run with --include=all (or at least ${flag} + packages).`,
    ].join('\n');
  }
  if (branchExists === true) {
    return (
      `NOTE: ${flag} on an EXISTING dev branch: its current zips keep serving under the ` +
      'frozen manifest entries (the upload never deletes), so this run stays consistent.'
    );
  }
  return (
    `NOTE: ${flag} on a dev publish: fine on an existing branch (its zips keep serving), ` +
    'but if this run CREATES the dev-build branch the branch is born with a manifest naming zips ' +
    'it has never carried — permanent "update available" + zip 404s.'
  );
}

/**
 * The dev-publish variant of the same trap for the tab-only role: a dev branch
 * CREATED with `--include=updater-ui` carries the tab but not the two
 * manual-download zips, so the installer 404s on them. On an existing branch
 * the frozen entries keep serving and the run is consistent — same bar as
 * devBranchStrandWarning.
 *
 * @param {Set<string>} include roles to publish
 * @param {{branchExists?: boolean | null}} [opts]
 * @returns {string} warning text ('' when nothing applies)
 */
export function devTabOnlyWarning(include, {branchExists = null} = {}) {
  if (include.has('packages') || !include.has('updater-ui')) return '';
  const flag = '--include=updater-ui';
  if (branchExists === false) {
    return [
      `WARNING: ${flag} on a dev publish that CREATES its dev-build branch.`,
      'The branch is born carrying updater-ui.zip but NOT utils.zip / fx-folder.zip,',
      'while their manifest entries stay frozen — the installer will 404 on the zips.',
      'Re-run with --include=packages (or all) so the branch carries the full set.',
    ].join('\n');
  }
  if (branchExists === true) {
    return (
      `NOTE: ${flag} on an EXISTING dev branch: only the tab moves; utils.zip / ` +
      'fx-folder.zip keep serving under their frozen manifest entries, so this run stays consistent.'
    );
  }
  return (
    `NOTE: ${flag} on a dev publish: fine on an existing branch (its zips keep serving), ` +
    'but if this run CREATES the dev-build branch the branch will carry updater-ui.zip alone — ' +
    'the installer will 404 on utils.zip / fx-folder.zip.'
  );
}
