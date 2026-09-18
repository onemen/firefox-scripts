// test/e2e/shared/legWatchdog.mjs — per-leg watchdog for the installer E2E.
//
// The harness keeps its global run watchdog (installer-e2e.mjs), but on a
// wedge it only reports "run exceeded N min" — it cannot say *which* leg
// hung. This module names the layer: each leg runs inside withLegWatchdog(),
// which logs `[leg-watchdog] leg '<name>' exceeded N min` before killing the
// leg's processes and failing the leg, so the harness log and CI output carry
// the leg name and the orphan sweep still runs (same matcher as
// processHygiene — installer/browser children only, never unrelated apps).
//
// Bound the per-leg budget so the sum of the slowest legal leg durations
// stays below the global watchdog: the global timer remains the backstop that
// sweeps orphans on a hard wedge; the leg timer is the diagnostic that fires
// first. Never throws from the sweep itself — the leg timeout is what
// propagates.

import {killStrayProcesses} from './processHygiene.mjs';

/**
 * Default per-leg budget in minutes. Derived from the audited leg profile: the
 * UI layer (installer scan + real Firefox + full assertion set) is the slowest
 * legal leg at ≤2.5 min on windows-latest; 6 min ≈ 2.4× that, and the sum of
 * all four default-on legs (0.5 + 0.5 + 3 + 6) stays under the 10-min global
 * watchdog. Override with LEG_WATCHDOG_MIN for slow machines.
 */
export const DEFAULT_LEG_WATCHDOG_MIN = 6;

/**
 * Run one E2E leg under its own watchdog.
 *
 * @template T
 * @param {string} name leg label used in logs (e.g. 'http', 'ui')
 * @param {() => Promise<T>} fn the leg body
 * @param {{
 *   timeoutMin?: number | string;
 *   timeoutMs?: number;
 *   log?: (msg: string) => void;
 *   run?: typeof import('node:child_process').spawnSync;
 *   platform?: string;
 * }} [opts]
 *   timeoutMin accepts the raw env value (string) or a number; timeoutMs
 *   overrides the minute math entirely (unit-test seam — never set in
 *   production callers); log/run/platform mirror killStrayProcesses' test seams
 *   and are forwarded to the sweep.
 * @returns {Promise<T>} the leg body's result
 */
export async function withLegWatchdog(name, fn, opts = {}) {
  const log = opts.log ?? console.log;
  const ms = opts.timeoutMs ?? resolveMs(opts.timeoutMin);

  let timer;
  let expired = false;
  const expiry = new Promise(resolve => {
    timer = setTimeout(() => {
      expired = true;
      log(
        `\n[leg-watchdog] leg '${name}' exceeded ${Math.round(ms / 60_000)} min — killing stray installer/browser children and failing`
      );
      // Best-effort: a sweep failure must not mask the leg timeout.
      killStrayProcesses(opts)
        .catch(() => {})
        .finally(() => resolve(null));
    }, ms);
    timer.unref?.();
  });

  try {
    const winner = await Promise.race([fn(), expiry]);
    // The leg resolving null exactly as the timer fires is indistinguishable
    // from expiry — and a leg that needed its full budget is a wedge anyway.
    if (expired && winner === null) {
      throw new Error(`leg '${name}' exceeded ${Math.round(ms / 60_000)} min watchdog`);
    }
    return winner;
  } finally {
    clearTimeout(timer);
  }
}

/** Resolve the timeout in ms; non-numeric input falls back to the default. */
function resolveMs(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  const min = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_LEG_WATCHDOG_MIN;
  return min * 60_000;
}
