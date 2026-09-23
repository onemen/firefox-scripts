// tools/ci/watchdog-report.mjs — the URL watchdog's pure reporting layer
// (extracted from tools/check-browser-downloads.mjs, 2026-09 — the §3.1
// modularity split). No imports, no I/O: everything here is a pure function of
// its arguments, so the whole layer is unit-testable without network or
// GitHub API access.
//
// Ownership:
// - domain constants shared by the watchdog and the publish pre-flight
//   (BROWSERS, VALIDATED_BROWSERS, FORK_BROWSERS, the label/title constants)
// - drift classification (compareBaseline, collectDrift,
//   collectValidatedDrift) and the E2E dispatch planner (planDispatches)
// - GitHub-visible rendering: meta-issue status table, version history,
//   meta-issue body, failure-issue titles/bodies, and their formatters
//
// The watchdog keeps the network resolution, baseline persistence, GitHub API
// calls and CLI orchestration in tools/check-browser-downloads.mjs, which
// re-exports this module's names for its existing importers.

/** Browsers the E2E map installs or tracks — each must resolve its version. */
export const BROWSERS = [
  'firefox',
  'firefox-dev',
  'nightly',
  'librewolf',
  'floorp',
  'zen',
  'waterfox',
];

/**
 * Informational ledger rows: tracked in the meta issue (version + last check)
 * but never drift-blocking, never dispatched, never validated. Nightly changes
 * DAILY, so a normal ledger row would put permanent drift between weekly
 * watchdog runs and churn the version history — its real coverage stays the
 * required 3-OS `updater` E2E legs on every core/updater PR (ADR 0021
 * tiering).
 */
export const INFORMATIONAL_BROWSERS = ['nightly'];

/**
 * Browsers whose vendor replaces the binary WITHIN one version string: nightly
 * stays N.0a1 for ~2 weeks while Mozilla ships fresh dailies into it, so a
 * same-version size change there is by design, not a tamper signal (#276). The
 * watchdog re-verifies such a replacement with a full download + SHA-256 (same
 * as a version bump) instead of opening a size-change issue.
 */
export const ROLLING_BINARIES = new Set(['nightly']);

/** True when a same-version size change is expected for `browser` (#276). */
export function isRollingBinary(browser) {
  return ROLLING_BINARIES.has(browser);
}

/**
 * The dynamic ESR window: browser keys are `firefox-esr-<major>` (e.g.
 * `firefox-esr-140`), one ledger row + one advisory E2E leg per watched major.
 * The window is the two newest ESR majors, maintained by updateEsrState() from
 * Mozilla's product-details keys (`FIREFOX_ESR`, `FIREFOX_ESR_NEXT`) — never
 * hardcoded. Unlike the static BROWSERS these rows never reach the publish
 * drift gate (collectDrift iterates the static list), so an ESR release can
 * never block a prod publish; drift only dispatches the advisory leg.
 */
export const ESR_BROWSER_PREFIX = 'firefox-esr-';

export function esrBrowserKey(major) {
  return `firefox-esr-${major}`;
}

/** '140.16.0esr' → '140'; null when the string is not an ESR version. */
export function esrMajorOf(version) {
  // Two or three components: Mozilla has shipped both shapes across ESR
  // chains (140.16.0esr today; a x.yesr shape must still rotate the window).
  // Anchored + bounded alternation over a version string — no backtracking risk.
  // eslint-disable-next-line security/detect-unsafe-regex
  const m = /^(\d+)(?:\.\d+){1,2}esr$/.exec(String(version ?? ''));
  return m ? m[1] : null;
}

