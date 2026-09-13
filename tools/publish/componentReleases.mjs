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
}

/**
 * The managed self-update block embedded in an installer-<date> release body
 * (ADR 0019 amendment, date-based self-update): the installer tab ingests the
 * newest installer-<date> body, and the C side parses this block for the build
 * date and this platform's download URL. The block is wrapped in a
 *
 * ```json
 * keys, so the fence is opaque to it.
 *
 * `urlByAsset` maps installer asset name → browser_download_url under the
 * permanently-named `latest` tag (entries missing for platforms this run did
 * not rebuild — the installer falls back to the releases page for those).
 *
 * @param {string} date YYYY-MM-DD (must match config/installer.conf
 *   BUILD_DATE for the binaries this publish ships — that equality is what
 *   makes the C-side strcmp comparison converge)
 * @param {Record<string, string>} urlByAsset asset name → download URL
 * @returns {string} JSON block, no fence
 * ```
 */
export function renderSelfUpdateBlock(date, urlByAsset) {
  return JSON.stringify({installerDate: date, download: urlByAsset});
}

/**
 * Managed self-update block from an existing release body, for merging (a
 * same-day republish keeps the URLs an earlier run recorded for platforms it
 * did rebuild — see mergeSelfUpdateBlock).
 *
 * @param {string} body prior release body
 * @returns {{
 *   installerDate?: string;
 *   download?: Record<string, string>;
 * } | null}
 */
