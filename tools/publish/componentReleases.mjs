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

import fs from 'fs';

import {REPO_OWNER, REPO_NAME, SELF_UPDATE_MECHANISM_SINCE} from './paths.js';
import {green, dim, warn} from './log.mjs';
import {installerSha256Sidecar} from './hashUtils.mjs';

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
 * The managed self-update payload (issue #341): `installerDate` + per-platform
 * `download` URLs, plus `mechanismSince` — the cutover date (config
 * SELF_UPDATE_MECHANISM_SINCE) a binary compares its own build date against to
 * decide which ingest surface to trust (Pages payload vs release body). The
 * Pages copy carries the same fields — one shape, two hosts.
 *
 * `urlByAsset` maps installer asset name → browser_download_url under the
 * permanently-named `latest` tag (entries missing for platforms this run did
 * not rebuild — the installer falls back to the releases page for those).
 *
 * @param {string} date YYYY-MM-DD (must match config/installer.conf BUILD_DATE
 *   for the binaries this publish ships — that equality is what makes the
 *   C-side strcmp comparison converge)
 * @param {Record<string, string>} urlByAsset asset name → download URL
 * @returns {string} JSON payload, no fence (the renderer adds markup)
 */
export function renderSelfUpdatePayload(date, urlByAsset) {
  return JSON.stringify({
    ...(SELF_UPDATE_MECHANISM_SINCE ? {mechanismSince: SELF_UPDATE_MECHANISM_SINCE} : {}),
    installerDate: date,
    download: urlByAsset,
  });
}

/**
 * Should this publish append the managed self-update block to the
 * installer-<date> release body? (issue #341 — the one-transition-release
 * fallback window.) The block serves binaries baked BEFORE the cutover
 * (SELF_UPDATE_MECHANISM_SINCE): they parse release bodies only, never the
 * Pages payload. It retires only once a post-cutover installer release has
 * already shipped — that transition release carried the block and gave every
 * updating install the post-cutover binaries, so later tags need not carry it.
 * Fail-safe ordering (a missing block strands pre-cutover installs; an extra
 * block costs one collapsed <details>): • no cutover configured (stripped conf)
 * → always append (legacy); • no prior tag known (listing failed / first
 * publish) → append; • prior newest < cutover → append (this publish IS the
 * transition); • prior newest ≥ cutover → retire.
 *
 * @param {string | null} newestPriorInstallerTag YYYY-MM-DD of the newest
 *   installer-<date> tag EXCLUDING this run's own tag (a same-day republish
 *   must not retire the block an earlier run today appended)
 * @returns {boolean}
 */
export function shouldAppendManagedBlock(newestPriorInstallerTag) {
  if (!SELF_UPDATE_MECHANISM_SINCE) return true;
  if (!newestPriorInstallerTag) return true;
  return newestPriorInstallerTag < SELF_UPDATE_MECHANISM_SINCE;
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
  const merged = {
    ...(prior && prior.installerDate === date ? prior.download : {}),
    ...urlByAsset,
  };
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
 * this run built (helpers are gh-pages-only — never release assets), each with
 * its checksum sidecar (issue #324 — same scheme as the helper's since #174).
 *
 * @param {string[]} installer platform keys (groupBuilt's installer bucket)
 * @param {{builtInstallers: string[]}} built what the run rebuilt
 * @param {object} access
 * @param {(p: string) => string} access.installer platform → installer asset
 *   name
 * @param {(p: string) => string} access.installerSha platform → installer
 *   sidecar asset name (the map's value is rendered from the staged binary —
 *   sidecars are derived, never staged files)
 * @param {(p: string) => string} access.installerPath platform → staged path
 * @returns {Map<string, string>} asset name → staged path or Buffer (sidecars)
 */
export function componentAssets(installer, built, access) {
  const assets = new Map();
  for (const p of installer) {
    if (built.builtInstallers.includes(p)) {
      assets.set(access.installer(p), access.installerPath(p));
      assets.set(
        access.installerSha(p),
        installerSha256Sidecar(fs.readFileSync(access.installerPath(p)), access.installer(p))
      );
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
 * For installer releases `selfUpdateBlock` (the managed JSON payload from
 * renderSelfUpdatePayload) is appended as a ```json fence inside a <details>
 * element that renders collapsed by default (issue #356 item 2, the #341
 * collapse: machine-read, not for humans) — the machine-readable payload the
 * installer's date-based self-update ingests (ADR 0019 amendment) — followed by
 * the WINDOWS_ONLY_INSTALLER_NOTE (the README's SmartScreen/UAC paragraph:
 * user-facing, #184's plain-English standard; maintainers asked for it on the
 * release pages, 2026-09-27).
 */
export const WINDOWS_ONLY_INSTALLER_NOTE =
  '**Windows only:** the installer is currently unsigned, so SmartScreen may show ' +
  '_"Windows protected your PC"_ on first run — click **More info → Run anyway** to continue, ' +
  'and approve the single UAC prompt if it appears (one checksum-verified elevation, for the ' +
  'copy step only). It then connects to a running Firefox-family browser (Firefox, Waterfox, ' +
  'Zen Browser, LibreWolf, or Floorp), opens an install screen in a browser tab, and lets you ' +
  'pick which browser to set up.';

/**
 * Human-facing label of the collapsed managed self-update block (issue #356
 * item 2, the #341 collapse): the block stays in the body — the installed
 * installer's self-update parses it (ADR 0019 amendment; the C parser scans the
 * whole body for the bare keys, so the HTML wrapper is transparent) — but
 * renders as a collapsed <details> on the release page instead of a raw JSON
 * line. The blank line between the summary and the fence matters: it ends the
 * CommonMark HTML block, so the fence renders as a code block INSIDE the
 * collapsible instead of being absorbed as raw text.
 */
export const SELF_UPDATE_BLOCK_SUMMARY =
  '<summary>⚙ Managed self-update block — machine-read, not for humans (click to expand)</summary>';

export function renderComponentBody(kind, date, names, dates = {}, selfUpdateBlock = '') {
  const base = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases`;
  const title = kind === 'scripts' ? 'Package zips (utils, fx-folder)' : 'Installer binaries';
  const list =
    names.length > 0 ?
      names.map(n => `- ${n} — updated ${dates[n] || date}`).join('\n')
    : '- (no artifacts this date)';
  // The managed block keeps its ```json fence (the C side finds the bare keys
  // anywhere in the body; the JS side's same-day merge scans back to the
  // fence) inside a <details> wrapper with a blank line before the fence
  // (#356 item 2) — see SELF_UPDATE_BLOCK_SUMMARY for the shape rationale.
  // The block itself is the TRANSITION FALLBACK surface (#341): publishes stop
  // appending it once the run date reaches SELF_UPDATE_MECHANISM_SINCE, when
  // every installable binary reads the Pages payload instead.
  const managed =
    selfUpdateBlock ?
      `\n\n<details>\n${SELF_UPDATE_BLOCK_SUMMARY}\n\n\`\`\`json\n${selfUpdateBlock}\n\`\`\`\n</details>\n`
    : '';
  // The installer note rides LAST (after the managed block): the parser reads
  // the whole body, and humans get the user-facing note as the body's tail.
  const note = kind === 'installer' ? `\n\n${WINDOWS_ONLY_INSTALLER_NOTE}\n` : '';
  return (
    `${title} — ${date}.\n\n` +
    `${list}\n\n` +
    `This release is an archived snapshot: the files above are from that date and will not ` +
    `change. Always download the newest files from the [Latest Scripts release](${base}/latest).` +
    managed +
    note
  );
}

/**
 * Package zips that belong on the scripts component tag and the `latest`
 * release (issue #354): BOTH manual downloads, even when only one was rebuilt —
 * a snapshot missing fx-folder.zip (or utils.zip) is the exact gap the #157
 * purge left behind. updater-ui stays Pages-only: the updater downloads it
 * itself, it is never a release asset (ADR 0019).
 *
 * @param {string[]} builtZips rebuilt package names
 * @param {string[]} [stagedZips] every package zip staged this run — the
 *   scripts tag carries the complete set even when only one was rebuilt (issue
 *   #354)
 * @returns {string[]} package names for the scripts release, first-seen order
 */
export function scriptsAssetNames(builtZips, stagedZips = []) {
  return [...new Set([...builtZips, ...stagedZips])].filter(n => n && n !== 'updater-ui');
}

/**
 * Managed region of the `latest` body: the downloads table. The publish
 * rewrites ONLY the text between these markers (issue #354, maintainer rule
 * 2026-09-28: the table of files is updated on every release with the date of
 * the file that was released) — manual prose outside the markers (the
 * SmartScreen note, AV/WDSI notes) survives every publish.
 */
export const LATEST_MANAGED_START =
  '<!-- downloads:managed (rewritten by every prod publish; keep manual text outside) -->';
export const LATEST_MANAGED_END = '<!-- /downloads:managed -->';

/** Human descriptions for the known release assets (ADR 0024 names). */
const LATEST_ASSET_DESCRIPTIONS = {
  'utils.zip': 'User scripts (the main package)',
  'fx-folder.zip': 'The `fx-folder` core loader',
  'installer_win.exe': 'Windows installer (`.exe`)',
  'installer_mac': 'macOS installer',
  'installer_linux': 'Linux installer',
  'installer_linux_aarch64': 'Linux installer (ARM64)',
};

const describeAsset = name => LATEST_ASSET_DESCRIPTIONS[name] ?? '';

/** Package-zip row order in the latest table's Packages section (#356). */
const LATEST_PACKAGE_ASSETS = ['utils.zip', 'fx-folder.zip'];
/** Installer row order in the latest table's Installer section (#356). */
const LATEST_INSTALLER_ASSETS = [
  'installer_win.exe',
  'installer_mac',
  'installer_linux',
  'installer_linux_aarch64',
];

/**
 * Render the managed downloads table for the `latest` body. One row per
 * downloadable asset (sidecars are NOT rows — the verify line below the table
 * covers them), with the date that asset was last uploaded — "the date of the
 * file that was released".
 *
 * Two labeled sub-tables (issue #356, item 1): Packages (the zips users set up
 * through the installer/updater) and Installer (per-platform binaries).
 * Packages first — they are the artifact most users come for; installers are
 * the platform pick. Within each table, canonical order when the caller's list
 * contains them (any other asset still renders, trailing in its table).
 *
 * Row dates (issue #356 item 3, maintainer decision 2026-09-29): the installer
 * tag date IS the installer's version (the binaries bake it as their
 * VERSIONINFO FileVersion and the self-update compares it — ADR 0019/0036), so
 * Installer rows carry it via `context.installerDate` — this run's derived
 * build date at publish time, else the newest installer-<date> tag's date —
 * falling back to the upload date when no installer tag exists yet. Package
 * rows keep their own upload date ("the date of the file that was released",
 * issue #354).
 *
 * @param {{name: string; updatedAt?: string | null}[]} assets release assets
 * @param {{installerDate?: string | null}} [context] this run's derived
 *   installer build date, or the newest installer-<date> tag's date (both are
 *   the installer's version; publish passes the former, callers without a fresh
 *   build the latter) — null/absent falls back to upload dates
 * @returns {string} the full managed section, markers included
 */
export function renderLatestDownloads(assets, context = {}) {
  const base = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/latest/download`;
  // Downloadable assets only (sidecars are NOT rows — the verify line below
  // covers them), grouped: packages vs installer binaries.
  const rows = assets
    .filter(a => !a.name.endsWith('.sha256'))
    .map(a => ({
      name: a.name,
      // Installer rows show the version (build date); packages show their own
      // upload date. The fallback never fires for a published repo (the
      // installer tag always exists) — it keeps first runs honest.
      date:
        LATEST_INSTALLER_ASSETS.includes(a.name) && context.installerDate ?
          context.installerDate
        : (a.updatedAt || '').slice(0, 10),
      row: '',
    }));
  for (const r of rows) {
    r.row = `| [\`${r.name}\`](${base}/${r.name}) | ${describeAsset(r.name)} | ${r.date} |`;
  }
  // Canonical row order within each table, regardless of the caller's
  // (GitHub upload) order.
  const rowsFor = names => names.map(name => rows.find(r => r.name === name)?.row).filter(Boolean);
  const packages = rowsFor(LATEST_PACKAGE_ASSETS).join('\n');
  // A known-but-unbuilt installer just renders no row; an unknown future asset
  // trails the Installer table rather than disappearing.
  const known = new Set([...LATEST_PACKAGE_ASSETS, ...LATEST_INSTALLER_ASSETS]);
  const installers = [
    ...rowsFor(LATEST_INSTALLER_ASSETS),
    ...rows.filter(r => !known.has(r.name)).map(r => r.row),
  ].join('\n');
  // Mock-faithful shape (releases-mock, #356 split): a bold Downloads line,
  // the two labeled tables, the verify sentence — no H2 sections in the body.
  return (
    `${LATEST_MANAGED_START}\n\n**Downloads**\n\n` +
    `Packages\n\n` +
    `| File | What it is | Updated |\n|---|---|---|\n${packages}\n\n` +
    `Installer (per platform, sidecars ride each binary)\n\n` +
    `| File | What it is | Updated |\n|---|---|---|\n${installers}\n\n` +
    `Verify before use: each file has a \`.sha256\` sidecar; the installer itself ` +
    `hash-verifies every package it fetches.\n\n${LATEST_MANAGED_END}`
  );
}

/**
 * Newest `installer-<date>` date among tag names — the installer's current
 * version (the tag date is the binaries' derived build date, ADR 0036, and what
 * the release page shows as the installer's version). Pure: exported for tests;
 * lexicographic max is chronological for ISO dates.
 *
 * @param {string[]} tagNames tag names from the repo
 * @returns {string | null} YYYY-MM-DD of the newest installer tag, or null when
 *   the repo has none
 */
export function newestInstallerDate(tagNames) {
  let best = null;
  for (const n of tagNames) {
    const m = /^installer-(\d{4}-\d{2}-\d{2})$/.exec(n);
    if (m && (!best || m[1] > best)) best = m[1];
  }
  return best;
}

/**
 * Newest installer-<date> tag date on the repo EXCLUDING `excludeTag` (this
 * run's own tag — a same-day republish must not count itself as the transition
 * release). Fail-safe for the #341 body-block retire decision: any listing
 * error resolves null (caller appends the block). Pure networking, no CLI.
 *
 * @param {import('@octokit/rest').Octokit} octokit authenticated client
 * @param {string} excludeTag this run's installer tag name
 * @returns {Promise<string | null>} YYYY-MM-DD or null
 */
export async function newestPriorInstallerTag(octokit, excludeTag) {
  try {
    const tagNames = [];
    for (let page = 1; page <= 3; page++) {
      const {data} = await octokit.repos.listTags({
        owner: REPO_OWNER,
        repo: REPO_NAME,
        per_page: 100,
        page,
      });
      tagNames.push(...data.map(t => t.name).filter(n => n !== excludeTag));
      if (data.length < 100) break;
    }
    return newestInstallerDate(tagNames);
  } catch {
    return null; // append rather than retire — never strand a pre-cutover install
  }
}

/**
 * Splice a freshly rendered managed section into a `latest` body: replace the
 * region between the markers when present, otherwise append. Everything outside
 * the markers is returned untouched.
 *
 * @param {string} body current release body
 * @param {string} section renderLatestDownloads() output
 * @returns {string} updated body
 */
export function updateLatestDownloads(body, section) {
  const at = body.indexOf(LATEST_MANAGED_START);
  if (at === -1) return `${body.trimEnd()}\n\n${section}\n`;
  const end = body.indexOf(LATEST_MANAGED_END, at);
  if (end === -1) return `${body.trimEnd()}\n\n${section}\n`;
  return body.slice(0, at) + section + body.slice(end + LATEST_MANAGED_END.length);
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
 * given assets (no labels — GitHub renders a label instead of the file name)
 * and refresh the body. The body lists the union of this run's assets and
 * everything an earlier same-day run left on the tag (assets are replaced,
 * never swept). The caller re-pins the Latest badge onto `latest` via
 * make_latest afterwards — a newly created full release briefly holds the badge
 * otherwise. Idempotent: same-day republishes replace assets and rewrite the
 * body.
 *
 * @param {object} [opts]
 * @param {'scripts' | 'installer'} [opts.kind] which component (labels the
 *   body)
 * @param {Record<string, string>} [opts.dates] per-asset body-date override
 *   (defaults to the tag date for every row; no asset labels — GitHub renders a
 *   label instead of the file name, issue #354)
 * @param {Record<string, string> | null} [opts.selfUpdateUrlByAsset] asset →
 *   self-update URL map (installer body only)
 * @param {string} [opts.selfUpdateBlock] this run's managed self-update JSON
 *   payload (renderSelfUpdatePayload output) — '' retires the block from the
 *   body (the #341 post-cutover state); undefined keeps the legacy behavior of
 *   always rendering it
 * @returns {Promise<{created: boolean}>} whether the release was newly created
 */
export async function syncComponentRelease(octokit, tagName, date, assets, opts = {}) {
  const {kind, dates = {}, selfUpdateUrlByAsset = null, selfUpdateBlock: forcedBlock} = opts;
  const {getRelease, getOrCreateRelease, deleteExistingAsset, uploadAsset, uploadAssetBuffer} =
    await import('./uploadUtilsZip.mjs');
  const existed = !!(await getRelease(octokit, tagName));

  // Managed self-update block (installer releases only): merge this run's
  // download URLs over the prior same-day body so entries for platforms an
  // earlier run rebuilt survive (same-day tag reuse). The caller may force
  // '' (post-cutover, #341: the body block is retired) — the retire decision
  // must win over the merge, but the MERGE still runs first so a later revert
  // of the cutover loses nothing.
  let selfUpdateBlock;
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
    selfUpdateBlock = renderSelfUpdatePayload(
      date,
      mergeSelfUpdateBlock(date, selfUpdateUrlByAsset, prior)
    );
  }
  if (forcedBlock !== undefined) selfUpdateBlock = forcedBlock;

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
    // No asset label (issue #354): GitHub renders the label INSTEAD of the
    // file name — "utils.zip" showed up as "Updated 2026-09-26" and the
    // manual-download table lost its file names. The dates live in the body.
    if (Buffer.isBuffer(src)) {
      await uploadAssetBuffer(octokit, release.id, src, assetName);
    } else {
      await uploadAsset(octokit, release.id, src, assetName);
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
 * Rewrite the `latest` body's managed downloads section from the release's
 * current assets (each dated by its own upload time; installer rows dated by
 * the installer's version — see renderLatestDownloads). Fails soft: a GitHub
 * error warns, never fails the publish.
 *
 * @param {import('@octokit/rest').Octokit} octokit authenticated client
 * @param {{id: number}} latestRelease the `latest` release — only the id is
 *   used: body and assets are re-fetched fresh below, so the refresh can never
 *   overwrite a manual edit made while this run was uploading and every row
 *   carries its true upload date (CodeRabbit on #355)
 * @param {{installerDate?: string | null}} [context] when the run rebuilt
 *   installers, the derived build date just baked into them (the binaries on
 *   `latest` are exactly that version; the newest installer tag still points at
 *   the previous one until the component sync below runs). When absent, the
 *   version is read from the newest installer-<date> tag instead
 */
export async function refreshLatestBody(octokit, latestRelease, context = {}) {
  try {
    let installerDate = context.installerDate || null;
    if (!installerDate) {
      // Idle / packages-only run: the installer binaries on `latest` are the
      // ones the newest installer-<date> tag freezes — that tag's date IS
      // their version. (First runs with no installer tag fall back to upload
      // dates.) Fail soft — dates are display-only.
      try {
        const tagNames = [];
        for (let page = 1; page <= 3; page++) {
          const {data} = await octokit.repos.listTags({
            owner: REPO_OWNER,
            repo: REPO_NAME,
            per_page: 100,
            page,
          });
          tagNames.push(...data.map(t => t.name));
          if (data.length < 100) break;
        }
        installerDate = newestInstallerDate(tagNames);
      } catch {
        installerDate = null;
      }
    }
    const [{data: release}, {data: assets}] = await Promise.all([
      octokit.repos.getRelease({
        owner: REPO_OWNER,
        repo: REPO_NAME,
        release_id: latestRelease.id,
      }),
      octokit.repos.listReleaseAssets({
        owner: REPO_OWNER,
        repo: REPO_NAME,
        release_id: latestRelease.id,
      }),
    ]);
    const section = renderLatestDownloads(
      assets.map(a => ({name: a.name, updatedAt: a.updated_at})),
      {
        installerDate,
      }
    );
    const body = updateLatestDownloads(release.body || '', section);
    await octokit.repos.updateRelease({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      release_id: latestRelease.id,
      body,
    });
    console.log(green('  ✓ latest downloads table refreshed (managed section)'));
  } catch (err) {
    warn(`latest downloads-table refresh failed (non-fatal): ${err.message}`);
  }
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
 * @param {import('@octokit/rest').Octokit} octokit authenticated client
 * @param {object} p
 * @param {string[]} p.builtZips rebuilt package names
 * @param {string[]} [p.stagedZips] every package zip staged this run — the
 *   scripts tag carries the complete set even when only one zip was rebuilt
 *   (issue #354)
 * @param {string[]} p.builtInstallers rebuilt platform keys
 * @param {string[]} p.builtHelpers rebuilt platform keys (informed the
 *   installer/helper rebuild decisions upstream; helpers never join a release)
 * @param {Record<string, {hash: string; date?: string}>} p.manifest the merged
 *   hash manifest — per-package `date` stays a lookup aid in hashes.json
 * @param {(name: string) => string} p.zipPath staged zip path by package name
 * @param {(p: string) => string} p.installerPath staged installer path by
 *   platform
 * @param {string} [p.installerDate] this run's installer build date
 *   (YYYY-MM-DD) — labels the installer component release
 */
export async function syncComponentReleases(
  octokit,
  {
    builtZips,
    stagedZips = [],
    builtInstallers,
    builtHelpers,
    manifest,
    zipPath,
    installerPath,
    installerDate: installerBuiltDate,
  }
) {
  try {
    const {installerAssetName, installerShaAssetName} = await import('./platforms.mjs');
    const date = componentDate();
    // Installer bucket date: the DERIVED installer date (issue #322, passed
    // through by upload.mjs), never the clock.  The binaries this run
    // publishes bake that exact string (CFG_BUILD_DATE_INSTALLER) and the C
    // self-update compares against it — a clock date here would publish a tag
    // whose managed installerDate disagrees with the binaries under it.
    // Falls back to the manifest's per-package source-commit date
    // (local/tests), then the release date.
    const installerDate = installerBuiltDate ?? (manifest.installer?.date || date);
    if (installerBuiltDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(installerBuiltDate)) {
      throw new Error(
        `derived installer build date '${installerBuiltDate}' is not YYYY-MM-DD — ` +
          `fix git history (or the generator) before publishing installers (the self-update date compare depends on it).`
      );
    }
    const {scripts, installer} = groupBuilt({
      builtZips,
      builtInstallers,
      builtHelpers,
    });
    // scriptsTagNames (issue #354): the complete staged package set — the tag
    // is synced whenever ANY zip was rebuilt, so an unchanged zip still lands
    // on the tag when its sibling changed. (The `latest` table refresh is NOT
    // gated on rebuilds — upload.mjs calls it on every prod run.)
    const scriptsTagNames = scriptsAssetNames(scripts, stagedZips);
    if (scripts.length === 0 && installer.length === 0) {
      console.log(dim('  component releases: nothing rebuilt — date tags unchanged'));
      return;
    }
    // Body rows all carry the TAG date (the snapshot's own date, per the
    // approved releases-mock) — not each package's source-commit date. The
    // manifest's per-package dates remain a lookup aid in hashes.json only.

    if (scripts.length > 0) {
      // The tag carries the COMPLETE package set even when only one zip was
      // rebuilt (issue #354) — stagedZips is the full packages scope. Body
      // rows carry the TAG date (the snapshot's date, per the approved
      // releases-mock), not each package's source-commit date.
      const assets = new Map(scriptsTagNames.map(n => [`${n}.zip`, zipPath(n)]));
      await syncComponentRelease(octokit, scriptsTag(date), date, assets, {
        kind: 'scripts',
      });
    }

    if (installer.length > 0) {
      const assets = componentAssets(
        installer,
        {builtInstallers},
        {
          installer: installerAssetName,
          installerSha: installerShaAssetName,
          installerPath,
        }
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
      // and needs no CORS).  The Pages mirror exists for the #341 fetch-based
      // flow's post-cutover binaries.
      // Sidecar names are excluded: the C self-update resolves its URL by a
      // plain substring search for the asset name, and `installer_win.exe` is
      // a prefix of `installer_win.exe.sha256` — a sidecar entry here would
      // shadow the binary's URL (issue #324).
      for (const assetName of assets.keys()) {
        if (assetName.endsWith('.sha256')) continue;
        selfUpdateUrlByAsset[assetName] = `${downloadBase}/latest/${assetName}`;
      }
      // Transition fallback only (#341): the body block serves pre-cutover
      // binaries; it retires once a post-cutover installer release has
      // already shipped (that transition release carried the block). List the
      // repo's tags (excluding this run's own) and let shouldAppendManagedBlock
      // decide — fail-safe (unknown → append). (Old same-day bodies still
      // parse — parseSelfUpdateBlock ignores the wrapper and mechanismSince.)
      const selfUpdateBlock =
        (
          shouldAppendManagedBlock(
            await newestPriorInstallerTag(octokit, installerTag(installerDate))
          )
        ) ?
          renderSelfUpdatePayload(installerDate, selfUpdateUrlByAsset)
        : '';
      if (!selfUpdateBlock) {
        console.log(
          dim(
            `  managed JSON block retired from the release body ` +
              `(a post-cutover installer release already shipped; #341)`
          )
        );
      }
      await syncComponentRelease(octokit, installerTag(installerDate), installerDate, assets, {
        kind: 'installer',
        selfUpdateUrlByAsset,
        selfUpdateBlock,
      });
    }
  } catch (err) {
    warn(`component releases sync failed (non-fatal): ${err.message}`);
  }
}