/**
 * Rotate the watched ESR window (pure).
 *
 * The window is ALWAYS the two newest known ESR majors: the watched set is
 * {previous majors} ∪ {FIREFOX_ESR's major} ∪ {FIREFOX_ESR_NEXT's major}, and
 * the top two by major number win. Consequences (all intended, see the ESR
 * watchdog design):
 *
 * - The serving key flipping which major it carries (e.g. FIREFOX_ESR moving 140
 *   → 153 on the overlap's end) changes NOTHING: 153 is already watched.
 * - When FIREFOX_ESR_NEXT brings a NEW major (e.g. 164 in ~Dec 2026), the window
 *   slides [140,153] → [153,164] and the dropped major leaves tracking.
 * - Cold start (no state): the two live keys seed the window; with NEXT absent
 *   the window degrades to the serving major alone (single leg) until state
 *   exists.
 *
 * Versions are refreshed from the live keys for the majors they serve; a
 * retired major keeps its last recorded version (and stays update-watchable
 * through the archive releases index — see browserResolver.mjs).
 *
 * @param {{majors: string[]; versions: Record<string, string>} | null} state
 *   the `esr` block from the watchdog baseline (null on first run)
 * @param {string | null} esrVersion live FIREFOX_ESR (null = lookup failed)
 * @param {string | null} nextVersion live FIREFOX_ESR_NEXT (null/empty =
 *   absent)
 * @returns {{
 *   state: {majors: string[]; versions: Record<string, string>};
 *   droppedMajors: string[];
 * }}
 *   dropped majors must be cleaned from the ledger (baseline entries + history)
 *   by the caller
 */
export function updateEsrState(state, esrVersion, nextVersion) {
  const known = new Set((state?.majors ?? []).map(Number));
  const live = [];
  for (const [version, key] of [
    [esrVersion, 'esr'],
    [nextVersion, 'next'],
  ]) {
    const major = esrMajorOf(version);
    if (!major) continue;
    known.add(Number(major));
    live.push([key, major, String(version)]);
  }
  const majors = [...known]
    .sort((a, b) => a - b)
    .slice(-2)
    .map(String);
  const droppedMajors = (state?.majors ?? []).filter(m => !majors.includes(m));
  const versions = {...(state?.versions ?? {})};
  for (const m of droppedMajors) delete versions[m];
  // Refresh only majors that are still watched — a live key can serve a major
  // this same rotation just dropped (ESR=140 while NEXT announces 164):
  // re-recording it would keep the dropped line alive in the cache.
  for (const [, major, version] of live) {
    if (majors.includes(major)) versions[major] = version;
  }
  return {state: {majors, versions}, droppedMajors};
}

/**
 * Ledger row keys for the watched ESR majors, lowest major first — the meta
 * issue table, the history seed and the CI matrix are all built from these.
 *
 * @param {{majors: string[]} | null | undefined} esrState
 * @returns {string[]}
 */
export function esrLedgerNames(esrState) {
  const majors = Array.isArray(esrState?.majors) ? esrState.majors : [];
  return majors.map(esrBrowserKey);
}

/**
 * The dynamic matrix JSON for the `esr-portable` E2E job: one leg per watched
 * ESR major. Empty state (cold cache) → the generic serving-ESR key
 * (`firefox-esr`), which resolves its version at run time from Mozilla's keys —
 * degradation, never a hardcoded version.
 *
 * @param {{majors: string[]} | null | undefined} esrState
 * @returns {string} e.g. '["firefox-esr-140", "firefox-esr-153"]'
 */
export function buildEsrMatrix(esrState) {
  const names = esrLedgerNames(esrState);
  return JSON.stringify(names.length > 0 ? names : ['firefox-esr']);
}

/**
 * Browsers whose current version must be covered by a successful E2E run before
 * a prod publish (the hard-gated `updater` legs — firefox/firefox-dev/nightly
 * on all 3 OSes, waterfox on Windows).
 *
 * Waterfox soak (ADR 0021) completed: 4 consecutive green advisory runs
 * (2026-09-05 ×2, 2026-09-09 ×2 — the latter two against the freshly released
 * 6.7.2), so it graduated to the hard gate (ADR 0025): a required
 * `updater-waterfox` E2E leg (Windows-only — its download recipe is the Windows
 * NSIS installer) and publish-drift coverage via this list.
 */
export const VALIDATED_BROWSERS = ['firefox', 'firefox-dev', 'waterfox'];

/**
 * Fork browsers whose version lookup may degrade to warn-and-continue in the
 * publish pre-flight (ADR 0021): after the resolver's retry + mirror chain is
 * exhausted, an unresolved fork lookup warns, notifies, and lets the publish
 * proceed. Fork DRIFT (resolved but newer than the baseline) still blocks.
 *
 * Waterfox is NOT here anymore (ADR 0025): as a hard-gate browser its lookup
 * failure blocks a publish, exactly like firefox/firefox-dev.
 */
