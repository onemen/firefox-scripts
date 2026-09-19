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
 * Cleanup margin reserved against the global run watchdog: the global timer
 * must stay the backstop, so a leg budget derived from the remaining global
 * deadline leaves this much room for the final sweep + log to win the race.
 */
export const SWEEP_MARGIN_MS = 60_000;

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
 *   production callers); remainingMs is the production input: the ms still
 *   available under the global run watchdog, which caps (clamps, with a log
 *   line) the leg budget so a leg timer can never let the global backstop fire
 *   first — LEG_WATCHDOG_MIN raises the ceiling, not the deadline. marginMs
 *   (default SWEEP_MARGIN_MS) is the cleanup room reserved from remainingMs;
 *   log/run/platform mirror killStrayProcesses' test seams and are forwarded to
 *   the sweep.
 * @returns {Promise<T>} the leg body's result (falsy results preserved)
 * @throws {Error} leg-named watchdog error once the budget expires — a leg
 *   rejection that lands after expiry is superseded by it
 */
export async function withLegWatchdog(name, fn, opts = {}) {
  const log = opts.log ?? console.log;
  let ms = opts.timeoutMs ?? resolveMs(opts.timeoutMin);
  if (opts.remainingMs != null) {
    const available = Math.max(1_000, opts.remainingMs - (opts.marginMs ?? SWEEP_MARGIN_MS));
    if (available < ms) {
      log(
        `[leg-watchdog] leg '${name}' budget clamped to ${Math.round(available / 1000)}s — global watchdog deadline`
      );
      ms = available;
    }
  }

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
    // Race on outcome objects (not raw values) so expiry's null sentinel can
    // never collide with a legitimate falsy leg result, and decide on the
    // synchronous `expired` flag rather than which promise settled: the
    // expiry promise only resolves after the sweep finishes, so a leg that
    // was merely slow — not hung — can resolve *during* the sweep window.
    // A leg that needed its full budget is a wedge: always fail it.
    const outcome = await Promise.race([
      fn().then(
        value => ({kind: 'leg', value}),
        error => ({kind: 'leg-error', error})
      ),
      expiry.then(() => ({kind: 'expired'})),
    ]);
    if (expired || outcome.kind === 'expired') {
      throw new Error(`leg '${name}' exceeded ${Math.round(ms / 60_000)} min watchdog`);
    }
    if (outcome.kind === 'leg-error') throw outcome.error;
    return outcome.value;
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
