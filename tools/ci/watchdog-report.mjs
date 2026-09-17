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
export const BROWSERS = ['firefox', 'firefox-dev', 'librewolf', 'floorp', 'zen', 'waterfox'];

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
  const newVersions = findings.filter(f => f.kind === 'new-version');
  const forks = [
    ...new Set(newVersions.map(f => f.browser).filter(b => FORK_BROWSERS.includes(b))),
  ];
  const hardGates = newVersions.some(f => VALIDATED_BROWSERS.includes(f.browser));
  const plans = forks.map(browser => ({browser, ref: 'main'}));
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
 * Markdown status table for the meta issue. `baseline` is the per-browser
 * record AFTER this run — a browser that failed keeps its previous entry, which
 * is exactly what the version-aware CI installer cache still serves (the
 * fallback column). `validated` is the E2E record (see validatedCell).
 */
export function buildStatusTable({results, baseline, validated}) {
  const rows = BROWSERS.map(browser => {
    const res = results[browser] || {status: 'ok'};
    const entry = baseline[browser] || {};
    const failed =
      res.status === 'lookup-failed' ||
      res.status === 'endpoint-failed' ||
      res.status === 'download-failed';
    const version = entry.version || '—';
    const sizeSha = `${formatSize(entry.size)} · ${shortSha(entry.sha256)}`;
    const lastCheck = formatCheck(entry.checkedAt, entry.checkedUrl);
    // The CI cache always holds the last verified version, green run or not —
    // show it unconditionally (the staleness suffix matters only on failure,
    // where it tells the operator how old the fallback is).
    const fallback =
      version === '—' ? '—'
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
  const changes = BROWSERS.filter(b => baseline[b]?.version).map(b => ({
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
