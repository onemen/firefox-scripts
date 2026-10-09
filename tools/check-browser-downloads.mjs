#!/usr/bin/env node

/**
 * tools/check-browser-downloads.mjs — watchdog for the E2E browser download map
 * (test/e2e/shared/downloads.mjs).
 *
 * Runs in three modes (two driven by .github/workflows/url-watchdog.yml, one by
 * the Pages publish pre-flight):
 *
 * - Nightly (schedule/workflow_dispatch). For each browser CI installs it:
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
 *        sha256} in the baseline (.watchdog/baseline.json, published to the
 *        durable `watchdog-state` branch — ADR 0046; it used to be an Actions
 *        cache entry, and its eviction rendered every browser "first run",
 *        #462). Same-version runs re-check only the 1 KB range, but flag a size
 *        change (binary replaced without a bump) — except the rolling binaries
 *        (nightly: fresh binaries inside one N.0a1 window, #276), where the
 *        replacement is re-verified with a full download instead of flagged.
 *        Each run logs where the state came from and its age, so a state that
 *        stopped arriving is visible instead of masquerading as a first run.
 *   4. META ISSUE — one `[url-watchdog] status` issue is kept current after every
 *        run: a per-browser status table (last verified version, size +
 *        SHA-256, the run that last checked it, a status tag, the CI-cache
 *        fallback version, the full-download transfer time, and the
 *        E2E-validated version for the hard-gate browsers) plus a version
 *        history that only grows on runs with real version updates — the
 *        durable SHA-256 ledger (search `label:url-watchdog` for it).
 *   5. ERROR ISSUES — rot and same-version size changes still open their own issue,
 *        deduped per browser (the exact issue title is matched against open
 *        issues carrying the `url-watchdog` label; rolling binaries like
 *        nightly are excluded, #276); the watchdog auto-closes any open failure
 *        issue for a browser once a later run checks it green again.
 *   6. E2E DISPATCH — a new release triggers the browser E2E: fork browsers get a
 *        single-browser dispatch (the ADR 0021 manual escape), the hard-gate
 *        browsers share one full dispatch whose record-validation refreshes the
 *        validated-versions record. Non-fatal on failure.
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
 * Requires GITHUB_TOKEN with issues: write for issue creation and actions:
 * write for the E2E dispatch; without it, or with --dry-run, findings are
 * printed instead. Exit code stays 0 when findings are reported (they become
 * issues / annotations, not CI failures).
 *
 * The pure reporting layer — the domain constants, drift classification, the
 * E2E dispatch planner, and all GitHub-visible rendering (status table, version
 * history, meta-issue body, issue titles/bodies) — lives in
 * tools/ci/watchdog-report.mjs. This file keeps the network resolution,
 * baseline persistence, GitHub API calls and CLI orchestration, and re-exports
 * the reporting names for its existing importers (the unit tests,
 * record-validated-versions.mjs).
 */