export function parseSelfUpdateBlock(body) {
  if (!body) return null;
  /** Balanced-brace JSON object starting at `start` (an opening brace). */
  const extractObject = start => {
    let depth = 0;
    for (let i = start; i < body.length; i++) {
      if (body[i] === '{') {
        depth++;
        if (depth === 1) start = i;
      } else if (body[i] === '}') {
        depth--;
        if (depth === 0) return body.slice(start, i + 1);
      }
    }
    return null;
  };
  const keyAt = body.indexOf('"installerDate"');
  if (keyAt === -1) return null;
  // The block sits in a ```json fence in normal bodies; a bare occurrence
  // (body embedded as a plain JSON string value, unescaped by GitHub's API)
  // is accepted too.  Walk BACKWARDS from the key to the block's opening
  // brace (the key sits above the nested download map, so a forward scan
  // from the key itself would latch onto the inner brace), then extract the
  // balanced object — a regex `[^{}]*` would truncate the map and same-day
  // merges would lose prior platforms' URLs.
  let openAt = -1;
  let depth = 0;
  for (let i = keyAt; i >= 0; i--) {
    if (body[i] === '}') depth++;
    else if (body[i] === '{') {
      if (depth === 0) {
        openAt = i;
        break;
      }
      depth--;
    }
  }
  const fencedAt = body.lastIndexOf('```json', keyAt);
  const candidates = [];
  if (fencedAt !== -1) {
    const fenceEnd = body.indexOf('```', fencedAt + 7);
    if (fenceEnd !== -1) candidates.push(body.slice(fencedAt + 7, fenceEnd));
  }
  candidates.push(openAt === -1 ? null : extractObject(openAt));
  for (const c of candidates) {
    if (!c) continue;
    try {
      const parsed = JSON.parse(c);
      if (parsed && typeof parsed.installerDate === 'string') return parsed;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

/**
 * Merge this run's download URLs over a prior block (same-day tag reuse): this
 * run's entries win, prior entries for platforms this run did not rebuild
 * survive. The date always comes from this run.
 *
 * @param {string} date this run's YYYY-MM-DD
 * @param {Record<string, string>} urlByAsset this run's asset → URL map
 * @param {{
 *   installerDate?: string;
 *   download?: Record<string, string>;
 * } | null} prior
 * @returns {Record<string, string>} merged asset → URL map
 */
export function mergeSelfUpdateBlock(date, urlByAsset, prior) {
  const merged = {...(prior && prior.installerDate === date ? prior.download : {}), ...urlByAsset};
  return merged;
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
 *
 * For installer releases `selfUpdateBlock` (the managed JSON block from
 * renderSelfUpdateBlock) is appended in a ```json fence — the machine-readable
 * payload the installer's date-based self-update ingests (ADR 0019 amendment).
 */
export function renderComponentBody(kind, date, names, dates = {}, selfUpdateBlock = '') {
  const base = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases`;
  const title = kind === 'scripts' ? 'Package zips (utils, fx-folder)' : 'Installer binaries';
  const list =
    names.length > 0 ?
      names.map(n => `- ${n} — updated ${dates[n] || date}`).join('\n')
    : '- (no artifacts this date)';
  const managed = selfUpdateBlock ? `\n\n\`\`\`json\n${selfUpdateBlock}\n\`\`\`\n` : '';
  return (
    `${title} — ${date}.\n\n` +
    `${list}\n\n` +
    `This release is an archived snapshot: the files above are from that date and will not ` +
    `change. Always download the newest files from the [Latest Scripts release](${base}/latest).` +
    managed
  );
}

/**
 * Asset list for a component release's body: this run's files first, then any
 * assets an earlier same-day run left on the tag that this run did not rebuild
 * (same-day tags are reused, so assets accumulate across runs). Each name once,
 * order-stable — the body always lists everything the tag carries.
 *
 * @param {string[]} currentNames assets this run uploads
 * @param {string[]} priorNames assets already on the tag from earlier runs
 * @returns {string[]}
 */
export function bodyAssetNames(currentNames, priorNames) {
  const out = [];
  for (const n of currentNames) {
    if (n && !out.includes(n)) out.push(n);
  }
  for (const n of priorNames) {
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

/**
 * Sync one component release: get-or-create the tagged release as a FULL
 * release (no prerelease flag — the maintainer's Latest Scripts scheme,
 * 2026-09-12: date tags are first-class releases), then delete+reupload the
 * given assets (each labelled with its updated-date) and refresh the body. The
 * body lists the union of this run's assets and everything an earlier same-day
 * run left on the tag (assets are replaced, never swept). The caller re-pins
 * the Latest badge onto `latest` via make_latest afterwards — a newly created
 * full release briefly holds the badge otherwise. Idempotent: same-day
 * republishes replace assets and rewrite the body.
 *
 * @returns {Promise<{created: boolean}>} whether the release was newly created
 */
export async function syncComponentRelease(
  octokit,
  tagName,
  date,
  assets,
  {kind, dates = {}, selfUpdateUrlByAsset = null} = {}
) {
  const {getRelease, getOrCreateRelease, deleteExistingAsset, uploadAsset, uploadAssetBuffer} =
    await import('./uploadUtilsZip.mjs');
  const existed = !!(await getRelease(octokit, tagName));

  // Managed self-update block (installer releases only): merge this run's
  // download URLs over the prior same-day body so entries for platforms an
  // earlier run rebuilt survive (same-day tag reuse).
  let selfUpdateBlock = '';
  if (kind === 'installer' && selfUpdateUrlByAsset) {
    let prior = null;
    if (existed) {
      try {
        const current = await getRelease(octokit, tagName);
        prior = parseSelfUpdateBlock(current?.body);
      } catch {
        prior = null; // under-merge rather than fail the sync
      }
    }
    selfUpdateBlock = renderSelfUpdateBlock(
      date,
      mergeSelfUpdateBlock(date, selfUpdateUrlByAsset, prior)
    );
  }

  const release = await getOrCreateRelease(octokit, tagName, {
    name: `${kind === 'scripts' ? 'Scripts' : 'Installer'} — ${date}`,
    body: renderComponentBody(kind, date, [...assets.keys()], dates, selfUpdateBlock),
    commitish: 'main',
    prerelease: false,
  });

  // Same-day reuse: assets from earlier runs today that this run did not
  // rebuild stay on the tag — the body must keep listing them.
  let priorNames = [];
  if (existed) {
    try {
      const {data: prior} = await octokit.repos.listReleaseAssets({
        owner: REPO_OWNER,
        repo: REPO_NAME,
        release_id: release.id,
      });
      const current = new Set(assets.keys());
      priorNames = prior.map(a => a.name).filter(n => !current.has(n));
    } catch {
      // Listing failed: the body under-reports rather than failing the sync.
    }
  }

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
  await octokit.repos.updateRelease({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    release_id: release.id,
    body: renderComponentBody(
      kind,
      date,
      bodyAssetNames([...assets.keys()], priorNames),
      dates,
      selfUpdateBlock
    ),
  });
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
  {
    builtZips,
    builtInstallers,
    builtHelpers,
    manifest,
    zipPath,
    installerPath,
    installerDate: installerBuiltDate,
  }
) {
  try {
    const {installerAssetName} = await import('./platforms.mjs');
    const date = componentDate();
    // Installer bucket date: conf BUILD_DATE (passed through by upload.mjs),
    // never the clock.  The binaries this run publishes bake that exact
    // string (CFG_BUILD_DATE) and the C self-update compares against it — a
    // clock date here would publish a tag whose managed installerDate
    // disagrees with the binaries under it.  Falls back to the manifest's
    // per-package source-commit date (local/tests), then the release date.
    const installerDate = installerBuiltDate ?? (manifest.installer?.date || date);
    if (installerBuiltDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(installerBuiltDate)) {
      throw new Error(
        `config/installer.conf BUILD_DATE '${installerBuiltDate}' is not YYYY-MM-DD — ` +
          `fix the conf before publishing installers (the self-update date compare depends on it).`
      );
    }
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
      // Managed self-update URLs (ADR 0019 amendment): every rebuilt asset
      // points at its permanent `latest`-tag download URL.
      const downloadBase = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download`;
      const selfUpdateUrlByAsset = {};
      // The managed URL intentionally targets the `latest` RELEASE download
      // (the user-facing artifact; the banner downloads via an anchor click
      // and needs no CORS).  The gh-pages mirror exists for any future
      // fetch-based flow, not as the banner's target.
      for (const assetName of assets.keys()) {
        selfUpdateUrlByAsset[assetName] = `${downloadBase}/latest/${assetName}`;
      }
      await syncComponentRelease(octokit, installerTag(installerDate), installerDate, assets, {
        kind: 'installer',
        dates,
        selfUpdateUrlByAsset,
      });
    }
  } catch (err) {
    warn(`component releases sync failed (non-fatal): ${err.message}`);
  }
}
