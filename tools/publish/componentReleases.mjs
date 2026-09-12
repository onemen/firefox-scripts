// componentReleases.mjs — date-stamped component releases alongside `latest`
// (issue #72, ADR 0019): every prod publish also syncs tagged releases —
// `scripts-<date>` (the changed package zips) and `installer-<date>` (the
// changed installer + helper binaries) — so `latest` keeps serving the full
// asset set by permanent unversioned names while the date tags freeze
// per-component snapshots humans can browse.
//
// "Latest" badge rule (the #72 mechanism decision): a component release is
// created with prerelease=true. GitHub's "Latest" badge only ever lands on a
// non-draft, non-prerelease release, so the date tags can never steal the
// badge from `latest` — no create-order coupling, no post-hoc re-pin, and the
// flag is semantically honest: a date tag is a frozen snapshot, not "the"
// release. (REST has no make_latest parameter; prerelease=true is the only
// per-release control, and the workflow-CLI-only make_latest flag proves the
// badge is what the flag protects.)
//
// Library-only (no entry point): upload.mjs calls syncComponentReleases() in
// prod mode after the latest-release + Pages uploads, then re-pins the Latest
// badge onto `latest` with make_latest=true (see pinLatestRelease below).
// All GitHub calls fail soft: a component-release sync problem is a loud
// warning, never a publish failure (latest + Pages are the contract; the date
// tags are a convenience).
//
// Release shape (maintainer's Latest Scripts scheme, 2026-09-12): component
// releases are FULL releases — GitHub renders the badge-holding release as the
// hero card at the top of the releases page (verified on TabMixPlus), so after
// every publish the badge is re-pinned onto `latest` and the page reads:
// Latest Scripts hero first, frozen date tags below. The old prerelease=true
// trick is obsolete: "Update a release" accepts make_latest (REST-level
// parameter surfaced by the CLI's --latest flag), and prereleases can never
// hold the badge.

import {REPO_OWNER, REPO_NAME} from './paths.js';
import {green, dim, warn} from './log.mjs';

/**
 * YYYY-MM-DD (UTC) for the component tags. Run-date convention, matching the
 * Pages-commit message dates; the manifest's per-component `date` fields stay
 * the source-commit dates (a lookup aid, not a version).
 *
 * @param {Date} [now] injectable for tests
 * @returns {string}
 */
