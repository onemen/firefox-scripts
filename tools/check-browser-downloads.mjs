#!/usr/bin/env node

/**
 * tools/check-browser-downloads.mjs — watchdog for the E2E browser download map
 * (test/e2e/shared/downloads.mjs).
 *
 * Runs in three modes (two driven by .github/workflows/url-watchdog.yml, one by
 * the Pages publish pre-flight):
 *
 * - Weekly (schedule/workflow_dispatch). For each browser CI installs it:
 *
 *   1. VERSION — reads the current release version from the vendor's API (Firefox
 *        product-details, LibreWolf Codeberg packages, Floorp / Zen / Waterfox
 *        GitHub releases). Nothing is downloaded.
 *   2. ENDPOINT — fetches the resolved installer URL with a 1 KB range request and
 *        asserts the host still serves a binary (2xx, binary content-type,
 *        plausible size). Catches 404s, HTML error pages and hosts that changed
 *        shape.
 *   3. SHA-256 — when the version changed since the last run (or on the first run),
 *        downloads the installer once, hashes it and records {version, size,
 *        sha256} in the baseline (.watchdog/baseline.json, stored in the
 *        Actions cache). Same-version runs re-check only the 1 KB range, but
 *        flag a size change (binary replaced without a bump). Each run logs the
 *        baseline's cache-hit status and age, so a silently evicted cache is
 *        visible instead of masquerading as a first run.
 *   4. META ISSUE — one `[url-watchdog] status` issue is kept current after every
 *        run: a per-browser status table (last verified version, size +
 *        SHA-256, the run that last checked it, a status tag, the CI-cache
 *        fallback version for failed browsers, and the E2E-validated version
 *        for the hard-gate browsers) plus a version history that only grows on
 *        runs with real version updates — the durable SHA-256 ledger (search
 *        `label:url-watchdog` for it).
 *   5. ERROR ISSUES — rot and same-version size changes still open their own issue,
 *        deduped per browser (the exact issue title is matched against open
 *        issues carrying the `url-watchdog` label); the watchdog auto-closes
 *        any open failure issue for a browser once a later run checks it green
 *        again.
 * - PR (pull_request touching the download map): stateless and always green —
 *   findings surface as ::warning:: / ::notice:: annotations, so the check can
 *   be marked required without ever blocking. No baseline, no issues, no full
 *   downloads.
 * - Drift (--drift, the Pages publish pre-flight): re-resolves every browser's
 *   current version and diffs it against the last watchdog baseline. No
 *   downloads, no issues. Exit 1 on drift so a prod publish is blocked until
 *   the watchdog refreshes the baseline and triggers the browser-specific E2E.
 *
 * Every browser in the E2E map — including waterfox, which resolves its CDN
 * installer since ADR 0021 — gets the full version + endpoint + SHA-256
 * treatment.
 *
 * Requires GITHUB_TOKEN with issues: write for issue creation; without it, or
 * with --dry-run, findings are printed instead. Exit code stays 0 when findings
 * are reported (they become issues / annotations, not CI failures).
 */

