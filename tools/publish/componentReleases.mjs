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
// prod mode after the latest-release + Pages uploads. All GitHub calls fail
// soft: a component-release sync problem is a loud warning, never a publish
// failure (latest + Pages are the contract; the date tags are a convenience).

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
}

/**
 * Group the built artifacts into component-release buckets.
 *
 * @param {{
 *   builtZips: string[];
 *   builtInstallers: string[];
 *   builtHelpers: string[];
 * }} built
 *   package names / platform keys actually rebuilt this run
 * @returns {{scripts: string[]; installer: string[]}} package names for the
 *   scripts release (updater-ui excluded — internal, Pages-only), platform keys
 *   for the installer release (helpers ride with the installer: same helper
 *   sources, one tag for the binary surface)
 */
export function groupBuilt(built) {
  const scripts = built.builtZips.filter(n => n !== 'updater-ui');
  const installer = [...new Set([...built.builtInstallers, ...built.builtHelpers])];
  return {scripts, installer};
}

/**
 * Render the release body for one component release: what's in it, and the
 * pointer back to `latest` + hashes.json (the machines' source of truth).
 */
export function renderComponentBody(kind, date, names) {
  const base = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases`;
  const title =
    kind === 'scripts' ? 'Package zips (utils, fx-folder)' : 'Installer + helper binaries';
  const list =
    names.length > 0 ? names.map(n => `- ${n}`).join('\n') : '- (no artifacts this date)';
  return (
    `${title} — ${date}.\n\n` +
    `${list}\n\n` +
    `Frozen per-component snapshot for browsing only: fetch artifacts by their permanent ` +
    `unversioned names from the [latest release](${base}/latest) or the gh-pages branch ` +
    `(integrity: \`hashes.json\`).`
  );
}

/**
 * Sync one component release: get-or-create the tagged release (prerelease=true
 * — never "Latest"), then delete+reupload the given assets and refresh the
 * body. Idempotent: same-day republishes replace assets and rewrite the body in
 * place.
 *
 * @returns {Promise<{created: boolean}>} whether the release was newly created
 */
export async function syncComponentRelease(octokit, tagName, date, assets, {kind} = {}) {
  const {getRelease, getOrCreateRelease, deleteExistingAsset, uploadAsset} =
    await import('./uploadUtilsZip.mjs');
  const existed = !!(await getRelease(octokit, tagName));
  const release = await getOrCreateRelease(octokit, tagName, {
    name: `${kind === 'scripts' ? 'Scripts' : 'Installer'} — ${date}`,
    body: renderComponentBody(kind, date, [...assets.keys()]),
    commitish: 'main',
    prerelease: true,
  });

  for (const [assetName, src] of assets) {
    await deleteExistingAsset(octokit, release.id, assetName);
    if (!src) continue;
    if (Buffer.isBuffer(src)) {
      // Buffer source (the derived sha256 sidecar) — uploadReleaseAsset takes
      // data directly; reuse uploadAsset's logging by a tiny inline upload.
      const {uploadAssetBuffer} = await import('./uploadUtilsZip.mjs');
      await uploadAssetBuffer(octokit, release.id, src, assetName);
    } else {
      await uploadAsset(octokit, release.id, src, assetName);
    }
  }
  console.log(green(`  ✓ component release ${tagName} synced`));
  return {created: !existed};
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
 * @param {string[]} p.builtHelpers rebuilt platform keys
 * @param {(name: string) => string} p.zipPath staged zip path by package name
 * @param {(p: string) => string} p.installerPath staged installer path by
 *   platform
 * @param {(p: string) => string} p.helperPath staged helper path by platform
 */
export async function syncComponentReleases(
  octokit,
  {builtZips, builtInstallers, builtHelpers, zipPath, installerPath, helperPath}
) {
  try {
    const {installerAssetName, helperAssetName, helperShaAssetName} =
      await import('./platforms.mjs');
    const date = componentDate();
    const {scripts, installer} = groupBuilt({builtZips, builtInstallers, builtHelpers});
    if (scripts.length === 0 && installer.length === 0) {
      console.log(dim('  component releases: nothing rebuilt — date tags unchanged'));
      return;
    }

    if (scripts.length > 0) {
      const assets = new Map(scripts.map(n => [`${n}.zip`, zipPath(n)]));
      await syncComponentRelease(octokit, scriptsTag(date), date, assets, {kind: 'scripts'});
    }

    if (installer.length > 0) {
      const assets = new Map();
      const {helperSha256Sidecar} = await import('./hashUtils.mjs');
      const {readFileSync} = await import('fs');
      for (const p of installer) {
        const inst = installerAssetName(p);
        const helper = helperAssetName(p);
        const sidecar = helperShaAssetName(p);
        assets.set(inst, installerPath(p));
        assets.set(helper, helperPath(p));
        // Sidecar regenerated from the staged bytes (issue #33 contract).
        assets.set(sidecar, helperSha256Sidecar(readFileSync(helperPath(p)), helper));
      }
      await syncComponentRelease(octokit, installerTag(date), date, assets, {kind: 'installer'});
    }
  } catch (err) {
    warn(`component releases sync failed (non-fatal): ${err.message}`);
  }
}
