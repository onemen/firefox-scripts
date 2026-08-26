#!/usr/bin/env node

/**
 * tools/check-browser-downloads.mjs — weekly watchdog for the E2E browser
 * download map (test/e2e/shared/downloads.mjs).
 *
 * The URL watchdog workflow (.github/workflows/url-watchdog.yml) runs this on a
 * schedule. For each browser CI installs (firefox, librewolf, floorp) it:
 *
 * 1. VERSION — reads the current release version from the vendor's API (Firefox
 *    product-details, LibreWolf Codeberg packages, Floorp GitHub releases).
 *    Nothing is downloaded.
 * 2. ENDPOINT — fetches the resolved installer URL with a 1 KB range request and
 *    asserts the host still serves a binary (2xx, binary content-type,
 *    plausible size). Catches 404s, HTML error pages and hosts that changed
 *    shape — the failure mode that made the LibreWolf winget leg flaky.
 * 3. BASELINE — compares versions against the last run's baseline (stored in the
 *    Actions cache under .watchdog/). New versions and broken endpoints open a
 *    GitHub issue, deduped per browser (the exact issue title is matched
 *    against open issues carrying the `url-watchdog` label).
 *
 * Never downloads the ~100 MB installers — a 1 KB ranged GET (plus cancelling
 * the body stream) is enough to verify a host. Requires GITHUB_TOKEN with
 * issues: write for issue creation; without it, or with --dry-run, findings are
 * printed instead. Exit code stays 0 when findings are reported (they become
 * issues, not CI failures).
 */

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {resolveDownloadUrl} from '../test/e2e/shared/downloads.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const REPO_ROOT = path.resolve(__dirname, '..');

export const WATCHDOG_LABEL = 'url-watchdog';
const MIN_BINARY_BYTES = 10_000_000; // installers are ~100 MB; smaller = wrong file
const RANGE_BYTES = 1024;

/** The browsers the E2E map installs — each must resolve + serve a binary. */
const BROWSERS = ['firefox', 'librewolf', 'floorp'];

const VERSION_APIS = {
  firefox: {
    // Mozilla product-details: the canonical "current stable version" endpoint.
    url: 'https://product-details.mozilla.org/1.0/firefox_versions.json',
    parse: j => j.LATEST_FIREFOX_VERSION,
  },
  librewolf: {
    // Gitea package list on Codeberg, newest-first; the installer is the
    // `generic` `librewolf` package (not `librewolf-source`).
    url: 'https://codeberg.org/api/v1/packages/librewolf',
    parse: packages => packages.find(p => p.type === 'generic' && p.name === 'librewolf')?.version,
  },
  floorp: {
    // Floorp moved to the Floorp-Projects org; the latest release's tag is the
    // marketing version.
    url: 'https://api.github.com/repos/Floorp-Projects/Floorp/releases/latest',
    parse: release => (release.tag_name || '').replace(/^v/, ''),
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
    return {ok: true, total};
  } finally {
    // Best-effort: drain/cancel is handled above; nothing further to release.
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
 * The dedup key for an issue: exact-title match against open issues carrying
 * the url-watchdog label, so a re-run never duplicates an open finding.
 */
export function issueTitle(kind, browser, {prevVersion, newVersion, reason} = {}) {
  if (kind === 'rot') {
    return `[url-watchdog] ${browser} download check failed: ${reason}`;
  }
  return `[url-watchdog] ${browser} ${prevVersion} → ${newVersion}`;
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
  const token = process.env.GITHUB_TOKEN || '';
  const repo = process.env.GITHUB_REPOSITORY || '';
  const baselineDir = process.env.BASELINE_DIR || path.join(REPO_ROOT, '.watchdog');
  const baselineFile = path.join(baselineDir, 'baseline.json');

  let baseline = {};
  if (fs.existsSync(baselineFile)) {
    baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf-8'));
  }

  const findings = [];
  const next = {};
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
    console.log(`  endpoint ok (${endpoint.total} bytes)`);

    const prev = baseline[browser];
    const change = compareBaseline(prev, {version});
    next[browser] = {version, size: endpoint.total};
    if (change === 'new-version') {
      console.log(`  ✗ new version: ${prev.version} → ${version}`);
      findings.push({
        kind: 'new-version',
        browser,
        prevVersion: prev.version,
        newVersion: version,
      });
    } else {
      console.log(`  ${change === 'first-run' ? 'first run — baseline recorded' : 'unchanged'}`);
    }
  }

  // Persist the baseline (only for non-dry runs; CI's cache step picks it up).
  if (!dryRun) {
    fs.mkdirSync(baselineDir, {recursive: true});
    fs.writeFileSync(baselineFile, JSON.stringify(next, null, 2) + '\n');
  }

  for (const f of findings) {
    const title = issueTitle(f.kind, f.browser, f);
    const body =
      `Watchdog run: ${runUrl || 'local'}\n\n` +
      (f.kind === 'rot' ?
        `The ${f.browser} download chain failed:\n\n- ${f.reason}\n\n` +
        'Check test/e2e/shared/downloads.mjs and the vendor host; E2E CI installs ' +
        'this browser from the resolved URL.'
      : `New ${f.browser} release: ${f.prevVersion} → ${f.newVersion}.\n\n` +
        'No action required unless E2E CI starts failing; the version-aware ' +
        'download cache key will invalidate on the next run.');
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
    `\n${findings.length} finding(s); baseline ${dryRun ? 'not written (dry-run)' : 'written'}.`
  );
}

const isMain =
  process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('check-browser-downloads.mjs');
if (isMain) {
  main().catch(err => {
    console.error(`✗ Error: ${err.message}`);
    process.exit(1);
  });
}