export const FORK_BROWSERS = ['librewolf', 'floorp', 'zen'];

export const WATCHDOG_LABEL = 'url-watchdog';
/** Single status + ledger issue updated after each weekly run. */
export const META_ISSUE_TITLE = '[url-watchdog] status';

/**
 * Version-history cap per browser: each browser keeps its last N transition
 * entries in the meta issue. Per-browser (not per-run) so a chatty browser
 * cannot evict a quiet one's only history, and bounded overall at
 *
 * |BROWSERS| × N lines.
 */
export const HISTORY_PER_BROWSER = 3;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Pure planner for the post-baseline E2E auto-dispatch (issue #143): map
 * new-version findings to E2E workflow dispatches.
 *
 * - Fork browsers each get a single-browser dispatch — the `browser` input
 *   collapses the matrix to that leg (the ADR 0021 manual escape, whose runs
 *   sit in their own non-cancelled concurrency group).
 * - The hard-gate browsers share ONE full dispatch (`browser=all`): it runs the
 *   updater legs (incl. the required waterfox leg, ADR 0025) on their OSes and
 *   record-validation, refreshing the validated-versions record the publish
 *   gate reads. One dispatch, never two — a second full dispatch would land in
 *   the same cancel-in-progress concurrency group and kill the first.
 *
 * `first-run` findings are deliberately excluded: a cache eviction re-baselines
 * without any release having shipped. Fork dispatches are capped at the fork
 * browser set, so a malformed findings list cannot spam the API.
 *
 * @param {{kind: string; browser: string}[]} findings
 * @returns {{browser?: string; ref: string}[]} dispatch payloads in issue order
 *   (`browser` absent = full matrix)
 */
export function planDispatches(findings) {
  // Informational rows (nightly) never dispatch — their coverage is the PR
  // legs, and a weekly-churning channel would spam the dispatch API.
  const newVersions = findings.filter(
    f => f.kind === 'new-version' && !INFORMATIONAL_BROWSERS.includes(f.browser)
  );
  const forks = [
    ...new Set(newVersions.map(f => f.browser).filter(b => FORK_BROWSERS.includes(b))),
  ];
  const hardGates = newVersions.some(f => VALIDATED_BROWSERS.includes(f.browser));
  // Any watched ESR major drifting (point release on the serving line, or the
  // archive-index catch on a retired line) → ONE dispatch that runs the whole
  // esr-portable matrix — both current ESR legs — via the `browser=firefox-esr`
  // escape input. One dispatch, never two: a second would land in the same
  // non-cancelled escape concurrency group and kill the first.
  const esr = newVersions.some(
    f => typeof f.browser === 'string' && f.browser.startsWith(ESR_BROWSER_PREFIX)
  );
  const plans = forks.map(browser => ({browser, ref: 'main'}));
  if (esr) plans.push({browser: 'firefox-esr', ref: 'main'});
  if (hardGates) plans.push({ref: 'main'});
  return plans;
}

/**
 * Classify a browser's version change against the previous baseline.
 *
 * @param {{version: string} | null} prev baseline entry for the browser
 * @param {{version: string}} curr freshly resolved version
 * @returns {'first-run' | 'new-version' | 'ok'}
 */
export function compareBaseline(prev, curr) {
  if (!prev) return 'first-run';
  return prev.version !== curr.version ? 'new-version' : 'ok';
}

/**
 * Diff a baseline map (as written by the watchdog) against freshly resolved
 * versions. Returns a list of human-readable drift strings; empty = no drift.
 * Used by the pre-publish gate: a browser released since the last watchdog run
 * must be validated (watchdog → browser E2E) before artifacts ship.
 *
 * `ignoreLookupFailureFor` (ADR 0021 warn-and-continue): fork browsers whose
 * version could not be resolved are omitted from the blocking list — the caller
 * surfaces them as a warning + notification instead. A fork that DID resolve
 * but drifted still blocks, as does any hard-gate lookup failure.
 *
 * @param {Record<string, {version: string} | undefined>} baseline
 * @param {Record<string, string | undefined>} versions current version per
 *   browser
 * @param {{ignoreLookupFailureFor?: string[]}} [opts]
 * @returns {string[]}
 */
export function collectDrift(baseline, versions, {ignoreLookupFailureFor = []} = {}) {
  const drift = [];
  for (const browser of BROWSERS) {
    // Informational rows (nightly) are never publish-gate inputs — a lookup
    // failure or version bump on them must not block a prod publish. The
    // dynamic ESR rows are dispatch-only and never appear in the static list.
    if (INFORMATIONAL_BROWSERS.includes(browser)) continue;
    const prev = baseline[browser];
    const curr = versions[browser];
    if (curr === undefined || curr === null || curr === '') {
      if (!ignoreLookupFailureFor.includes(browser)) {
        drift.push(`${browser}: version lookup failed`);
      }
    } else if (!prev) {
      drift.push(`${browser}: not in baseline (first run — run the watchdog first)`);
    } else if (String(prev.version) !== String(curr)) {
      drift.push(`${browser}: ${prev.version} → ${curr}`);
    }
  }
  return drift;
}

/**
 * Diff the validated-versions record (written only by successful browser E2E
 * runs, see tools/ci/record-validated-versions.mjs) against freshly resolved
 * versions. Returns a list of human-readable drift strings; empty = the current
 * releases are exactly what E2E validated.
 *
 * Unlike collectDrift, a browser missing from the record is drift even on a
 * "first run": the prod pre-flight must never pass on an absent validation.
 *
 * @param {Record<string, {version: string} | undefined>} validated
 * @param {Record<string, string | undefined>} versions current version per
 *   browser
 * @returns {string[]}
 */
export function collectValidatedDrift(validated, versions) {
  const drift = [];
  for (const browser of VALIDATED_BROWSERS) {
    const entry = validated[browser];
    const curr = versions[browser];
    if (curr === undefined || curr === null || curr === '') {
      drift.push(`${browser}: version lookup failed`);
    } else if (
      !entry ||
      entry.version === undefined ||
      entry.version === null ||
      entry.version === ''
    ) {
      drift.push(`${browser}: never validated — no successful E2E run recorded this version`);
    } else if (String(entry.version) !== String(curr)) {
      drift.push(`${browser}: E2E validated ${entry.version}, current release is ${curr}`);
    }
  }
  return drift;
}

/**
 * Human-readable age from a millisecond span — e.g. '3d 2h', '5h 12m', '8m'.
 * Clamped to 0 so clock skew never prints negative.
 */
export function formatAge(ms) {
  const min = Math.max(0, Math.floor(ms / 60_000));
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ${min % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

/**
 * Short UTC date for run links ('Sep 5') — the visible text; the full run URL
 * only ever lives behind the link.
 */
export function formatRunDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** Human size in MB with one decimal ('91.7 MB'), '—' when unknown. */
export function formatSize(bytes) {
  if (!bytes) return '—';
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/** First 6 chars of a SHA-256, backticked for the table. */
export function shortSha(sha256) {
  return sha256 ? `\`${sha256.slice(0, 6)}…\`` : '—';
}

/** A short `[Sep 5](run-url)` link, or the bare date when the URL is unknown. */
export function formatCheck(iso, url) {
  const date = formatRunDate(iso);
  return url ? `[${date}](${url})` : date;
}

/**
 * Status tag for the last check of a browser. `results[browser].status` is set
 * by the watchdog's main loop: 'ok' | 'new-version' | 'first-run' |
 * 'lookup-failed' | 'endpoint-failed' | 'download-failed' | 'size-change'.
 */
export function statusTag(status) {
  switch (status) {
    case 'ok':
      return '✅ up to date';
    case 'new-version':
      return '🆕 new version';
    case 'first-run':
      return '⏳ first run';
    case 'lookup-failed':
      return '❌ lookup failed';
    case 'endpoint-failed':
      return '⚠️ endpoint failed';
    case 'download-failed':
      return '⚠️ download failed';
    case 'size-change':
      return '🔄 size changed';
    case 'report-only':
      return 'ℹ️ not checked';
    default:
      return status || '—';
  }
}

/**
 * E2E-validated cell for the status table: `✅ <version>` when a successful E2E
 * run validated exactly the baseline version, `⏳ <older>` when the record shows
 * an earlier release (current one not yet E2E-tested), `⏳ none` when there is
 * no record, and '—' for the advisory fork browsers that the validated-versions
 * record does not cover.
 */
export function validatedCell(browser, entry, validated) {
  if (!VALIDATED_BROWSERS.includes(browser)) return '—';
  const v = validated?.browsers?.[browser]?.version;
  if (!v) return '⏳ none';
  return v === entry?.version ? `✅ ${v}` : `⏳ ${v}`;
}

/**
 * Human-readable duration for the meta-issue download-time cell ('13s', '4m
 * 12s'); '—' when unknown (browser never fully downloaded this version).
 */
export function formatDownloadMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

/**
 * Escape a value interpolated into a markdown table cell: an unescaped pipe
 * would split the cell on github.com (silently shifting/dropping the cells
 * after it), and a raw line break would split the ROW into extra markdown rows.
 * Values are vendor-served (version strings, checked URLs), so treat them as
 * hostile. Backslashes are escaped first so a pre-escaped backslash pipe
 * sequence can't become live again; an escaped pipe renders as a literal pipe
 * and does NOT split — cmark-gfm splits the raw row before inline parsing, so
 * no code-span awareness is needed.
 */
export function escapeTableCell(value) {
  // Backslashes first (a pre-escaped \| can't become live again), then line
  // breaks (a raw \r/\n would split the ROW into extra markdown rows — same
  // failure class as a pipe), then pipes.
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\|/g, '\\|');
}

/**
 * Cache-key prefixes per (non-fork) browser ledger name, used to attribute
 * opaque URL-hash cache keys to browsers. The Mozilla namespace is SHARED:
 * firefox, firefox-dev, nightly and waterfox all cache under `firefox-dl-`
 * (different URLs → different hashes, indistinguishable offline). Attribution
 * is therefore at NAMESPACE level and duplicated across the consumers (each
 * sees the whole namespace's keys) — the inventory proves presence/age; the
 * VERSION still comes from the baseline entry (what the last verified download
 * cached). `firefox` also matches the portable job's namespace; the advisory
 * ESR legs use `esr-portable-`.
 */
export function cacheKeyPrefixesFor(browser) {
  if (FORK_BROWSERS.includes(browser)) return []; // sticky namespace, parsed separately
  if (browser === 'firefox') return ['firefox-dl-', 'firefox-portable-'];
  if (browser.startsWith('firefox-esr')) return ['esr-portable-'];
  return ['firefox-dl-']; // firefox-dev, nightly, waterfox
}

/**
 * One sticky fork cache key: `browser-dl-<OS>-<browser>[-portable]-v<version>`
 * (ADR 0034). The extracted-dir twin (`…-portable-dir-v…`) does NOT match — the
 * `dir` segment cannot be absorbed by `[a-z]+`, so dir entries never double-
 * count the same release. Hard-gate URL-hash keys (`<prefix>-<OS>-<hex>`) can't
 * match either: hex hashes contain no dash before `-v` and never start with a
 * letter followed by a `-v` boundary. (Old dead fork keys from the URL-hash
 * regime, `browser-dl-<OS>-<hex>`, are hex — also no match.)
 */
const FORK_STICKY_RE = /^browser-dl-[^-]+-([a-z]+)(?:-portable)?-v(\S+)$/;

/**
 * Group the repo's Actions-cache entries (as returned by the caches API:
 * `[{key, createdAt}]`) per browser ledger name. Fork browsers are attributed
 * exactly (their sticky keys name the browser); Mozilla-family browsers are
 * attributed per the shared-namespace rule of cacheKeyPrefixesFor — every
 * consumer of a namespace sees that namespace's whole key list. Unknown keys
 * (pnpm, node-cache, the watchdog's own caches) land nowhere.
 */
export function groupCacheKeysByBrowser(entries, browsers) {
  const groups = {};
  for (const name of browsers) groups[name] = [];
  for (const entry of entries) {
    const sticky = FORK_STICKY_RE.exec(entry.key);
    if (sticky && FORK_BROWSERS.includes(sticky[1])) {
      groups[sticky[1]]?.push(entry);
      continue;
    }
    for (const name of browsers) {
      if (cacheKeyPrefixesFor(name).some(prefix => entry.key.startsWith(prefix))) {
        groups[name].push(entry);
      }
    }
  }
  return groups;
}

/**
 * Truthful Fallback (CI cache) cell from the live cache inventory.
 *
 * - Fork browsers: the version is decoded from the sticky key itself (the key IS
 *   the ground truth — it is named after the installed version that saved it),
 *   so the cell cannot drift from the cache the way a baseline-derived cell
 *   could (issue #136: the table showed a version the cache no longer held
 *   after a key-regime change).
 * - Hard gates: version comes from the baseline entry (hash keys carry no
 *   version); the inventory proves the entry still exists and how fresh it is.
 * - No matching keys: `⚠️ cache miss` when a baseline version exists (the cache
 *   was evicted — the next leg re-downloads), '—' when there is nothing to fall
 *   back to at all.
 *
 * The age suffix is the newest matching entry's age: for forks that is the
 * watchdog validation run that saved the release; for hard gates the last
 * version-bump download.
 */
export function cacheFallbackCell(browser, keys, entry, {now = Date.now()} = {}) {
  const list = Array.isArray(keys) ? keys : [];
  if (list.length === 0) return entry?.version ? '⚠️ cache miss' : '—';
  const newest = Math.max(...list.map(k => Date.parse(k.createdAt) || 0));
  const age = newest > 0 && now > newest ? ` · ${formatAge(now - newest)}` : '';
  if (FORK_BROWSERS.includes(browser)) {
    const sticky = list.map(k => FORK_STICKY_RE.exec(k.key)).find(Boolean);
    if (sticky) return `cached: ${sticky[2]}${age}`;
    return entry?.version ? `cached: ${entry.version}${age}` : 'cached (unknown version)';
  }
  return entry?.version ? `cached: ${entry.version}${age}` : 'cached (unknown version)';
}

/**
 * Markdown status table for the meta issue. `baseline` is the per-browser
 * record AFTER this run — a browser that failed keeps its previous entry, which
 * is exactly what the version-aware CI installer cache still serves (the
 * fallback column). `validated` is the E2E record (see validatedCell).
 *
 * `cache` (optional) is the live Actions-cache inventory grouped per browser
 * (groupCacheKeysByBrowser). When provided, the Fallback column is derived from
 * the REAL keys — decoded version + age for forks (ADR 0034 sticky namespace),
 * presence + age for the shared Mozilla namespace — instead of the
 * baseline-derived approximation. Omitted (local runs, PR mode): the column
 * renders exactly as before. `now` pins the clock for deterministic tests.
 */
export function buildStatusTable({results, baseline, validated, browsers = BROWSERS, cache, now}) {
  const rows = browsers.map(browser => {
    const res = results[browser] || {status: 'ok'};
    const entry = baseline[browser] || {};
    const failed =
      res.status === 'lookup-failed' ||
      res.status === 'endpoint-failed' ||
      res.status === 'download-failed';
    const version = entry.version || '—';
    // Informational rows (nightly) and rows that never fully downloaded carry
    // no size/hash — render a clean dash instead of '— · —'.
    const sizeSha =
      entry.size || entry.sha256 ? `${formatSize(entry.size)} · ${shortSha(entry.sha256)}` : '—';
    const lastCheck = formatCheck(entry.checkedAt, entry.checkedUrl);
    // The CI cache always holds the last verified version, green run or not —
    // show it unconditionally. With a live inventory the cell is cache-backed
    // (cacheFallbackCell — real keys, ages, and fork versions decoded from the
    // sticky keys, issue #136); without one, the baseline-derived view stands
    // (the staleness suffix matters only on failure, where it tells the
    // operator how old the fallback is).
    const fallback =
      version === '—' ? '—'
      : cache ? cacheFallbackCell(browser, cache[browser] || [], entry, {now: now ?? Date.now()})
      : failed ? `cached: ${version} · ${lastCheck}`
      : `cached: ${version}`;
    // Download time of the last VERIFIED full download — the transfer-speed
    // history for the vendor hosts (issue #136). Unknown until a browser's
    // version has been fully downloaded at least once.
    const downloadTime = formatDownloadMs(entry.downloadMs);
    const e2e = validatedCell(browser, entry, validated);
    // Every variable value goes through escapeTableCell: the row's cell
    // count must never depend on what a vendor feed returned (issue #136).
    return `| ${browser} | ${escapeTableCell(version)} | ${escapeTableCell(sizeSha)} | ${escapeTableCell(lastCheck)} | ${escapeTableCell(statusTag(res.status))} | ${escapeTableCell(fallback)} | ${escapeTableCell(downloadTime)} | ${escapeTableCell(e2e)} |`;
  });
  return [
    '| Browser | Last verified | Size · SHA-256 | Last check | Status | Fallback (CI cache) | Download time | E2E validated |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

/**
 * Append one version-history entry per run with real updates ({date, runUrl,
 * changes: [{browser, prevVersion, newVersion, size, sha256, downloadMs}]}).
 * Capped per browser at HISTORY_PER_BROWSER — an entry whose every change
 * overflowed a browser's cap is dropped; one that only partially overflows
 * keeps its under-cap changes (splitting preserves the other browsers' data,
 * and the rendered line still carries the same date/run link).
 */
export function updateHistory(history, entry, {perBrowser = HISTORY_PER_BROWSER} = {}) {
  const next = [...history, entry];
  // Total recorded occurrences per browser across the whole (new) history.
  const totals = {};
  for (const h of next) {
    for (const c of h.changes ?? []) {
      if (c.browser) totals[c.browser] = (totals[c.browser] ?? 0) + 1;
    }
  }
  // Walk oldest → newest, keeping each browser's LAST perBrowser occurrences.
  const seen = {};
  const out = [];
  for (const h of next) {
    const changes = h.changes ?? [];
    const kept = changes.filter(c => {
      if (!c.browser) return true;
      seen[c.browser] = (seen[c.browser] ?? 0) + 1;
      return seen[c.browser] > totals[c.browser] - perBrowser;
    });
    if (kept.length === 0) continue;
    out.push(kept.length === changes.length ? h : {...h, changes: kept});
  }
  return out;
}

/**
 * Seed the version history from the current baseline (used until the first real
 * update run persists a history entry — e.g. when the meta issue is first
 * created mid-life). Deliberately date-free so the rendered body stays stable
 * across no-op runs.
 */
export function seedHistoryFromBaseline(baseline) {
  const tracked = [...BROWSERS, ...esrLedgerNames(baseline.esr)];
  const changes = tracked
    .filter(b => baseline[b]?.version)
    .map(b => ({
      browser: b,
      version: baseline[b].version,
      size: baseline[b].size,
      sha256: baseline[b].sha256,
      downloadMs: baseline[b].downloadMs,
    }));
  return changes.length ? [{kind: 'baseline', changes}] : [];
}

/** Render the version-history section lines ('- [Sep 5](run) — update: …'). */
export function renderHistory(history) {
  return history
    .map(h => {
      const items = h.changes
        .map(c => {
          const sha = shortSha(c.sha256);
          const dl =
            formatDownloadMs(c.downloadMs) === '—' ? '' : ` · ${formatDownloadMs(c.downloadMs)}`;
          if (h.kind === 'baseline') {
            return `${c.browser} ${c.version} · ${formatSize(c.size)} · ${sha}${dl}`;
          }
          return `${c.browser} ${c.prevVersion} → ${c.newVersion} · ${formatSize(c.size)} · ${sha}${dl}`;
        })
        .join(' · ');
      const label =
        h.kind === 'baseline' ? 'baseline' : `${formatCheck(h.date, h.runUrl)} — update`;
      return `- ${label}: ${items}`;
    })
    .join('\n');
}

/**
 * Static intro for the meta issue: what the watchdog is and that the body is
 * bot-maintained. Constant, so it never churns the body on its own — the body
 * still only changes when the table or the history changes.
 */
const WATCHDOG_INTRO = `This is the status page for the **URL watchdog** — the weekly workflow
(.github/workflows/url-watchdog.yml) that re-resolves every browser's latest version from its
vendor API, verifies the download endpoint, and re-baselines the SHA-256 ledger on new releases
(each new release also dispatches the browser E2E). The table and history below are bot-maintained
and rewritten each run; download failures and size changes open separate [url-watchdog] issues that
auto-close once the browser checks green again.`;

/**
 * Meta-issue body: the static intro + the status table + the version history.
 * No run date in the header on purpose — the body must only change when the
 * table or the history changes, so fully-green no-op runs do not churn the
 * issue.
 */
export function buildMetaIssueBody({table, history}) {
  const historyBlock =
    history ? `\n\n## Version history (runs with real updates)\n\n${history}\n` : '';
  return `## Watchdog status\n\n${WATCHDOG_INTRO}\n\n${table}${historyBlock}`;
}

/**
 * True when the title is a failure/size issue for `browser` — the set the
 * watchdog auto-closes once the browser checks green again.
 */
export function isFailureIssueTitle(browser, title) {
  return (
    title.startsWith(`[url-watchdog] ${browser} download check failed:`) ||
    title === `[url-watchdog] ${browser} version lookup failed` ||
    title === `[url-watchdog] ${browser} same version, binary size changed`
  );
}

/**
 * The dedup key for an issue: exact-title match against open issues carrying
 * the url-watchdog label, so a re-run never duplicates an open finding.
 */
export function issueTitle(kind, browser, {prevVersion, newVersion, reason} = {}) {
  if (kind === 'rot') {
    return `[url-watchdog] ${browser} download check failed: ${reason}`;
  }
  if (kind === 'lookup-failure') {
    // Fixed title (no error text): the dedup key must match across runs so a
    // recurring vendor stall comments on one issue instead of spawning new ones.
    return `[url-watchdog] ${browser} version lookup failed`;
  }
  if (kind === 'size-change') {
    return `[url-watchdog] ${browser} same version, binary size changed`;
  }
  return `[url-watchdog] ${browser} ${prevVersion} → ${newVersion}`;
}

/**
 * Markdown body for a watchdog issue. Used for error findings (rot,
 * size-change, lookup-failure); the new-version branch is kept for the unit
 * tests + API stability, but the release ledger now lives in the meta issue
 * (buildMetaIssueBody), not in per-release issues.
 *
 * @param {{
 *   kind: string;
 *   browser: string;
 *   reason?: string;
 *   prevVersion?: string;
 *   newVersion?: string;
 *   prevSize?: number;
 *   newSize?: number;
 *   size?: number;
 *   sha256?: string;
 * }} f
 * @param {string} runUrl
 */
export function issueBody(f, runUrl = 'local') {
  const head = `Watchdog run: ${runUrl}\n\n`;
  if (f.kind === 'rot') {
    return (
      head +
      `The ${f.browser} download chain failed:\n\n- ${f.reason}\n\n` +
      'Check test/e2e/shared/downloads.mjs and the vendor host; E2E CI installs ' +
      'this browser from the resolved URL.'
    );
  }
  if (f.kind === 'lookup-failure') {
    return (
      head +
      `The ${f.browser} version lookup failed after the resolver's retry + mirror ` +
      `chain was exhausted:\n\n- ${f.reason}\n\n` +
      (f.context === 'drift' ?
        'The publish pre-flight continued (fork browsers are warn-and-continue, ' +
        'ADR 0021) — the shipped artifacts were NOT re-validated against a fresh ' +
        `${f.browser} release. Re-run the URL watchdog when the vendor recovers.`
      : 'The watchdog run failed WITHOUT saving a baseline (fail-closed, ADR 0021) ' +
        '— re-run the URL watchdog workflow when the vendor recovers. E2E legs ' +
        'fall back to their cached installer meanwhile.')
    );
  }
  if (f.kind === 'size-change') {
    return (
      head +
      `The ${f.browser} installer changed size without a version bump ` +
      `(${f.prevSize} → ${f.newSize} bytes). The host likely replaced the binary ` +
      '— verify it is still the official release.'
    );
  }
  return (
    head +
    `New ${f.browser} release: ${f.prevVersion} → ${f.newVersion}.\n\n` +
    `Verified SHA-256 (${f.size} bytes): \`${f.sha256}\`\n\n` +
    'No action required unless E2E CI starts failing; the version-aware ' +
    'download cache key will invalidate on the next run.'
  );
}