import {createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {resolveBrowserVersion} from '../test/e2e/shared/browserResolver.mjs';
import {downloadTo, resolveDownloadUrl} from '../test/e2e/shared/downloads.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const REPO_ROOT = path.resolve(__dirname, '..');

export const WATCHDOG_LABEL = 'url-watchdog';
/** Single status + ledger issue updated after each weekly run. */
export const META_ISSUE_TITLE = '[url-watchdog] status';
const MIN_BINARY_BYTES = 10_000_000; // installers are ~100 MB; smaller = wrong file
const RANGE_BYTES = 1024;
/** Version-history entries kept in the meta issue (oldest trimmed). */
const HISTORY_MAX = 10;
/**
 * Statuses that prove a browser checked green — their failure issues
 * auto-close.
 */
const OK_STATUSES = new Set(['ok', 'new-version', 'first-run']);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Browsers the E2E map installs or tracks — each must resolve its version. */
const BROWSERS = ['firefox', 'firefox-dev', 'librewolf', 'floorp', 'zen', 'waterfox'];

/**
 * Browsers whose current version must be covered by a successful E2E run before
 * a prod publish (the hard-gated `updater` legs on all 3 OSes). Fork legs are
 * advisory, so they stay on the watchdog-baseline check only.
 *
 * Waterfox soak (ADR 0021): its E2E leg runs advisory for its first green runs;
 * once stable, add 'waterfox' here AND move the leg from the gate's `advisory`
 * to `required` in e2e.yml (one line each).
 */
export const VALIDATED_BROWSERS = ['firefox', 'firefox-dev'];

/**
 * Fork browsers whose version lookup may degrade to warn-and-continue in the
 * publish pre-flight (ADR 0021): after the resolver's retry + mirror chain is
 * exhausted, an unresolved fork lookup warns, notifies, and lets the publish
 * proceed. Fork DRIFT (resolved but newer than the baseline) still blocks.
 */
export const FORK_BROWSERS = ['librewolf', 'floorp', 'zen', 'waterfox'];

/**
 * Resolve the current release version for a browser via the shared resolver
 * (retry + mirror chains; LibreWolf bsys6-first, waterfox GitHub→CDN).
 */
export async function resolveVersion(browser) {
  const {version} = await resolveBrowserVersion(browser);
  return version;
}

/** Parse a Content-Range header ('bytes 0-1023/104857600') → total size. */
export function parseContentRange(header) {
  if (!header) return null;
  const m = /\/\s*(\d+)\s*$/.exec(header);
  return m ? Number(m[1]) : null;
}

/**
 * Verify a download endpoint serves a binary: 2xx, binary content-type, and a
 * plausible size. A 1 KB ranged GET; the body stream is cancelled after the
 * first chunk so a server ignoring Range still costs ~one chunk, not 100 MB.
 */
async function checkEndpoint(url) {
  let res;
  try {
    res = await fetch(url, {
      headers: {Range: `bytes=0-${RANGE_BYTES - 1}`},
      redirect: 'follow',
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    return {ok: false, reason: `fetch failed: ${err.message}`};
  }
  try {
    if (!res.ok) return {ok: false, reason: `HTTP ${res.status} ${res.statusText}`};
    const type = (res.headers.get('content-type') || '').toLowerCase();
    if (
      !/application\/(octet-stream|x-msdownload|x-msdos-program)|application\/zip|^binary\//.test(
        type
      )
    ) {
      return {ok: false, reason: `unexpected content-type '${type}'`};
    }
    const total = parseContentRange(res.headers.get('content-range')) || 0;
    if (total && total < MIN_BINARY_BYTES) {
      return {ok: false, reason: `suspiciously small (${total} bytes)`};
    }
    if (res.body) {
      const reader = res.body.getReader();
      await reader.read(); // first chunk (≤ 64 KB) — enough to confirm it's a download
      await reader.cancel();
    }
    // null (not 0) when the server ignored Range and reported no total, so
    // callers can tell "unknown" apart from a zero-byte response.
    return {ok: true, total: total || null};
  } finally {
    // Best-effort: drain/cancel is handled above; nothing further to release.
  }
}

/**
 * Stream-hash a file. Exported for unit tests.
 *
 * @param {string} file
 * @returns {Promise<string>} lowercase hex SHA-256
 */
export async function sha256File(file) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  return hash.digest('hex');
}

/**
 * One-time full download + hash for a release, proving the whole file transfers
 * (not just the first KB) and recording a known-good SHA-256. The temp file is
 * removed afterwards — only the hash persists in the baseline.
 */
async function verifyFullDownload(url, browser) {
  const tmp = path.join(os.tmpdir(), `watchdog-${browser}-${process.pid}.exe`);
  try {
    await downloadTo(url, tmp);
    const sha256 = await sha256File(tmp);
    return {ok: true, size: fs.statSync(tmp).size, sha256};
  } catch (err) {
    return {ok: false, reason: `full download failed: ${err.message}`};
  } finally {
    fs.rmSync(tmp, {force: true});
  }
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
 * Exported for unit tests; clamped to 0 so clock skew never prints negative.
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
 * by the main loop: 'ok' | 'new-version' | 'first-run' | 'lookup-failed' |
 * 'endpoint-failed' | 'download-failed' | 'size-change'.
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
    const fallback = failed ? `cached: ${version} · ${lastCheck}` : '—';
    const e2e = validatedCell(browser, entry, validated);
    return `| ${browser} | ${version} | ${sizeSha} | ${lastCheck} | ${statusTag(res.status)} | ${fallback} | ${e2e} |`;
  });
  return [
    '| Browser | Last verified | Size · SHA-256 | Last check | Status | Fallback (CI cache) | E2E validated |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

/**
 * Append one version-history entry per run with real updates ({date, runUrl,
 * changes: [{browser, prevVersion, newVersion, size, sha256}]}). Capped at
 * HISTORY_MAX — the oldest entries are trimmed.
 */
export function updateHistory(history, entry, {max = HISTORY_MAX} = {}) {
  const next = [...history, entry];
  return next.length > max ? next.slice(next.length - max) : next;
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
          if (h.kind === 'baseline') {
            return `${c.browser} ${c.version} · ${formatSize(c.size)} · ${sha}`;
          }
          return `${c.browser} ${c.prevVersion} → ${c.newVersion} · ${formatSize(c.size)} · ${sha}`;
        })
        .join(' · ');
      const label =
        h.kind === 'baseline' ? 'baseline' : `${formatCheck(h.date, h.runUrl)} — update`;
      return `- ${label}: ${items}`;
    })
    .join('\n');
}

