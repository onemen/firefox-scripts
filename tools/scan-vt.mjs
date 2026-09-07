// SPDX-License-Identifier: MIT
//
// tools/scan-vt.mjs — optional multi-engine scan of built binaries against
// VirusTotal before publishing.
//
// Why: the host AV gate (tools/scan-av.mjs) catches what the local engine
// sees, but installer_win.exe's false positive (Defender
// Program:Script/Wacapew.A!ml) was only confirmed as multi-engine by checking
// VT's ~70 engines (Defender local-vs-cloud, McAfee, Bkav).  Running every
// built binary through VT at publish time turns that manual check into a gate.
//
// Best-effort by design — VT_API_KEY (or VIRUSTOTAL_API_KEY) in the
// environment, a transient API error, a rate limit, or an analysis that never
// completes only warn, never block.  The publish hard-fails when the number of
// engines reporting the binary as malicious reaches VT_FAIL_THRESHOLD (default
// 3) — a multi-engine consensus that is not an AV false-positive — OR when a
// veto engine (Microsoft, the complainant in the original issue) reports it as
// malicious at any count.  An incomplete analysis is NEVER reported as clean:
// if VirusTotal has not finished scanning when the timeout elapses, the file
// is skipped with a warning so the publish cannot claim a verdict it did not
// get.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {pathToFileURL} from 'url';

const VT_API = 'https://www.virustotal.com/api/v3';
const POLL_INTERVAL_MS = 2000;
const DEFAULT_TIMEOUT_MS = 300_000;
// Engines whose 'malicious' verdict alone vetoes the publish (see
// docs/DEVELOPING.md — Microsoft cloud flagged installer_win.exe even when
// every other engine stayed silent, so a Defender verdict must never ship).
const VETO_ENGINES = ['Microsoft'];

export function vtApiKey() {
  return process.env.VT_API_KEY || process.env.VIRUSTOTAL_API_KEY || null;
}

