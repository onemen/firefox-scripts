// SPDX-License-Identifier: MIT
//
// tools/check-published-av.mjs — re-scan the binaries that are PUBLISHED, not
// the ones a run is about to publish.
//
// Why: the publish gate (tools/scan-vt.mjs in tools/publish/upload.mjs) judges
// the exact bytes it uploads, once, at publish time.  AV verdicts are not
// stable — the 2026-09-05 incident was a *cleared* binary that started being
// flagged afterwards, and Microsoft's `!ml` models re-roll verdicts as their
// training data moves.  Nothing watched the served bytes, so a flip was
// invisible until a user reported it (issue #157).
//
// What it does: read every surface a user can download from — the published
// Pages ref (gh-pages by default) plus the `latest` and `installer-<date>`
// releases — hash each installer/helper binary, and ask VirusTotal what it
// thinks of that hash — a lookup, never an upload, because the bytes are
// already public and the question is what the engines say about what users
// download TODAY.  The same build is usually served from several of those
// surfaces; because a verdict is about the bytes, hashes are de-duplicated and
// recorded once.  Verdicts are merged into a per-hash ledger
// (tools/ci/avLedger.mjs) and surfaced two ways: one status meta issue
// (`[av-watchdog] published binaries`) and one deduped issue per flagged hash,
// which auto-closes when a later run sees the hash clean again — the same
// shape as the url/skills watchdogs.
//
// Issues only: this tool never fails the run.  A flagged published binary is a
// finding to triage (re-report to Microsoft, publish a rebuild or a signed
// artifact), not a broken pipeline.
//
// Usage:
//   node tools/check-published-av.mjs [--ref gh-pages] [--repo owner/name]
//                                     [--state-dir .watchdog-av] [--dry-run]
//
// Environment: GITHUB_TOKEN (issues: write; a plain read token still allows the
// listing/hash pass), VT_API_KEY (without it the run records the hashes as
// 'unknown' and skips verdicts), GITHUB_STEP_SUMMARY (optional), GITHUB_REPOSITORY.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import {lookupVirusTotalHashes, vtApiKey, vtFailThreshold, vtVetoEngines} from './scan-vt.mjs';
import {
  AV_WATCHDOG_LABEL,
  META_ISSUE_TITLE,
  isCleared,
  isWatchedRelease,
  issueBodyFor,
  issueTitleFor,
  ledgerEntry,
  ledgerStats,
  ledgerTable,
  mergeLedger,
  pickPublishedBinaries,
  shortHash,
} from './ci/avLedger.mjs';

const DEFAULT_STATE_DIR = '.watchdog-av';
const LEDGER_FILE = 'vt-ledger.json';

/** Minimal GitHub REST helper (contents + issues). */
async function ghApi(token, pathname, {method = 'GET', body} = {}) {
  const res = await fetch(`https://api.github.com${pathname}`, {
    method,
    headers: {
      ...(token ? {Authorization: `Bearer ${token}`} : {}),
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? {'Content-Type': 'application/json'} : {}),
    },
    ...(body ? {body: JSON.stringify(body)} : {}),
    signal: AbortSignal.timeout(30_000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GitHub API ${method} ${pathname}: HTTP ${res.status}`);
  return json;
}

/** Files at the root of a published ref (name + download_url). */
async function listPublished(token, repo, ref) {
  const entries = await ghApi(token, `/repos/${repo}/contents/?ref=${encodeURIComponent(ref)}`);
  return entries
    .filter(e => e.type === 'file')
    .map(e => ({name: e.name, size: e.size, url: e.download_url, surface: ref}));
}

/**
 * Binaries attached to releases. The same bytes are served from more than one
 * place — the Pages surface, the `latest` release and the date-stamped
 * `installer-<date>` snapshots (ADR 0019) — and a user can download from any of
 * them, so each is a surface to watch, not a mirror to assume.
 */
async function listReleaseBinaries(token, repo) {
  const releases = await ghApi(token, `/repos/${repo}/releases?per_page=100`);
  const files = [];
  for (const rel of releases.filter(r => isWatchedRelease(r.tag_name))) {
    const assets = await ghApi(token, `/repos/${repo}/releases/${rel.id}/assets?per_page=100`);
    for (const a of assets) {
      files.push({
        name: a.name,
        size: a.size,
        url: a.browser_download_url,
        surface: `release:${rel.tag_name}`,
      });
    }
  }
  return files;
}

/** sha256 + size of a published file (download_url is public raw content). */
async function hashRemote(file) {
  const res = await fetch(file.url, {signal: AbortSignal.timeout(120_000)});
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return {sha256: crypto.createHash('sha256').update(buf).digest('hex'), size: buf.length};
}

/** Open watchdog issues whose title carries a 12-char hash prefix. */
async function openWatchdogIssues(token, repo) {
  return ghApi(token, `/repos/${repo}/issues?state=open&labels=${AV_WATCHDOG_LABEL}&per_page=100`);
}

/** `[av-watchdog] <file> <hash12…> <verdict>` → hash prefix, or null. */
function hashPrefixOf(title) {
  const m = /^\[av-watchdog\] \S+ ([0-9a-f]{12})…/.exec(title);
  return m ? m[1] : null;
}

async function upsertMetaIssue(token, repo, body, dryRun) {
  const open = await openWatchdogIssues(token, repo);
  const existing = open
    .filter(i => i.title === META_ISSUE_TITLE)
    .sort((a, b) => a.number - b.number)[0];
  if (existing) {
    if (existing.body === body) {
      console.log('meta issue already current');
      return;
    }
    if (dryRun) {
      console.log(`[dry-run] would update meta issue #${existing.number}`);
      return;
    }
    await ghApi(token, `/repos/${repo}/issues/${existing.number}`, {method: 'PATCH', body: {body}});
    console.log(`updated meta issue #${existing.number}`);
    return;
  }
  if (dryRun) {
    console.log('[dry-run] would create the meta issue');
    return;
  }
  const created = await ghApi(token, `/repos/${repo}/issues`, {
    method: 'POST',
    body: {title: META_ISSUE_TITLE, body, labels: [AV_WATCHDOG_LABEL]},
  });
  console.log(`created meta issue #${created.number}`);
}

