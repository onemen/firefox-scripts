// test/e2e/shared/processHygiene.mjs — E2E profile/process hygiene (issue
// #130): deterministic repeat runs with no manual cleanup in between.
//
// Three primitives, all best-effort (they log what they did and never throw —
// a hygiene failure must not mask the test's own result):
//
// - killStrayProcesses(): pre-run sweep. A cancelled/crashed previous run can
//   leave the detached installer holding port 8777 (the next run's
//   waitForServer would then talk to the DEAD run's server) and BiDi-driven
//   browser instances holding temp profiles. Sweeps processes whose command
//   line references the harness's temp-dir prefixes (`fxs-e2e`,
//   `fxs-installer-ui`) or the harness-built installer binaries
//   (`installer_win|linux|mac` under dist/.build).
//
// - removeProfileCompatibilityIni(profileDir): deletes compatibility.ini after
//   profile seeding so Firefox cannot reuse stale GRE-compatibility state from
//   a previous run sharing the directory.
//
// - closeBrowser(browser): browser.close() + wait for the OS process to
//   actually exit, so the next scenario starts with the port and profile
//   directory genuinely free (bare `browser.close()` resolves when the BiDi
//   session ends, which can race the process teardown).

import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Does a process command line belong to the E2E harness? Matches the temp-dir
 * prefixes the harness passes in argv (browser profiles, the installer
 * `--env-file` dir) and the harness-built installer binary names. Exported for
 * unit tests.
 *
 * @param {string | null | undefined} cmdline full command line of a process
 * @returns {boolean}
 */
export function isE2eProcess(cmdline) {
  if (!cmdline) return false;
  return /fxs-(e2e|installer-ui)|installer_(win|linux|mac)/.test(cmdline);
}

/**
 * Kill processes left behind by a previous E2E run. Never throws: if the OS
 * tooling is unavailable or lists nothing, the sweep is a no-op with a log
 * line.
 *
 * Unit-test seam: `run` replaces the spawnSync call (tests must never execute
 * the real sweep — it kills matching processes) and `platform` selects the
 * win32/POSIX branch so both are covered on any host.
 *
 * @param {{
 *   log?: (msg: string) => void;
 *   run?: typeof import('node:child_process').spawnSync;
 *   platform?: string;
 * }} [opts]
 * @returns {Promise<number>} number of processes killed (best-effort count;
 *   pkill on POSIX does not report a count, so ≥1 is reported as 1)
 */
export async function killStrayProcesses({
  log = console.log,
  run = spawnSync,
  platform = process.platform,
} = {}) {
  // Windows: list candidate processes with their command lines, kill each by
  // PID. One PowerShell round-trip; -NoProfile keeps it fast and side-effect
  // free. Stop-Process on an already-exited PID throws per-process, hence the
  // per-item -ErrorAction SilentlyContinue.
  if (platform === 'win32') {
    const ps =
      'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match ' +
      "'fxs-(e2e|installer-ui)|installer_(win|linux|mac)' } | ForEach-Object { " +
      'Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; ' +
      '"$($_.ProcessId):$($_.Name)" }';
    const res = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    return report(res, log);
  }
  // POSIX: pkill -f matches the same argv patterns. pkill exits 1 when no
  // process matched — the normal steady state, not an error — and it prints
  // nothing either way, so "how many" is only known on Windows. macOS and the
  // Ubuntu runner images both ship pkill.
  const res = run('pkill', ['-f', 'fxs-(e2e|installer-ui)|installer_(win|linux|mac)'], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (res.error) {
    log(`  [hygiene] stray-process sweep unavailable: ${res.error.message}`);
    return 0;
  }
  if (res.status === 0) {
    // pkill matched and signalled at least one process, but does not report
    // the count.
    log(
      '  [hygiene] killed ≥1 stray process(es) from a previous run (pkill does not report the count)'
    );
    return 1;
  }
  if (res.status > 1) {
    log(`  [hygiene] stray-process sweep failed (pkill exit ${res.status})`);
    return 0;
  }
  log('  [hygiene] no stray processes from a previous run');
  return 0;
}

/**
 * Interpret the Windows sweep result for the log; returns the killed-process
 * count (the PowerShell loop prints one `PID:Name` line per killed process).
 */
function report(res, log) {
  if (res.error) {
    log(`  [hygiene] stray-process sweep unavailable: ${res.error.message}`);
    return 0;
  }
  const out = `${res.stdout ?? ''}`.trim();
  const count = out ? out.split('\n').filter(Boolean).length : 0;
  if (count > 0) {
    log(
      `  [hygiene] killed ${count} stray process(es) from a previous run: ${out.replaceAll('\n', ', ')}`
    );
  } else if (res.status !== null && res.status > 1) {
    log(`  [hygiene] stray-process sweep failed (exit ${res.status})`);
  } else {
    log('  [hygiene] no stray processes from a previous run');
  }
  return count;
}

/**
 * Remove compatibility.ini from a (seeded) profile so Firefox cannot reuse
 * stale GRE-compatibility state across repeat runs. Best-effort: a missing file
 * or a failed unlink is logged and ignored.
 *
 * @param {string} profileDir
 * @param {{log?: (msg: string) => void}} [opts]
 */
export function removeProfileCompatibilityIni(profileDir, {log = console.log} = {}) {
  const ini = path.join(profileDir, 'compatibility.ini');
  try {
    if (fs.existsSync(ini)) {
      fs.unlinkSync(ini);
      log(`  [hygiene] removed ${ini}`);
    }
  } catch (err) {
    log(`  [hygiene] could not remove compatibility.ini: ${err.message}`);
  }
}

/**
 * Close a puppeteer browser and wait for its OS process to actually exit, so
 * the next scenario starts with the port and profile genuinely free. Falls back
 * to a hard kill when the process does not exit in time. Safe on null/undefined
 * (the `browser?` call sites) and on already-closed browsers.
 *
 * @param {import('puppeteer-core').Browser | null | undefined} browser
 * @param {{timeoutMs?: number; log?: (msg: string) => void}} [opts]
 */
export async function closeBrowser(browser, {timeoutMs = 10_000, log = console.log} = {}) {
  if (!browser) return;
  try {
    await browser.close();
  } catch {
    /* already disconnected */
  }
  const proc = typeof browser.process === 'function' ? browser.process() : null;
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    await new Promise(r => setTimeout(r, 100));
  }
  log('  [hygiene] browser process did not exit in time — killing');
  try {
    proc.kill();
  } catch {
    /* already gone */
  }
}