export function vtFailThreshold() {
  const n = Number.parseInt(process.env.VT_FAIL_THRESHOLD ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 3;
}

export function vtVetoEngines() {
  const raw = process.env.VT_VETO_ENGINES;
  const parsed = (raw ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  // Empty/unset (or a list that filters to nothing) ⇒ the default veto.
  return parsed.length > 0 ? parsed : [...VETO_ENGINES];
}

/**
 * Pure verdict over VT detection stats. Only meaningful for a COMPLETED
 * analysis (see analysisComplete) — an empty/incomplete stats object is not
 * "clean", callers must guard with analysisComplete first.
 *
 * @param {{malicious: number; suspicious: number}} stats
 * @param {number} threshold
 * @param {Object<string, {category?: string}>} [engines] per-engine results
 * @param {string[]} [vetoEngines] engines whose malicious verdict is a veto
 * @returns {'fail' | 'warn' | 'clean'}
 */
export function vtVerdict(stats, threshold, engines = {}, vetoEngines = VETO_ENGINES) {
  const malicious = Number(stats?.malicious ?? 0);
  const vetoed = Object.entries(engines).some(
    ([name, result]) => vetoEngines.includes(name) && result?.category === 'malicious'
  );
  if (vetoed || malicious >= threshold) return 'fail';
  if (malicious > 0) return 'warn';
  return 'clean';
}

/**
 * Number of engines that reported a result in the given stats object (every VT
 * category counts — a verdict of "clean" with zero engines is meaningless).
 *
 * @param {{}} stats
 * @returns {number}
 */
export function enginesReported(stats) {
  const s = stats ?? {};
  return [
    'malicious',
    'suspicious',
    'harmless',
    'undetected',
    'timeout',
    'confirmed-timeout',
    'failure',
    'type-unsupported',
  ].reduce((n, k) => n + Number(s[k] ?? 0), 0);
}

/**
 * A VT analysis is only trustworthy once it finished (status 'completed') AND
 * at least one engine reported a result. A 'queued'/'running' analysis, or a
 * 'completed' one with empty stats, must never be read as a verdict.
 *
 * @param {string | undefined} status
 * @param {{}} stats
 * @returns {boolean}
 */
export function analysisComplete(status, stats) {
  return status === 'completed' && enginesReported(stats) > 0;
}

/**
 * Engine names whose last result was 'malicious'.
 *
 * @param {Object<string, {category?: string}> | undefined} engines
 * @returns {string[]}
 */
export function maliciousEngines(engines) {
  return Object.entries(engines ?? {})
    .filter(([, result]) => result?.category === 'malicious')
    .map(([name]) => name);
}

/**
 * Submit bytes to VirusTotal and return either a fresh pollable analysis id
 * ({id}) or, when VirusTotal already knows the bytes and rejects the duplicate
 * submission with HTTP 409 (AlreadySubmittedError), their last completed stats
 * ({stats}). Never throws on 409 — the known file's stats are the fallback so
 * repeat scans of unchanged bytes still get a verdict.
 */
async function uploadFile(apikey, file) {
  const buf = await fs.promises.readFile(file);
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const form = new FormData();
  form.append('file', new Blob([buf]), path.basename(file));
  const res = await fetch(`${VT_API}/files`, {
    method: 'POST',
    headers: {'x-apikey': apikey},
    body: form,
  });
  if (res.ok) {
    const id = (await res.json()).data?.id;
    if (id) return {sha256, id};
    throw new Error('VirusTotal returned no analysis id');
  }
  if (res.status !== 409) throw new Error(`VirusTotal upload failed (HTTP ${res.status})`);
  // Duplicate submission — fall back to the file's last completed analysis.
  const known = await fetch(`${VT_API}/files/${sha256}`, {
    headers: {'x-apikey': apikey},
  });
  if (!known.ok) throw new Error(`VirusTotal upload failed (HTTP ${res.status})`);
  return {sha256, stats: (await known.json()).data?.attributes?.last_analysis_stats ?? {}};
}

async function getAnalysis(apikey, id) {
  const res = await fetch(`${VT_API}/analyses/${id}`, {headers: {'x-apikey': apikey}});
  if (!res.ok) throw new Error(`VirusTotal analysis failed (HTTP ${res.status})`);
  return (await res.json()).data;
}

/** Best-effort per-engine results of the file's last completed analysis. */
async function getFileEngines(apikey, sha256) {
  const res = await fetch(`${VT_API}/files/${sha256}`, {headers: {'x-apikey': apikey}});
  if (!res.ok) return undefined;
  return (await res.json()).data?.attributes?.last_analysis_results;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Scan each binary against VirusTotal and return per-file results. Never throws
 * — per-file errors are captured in each result.
 *
 * @param {string[]} files absolute paths of the binaries to scan
 * @param {{threshold?: number; timeoutMs?: number}} [opts]
 * @returns {Promise<{results: Array}>} results entries: {file, status, stats,
 *   threshold, verdict, flags} or {file, error} when that file's scan failed or
 *   never completed.
 */
export async function scanVirusTotal(
  files,
  {threshold = vtFailThreshold(), timeoutMs = DEFAULT_TIMEOUT_MS} = {}
) {
  const key = vtApiKey();
  if (!key) return {results: []};
  // The veto list is read once per run so the env override (VT_VETO_ENGINES)
  // reaches the verdict — without this, vtVerdict's default would silently
  // hardcode the VETO_ENGINES constant and the knob would do nothing.
  const vetoEngines = vtVetoEngines();
  const results = [];
  for (const file of files) {
    try {
      const uploaded = await uploadFile(key, file);
      let stats;
      if (uploaded.stats) {
        // Bytes VirusTotal already knew — its last completed analysis is the
        // verdict.  An empty stats object means the analysis has not finished
        // yet: skip with a warning, never report as clean.
        if (!analysisComplete('completed', uploaded.stats)) {
          results.push({
            file,
            error:
              'VirusTotal has no completed analysis for these bytes yet — skipping, not treated as clean',
          });
          continue;
        }
        stats = uploaded.stats;
      } else {
        const start = Date.now();
        let data;
        for (;;) {
          await sleep(POLL_INTERVAL_MS);
          data = await getAnalysis(key, uploaded.id);
          const attrs = data.attributes ?? {};
          if (analysisComplete(attrs.status, attrs.stats) || Date.now() - start >= timeoutMs) break;
        }
        const attrs = data.attributes ?? {};
        stats = attrs.stats ?? {};
        if (!analysisComplete(attrs.status, stats)) {
          // VirusTotal never finished scanning (still queued, or completed
          // with no engine results).  Skip with a warning — never clean.
          results.push({
            file,
            error:
              `VirusTotal analysis incomplete after ${Math.round((Date.now() - start) / 1000)}s ` +
              `(status: ${attrs.status ?? 'unknown'}) — skipping, not treated as clean`,
          });
          continue;
        }
      }
      // Engine names only matter once something is flagged (a veto engine at
      // count 0 is a contradiction) — and the lookup is best-effort: if it
      // fails, the count-based verdict still stands (never a silent clean).
      let engines;
      if ((stats.malicious ?? 0) > 0) {
        try {
          engines = await getFileEngines(key, uploaded.sha256);
        } catch {
          engines = undefined;
        }
      }
      results.push({
        file,
        status: 'completed',
        stats,
        threshold,
        verdict: vtVerdict(stats, threshold, engines, vetoEngines),
        flags: maliciousEngines(engines),
      });
    } catch (err) {
      results.push({file, error: err.message});
    }
  }
  return {results};
}

// CLI entry: node tools/scan-vt.mjs <binary> [<binary>...]
// Reads VT_API_KEY from the environment (e.g. via `node --env-file-if-exists=.env`,
// as pnpm scan:vt does).  Exits 0 = clean, 1 = flagged (>= threshold engines or
// a veto engine), 2 = usage.
const isCli =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isCli) {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error('usage: node tools/scan-vt.mjs <binary> [<binary>...]');
    process.exit(2);
  }
  const {results} = await scanVirusTotal(files.map(f => path.resolve(f)));
  if (results.length === 0) {
    console.warn('VirusTotal scan skipped — VT_API_KEY not set (add it to .env).');
    process.exit(0);
  }
  let blocked = false;
  for (const r of results) {
    if (r.error) {
      console.warn(`! ${r.file} — ${r.error}`);
      continue;
    }
    const {malicious, suspicious, harmless, undetected} = r.stats;
    const line =
      `${r.file} — ${malicious} malicious / ${suspicious} suspicious / ` +
      `${harmless} harmless / ${undetected} undetected (threshold ${r.threshold})`;
    const who = r.flags.length > 0 ? ` (flagged by ${r.flags.join(', ')})` : '';
    if (r.verdict === 'fail') {
      console.error(`!! ${line}${who}`);
      blocked = true;
    } else if (r.verdict === 'warn') {
      console.warn(`! ${line}${who}`);
    } else {
      console.log(`OK ${line}`);
    }
  }
  if (blocked) process.exit(1);
}