import {createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {fetchJsonWithRetry, resolveBrowserVersion} from '../test/e2e/shared/browserResolver.mjs';
import {downloadTo, resolveDownloadUrl} from '../test/e2e/shared/downloads.mjs';
import {
  BROWSERS,
  FORK_BROWSERS,
  META_ISSUE_TITLE,
  VALIDATED_BROWSERS,
  WATCHDOG_LABEL,
  buildMetaIssueBody,
  buildStatusTable,
  collectDrift,
  collectValidatedDrift,
  compareBaseline,
  esrLedgerNames,
  formatAge,
  groupCacheKeysByBrowser,
  isFailureIssueTitle,
  isRollingBinary,
  issueBody,
  issueTitle,
  planDispatches,
  renderHistory,
  seedHistoryFromBaseline,
  updateEsrState,
  updateHistory,
} from './ci/watchdog-report.mjs';

// Compat surface: the reporting layer's names, re-exported so existing
// importers (test/unit/tools/*, tools/ci/record-validated-versions.mjs) can
// keep importing them from this module.
export {
  BROWSERS,
  ESR_BROWSER_PREFIX,
  FORK_BROWSERS,
  HISTORY_PER_BROWSER,
  META_ISSUE_TITLE,
  VALIDATED_BROWSERS,
  WATCHDOG_LABEL,
  buildEsrMatrix,
  buildMetaIssueBody,
  buildStatusTable,
  cacheFallbackCell,
  cacheKeyPrefixesFor,
  collectDrift,
  collectValidatedDrift,
  compareBaseline,
  escapeTableCell,
  esrLedgerNames,
  esrMajorOf,
  formatAge,
  formatCheck,
  formatDownloadMs,
  formatRunDate,
  formatSize,
  groupCacheKeysByBrowser,
  isFailureIssueTitle,
  isRollingBinary,
  issueBody,
  issueTitle,
  planDispatches,
  renderHistory,
  seedHistoryFromBaseline,
  shortSha,
  statusTag,
  updateEsrState,
  updateHistory,
  validatedCell,
} from './ci/watchdog-report.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const REPO_ROOT = path.resolve(__dirname, '..');

const MIN_BINARY_BYTES = 10_000_000; // installers are ~100 MB; smaller = wrong file
const RANGE_BYTES = 1024;

/**
 * Statuses that prove a browser checked green — their failure issues
 * auto-close.
 */
const OK_STATUSES = new Set(['ok', 'new-version', 'first-run']);

/** E2E workflow the nightly revalidation dispatches (repo file name). */
const E2E_WORKFLOW = 'e2e.yml';

/** The scheduled core smoke, dispatched nightly. */
const CORE_SMOKE_WORKFLOW = 'core-smoke-nightly.yml';

/**
 * The plan file a check run leaves in the baseline dir for the workflow's
 * post-save step to replay — the dispatch decision is made where the findings
 * are, the dispatch itself runs after the baseline is saved.
 */
const DISPATCH_PLAN_FILE = 'dispatch-plan.json';

/**
 * Resolve the current release version for a browser via the shared resolver
 * (retry + mirror chains; LibreWolf bsys6-first, waterfox GitHub→CDN).
 */
export async function resolveVersion(browser) {
  const {version} = await resolveBrowserVersion(browser);
  return version;
}

/**
 * Fetch Mozilla's product-details keys for the ESR state machine. Returns the
 * raw FIREFOX_ESR / FIREFOX_ESR_NEXT strings (null when absent — NEXT comes and
 * goes across the ESR overlap cycle). Throws on a total product-details outage;
 * the caller decides how to degrade.
 */
export async function fetchEsrVersions() {
  const versions = await fetchJsonWithRetry(
    'https://product-details.mozilla.org/1.0/firefox_versions.json'
  );
  return {
    esr: typeof versions.FIREFOX_ESR === 'string' ? versions.FIREFOX_ESR : null,
    next: typeof versions.FIREFOX_ESR_NEXT === 'string' ? versions.FIREFOX_ESR_NEXT : null,
  };
}

/**
 * Dispatch one planned workflow run on main. `inputs` must contain only keys
 * the target workflow declares — an unknown input is an API error, so the plan
 * never carries a key the workflow does not declare.
 */
async function dispatchWorkflow(token, repo, {workflow, inputs}) {
  await ghApi(token, `/repos/${repo}/actions/workflows/${workflow}/dispatches`, {
    method: 'POST',
    body: {ref: 'main', inputs},
  });
}

/**
 * The dispatch plan one check run leaves for the workflow's post-save step.
 *
 * Finding-driven part: exactly `planDispatches`' output — one dispatch per new
 * fork release (its own `browser` escape), one for ESR drift, one full run when
 * a hard gate moved.
 *
 * Nightly part: when the run is the scheduled nightly, a FULL e2e run is
 * dispatched whatever the findings — the workflow no longer has a `schedule:`
 * or `push: [main]` trigger, so a quiet week must not be a coverage hole — and
 * core-smoke-nightly.yml is dispatched once (its own build-ID cache marker
 * skips nights without a new build, so this is cheap).
 *
 * Dedupe: two full e2e runs share the `e2e-<ref>` concurrency group with
 * cancel-in-progress, so the second would cancel the first. A nightly that
 * already has a full run from the findings marks it instead of adding one.
 *
 * `GITHUB_EVENT_NAME === 'schedule'` is the nightly signal — the workflow's own
 * cron; a manual watchdog dispatch keeps the finding-driven behavior only.
 *
 * @param {{kind: string; browser: string}[]} findings
 * @returns {{nightly: boolean; plans: {workflow: string; inputs: object}[]}}
 */
export function buildDispatchPlan(findings) {
  const nightly = process.env.GITHUB_EVENT_NAME === 'schedule';
  // CORE_SMOKE takes no inputs, so `inputs` stays permissive here (the
  // declared @returns above types it as `object`).
  /**
   * @type {{
   *   workflow: string;
   *   inputs: {browser?: string; version?: string; nightly?: boolean};
   * }[]}
   */
  const plans = planDispatches(findings).map(plan => ({
    workflow: E2E_WORKFLOW,
    inputs: {browser: plan.browser || 'all', version: ''},
  }));
  if (nightly) {
    const full = plans.find(p => p.inputs.browser === 'all');
    if (full) full.inputs.nightly = true;
    else plans.push({workflow: E2E_WORKFLOW, inputs: {browser: 'all', version: '', nightly: true}});
    plans.push({workflow: CORE_SMOKE_WORKFLOW, inputs: {}});
  }
  return {nightly, plans};
}

/**
 * Replay the plan the check run wrote. Called by the workflow AFTER the
 * baseline save — the dispatched runs read that baseline, so dispatching before
 * the save validated the previous one. A check run that wrote no plan
 * (report-only, --dry-run, or a failed check) has nothing to replay.
 *
 * @param {{token: string; repo: string; dryRun: boolean}} io
 * @returns {Promise<void>}
 */
export async function dispatchRevalidation({token, repo, dryRun}) {
  const planFile = path.join(
    process.env.BASELINE_DIR || path.join(REPO_ROOT, '.watchdog'),
    DISPATCH_PLAN_FILE
  );
  if (!fs.existsSync(planFile)) {
    console.log(`no dispatch plan at ${planFile} — nothing to replay`);
    return;
  }
  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  // Consume the plan BEFORE dispatching:
  // the plan lives inside the baseline cache's directory, so the next run's
  // restore would otherwise bring it back and replay the previous night's
  // dispatches — a second full nightly e2e run, a second core-smoke, the
  // finding-driven fork escapes. Deleting it here makes "replay at most
  // once" true by construction: the run that observes a plan is the one that
  // dispatched it. A dry-run keeps the file (it dispatches nothing, so a
  // later real replay stays correct).
  if (!dryRun) fs.rmSync(planFile, {force: true});
  console.log(
    `dispatching ${plan.plans.length} workflow run(s)` +
      (plan.nightly ? ' (nightly revalidation)' : '') +
      (dryRun ? ' [dry-run]' : '')
  );
  for (const entry of plan.plans) {
    const what = entry.workflow + (entry.inputs?.browser ? ` (${entry.inputs.browser})` : '');
    try {
      if (!dryRun) await dispatchWorkflow(token, repo, entry);
      console.log(`  dispatched ${what}`);
    } catch (err) {
      console.log(
        `::warning file=tools/check-browser-downloads.mjs::dispatch failed for ${what}: ${err.message}`
      );
      if (entry.workflow === CORE_SMOKE_WORKFLOW) {
        await notifyCoreSmokeDispatchFailure(err.message);
        continue;
      }
      // See notifyDispatchFailure: not retried on later runs — make the
      // untested release visible with a deduped issue per affected browser
      // (the full dispatch covers both hard gates).
      for (const browser of entry.inputs.browser === 'all' ?
        VALIDATED_BROWSERS
      : [entry.inputs.browser]) {
        await notifyDispatchFailure(browser, err.message);
      }
    }
  }
}

/**
 * Notify a failed core-smoke dispatch. Same shape as notifyDispatchFailure: the
 * marker is keyed on the build ID and this run did not write it, so nothing
 * re-dispatches on its own — the issue stays open until the operator retries.
 */
async function notifyCoreSmokeDispatchFailure(reason) {
  try {
    const token = process.env.GITHUB_TOKEN || '';
    const repo = process.env.GITHUB_REPOSITORY || '';
    const runUrl =
      process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY ?
        `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID || ''}`
      : 'local';
    const title = '[url-watchdog] core smoke dispatch failed';
    const body =
      `Watchdog run: ${runUrl}\n\n` +
      'The nightly dispatch of core-smoke-nightly.yml failed, so this Nightly ' +
      'build is unvalidated and the marker was not written — later nights will ' +
      `NOT re-dispatch it:\n\n- ${reason}\n\n` +
      'Retry the dispatch manually, then close this issue:\n\n' +
      '`gh workflow run core-smoke-nightly.yml`';
    if (!token || !repo || process.argv.includes('--dry-run')) {
      console.log(`[notification skipped] would open: ${title}`);
      return;
    }
    await openIssueIfNew(token, repo, title, body);
  } catch (err) {
    console.log(`  notification failed (non-fatal): ${err.message}`);
  }
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
  const startedAt = Date.now();
  try {
    await downloadTo(url, tmp);
    // Capture the transfer time BEFORE hashing — the metric is download
    // duration; hashing (1-2s for a 158 MB installer) is verification.
    const downloadMs = Date.now() - startedAt;
    const sha256 = await sha256File(tmp);
    return {ok: true, size: fs.statSync(tmp).size, sha256, downloadMs};
  } catch (err) {
    return {ok: false, reason: `full download failed: ${err.message}`};
  } finally {
    fs.rmSync(tmp, {force: true});
  }
}

/**
 * List the repo's Actions-cache entries (key + creation time), all pages. Used
 * to derive the truthful Fallback (CI cache) column: the sticky fork keys
 * decode to their version; the shared Mozilla namespace proves presence/age.
 * Needs the `actions: read` scope (the watchdog's check job already carries
 * `actions: write` for the E2E dispatch).
 */
export async function listActionsCaches(token, repo) {
  const out = [];
  for (let page = 1; ; page++) {
    const body = await ghApi(token, `/repos/${repo}/actions/caches?per_page=100&page=${page}`);
    out.push(...(body.actions_caches ?? []).map(c => ({key: c.key, createdAt: c.created_at})));
    if ((body.actions_caches ?? []).length < 100) break;
    if (page >= (body.total_count ?? 0) / 100 + 1) break;
  }
  return out;
}

/**
 * Minimal GitHub REST helper (issues only).
 *
 * @param {string} token
 * @param {string} pathname
 * @param {{method?: string; body?: any}} [opts]
 */
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

/**
 * Find an open url-watchdog issue by exact title (null when absent).
 *
 * The label-filtered list serves from GitHub's label index, which can be
 * momentarily stale — on 2026-09-09 it transiently omitted the open, labeled
 * meta issue minutes after comments on it were deleted, and the watchdog
 * created a duplicate status issue instead of PATCHing it (issue #173, closed
 * as a duplicate of #136). So a miss falls back to one unfiltered open-issues
 * query (title match only, no label index) before concluding "absent", and the
 * OLDEST match wins so a stable target accumulates history.
 */
async function findOpenIssueByTitle(token, repo, title) {
  const open = await ghApi(
    token,
    `/repos/${repo}/issues?state=open&labels=${WATCHDOG_LABEL}&per_page=100`
  );
  let matches = open.filter(i => i.title === title);
  if (matches.length === 0) {
    const unfiltered = await ghApi(token, `/repos/${repo}/issues?state=open&per_page=100`);
    matches = unfiltered.filter(i => i.title === title);
  }
  return matches.sort((a, b) => a.number - b.number)[0] || null;
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

/**
 * Notify a failed E2E auto-dispatch: the baseline already recorded the new
 * version, so later watchdog runs will NOT re-dispatch it — without this issue
 * the release would sit untested silently. The title deliberately does NOT
 * match isFailureIssueTitle: the watchdog cannot verify an E2E run happened, so
 * the issue stays open until the operator closes it after a successful (manual)
 * dispatch — a green watchdog check must not auto-close it. Deduped per browser
 * via the exact-title match.
 */
async function notifyDispatchFailure(browser, reason) {
  try {
    const token = process.env.GITHUB_TOKEN || '';
    const repo = process.env.GITHUB_REPOSITORY || '';
    const runUrl =
      process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY ?
        `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID || ''}`
      : 'local';
    const title = `[url-watchdog] ${browser} E2E dispatch failed`;
    const remedy =
      FORK_BROWSERS.includes(browser) ?
        `gh workflow run e2e.yml -f browser=${browser}`
      : 'gh workflow run e2e.yml  # full dispatch — also refreshes the validated-versions record';
    const body =
      `Watchdog run: ${runUrl}\n\n` +
      `The automatic E2E dispatch for the new ${browser} release failed, and the ` +
      'version is already recorded in the watchdog baseline — later runs will NOT ' +
      `re-dispatch it, so the release stays untested:\n\n- ${reason}\n\n` +
      'Retry the dispatch manually, then close this issue:\n\n' +
      `\`${remedy}\``;
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
  // Replay the dispatch plan the check run wrote. Its own mode: the
  // workflow calls it as a separate step AFTER the baseline save, so it must
  // not re-run the vendor probes.
  if (process.argv.includes('--dispatch')) {
    await dispatchRevalidation({
      token: process.env.GITHUB_TOKEN || '',
      repo: process.env.GITHUB_REPOSITORY || '',
      dryRun,
    });
    return;
  }
  // Report-only: skip every vendor-facing probe (no version lookups, no
  // endpoint checks, no downloads) and only rebuild the meta issue from the
  // existing baseline + the LIVE Actions-cache inventory. Cost: two GitHub API
  // calls (caches list + issue list) — cheap enough to run after any cache
  // save. Fail-open: an inventory fetch failure renders the baseline-derived
  // column instead of failing the run (the table is informational).
  const reportOnly = process.argv.includes('--report-only');
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
        'baseline: no watchdog baseline — the watchdog-state branch carries none. ' +
          'Run the URL watchdog workflow first.'
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
    // Advisory ESR rows: a point release on a watched ESR line warns instead
    // of blocking (the E2E legs are advisory — see the esr-portable job).
    for (const browser of esrLedgerNames(baseline.esr)) {
      try {
        const version = String(await resolveVersion(browser));
        const prev = baseline[browser]?.version;
        if (prev && prev !== version) {
          console.log(
            `::warning file=tools/check-browser-downloads.mjs::${browser}: ` +
              `advisory ESR drift ${prev} → ${version} — run the url-watchdog to refresh`
          );
        }
      } catch (err) {
        console.log(`  ${browser}: advisory ESR lookup failed (non-blocking): ${err.message}`);
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

  // Baseline record: per-browser entries plus the ledger extras (`esr`
  // state machine, `history`) — all optional when the branch has no baseline
  // yet (first run).
  /** @type {{esr?: any; history?: any; [browser: string]: any}} */
  let baseline = {};
  // Report-only reads the baseline too — it is the table's data source.
  const baselineFound = !prMode && fs.existsSync(baselineFile);
  if (baselineFound) {
    baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf-8'));
    // State telemetry: the fetch dates the file from the commit that wrote it
    // (state-branch.mjs), so age = time since the last watchdog run published
    // it. A state that stopped arriving is otherwise indistinguishable from a
    // quiet week.
    const stat = fs.statSync(baselineFile);
    console.log(
      `baseline: state loaded from the watchdog-state branch — written ` +
        `${new Date(stat.mtimeMs).toISOString()} (${formatAge(Date.now() - stat.mtimeMs)} ago)`
    );
  } else if (!prMode) {
    console.log(
      'baseline: no state on the watchdog-state branch — first run, re-baselining all browsers'
    );
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

  // ── ESR state machine (the dynamic firefox-esr-<major> rows) ─────────────
  // Rotate the watched two-major window from Mozilla's serving keys BEFORE the
  // check loop, so the new rows are checked (and re-baselined) this same run.
  // A product-details outage keeps the previous window — the state machine is
  // never fed nulls that would shrink it.
  let esrState = baseline.esr ?? null;
  // Report-only: no vendor probes — the watched window comes from the restored
  // baseline verbatim (a rotation slide is next scheduled run's business).
  if (reportOnly) {
    console.log(
      esrState ?
        `  esr window (from baseline): ${esrState.majors.join(' + ')}`
      : '  esr: no baseline state — generic row only'
    );
  } else {
    try {
      const {esr, next: esrNext} = await fetchEsrVersions();
      const rotated = updateEsrState(esrState, esr, esrNext);
      esrState = rotated.state;
      // Slide cleanup: a dropped major leaves the ledger — its baseline entry and
      // history rows go with it (the rebuilt meta issue sheds the row too).
      for (const major of rotated.droppedMajors) {
        const dropped = `firefox-esr-${major}`;
        delete next[dropped];
        if (Array.isArray(next.history)) {
          next.history = next.history.map(h => {
            const c = {...h, changes: (h.changes || []).filter(ch => ch.browser !== dropped)};
            return c;
          });
        }
        console.log(`  esr: major ${major} dropped from the watched window (${dropped})`);
      }
      next.esr = esrState;
      console.log(
        `  esr window: ${esrState.majors.join(' + ')}` +
          ` (${esrState.majors.map(m => esrState.versions[m] || '?').join(', ')})`
      );
    } catch (err) {
      console.log(
        `  esr: product-details unavailable (${err.message}) — keeping the previous window`
      );
    }
  }
  const esrNames = esrLedgerNames(esrState);

  /** One browser's full check: resolve → endpoint → verify/record. */
  const runCheck = async browser => {
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
      return;
    }
    const prev = prMode ? undefined : baseline[browser];
    const change = compareBaseline(prev, {version});

    // Endpoint check (1 KB ranged GET) for every browser. `url` is resolved
    // ONCE here and reused by the full-download verifications below: a second
    // resolution could transiently fail after the endpoint check succeeded,
    // and an unhandled rejection would abort runCheck without recording
    // download-failed or publishing the rot finding.
    let endpoint;
    let url;
    try {
      url = await resolveDownloadUrl(browser, 'win32');
      console.log(`  url ${url}`);
      endpoint = await checkEndpoint(url);
    } catch (err) {
      endpoint = {ok: false, reason: err.message};
    }
    if (!endpoint.ok) {
      console.log(`  ✗ ${endpoint.reason}`);
      results[browser] = {status: 'endpoint-failed'};
      findings.push({kind: 'rot', browser, reason: endpoint.reason, version});
      return; // broken chain — do not touch the baseline for this browser
    }
    console.log(
      `  endpoint ok${endpoint.total ? ` (${endpoint.total} bytes)` : ' (no size reported)'}`
    );

    // PR mode: stateless, always green — surface findings as annotations.
    if (prMode) {
      results[browser] = {status: 'ok'};
      return;
    }

    // New release (or first run): one-time full download + SHA-256.
    if (change !== 'ok') {
      console.log(
        `  ${change === 'first-run' ? 'first run' : `new version: ${prev.version} → ${version}`}` +
          ' — verifying full download + SHA-256'
      );
      const verified = await verifyFullDownload(url, browser);
      if (!verified.ok) {
        console.log(`  ✗ ${verified.reason}`);
        // Mark the failure so the meta issue does not render this browser as
        // 'ok' (buildStatusTable defaults a missing result to ok) and shows
        // the CI-cache fallback instead.
        results[browser] = {status: 'download-failed'};
        findings.push({kind: 'rot', browser, reason: verified.reason, version});
        return;
      }
      console.log(`  sha256 ${verified.sha256}`);
      next[browser] = {
        version,
        size: verified.size,
        sha256: verified.sha256,
        downloadMs: verified.downloadMs,
        checkedAt: new Date().toISOString(),
        checkedUrl: runUrl,
      };
      // A first run is treated exactly like a new release: status, ledger
      // row, and an E2E dispatch. After a state loss (cache eviction, wipe)
      // the validated-versions record is empty and the publish drift gate
      // fails closed on it — the dispatch is what rebuilds it.
      results[browser] = {status: 'new-version'};
      findings.push({
        kind: 'new-version',
        browser,
        ...(change === 'new-version' ? {prevVersion: prev.version} : {}),
        newVersion: version,
        size: verified.size,
        sha256: verified.sha256,
        downloadMs: verified.downloadMs,
      });
      if (change === 'first-run') console.log('  first run — baseline recorded');
      return;
    }

    // Same version: keep the recorded hash, flag a binary replacement. A server
    // that ignores Range reports no total — keep the recorded size in that case
    // instead of overwriting it with 0 and raising a false size-change.
    const total = endpoint.total || 0;
    const sizeChanged = Boolean(total && prev.size && prev.size !== total);

    // Nightly rolls fresh binaries inside one N.0a1 version window — N only
    // moves every ~2 weeks, so a same-version size change is by design, not a
    // tamper signal. Re-verify the replacement exactly like a version
    // bump and record the fresh hash: the ledger stays honest, no issue opens,
    // and the next run sees a matching size and goes 'ok'.
    if (sizeChanged && isRollingBinary(browser)) {
      console.log(
        `  nightly replaced its binary within the same ${version} window — re-verifying full download + SHA-256`
      );
      const verified = await verifyFullDownload(url, browser);
      if (!verified.ok) {
        console.log(`  ✗ ${verified.reason}`);
        results[browser] = {status: 'download-failed'};
        findings.push({kind: 'rot', browser, reason: verified.reason, version});
        return;
      }
      console.log(`  sha256 ${verified.sha256}`);
      next[browser] = {
        version,
        size: verified.size,
        sha256: verified.sha256,
        downloadMs: verified.downloadMs,
        checkedAt: new Date().toISOString(),
        checkedUrl: runUrl,
      };
      results[browser] = {status: 'ok'};
      return;
    }

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
      downloadMs: prev.downloadMs ?? null,
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
  };

  if (reportOnly) {
    // No vendor probes at all. runCheck below is skipped; results mark every
    // row so the table shows 'ℹ️ not checked' instead of a stale ✅/❌.
    for (const browser of BROWSERS) {
      results[browser] = {status: 'report-only'};
    }
    for (const browser of esrNames) {
      results[browser] = {status: 'report-only'};
    }
  } else {
    for (const browser of BROWSERS) {
      await runCheck(browser);
    }
    for (const browser of esrNames) {
      await runCheck(browser);
    }
  }

  // ── GitHub surface (schedule mode only) ─────────────────────────────────
  // Error issues first, then auto-close resolved failures, then the meta
  // issue — all BEFORE the fail-closed exit so a failed run still updates
  // GitHub. Report-only skips 1) and 2): the baseline was not re-checked, so
  // opening rot issues or auto-closing resolved ones would act on stale
  // evidence — the refreshed table is the entire deliverable. New-version findings no longer open their own issues: the meta
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
    for (const browser of [...BROWSERS, ...esrNames]) {
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
        downloadMs: f.downloadMs,
      })),
    });
  }

  // 4) Meta issue: status table + version history, PATCHed only when the body
  //    actually changed. While no update history exists yet (e.g. right after a
  //    cache eviction) the body falls back to a date-free 'baseline' seed
  //    derived from the baseline itself, so it stays stable across no-op runs.
  if (!prMode) {
    // Live cache inventory for the Fallback column (skipped in PR mode — the
    // PR job has no actions scope and needs no table). Fail-open: without a
    // token the column degrades to the baseline-derived view.
    let cacheGroups;
    if (token && repo && !prMode) {
      try {
        const caches = await listActionsCaches(token, repo);
        cacheGroups = groupCacheKeysByBrowser(caches, [...BROWSERS, ...esrNames], esrState);
        console.log(`cache inventory: ${caches.length} entries fetched`);
      } catch (err) {
        console.log(
          `::warning file=tools/check-browser-downloads.mjs::cache inventory fetch failed ` +
            `(${err.message}) — Fallback column falls back to the baseline view`
        );
      }
    }
    const table = buildStatusTable({
      results,
      baseline: next,
      validated,
      browsers: [...BROWSERS, ...esrNames],
      cache: cacheGroups,
    });
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
  if (!prMode && !dryRun && !reportOnly) {
    fs.mkdirSync(baselineDir, {recursive: true});
    fs.writeFileSync(baselineFile, JSON.stringify(next, null, 2) + '\n');
  }

  // Plan the dispatch instead of performing it. The decision lives here
  // — where the findings are — and the dispatch moved to the workflow's step
  // AFTER the baseline save: the dispatched runs read that baseline (esr-matrix
  // consumes it, record-validation's pre-flight compares against it), so
  // dispatching before the save would validate the previous baseline. Runs only after
  // the baseline persisted (the fail-closed exit above already returned
  // otherwise), so a browser is planned at most once per recorded version —
  // which also means a FAILED dispatch is never retried by later runs (the
  // version is no longer new): it surfaces as a run warning plus a deduped
  // per-browser issue, from the replay step.
  if (!prMode && !dryRun && !reportOnly && token && repo) {
    const plan = buildDispatchPlan(findings);
    fs.mkdirSync(baselineDir, {recursive: true});
    fs.writeFileSync(
      path.join(baselineDir, DISPATCH_PLAN_FILE),
      JSON.stringify(plan, null, 2) + '\n'
    );
    console.log(
      `\nDispatch plan: ${plan.plans.length} workflow run(s)` +
        (plan.nightly ? ' (nightly revalidation)' : '') +
        ` -> ${path.join(baselineDir, DISPATCH_PLAN_FILE)}`
    );
  }

  console.log(
    `\n${findings.length} finding(s); ` +
      (prMode ? 'PR mode — no baseline, no issues.'
      : reportOnly ? 'report-only — table refreshed, nothing checked, nothing written.'
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