export function componentDate(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/** Tag for the package-zip component release. */
export function scriptsTag(date) {
  return `scripts-${date}`;
}

/** Tag for the installer+helper component release. */
export function installerTag(date) {
  return `installer-${date}`;
} /**
 * Group the built artifacts into component-release buckets.
 *
 * Helpers never join a component release (maintainer call, 2026-09-12, mock
 * review on #72): they are not user downloads — the updater fetches them from
 * gh-pages with their .sha256 sidecars (ADR 0019). A helper-only rebuild
 * therefore creates NO release tag at all; only installer binaries make the
 * installer-<date> bucket.
 *
 * @param {{
 *   builtZips: string[];
 *   builtInstallers: string[];
 *   builtHelpers: string[];
 * }} built
 *   package names / platform keys actually rebuilt this run
 * @returns {{scripts: string[]; installer: string[]}} package names for the
 *   scripts release (updater-ui excluded — internal, Pages-only), platform
 *   keys for the installer release (installer binaries only)
 */

export function groupBuilt(built) {
  const scripts = built.builtZips.filter(n => n !== 'updater-ui');
  const installer = built.builtInstallers;
  return {scripts, installer};
}

/**
 * Build the installer component release's asset map: exactly the installers
 * this run built (helpers are gh-pages-only — never release assets).
 *
 * @param {string[]} installer platform keys (groupBuilt's installer bucket)
 * @param {{builtInstallers: string[]}} built what the run rebuilt
 * @param {object} access
 * @param {(p: string) => string} access.installer platform → installer asset
 *   name
 * @param {(p: string) => string} access.installerPath platform → staged path
 * @returns {Map<string, string>} asset name → staged path
 */
export function componentAssets(installer, built, access) {
  const assets = new Map();
  for (const p of installer) {
    if (built.builtInstallers.includes(p)) {
      assets.set(access.installer(p), access.installerPath(p));
    }
  }
  return assets;
}

/**
 * Render the release body for one component release: what's in it (each file
 * with its own last-updated date — asset rows are collapsible on GitHub, the
 * body is always visible), and the pointer back to the latest release.
 *
 * `dates` maps asset name → YYYY-MM-DD (per-package source-commit date from the
 * manifest; defaults to the release's own date).
 */
export function renderComponentBody(kind, date, names, dates = {}) {
  const base = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases`;
  const title = kind === 'scripts' ? 'Package zips (utils, fx-folder)' : 'Installer binaries';
  const list =
    names.length > 0 ?
      names.map(n => `- ${n} — updated ${dates[n] || date}`).join('\n')
    : '- (no artifacts this date)';
  return (
    `${title} — ${date}.\n\n` +
    `${list}\n\n` +
    `This release is an archived snapshot: the files above are from that date and will not ` +
    `change. Always download the newest files from the [Latest Scripts release](${base}/latest).`
  );
}

/**
 * Sync one component release: get-or-create the tagged release as a FULL
 * release (no prerelease flag — the maintainer's Latest Scripts scheme,
 * 2026-09-12: date tags are first-class releases), then delete+reupload the
 * given assets (each labelled with its updated-date) and refresh the body. The
 * caller re-pins the Latest badge onto `latest` via make_latest afterwards — a
 * newly created full release briefly holds the badge otherwise. Idempotent:
 * same-day republishes replace assets and rewrite the body.
 *
 * @returns {Promise<{created: boolean}>} whether the release was newly created
 */
export async function syncComponentRelease(
  octokit,
  tagName,
  date,
  assets,
  {kind, dates = {}} = {}
) {
  const {getRelease, getOrCreateRelease, deleteExistingAsset, uploadAsset, uploadAssetBuffer} =
    await import('./uploadUtilsZip.mjs');
  const existed = !!(await getRelease(octokit, tagName));
  const release = await getOrCreateRelease(octokit, tagName, {
    name: `${kind === 'scripts' ? 'Scripts' : 'Installer'} — ${date}`,
    body: renderComponentBody(kind, date, [...assets.keys()], dates),
    commitish: 'main',
    prerelease: false,
  });

  for (const [assetName, src] of assets) {
    await deleteExistingAsset(octokit, release.id, assetName);
    if (!src) continue;
    const label = `Updated ${dates[assetName] || date}`.slice(0, 50);
    if (Buffer.isBuffer(src)) {
      await uploadAssetBuffer(octokit, release.id, src, assetName, label);
    } else {
      await uploadAsset(octokit, release.id, src, assetName, label);
    }
  }
  console.log(green(`  ✓ component release ${tagName} synced`));
  return {created: !existed};
}

/**
 * Re-pin the Latest badge onto the `latest` release (the Latest Scripts hero).
 * A newly created full component release briefly holds the badge (GitHub's
 * default for a new non-prerelease); make_latest=true on Update-a-release moves
 * it back. Idempotent and fails soft — the badge is cosmetic; the
 * /releases/latest URL is resolved by GitHub from this same flag, so call this
 * after every component-release sync.
 */
export async function pinLatestRelease(octokit) {
  try {
    const {getRelease} = await import('./uploadUtilsZip.mjs');
    const release = await getRelease(octokit);
    if (!release) {
      warn('component releases: latest release not found — badge pin skipped');
      return;
    }
    if (release.make_latest === 'true') {
      console.log(dim('  latest badge: already on latest'));
      return;
    }
    await octokit.repos.updateRelease({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      release_id: release.id,
      make_latest: 'true',
    });
    console.log(green('  ✓ latest badge pinned on latest (make_latest=true)'));
  } catch (err) {
    warn(`latest badge re-pin failed (non-fatal): ${err.message}`);
  }
}

/**
 * Sync both component releases for this publish, given what was actually
 * rebuilt. Skips a bucket when nothing in it was built (the existing date tag
 * stays frozen at its own date). Fails soft: any error is a warning — the date
 * tags are a browsing convenience, never a publish gate.
 *
 * @param {object} octokit authenticated client
 * @param {object} p
 * @param {string[]} p.builtZips rebuilt package names
 * @param {string[]} p.builtInstallers rebuilt platform keys
 * @param {string[]} p.builtHelpers rebuilt platform keys (informed the
 *   installer/helper rebuild decisions upstream; helpers never join a release)
 * @param {Record<string, {hash: string; date?: string}>} p.manifest the merged
 *   hash manifest — per-package `date` labels the assets and bodies
 * @param {(name: string) => string} p.zipPath staged zip path by package name
 * @param {(p: string) => string} p.installerPath staged installer path by
 *   platform
 */
export async function syncComponentReleases(
  octokit,
  {builtZips, builtInstallers, builtHelpers, manifest, zipPath, installerPath}
) {
  try {
    const {installerAssetName} = await import('./platforms.mjs');
    const date = componentDate();
    const {scripts, installer} = groupBuilt({builtZips, builtInstallers, builtHelpers});
    if (scripts.length === 0 && installer.length === 0) {
      console.log(dim('  component releases: nothing rebuilt — date tags unchanged'));
      return;
    }
    // Per-file dates for bodies + asset labels: the manifest's per-package
    // source-commit date (falls back to the release date when absent).
    const dates = {};
    for (const n of scripts) {
      if (manifest[n]?.date) dates[`${n}.zip`] = manifest[n].date;
    }
    for (const p of installer) {
      if (manifest.installer?.date) dates[installerAssetName(p)] = manifest.installer.date;
    }

    if (scripts.length > 0) {
      const assets = new Map(scripts.map(n => [`${n}.zip`, zipPath(n)]));
      await syncComponentRelease(octokit, scriptsTag(date), date, assets, {
        kind: 'scripts',
        dates,
      });
    }

    if (installer.length > 0) {
      const assets = componentAssets(
        installer,
        {builtInstallers},
        {installer: installerAssetName, installerPath}
      );
      if (assets.size === 0) {
        console.log(dim('  component releases: installer bucket empty — date tag unchanged'));
        return;
      }
      await syncComponentRelease(octokit, installerTag(date), date, assets, {
        kind: 'installer',
        dates,
      });
    }
  } catch (err) {
    warn(`component releases sync failed (non-fatal): ${err.message}`);
  }
}
