// SPDX-License-Identifier: MIT
//
// scan-av.mjs — scan built binaries with whatever antivirus engine is
// available on the host, so a publish can refuse to ship a flagged artifact.
//
// Why: unsigned, stripped, statically-linked executables are a classic AV
// machine-learning false-positive profile.  The installer was once flagged by
// Windows Defender (Program:Script/Wacapew.A!ml) even though every local build
// scanned clean — the trigger was the exact bytes of one CI-built artifact.
// The durable guard is to scan the EXACT bytes about to be uploaded, on every
// publish, and fail if any engine reports a detection.
//
// Engines (best-effort — a missing engine is a warning, never a blocker, so
// the gate degrades gracefully on machines without one; a POSITIVE detection
// is always a hard failure):
//   - Windows: Windows Defender (MpCmdRun.exe)
//   - Linux/macOS: ClamAV (clamscan), if installed
//
// NOTE: GitHub-hosted Windows runners frequently run Defender in passive mode
// or without current definitions, so CI scans may be unavailable there — the
// real Windows validation happens on a developer's machine (Defender active)
// and on the Linux publish job (clamscan).

import {existsSync, readdirSync} from 'fs';
import {spawnSync} from 'child_process';
import path from 'path';
import {pathToFileURL} from 'url';

const MPCMD_PATHS = [
  'C:\\Program Files\\Windows Defender\\MpCmdRun.exe',
  'C:\\ProgramData\\Microsoft\\Windows Defender\\Platform',
];

/** Locate MpCmdRun.exe (Windows Defender command-line scanner) or null. */
function findMpCmdRun() {
  for (const p of MPCMD_PATHS) {
    if (!existsSync(p)) continue;
    if (p.endsWith('MpCmdRun.exe')) return p;
    // Versioned platform dirs: pick the newest.
    let versions;
    try {
      versions = readdirSync(p)
        .filter(d => /^\d/.test(d))
        .sort();
    } catch {
      continue;
    }
    if (!versions || versions.length === 0) continue;
    const exe = `${p}\\${versions.at(-1)}\\MpCmdRun.exe`;
    if (existsSync(exe)) return exe;
  }
  const which = spawnSync('where.exe', ['MpCmdRun.exe'], {encoding: 'utf8'});
  if (which.status === 0 && which.stdout.trim()) {
    return which.stdout.trim().split(/\r?\n/)[0];
  }
  return null;
}

/** Resolve a command on PATH (where.exe on Windows, which elsewhere). */
function findOnPath(cmd) {
  const which = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [cmd], {
    encoding: 'utf8',
  });
  return which.status === 0 && which.stdout.trim() ? which.stdout.trim().split(/\r?\n/)[0] : null;
}

/**
 * Scan one file with Windows Defender. Returns {clean: true} | {clean: false,
 * detail} | {clean: null, detail} when the engine is unavailable/errored (exit
 * codes other than 0/2).
 */
function scanWithDefender(file) {
  const mp = findMpCmdRun();
  if (!mp) return null;
  const r = spawnSync(mp, ['-Scan', '-ScanType', '3', '-File', file], {
    encoding: 'utf8',
    timeout: 180_000,
  });
  const out = `${r.stdout || ''}\n${r.stderr || ''}`.trim();
  const last = out.split('\n').filter(Boolean).at(-1) || '';
  // Parse the result line — MpCmdRun's exit codes are unreliable (2 can mean
  // both "threats found" and an operational error like a locked file).
  const found = out.match(/found (\d+) threats?/i);
  if (found && Number(found[1]) > 0) return {clean: false, detail: last};
  if (/found no threats/i.test(out)) return {clean: true, detail: last};
  return {clean: null, detail: last || `MpCmdRun exit ${r.status}`};
}

/** Scan one file with ClamAV. Same contract as scanWithDefender. */
function scanWithClamav(file) {
  const clam = findOnPath('clamscan');
  if (!clam) return null;
  const r = spawnSync(clam, [file, '--no-summary'], {encoding: 'utf8', timeout: 180_000});
  const out = `${r.stdout || ''}\n${r.stderr || ''}`.trim();
  const last = out.split('\n').filter(Boolean).at(-1) || '';
  if (r.status === 0) return {clean: true, detail: last};
  if (r.status === 1) return {clean: false, detail: last || 'threat found'};
  // exit 2 = engine error (e.g. missing signature database) → unavailable.
  return {clean: null, detail: last || `clamscan exit ${r.status}`};
}

/**
 * Scan a list of binary paths with the platform's available engine.
 *
 * @param {string[]} files absolute paths of the binaries to scan
 * @returns {Promise<{findings: Array; scanned: string[]; notes: string[]}>}
 *   findings — {file, engine, detail} for every POSITIVE detection (always empty
 *   on a clean run); scanned — files actually scanned; notes — why a
 *   file/engine was skipped (no engine installed, engine error).
 */
export async function scanBinaries(files) {
  const findings = [];
  const scanned = [];
  const notes = [];

  for (const file of files) {
    const onWin = process.platform === 'win32';
    const res = onWin ? scanWithDefender(file) : scanWithClamav(file);
    if (res === null) {
      notes.push(
        `AV scan skipped for ${file}: ${onWin ? 'Windows Defender (MpCmdRun.exe)' : 'clamscan'} not available`
      );
    } else if (res.clean === null) {
      notes.push(`AV scan skipped for ${file}: ${res.detail}`);
    } else if (res.clean) {
      scanned.push(file);
    } else {
      findings.push({file, engine: onWin ? 'Windows Defender' : 'ClamAV', detail: res.detail});
    }
  }

  return {findings, scanned, notes};
}

// CLI entry: node tools/scan-av.mjs <binary> [<binary>...]
// Exits 0 = clean, 1 = threats found, 2 = usage error.  A missing scanner is
// reported but NOT an error (exit 0) — the publish gate is what must enforce.
const isCli =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isCli) {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error('usage: node tools/scan-av.mjs <binary> [<binary>...]');
    process.exit(2);
  }
  const {findings, scanned, notes} = await scanBinaries(files.map(f => path.resolve(f)));
  for (const n of notes) console.warn(`! ${n}`);
  for (const f of findings) console.error(`!! ${f.file} — ${f.engine}: ${f.detail}`);
  if (findings.length > 0) process.exit(1);
  console.log(
    scanned.length > 0 ?
      `OK — ${scanned.length} file(s) scanned, no threats`
    : 'No AV engine available on this machine (install ClamAV or run on Windows with Defender)'
  );
}
