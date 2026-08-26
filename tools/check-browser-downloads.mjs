#!/usr/bin/env node

/**
 * tools/check-browser-downloads.mjs — watchdog for the E2E browser download map
 * (test/e2e/shared/downloads.mjs).
 *
 * Runs in two modes, both driven by .github/workflows/url-watchdog.yml:
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
 *   4. ISSUES — new versions, rot, and same-version size changes open a GitHub
 *        issue, deduped per browser (the exact issue title is matched against
 *        open issues carrying the `url-watchdog` label). New-release issues
 *        carry the verified SHA-256 + size — the durable ledger (search
 *        `label:url-watchdog` for the record of any release).
 * - PR (pull_request touching the download map): stateless and always green —
 *   findings surface as ::warning:: / ::notice:: annotations, so the check can
 *   be marked required without ever blocking. No baseline, no issues, no full
 *   downloads.
 *
 * Browsers without a direct download URL (waterfox) are tracked by version
 * only: their vendor API is still polled, but there is no endpoint to verify
 * and no CI recipe to install.
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
import {downloadTo, resolveDownloadUrl} from '../test/e2e/shared/downloads.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const REPO_ROOT = path.resolve(__dirname, '..');

export const WATCHDOG_LABEL = 'url-watchdog';
const MIN_BINARY_BYTES = 10_000_000; // installers are ~100 MB; smaller = wrong file
const RANGE_BYTES = 1024;

/** Browsers the E2E map installs or tracks — each must resolve its version. */
const BROWSERS = ['firefox', 'firefox-dev', 'librewolf', 'floorp', 'zen', 'waterfox'];

const VERSION_APIS = {
  'firefox': {
    // Mozilla product-details: the canonical "current stable version" endpoint.
    url: 'https://product-details.mozilla.org/1.0/firefox_versions.json',
    parse: j => j.LATEST_FIREFOX_VERSION,
  },
  'firefox-dev': {
    url: 'https://product-details.mozilla.org/1.0/firefox_versions.json',
    parse: j => j.FIREFOX_DEVEDITION,
  },
  'librewolf': {
    // Gitea package list on Codeberg, newest-first; the installer is the
    // `generic` `librewolf` package (not `librewolf-source`).
    url: 'https://codeberg.org/api/v1/packages/librewolf',
    parse: packages => packages.find(p => p.type === 'generic' && p.name === 'librewolf')?.version,
  },
  'floorp': {
    // Floorp moved to the Floorp-Projects org; the latest release's tag is the
    // marketing version.
    url: 'https://api.github.com/repos/Floorp-Projects/Floorp/releases/latest',
    parse: release => (release.tag_name || '').replace(/^v/, ''),
  },
  'zen': {
    url: 'https://api.github.com/repos/zen-browser/desktop/releases/latest',
    parse: release => (release.tag_name || '').replace(/^v/, ''),
  },
  'waterfox': {
    // Waterfox publishes no release assets on GitHub — version-only tracking
    // (no direct download URL, so no endpoint to verify).
    url: 'https://api.github.com/repos/BrowserWorks/Waterfox/releases/latest',
    parse: release => (release.tag_name || '').replace(/^v/, ''),
    manual: true,
  },
};

/** Fetch + JSON-parse a URL, bounded by a timeout. */
async function getJson(url) {
  const res = await fetch(url, {signal: AbortSignal.timeout(30_000)});
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

/** Resolve the current release version for a browser from its vendor API. */
async function resolveVersion(browser) {
  const {url, parse} = VERSION_APIS[browser];
  const version = parse(await getJson(url));
  if (!version) {
    throw new Error(`version API for ${browser} returned no version (${url})`);
  }
  return String(version);
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
 * The dedup key for an issue: exact-title match against open issues carrying
 * the url-watchdog label, so a re-run never duplicates an open finding.
 */
export function issueTitle(kind, browser, {prevVersion, newVersion, reason} = {}) {
  if (kind === 'rot') {
    return `[url-watchdog] ${browser} download check failed: ${reason}`;
  }
  if (kind === 'size-change') {
    return `[url-watchdog] ${browser} same version, binary size changed`;
  }
  return `[url-watchdog] ${browser} ${prevVersion} → ${newVersion}`;
}

/**
 * Markdown body for a watchdog issue. New-release bodies carry the verified
 * SHA-256 + size — the durable ledger record for that browser/version.
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

/** Open a watchdog issue unless an open one with the same title already exists. */
async function openIssueIfNew(token, repo, title, body) {
  const open = await ghApi(
    token,
    `/repos/${repo}/issues?state=open&labels=${WATCHDOG_LABEL}&per_page=100`
  );
  if (open.some(i => i.title === title)) {
    console.log(`  already open: ${title}`);
    return;
  }
  await ghApi(token, `/repos/${repo}/issues`, {
    method: 'POST',
    body: {title, body, labels: [WATCHDOG_LABEL]},
  });
  console.log(`  opened issue: ${title}`);
}

export async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const prMode = process.argv.includes('--pr');
  const token = process.env.GITHUB_TOKEN || '';
  const repo = process.env.GITHUB_REPOSITORY || '';
  const baselineDir = process.env.BASELINE_DIR || path.join(REPO_ROOT, '.watchdog');
  const baselineFile = path.join(baselineDir, 'baseline.json');

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
  // Start from the loaded baseline so a browser whose check failed this run
  // keeps its recorded {version, size, sha256} instead of being erased — a
  // release landing during a transient outage must still reach the ledger.
  const next = {...baseline};
  const runUrl =
    process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY ?
      `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID || ''}`
    : '';

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
      findings.push({kind: 'rot', browser, reason});
      continue;
    }

    const prev = prMode ? undefined : baseline[browser];
    const change = compareBaseline(prev, {version});

    // Manual browsers (no direct download URL): version tracked only.
    if (VERSION_APIS[browser].manual) {
      console.log('  no direct download URL — manual install (version tracked only)');
      if (!prMode) {
        next[browser] = {version, manual: true};
        if (change === 'new-version') {
          console.log(`  new version: ${prev.version} → ${version} (no CI recipe — no action)`);
        } else {
          console.log(change === 'first-run' ? '  first run — baseline recorded' : '  unchanged');
        }
      }
      continue;
    }

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
      findings.push({kind: 'rot', browser, reason: endpoint.reason, version});
      continue; // broken chain — do not touch the baseline for this browser
    }
    console.log(
      `  endpoint ok${endpoint.total ? ` (${endpoint.total} bytes)` : ' (no size reported)'}`
    );

    // PR mode: stateless, always green — surface findings as annotations.
    if (prMode) {
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
        findings.push({kind: 'rot', browser, reason: verified.reason, version});
        continue;
      }
      console.log(`  sha256 ${verified.sha256}`);
      next[browser] = {version, size: verified.size, sha256: verified.sha256};
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
    next[browser] = {version, size: total || prev.size || null, sha256: prev.sha256 || null};
    if (total && prev.size && prev.size !== total) {
      console.log(`  ⚠ same version, binary size changed: ${prev.size} → ${total}`);
      findings.push({
        kind: 'size-change',
        browser,
        prevSize: prev.size,
        newSize: total,
      });
    } else {
      console.log('  unchanged');
    }
  }

  // Persist the baseline (schedule mode only; CI's cache step picks it up).
  if (!prMode && !dryRun) {
    fs.mkdirSync(baselineDir, {recursive: true});
    fs.writeFileSync(baselineFile, JSON.stringify(next, null, 2) + '\n');
  }

  for (const f of findings) {
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