async function openFlaggedIssue(token, repo, title, body, dryRun) {
  const open = await openWatchdogIssues(token, repo);
  const existing = open.find(i => i.title === title);
  if (existing) {
    console.log(`issue already open: ${title}`);
    return;
  }
  if (dryRun) {
    console.log(`[dry-run] would open: ${title}`);
    return;
  }
  const created = await ghApi(token, `/repos/${repo}/issues`, {
    method: 'POST',
    body: {title, body, labels: [AV_WATCHDOG_LABEL]},
  });
  console.log(`opened issue #${created.number}: ${title}`);
}

/** Close flag issues whose hash is clean in the merged ledger. */
async function closeClearedIssues(token, repo, ledger, runUrl, dryRun) {
  const open = await openWatchdogIssues(token, repo);
  for (const issue of open) {
    if (issue.title === META_ISSUE_TITLE) continue;
    const prefix = hashPrefixOf(issue.title);
    if (!prefix) continue;
    const hash = Object.keys(ledger.files).find(h => h.startsWith(prefix));
    if (!hash || !isCleared(ledger, hash)) continue;
    if (dryRun) {
      console.log(`[dry-run] would close #${issue.number} (${prefix} is clean again)`);
      continue;
    }
    await ghApi(token, `/repos/${repo}/issues/${issue.number}/comments`, {
      method: 'POST',
      body: {body: `Cleared: \`${hash}\` is no longer flagged. Resolved by ${runUrl}`},
    });
    await ghApi(token, `/repos/${repo}/issues/${issue.number}`, {
      method: 'PATCH',
      body: {state: 'closed'},
    });
    console.log(`closed #${issue.number} (${prefix} clean again)`);
  }
}

