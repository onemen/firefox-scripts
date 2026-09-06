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
// environment, a transient API error, or a rate limit only warn, never block.
// The publish only hard-fails when the number of engines reporting the binary
// as malicious reaches VT_FAIL_THRESHOLD (default 3) — a strong multi-engine
// consensus that is not an AV false-positive.

import fs from 'fs';
import path from 'path';
import {pathToFileURL} from 'url';

const VT_API = 'https://www.virustotal.com/api/v3';
const POLL_INTERVAL_MS = 2000;
const DEFAULT_TIMEOUT_MS = 120_000;

export function vtApiKey() {
  return process.env.VT_API_KEY || process.env.VIRUSTOTAL_API_KEY || null;
}

export function vtFailThreshold() {
  const n = Number.parseInt(process.env.VT_FAIL_THRESHOLD ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 3;
}

/**
 * Pure verdict over VT detection stats.
 *
 * @param {{malicious: number; suspicious: number}} stats
 * @param {number} threshold
 * @returns {'fail' | 'warn' | 'clean'}
 */
export function vtVerdict(stats, threshold) {
  const malicious = Number(stats?.malicious ?? 0);
  if (malicious >= threshold) return 'fail';
  if (malicious > 0) return 'warn';
  return 'clean';
}

async function uploadFile(apikey, file) {
  const buf = await fs.promises.readFile(file);
  const form = new FormData();
  form.append('file', new Blob([buf]), path.basename(file));
  const res = await fetch(`${VT_API}/files`, {
    method: 'POST',
    headers: {'x-apikey': apikey},
    body: form,
  });
  if (!res.ok) throw new Error(`VirusTotal upload failed (HTTP ${res.status})`);
  return (await res.json()).data?.id;
}

async function getAnalysis(apikey, id) {
  const res = await fetch(`${VT_API}/analyses/${id}`, {headers: {'x-apikey': apikey}});
  if (!res.ok) throw new Error(`VirusTotal analysis failed (HTTP ${res.status})`);
  return (await res.json()).data;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Scan each binary against VirusTotal and return per-file results. Never throws
 * — per-file errors are captured in each result.
 *
 * @param {string[]} files absolute paths of the binaries to scan
 * @param {{threshold?: number; timeoutMs?: number}} [opts]
 * @returns {Promise<{results: Array}>} results entries: {file, status,
 *   stats:{malicious,suspicious,harmless,undetected}} or {file, error} when
 *   that file's scan failed.
 */
export async function scanVirusTotal(
  files,
  {threshold = vtFailThreshold(), timeoutMs = DEFAULT_TIMEOUT_MS} = {}
) {
  const key = vtApiKey();
  if (!key) return {results: []};
  const results = [];
  for (const file of files) {
    try {
      const id = await uploadFile(key, file);
      const start = Date.now();
      let data;
      do {
        await sleep(POLL_INTERVAL_MS);
        data = await getAnalysis(key, id);
      } while (data.attributes?.status === 'queued' && Date.now() - start < timeoutMs);
      const stats = data.attributes?.stats ?? {};
      results.push({
        file,
        status: data.attributes?.status,
        stats,
        threshold,
        verdict: vtVerdict(stats, threshold),
      });
    } catch (err) {
      results.push({file, error: err.message});
    }
  }
  return {results};
}

// CLI entry: node tools/scan-vt.mjs <binary> [<binary>...]
// Reads VT_API_KEY from the environment (e.g. via `node --env-file-if-exists=.env`,
// as pnpm scan:vt does).  Exits 0 = clean, 1 = >= threshold engines flagged, 2 = usage.
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
    if (r.verdict === 'fail') {
      console.error(`!! ${line}`);
      blocked = true;
    } else if (r.verdict === 'warn') {
      console.warn(`! ${line}`);
    } else {
      console.log(`OK ${line}`);
    }
  }
  if (blocked) process.exit(1);
}