/**
 * Meta-issue body: the status table + the version history. No run date in the
 * header on purpose — the body must only change when the table or the history
 * changes, so fully-green no-op runs do not churn the issue.
 */ export function buildMetaIssueBody({table, history}) {
  const historyBlock =
    history ? `\n\n## Version history (runs with real updates)\n\n${history}\n` : '';
  return `## Watchdog status\n\n${table}${historyBlock}`;
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

/** Minimal GitHub REST helper (issues only). */
async function ghApi(token, pathname, {method = 'GET', body} = {}) {
  const res = await fetch(`https://api.github.com${pathname}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? {'Content-Type': 'application/json'} : {}),
    },
    ...(body ? {body: JSON.stringify(body)} : {}),
    signal: AbortSignal.timeout(30_000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`GitHub API ${method} ${pathname}: HTTP ${res.status} ${json.message || ''}`);
  }
  return json;
}

/** Find an open url-watchdog issue by exact title (null when absent). */
async function findOpenIssueByTitle(token, repo, title) {
  const open = await ghApi(
    token,
    `/repos/${repo}/issues?state=open&labels=${WATCHDOG_LABEL}&per_page=100`
  );
  return open.find(i => i.title === title) || null;
}

/** Open a watchdog issue unless an open one with the same title already exists. */
async function openIssueIfNew(token, repo, title, body) {
  const existing = await findOpenIssueByTitle(token, repo, title);
  if (existing) {
    // Recurring failure: append a comment with the fresh run link instead of
    // leaving the issue stale, so the notification stays actionable — but no
    // more than one comment per 24h per issue, so a hours-long vendor stall
    // doesn't spam maintainers with a comment per run. Only the newest
    // comment matters: default listing is ascending, so page one of 100 can
    // omit it — ask the API for exactly that one (newest first).
    const comments = await ghApi(
      token,
      `/repos/${repo}/issues/${existing.number}/comments?per_page=1&sort=created&direction=desc`
    );
    const last = comments[0];
    if (last && Date.now() - Date.parse(last.created_at) < 24 * 60 * 60 * 1000) {
      console.log(`  open issue already updated <24h ago: ${title}`);
      return;
    }
    await ghApi(token, `/repos/${repo}/issues/${existing.number}/comments`, {
      method: 'POST',
      body: {body},
    });
    console.log(`  commented on open issue: ${title}`);
    return;
  }
  await ghApi(token, `/repos/${repo}/issues`, {
    method: 'POST',
    body: {title, body, labels: [WATCHDOG_LABEL]},
  });
  console.log(`  opened issue: ${title}`);
}

/**
 * Keep the single status meta issue current: create it on first sight, PATCH
 * the body only when it actually changed (no churn on no-op runs).
 */
async function syncMetaIssue(token, repo, body) {
  const existing = await findOpenIssueByTitle(token, repo, META_ISSUE_TITLE);
  if (existing) {
    if (existing.body === body) {
      console.log('  meta issue unchanged — no update');
      return;
    }
    await ghApi(token, `/repos/${repo}/issues/${existing.number}`, {
      method: 'PATCH',
      body: {body},
    });
    console.log(`  updated meta issue: #${existing.number}`);
    return;
  }
  const created = await ghApi(token, `/repos/${repo}/issues`, {
    method: 'POST',
    body: {title: META_ISSUE_TITLE, body, labels: [WATCHDOG_LABEL]},
  });
  console.log(`  created meta issue: #${created.number}`);
}

/**
 * Auto-close every open failure/size issue for a browser once it checks green
 * again — a transient vendor stall must not leave a stale issue behind. A short
 * closing comment links the resolving run.
 */
async function closeResolvedFailureIssues(token, repo, browser, runUrl) {
  const open = await ghApi(
    token,
    `/repos/${repo}/issues?state=open&labels=${WATCHDOG_LABEL}&per_page=100`
  );
  const stale = open.filter(i => isFailureIssueTitle(browser, i.title));
  for (const issue of stale) {
    if (runUrl) {
      await ghApi(token, `/repos/${repo}/issues/${issue.number}/comments`, {
        method: 'POST',
        body: {body: `Resolved by watchdog run: ${runUrl}`},
      });
    }
    await ghApi(token, `/repos/${repo}/issues/${issue.number}`, {
      method: 'PATCH',
      body: {state: 'closed'},
    });
    console.log(`  closed resolved failure issue: #${issue.number} (${issue.title})`);
  }
}

/**
 * Notify a fork version-lookup failure (warn-and-continue path, ADR 0021):
 * annotation first (done by the caller), then a deduped notification issue so
 * the failure is visible after the run. Errors are swallowed — the publish must
 * continue even if the notification itself fails.
 */
async function notifyLookupFailure(browser, reason, context) {
  try {
    const token = process.env.GITHUB_TOKEN || '';
    const repo = process.env.GITHUB_REPOSITORY || '';
    const runUrl =
      process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY ?
        `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID || ''}`
      : 'local';
    const title = issueTitle('lookup-failure', browser);
    const body = issueBody({kind: 'lookup-failure', browser, reason, context}, runUrl);
    if (!token || !repo || process.argv.includes('--dry-run')) {
      console.log(`[notification skipped] would open: ${title}`);
      return;
    }
    await openIssueIfNew(token, repo, title, body);
  } catch (err) {
    console.log(`  notification failed (non-fatal): ${err.message}`);
  }
}

export async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const prMode = process.argv.includes('--pr');
  const driftMode = process.argv.includes('--drift');
  const token = process.env.GITHUB_TOKEN || '';
  const repo = process.env.GITHUB_REPOSITORY || '';
  const baselineDir = process.env.BASELINE_DIR || path.join(REPO_ROOT, '.watchdog');
  const baselineFile = path.join(baselineDir, 'baseline.json');

  // Pre-publish gate: re-resolve every browser's current version and compare
  // against the last watchdog baseline. No downloads, no issues — fast. Exit 1
  // on drift so pages.yml can block a prod publish until the watchdog refreshes
  // the baseline (and triggers the browser-specific E2E).
  if (driftMode) {
    if (!fs.existsSync(baselineFile)) {
      console.error(
        'baseline: cache miss — no watchdog baseline found. Run the URL watchdog workflow first.'
      );
      process.exit(1);
    }
    const baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf-8'));
    const versions = {};
    const lookupFailures = [];
    for (const browser of BROWSERS) {
      try {
        versions[browser] = String(await resolveVersion(browser));
      } catch (err) {
        console.log(`  ${browser}: version lookup failed: ${err.message}`);
        versions[browser] = null;
        // Fork lookups degrade to warn-and-continue (ADR 0021); hard-gate
        // browsers keep blocking via the resulting drift entry.
        if (FORK_BROWSERS.includes(browser)) {
          lookupFailures.push({browser, reason: err.message});
        }
      }
    }
    const drift = collectDrift(baseline, versions, {ignoreLookupFailureFor: FORK_BROWSERS});
    if (drift.length > 0) {
      console.error('Browser version drift since the last watchdog run:');
      for (const d of drift) console.error(`  - ${d}`);
      console.error(
        'Run the URL watchdog workflow (refreshes the baseline and triggers the ' +
          'browser-specific E2E), then re-dispatch publish.'
      );
      process.exit(1);
    }
    console.log('No browser version drift — baseline matches current releases.');

    // Warn-and-continue (ADR 0021): a fork whose version still cannot be
    // resolved after retries + mirrors must not block shipping to users. It
    // surfaces as an annotation plus a deduped notification issue; the next
    // successful watchdog run folds the version into the baseline.
    for (const f of lookupFailures) {
      console.log(
        `::warning file=tools/check-browser-downloads.mjs::${f.browser}: version lookup failed (${f.reason}) — publish continues (fork browsers are warn-and-continue)`
      );
      await notifyLookupFailure(f.browser, f.reason, 'drift');
    }
    if (lookupFailures.length > 0) {
      console.log(
        `${lookupFailures.length} fork lookup failure(s) — continuing without fresh validation for them.`
      );
    }

    // Second gate (#4): the watchdog baseline can be refreshed without any
    // test run, so a prod publish additionally requires the hard-gate
    // browsers' CURRENT versions to be covered by the validated-versions
    // record — written only by successful browser-specific E2E runs.
    if (process.argv.includes('--require-validated')) {
      // VALIDATED_DIR: where the publish pre-flight restored the E2E-written
      // record (kept separate from the watchdog baseline's BASELINE_DIR).
      const validatedDir = process.env.VALIDATED_DIR || baselineDir;
      const validatedFile = path.join(validatedDir, 'validated.json');
      if (!fs.existsSync(validatedFile)) {
        console.error(
          'validation: no validated-versions record found — dispatch the E2E ' +
            'workflow on main (it records validated browser versions on success), ' +
            'then re-dispatch publish.'
        );
        process.exit(1);
      }
      const validated = JSON.parse(fs.readFileSync(validatedFile, 'utf-8'));
      const versionsNow = {};
      for (const browser of VALIDATED_BROWSERS) {
        try {
          versionsNow[browser] = String(await resolveVersion(browser));
        } catch (err) {
          console.log(`  ${browser}: version lookup failed: ${err.message}`);
          versionsNow[browser] = null;
        }
      }
      // The record wraps the per-browser map under `browsers` (alongside
      // recordedAt/runId/sha metadata) — pass only the map to the diff.
      const validatedDrift = collectValidatedDrift(validated.browsers || {}, versionsNow);
      if (validatedDrift.length > 0) {
        console.error('Browser versions not covered by a successful E2E run:');
        for (const d of validatedDrift) console.error(`  - ${d}`);
        console.error(
          'Dispatch the E2E workflow on main (re-records validated versions on ' +
            'success), then re-dispatch publish.'
        );
        process.exit(1);
      }
      console.log(
        'Validated-versions record matches current releases ' +
          `(recorded ${validated.recordedAt || 'unknown'}).`
      );
    }
    process.exit(0);
  }

  let baseline = {};
  const baselineFound = !prMode && fs.existsSync(baselineFile);
  if (baselineFound) {
    baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf-8'));
    // Cache-hit telemetry: an evicted/expired Actions cache would otherwise
    // masquerade as a first run or a version bump. The cache restore preserves
    // the file mtime, so age = time since the previous run wrote the baseline.
    const stat = fs.statSync(baselineFile);
    console.log(
      `baseline: cache hit — written ${new Date(stat.mtimeMs).toISOString()} ` +
        `(${formatAge(Date.now() - stat.mtimeMs)} ago)`
    );
  } else if (!prMode) {
    console.log('baseline: cache miss — first run, re-baselining all browsers');
  }

  const findings = [];
  // Per-browser status for the meta table, set in the loop below.
  const results = {};
  // Start from the loaded baseline so a browser whose check failed this run
  // keeps its recorded {version, size, sha256} instead of being erased — a
  // release landing during a transient outage must still reach the ledger.
  const next = {...baseline};
  const runUrl =
    process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY ?
      `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID || ''}`
    : '';

  // E2E-validated record (restored by the workflow into VALIDATED_DIR, written
  // only by the E2E record-validation job after every hard-gate leg passed):
  // feeds the 'E2E validated' column. Absent → '⏳ none' for the hard gates.
  let validated = null;
  const validatedDir = process.env.VALIDATED_DIR || '';
  if (!prMode && validatedDir) {
    const validatedFile = path.join(validatedDir, 'validated.json');
    if (fs.existsSync(validatedFile)) {
      try {
        validated = JSON.parse(fs.readFileSync(validatedFile, 'utf-8'));
        console.log(`validated: record from ${validated.recordedAt || 'unknown'}`);
      } catch (err) {
        console.log(`validated: unreadable record ignored: ${err.message}`);
      }
    } else {
      console.log('validated: no record found (E2E has not recorded one yet)');
    }
  }

  for (const browser of BROWSERS) {
    console.log(`\n${browser}:`);
    let version;
    try {
      version = await resolveVersion(browser);
      console.log(`  version ${version} (API ok)`);
    } catch (err) {
      // The version API itself failed — that is rot in the resolution chain.
      const reason = `version lookup failed: ${err.message}`;
      console.log(`  ✗ ${reason}`);
      results[browser] = {status: 'lookup-failed'};
      findings.push({kind: 'rot', browser, reason});
      continue;
    }
    const prev = prMode ? undefined : baseline[browser];
    const change = compareBaseline(prev, {version});

    // Endpoint check (1 KB ranged GET) for every browser.
    let endpoint;
    try {
      const url = await resolveDownloadUrl(browser, 'win32');
      console.log(`  url ${url}`);
      endpoint = await checkEndpoint(url);
    } catch (err) {
      endpoint = {ok: false, reason: err.message};
    }
    if (!endpoint.ok) {
      console.log(`  ✗ ${endpoint.reason}`);
      results[browser] = {status: 'endpoint-failed'};
      findings.push({kind: 'rot', browser, reason: endpoint.reason, version});
      continue; // broken chain — do not touch the baseline for this browser
    }
    console.log(
      `  endpoint ok${endpoint.total ? ` (${endpoint.total} bytes)` : ' (no size reported)'}`
    );

    // PR mode: stateless, always green — surface findings as annotations.
    if (prMode) {
      results[browser] = {status: 'ok'};
      continue;
    }

    // New release (or first run): one-time full download + SHA-256.
    if (change !== 'ok') {
      console.log(
        `  ${change === 'first-run' ? 'first run' : `new version: ${prev.version} → ${version}`}` +
          ' — verifying full download + SHA-256'
      );
      const verified = await verifyFullDownload(
        await resolveDownloadUrl(browser, 'win32'),
        browser
      );
      if (!verified.ok) {
        console.log(`  ✗ ${verified.reason}`);
        // Mark the failure so the meta issue does not render this browser as
        // 'ok' (buildStatusTable defaults a missing result to ok) and shows
        // the CI-cache fallback instead.
        results[browser] = {status: 'download-failed'};
        findings.push({kind: 'rot', browser, reason: verified.reason, version});
        continue;
      }
      console.log(`  sha256 ${verified.sha256}`);
      next[browser] = {
        version,
        size: verified.size,
        sha256: verified.sha256,
        checkedAt: new Date().toISOString(),
        checkedUrl: runUrl,
      };
      results[browser] = {status: change === 'first-run' ? 'first-run' : 'new-version'};
      if (change === 'new-version') {
        findings.push({
          kind: 'new-version',
          browser,
          prevVersion: prev.version,
          newVersion: version,
          size: verified.size,
          sha256: verified.sha256,
        });
      } else {
        console.log('  first run — baseline recorded');
      }
      continue;
    }

    // Same version: keep the recorded hash, flag a binary replacement. A server
    // that ignores Range reports no total — keep the recorded size in that case
    // instead of overwriting it with 0 and raising a false size-change.
    const total = endpoint.total || 0;
    const sizeChanged = Boolean(total && prev.size && prev.size !== total);
    next[browser] = {
      version,
      // Keep the last VERIFIED size when the served binary changed size: the
      // new total is only observed, not verified. Persisting it would make the
      // next run see a match, go 'ok', and auto-close the size-change issue
      // without ever re-downloading the replacement to re-verify its SHA-256.
      // The mismatch stays visible until the binary returns to normal or the
      // version bumps (which re-verifies via a full download).
      size: sizeChanged ? prev.size : total || prev.size || null,
      sha256: prev.sha256 || null,
      checkedAt: new Date().toISOString(),
      checkedUrl: runUrl,
    };
    if (sizeChanged) {
      console.log(`  ⚠ same version, binary size changed: ${prev.size} → ${total}`);
      results[browser] = {status: 'size-change'};
      findings.push({
        kind: 'size-change',
        browser,
        prevSize: prev.size,
        newSize: total,
      });
    } else {
      results[browser] = {status: 'ok'};
      console.log('  unchanged');
    }
  }

  // ── GitHub surface (schedule mode only) ─────────────────────────────────
  // Error issues first, then auto-close resolved failures, then the meta
  // issue — all BEFORE the fail-closed exit so a failed run still updates
  // GitHub. New-version findings no longer open their own issues: the meta
  // issue's status table + version history carry the release ledger.

  const versionFindings = findings.filter(f => f.kind === 'new-version');

  // 1) Open/comment error issues (rot, size-change) — exact-title dedup.
  for (const f of findings) {
    if (f.kind === 'new-version') continue;
    const title = issueTitle(f.kind, f.browser, f);
    if (prMode) {
      // Annotations: rot → warning, everything else → notice. Exit stays 0 so
      // this can be a required check without ever blocking a merge.
      const level = f.kind === 'rot' ? 'warning' : 'notice';
      const msg = `${f.browser}: ${f.kind === 'rot' ? f.reason : title}`;
      console.log(`::${level} file=tools/check-browser-downloads.mjs::${msg}`);
      continue;
    }
    const body = issueBody(f, runUrl || 'local');
    if (dryRun || !token) {
      console.log(`\n${dryRun ? '[dry-run] ' : '[no GITHUB_TOKEN] '}would open: ${title}`);
      continue;
    }
    if (!repo) {
      console.log(`\nGITHUB_REPOSITORY not set — skipping issue creation for: ${title}`);
      continue;
    }
    await openIssueIfNew(token, repo, title, body);
  }

  // 2) Auto-close failure issues for browsers that checked green this run
  //    (ok / new version / first run). A size-change finding keeps its issue
  //    open until the binary returns to normal or the version bumps.
  if (!prMode) {
    for (const browser of BROWSERS) {
      const status = (results[browser] || {}).status;
      if (!status || !OK_STATUSES.has(status)) continue;
      if (dryRun || !token) {
        console.log(
          `\n${dryRun ? '[dry-run] ' : '[no GITHUB_TOKEN] '}would close resolved failure issues for ${browser}`
        );
        continue;
      }
      if (!repo) continue;
      await closeResolvedFailureIssues(token, repo, browser, runUrl);
    }
  }

  // 3) Version history: one entry per run with real version updates, persisted
  //    with the baseline (fail-closed runs skip the write, so the history stays
  //    consistent with what the drift gate sees).
  if (versionFindings.length > 0 && !prMode && !dryRun) {
    next.history = updateHistory(baseline.history || [], {
      date: new Date().toISOString(),
      runUrl,
      changes: versionFindings.map(f => ({
        browser: f.browser,
        prevVersion: f.prevVersion,
        newVersion: f.newVersion,
        size: f.size,
        sha256: f.sha256,
      })),
    });
  }

  // 4) Meta issue: status table + version history, PATCHed only when the body
  //    actually changed. While no update history exists yet (e.g. right after a
  //    cache eviction) the body falls back to a date-free 'baseline' seed
  //    derived from the baseline itself, so it stays stable across no-op runs.
  if (!prMode) {
    const table = buildStatusTable({results, baseline: next, validated});
    const history = (next.history || []).length > 0 ? next.history : seedHistoryFromBaseline(next);
    const metaBody = buildMetaIssueBody({table, history: renderHistory(history)});
    if (dryRun || !token) {
      console.log(
        `\n${dryRun ? '[dry-run] ' : '[no GITHUB_TOKEN] '}meta issue would be kept current with:\n${metaBody}`
      );
    } else if (!repo) {
      console.log('\nGITHUB_REPOSITORY not set — skipping meta issue update.');
    } else {
      await syncMetaIssue(token, repo, metaBody);
    }
  }

  // Persist the baseline (schedule mode only; CI's cache step picks it up).
  // Fail-closed (ADR 0021): a browser whose lookup or endpoint check failed
  // this run must NOT let a partial baseline be saved — the Sep 2026 incident
  // (watchdog green with a stale LibreWolf entry) made the drift gate lie. The
  // error issues + meta update above already surfaced the failure to GitHub.
  const failedBrowsers = findings.filter(f => f.kind === 'rot').map(f => f.browser);
  if (failedBrowsers.length > 0 && !prMode && !dryRun) {
    for (const f of findings.filter(f => f.kind === 'rot')) {
      console.log(`::error file=tools/check-browser-downloads.mjs::${f.browser}: ${f.reason}`);
    }
    console.error(
      `\nfail-closed: ${failedBrowsers.join(', ')} could not be resolved — NO baseline ` +
        'was saved. Re-run the URL watchdog when the vendor recovers; E2E legs fall ' +
        'back to their cached installer meanwhile.'
    );
    process.exit(1);
  }
  if (!prMode && !dryRun) {
    fs.mkdirSync(baselineDir, {recursive: true});
    fs.writeFileSync(baselineFile, JSON.stringify(next, null, 2) + '\n');
  }

  console.log(
    `\n${findings.length} finding(s); ` +
      (prMode ? 'PR mode — no baseline, no issues.'
      : dryRun ? 'baseline not written (dry-run).'
      : 'baseline written.')
  );
}

const isMain = process.argv[1] && path.basename(process.argv[1]) === 'check-browser-downloads.mjs';
if (isMain) {
  main().catch(err => {
    console.error(`✗ Error: ${err.message}`);
    process.exit(1);
  });
}