function parseArgs(argv) {
  const opts = {ref: 'gh-pages', repo: '', stateDir: DEFAULT_STATE_DIR, dryRun: false};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--ref' && argv[i + 1]) opts.ref = argv[++i];
    else if (argv[i] === '--repo' && argv[i + 1]) opts.repo = argv[++i];
    else if (argv[i] === '--state-dir' && argv[i + 1]) opts.stateDir = argv[++i];
    else if (argv[i] === '--dry-run') opts.dryRun = true;
    else {
      console.error(`unknown argument: ${argv[i]}`);
      process.exit(2);
    }
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const token = process.env.GITHUB_TOKEN || '';
const repo = opts.repo || process.env.GITHUB_REPOSITORY || '';
if (!repo) {
  console.error('usage: node tools/check-published-av.mjs [--repo owner/name] [--ref gh-pages]');
  process.exit(2);
}
const runUrl =
  process.env.GITHUB_SERVER_URL && process.env.GITHUB_RUN_ID ?
    `${process.env.GITHUB_SERVER_URL}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`
  : 'local run';

// Fail-soft by design: this job re-scans bytes that are already published, and
// a listing outage (GitHub API hiccup, CDN flake) must not turn a scheduled run
// into a red build — the next weekly run picks it up. A *verdict* is a finding;
// an unreachable listing is not.
let listing = [];
let releaseFiles = [];
try {
  listing = await listPublished(token, repo, opts.ref);
  releaseFiles = await listReleaseBinaries(token, repo);
} catch (err) {
  console.warn(`could not list the published surface (${err.message}) — skipping this run`);
  process.exit(0);
}
const files = [...listing, ...releaseFiles].filter(f => pickPublishedBinaries([f.name]).length > 0);
if (files.length === 0) {
  console.log(
    `no published installer/helper binaries on '${opts.ref}' or in its releases — nothing to watch yet`
  );
  process.exit(0);
}

// One entry per distinct byte sequence: the same build is often served from the
// Pages surface AND a release, and a verdict is about the bytes, not the URL.
const published = [];
const bySha = new Map();
for (const file of files) {
  // One unreadable artifact (a 404 after a re-publish, a stalled transfer)
  // skips that file; it never aborts the watch over the rest.
  let sha256;
  let size;
  try {
    ({sha256, size} = await hashRemote(file));
  } catch (err) {
    console.warn(`${file.name} (${file.surface}): could not be read (${err.message}) — skipped`);
    continue;
  }
  const seen = bySha.get(sha256);
  if (seen) {
    seen.surfaces.push(file.surface);
    console.log(`${file.name} (${file.surface}): same bytes as ${seen.name} — not re-scanned`);
    continue;
  }
  const entry = {name: file.name, sha256, size, surfaces: [file.surface]};
  bySha.set(sha256, entry);
  published.push(entry);
  console.log(`${file.name} (${file.surface}): ${size} bytes sha256 ${sha256}`);
}

const at = new Date().toISOString();
const verdicts = await lookupVirusTotalHashes(
  published.map(p => p.sha256),
  {
    threshold: vtFailThreshold(),
    vetoEngines: vtVetoEngines(),
  }
);
const byHash = new Map(verdicts.map(v => [v.sha256, v]));
if (!vtApiKey()) {
  console.warn('VT_API_KEY not set — recording hashes as unknown, skipping verdicts');
}

const entries = published.map(p => {
  const v = byHash.get(p.sha256);
  return ledgerEntry({
    file: p.name,
    sha256: p.sha256,
    size: p.size,
    verdict: v?.verdict ?? 'unknown',
    stats: v?.stats,
    flags: v?.flags,
    threshold: v?.threshold,
    source: 'av-watchdog',
    at,
    reason: v?.reason ?? (vtApiKey() ? undefined : 'VT_API_KEY not set'),
  });
});

const ledgerFile = path.join(opts.stateDir, LEDGER_FILE);
const prev = fs.existsSync(ledgerFile) ? JSON.parse(fs.readFileSync(ledgerFile, 'utf-8')) : null;
const ledger = mergeLedger(prev, entries, {at});
if (!opts.dryRun) {
  fs.mkdirSync(opts.stateDir, {recursive: true});
  fs.writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2) + '\n');
  console.log(`ledger: ${ledgerFile} (${Object.keys(ledger.files).length} hash(es))`);
}

const stats = ledgerStats(ledger);
const table = ledgerTable(ledger);
const surfaces = [...new Set(published.flatMap(p => p.surfaces))].sort();
if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `## av-watchdog — published binaries (${surfaces.join(', ')})\n\n` +
      `${stats.fail} fail / ${stats.warn} warn / ${stats.clean} clean / ${stats.unknown} unknown` +
      ` (${stats.total} hashes)\n\n${table}\n`
  );
}

const flagged = entries.filter(e => e.verdict === 'fail' || e.verdict === 'warn');
for (const e of flagged) {
  const line = `${e.file} ${shortHash(e.sha256)} — ${e.verdict} (${e.flags.join(', ') || 'no engine names'})`;
  if (e.verdict === 'fail') console.log(`::warning::av-watchdog: ${line}`);
  else console.log(`::notice::av-watchdog: ${line}`);
}
for (const e of entries) {
  if (!flagged.includes(e)) console.log(`ok ${e.file} ${shortHash(e.sha256)} — ${e.verdict}`);
}

if (token) {
  await upsertMetaIssue(
    token,
    repo,
    [
      `Re-scan of the binaries published on \`${opts.ref}\`: **${stats.fail} fail** / ` +
        `**${stats.warn} warn** / ${stats.clean} clean / ${stats.unknown} unknown.`,
      '',
      'A verdict here is about the bytes users download **today** — the publish gate only judges',
      'the bytes a single run uploads, so a flip after a clean publish lands here first.',
      '',
      table,
      '',
      `Last run: ${runUrl}`,
    ].join('\n'),
    opts.dryRun
  );
  for (const e of flagged) {
    await openFlaggedIssue(token, repo, issueTitleFor(e), issueBodyFor(e, runUrl), opts.dryRun);
  }
  await closeClearedIssues(token, repo, ledger, runUrl, opts.dryRun);
} else {
  console.log('GITHUB_TOKEN not set — skipping the issue surface');
}
