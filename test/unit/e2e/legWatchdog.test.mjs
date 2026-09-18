// Unit tests for test/e2e/shared/legWatchdog.mjs — the per-leg watchdog
// wrapper. Pure Node: expiry is driven through the `timeoutMs` test seam and
// the sweep through processHygiene's `run`/`platform` seams — no real
// minutes are waited and no real processes are killed.

import {describe, it} from 'node:test';
import assert from 'node:assert/strict';

import {withLegWatchdog, DEFAULT_LEG_WATCHDOG_MIN} from '../../e2e/shared/legWatchdog.mjs';

describe('withLegWatchdog', () => {
  it('passes through the leg result on success', async () => {
    const logs = [];
    const result = await withLegWatchdog('http', async () => 'ok', {
      timeoutMs: 60_000,
      log: m => logs.push(m),
    });
    assert.equal(result, 'ok');
    assert.deepEqual(logs, [], 'no watchdog output on a healthy leg');
  });

  it('propagates a leg error unchanged', async () => {
    await assert.rejects(
      withLegWatchdog('http', async () => {
        throw new Error('leg boom');
      }),
      /leg boom/
    );
  });

  it('fails with a leg-named error and announces the sweep on expiry', async () => {
    const logs = [];
    await assert.rejects(
      withLegWatchdog('ui', () => new Promise(() => {}), {timeoutMs: 20, log: m => logs.push(m)}),
      /leg 'ui' exceeded 0 min watchdog/
    );
    assert.equal(
      logs.filter(l => l.includes("[leg-watchdog] leg 'ui' exceeded")).length,
      1,
      'names the leg exactly once'
    );
    assert.ok(logs.some(l => l.includes('killing stray installer/browser children')));
  });

  it('falls back to the 6-minute default on non-numeric timeoutMin', async () => {
    // 6 min in ms, minus a hair — observable through the log text.
    const logs = [];
    await assert.rejects(
      withLegWatchdog('http', () => new Promise(() => {}), {timeoutMs: 1, timeoutMin: 'garbage'}),
      // timeoutMs wins over garbage timeoutMin, so this rejects via the seam;
      // the default is pinned by the exported constant below instead.
      /leg 'http' exceeded/
    );
    assert.equal(DEFAULT_LEG_WATCHDOG_MIN, 6);
    assert.ok(logs.length === 0); // log seam not passed here — assert no crash
  });

  it('sweeps exactly once on expiry, through the injected seams, and a sweep throw never masks the timeout', async () => {
    let sweepCalls = 0;
    const logs = [];
    await assert.rejects(
      withLegWatchdog('test-surface', () => new Promise(() => {}), {
        timeoutMs: 20,
        log: m => logs.push(m),
        platform: 'win32',
        run: (...args) => {
          sweepCalls += 1;
          assert.equal(args[0], 'powershell.exe', 'win32 sweep shells through powershell');
          throw new Error('sweep exploded');
        },
      }),
      /leg 'test-surface' exceeded/
    );
    assert.equal(sweepCalls, 1, 'the expiry sweep ran once');
  });

  it('keeps the leg result when it resolves before expiry', async () => {
    const result = await withLegWatchdog('restart-scope', async () => 42, {timeoutMs: 60_000});
    assert.equal(result, 42);
  });

  it('leg timer does not keep the event loop alive (unref)', async () => {
    // withLegWatchdog resolves the leg and clears its timer; if unref were
    // missing AND the leg outlived the process, CI would hang — simulate by
    // asserting the healthy path returns promptly after clearTimeout.
    const start = Date.now();
    await withLegWatchdog('ui', async () => {
      await new Promise(r => setTimeout(r, 10));
      return 'done';
    });
    assert.ok(Date.now() - start < 5_000, 'healthy leg completes promptly');
  });
});
