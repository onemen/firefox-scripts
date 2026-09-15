#!/usr/bin/env node
/**
 * Security smoke test for the installer's local HTTP API.
 *
 * Starts the installer binary headless (--smoke-test), then verifies:
 *
 * 1. Every state-changing /api route rejects a MISSING token.
 * 2. Every state-changing /api route rejects a WRONG token.
 * 3. Every state-changing route accepts a VALID token (passes the gate; the
 *    handler may still return a business error — that's fine).
 * 4. No response carries an Access-Control-Allow-Origin header (the wildcard CORS
 *    that made cross-origin pages able to drive the API is gone).
 *
 * Usage (run from the repo root, after `pnpm upload:local --mode=dev`): node
 * test/e2e/installer/smoke-security.mjs
 * INSTALLER_BIN=/path/to/installer_win-dev.exe node
 * test/e2e/installer/smoke-security.mjs
 *
 * Exits non-zero on the first failed category so CI fails the build.
 */

import {spawn} from 'node:child_process';
import {existsSync, readdirSync, statSync} from 'node:fs';
import net from 'node:net';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {killStrayProcesses} from '../shared/processHygiene.mjs';
import {
  GATED_API_ROUTES,
  OPEN_API_ROUTES,
  SHUTDOWN_API_ROUTE,
  SHUTDOWN_REJECT_BODY,
  UNAUTHORIZED_REJECT_BODY,
} from './apiRoutes.mjs';

// test/e2e/installer/smoke-security.mjs → repo root
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const PORT = 8777;
const BASE = `http://127.0.0.1:${PORT}`;
const WRONG_TOKEN = '0'.repeat(16);

// The route/token-gate sets live in ./apiRoutes.mjs so that
// test/unit/e2e/apiRouteContract.test.mjs (part of `pnpm test`, no build
// needed) can diff them against the routes actually registered in
// installer/src/*.c — a route added there without a classification fails that
// unit test rather than silently escaping this smoke test.

let failures = 0;
let checks = 0;

function check(ok, label, detail = '') {
  checks += 1;
  if (ok) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Locate the freshly built installer binary (dev snapshot or .build staging). */
function findInstaller() {
  if (process.env.INSTALLER_BIN) return process.env.INSTALLER_BIN;
  const candidates =
    process.platform === 'win32' ? ['installer_win-dev.exe', 'installer_win.exe']
    : process.platform === 'darwin' ? ['installer_mac-dev', 'installer_mac']
    : ['installer_linux-dev', 'installer_linux'];
  const searchDirs = [join(REPO_ROOT, 'dist', '.build', 'installer')];
  // dist/dev-<branch>-<hash>/ snapshots from `upload:local`.
  const distRoot = join(REPO_ROOT, 'dist');
  if (existsSync(distRoot)) {
    for (const entry of readdirSync(distRoot)) {
      const full = join(distRoot, entry);
      if (entry.startsWith('dev-') && statSync(full).isDirectory()) {
        searchDirs.push(full);
      }
    }
  }
  for (const dir of searchDirs) {
    for (const name of candidates) {
      const p = join(dir, name);
      if (existsSync(p)) return p;
    }
  }
  throw new Error(
    `installer binary not found in ${searchDirs.join(', ')} — run "pnpm upload:local --mode=dev" first (or set INSTALLER_BIN)`
  );
}

/** GET (or POST) an installer API path; returns {status, text, acao}. */
async function hit(route, {token, method = 'GET', body} = {}) {
  const qs = new URLSearchParams();
  if (token) qs.set('t', token);
  const url = `${BASE}/api/${route}${qs.size ? `?${qs}` : ''}`;
  const res = await fetch(url, {
    method,
    body,
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  return {
    status: res.status,
    text,
    acao: res.headers.get('access-control-allow-origin'),
  };
}

async function waitForServer(token, child) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`installer exited early (code ${child.exitCode}) before serving`);
    }
    try {
      const ping = await hit('ping');
      // Prove the port is served by OUR instance: a foreign installer on the
      // same port would report current:0 for our freshly generated token.
      const claim = await hit('claim', {token});
      if (claim.text.includes('"current":1')) return;
      if (claim.text.includes('"current":0')) {
        throw new Error('another installer instance already holds port 8777');
      }
      void ping;
    } catch {
      // not up yet — keep polling
    }
    if (Date.now() > deadline) throw new Error('installer did not start serving in time');
    await new Promise(r => setTimeout(r, 250));
  }
}

async function main() {
  const installer = findInstaller();
  console.log(`\nSecurity smoke test — ${installer}\n`);

  // Process hygiene (issue #130): a leftover installer from a previous run
  // would still own port 8777 and the smoke test would probe the wrong
  // process. Sweep first (best-effort, never throws).
  await killStrayProcesses();

  const child = spawn(installer, ['--smoke-test'], {
    cwd: REPO_ROOT,
    // Shorten the server's read deadlines for the timeout checks below: idle
    // 1000 ms, total 5000 ms. Honored only under --smoke-test (main.c);
    // production is unaffected.
    env: {
      ...process.env,
      FXS_HTTP_RECV_TIMEOUT_MS: '1000',
      FXS_HTTP_REQUEST_TOTAL_TIMEOUT_MS: '5000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.on('data', d => (stdout += d.toString()));
  child.stderr.on('data', d => (stdout += d.toString()));

  let token = null;
  try {
    const deadline = Date.now() + 10_000;
    while (!token && Date.now() < deadline) {
      const m = stdout.match(/SMOKE_TEST_SESSION_TOKEN=([0-9a-f]{32})/);
      if (m) token = m[1];
      if (child.exitCode !== null) break;
      await new Promise(r => setTimeout(r, 100));
    }
    if (!token) {
      throw new Error(
        `installer did not print a session token. Output so far:\n${stdout.slice(0, 2000)}`
      );
    }
    await waitForServer(token, child);

    console.log('Missing token → must be refused on every state-changing route');
    for (const route of [...GATED_API_ROUTES, SHUTDOWN_API_ROUTE]) {
      const reject = route === SHUTDOWN_API_ROUTE ? SHUTDOWN_REJECT_BODY : UNAUTHORIZED_REJECT_BODY;
      const res = await hit(route);
      check(
        res.text.includes(reject),
        `/api/${route} rejects missing token`,
        `got: ${res.text.slice(0, 80)}`
      );
      check(res.acao === null, `/api/${route} has no Access-Control-Allow-Origin`);
    }

    console.log('\nWrong token → must be refused on every state-changing route');
    for (const route of [...GATED_API_ROUTES, SHUTDOWN_API_ROUTE]) {
      const reject = route === SHUTDOWN_API_ROUTE ? SHUTDOWN_REJECT_BODY : UNAUTHORIZED_REJECT_BODY;
      const res = await hit(route, {token: WRONG_TOKEN});
      check(
        res.text.includes(reject),
        `/api/${route} rejects wrong token`,
        `got: ${res.text.slice(0, 80)}`
      );
      check(res.acao === null, `/api/${route} has no Access-Control-Allow-Origin`);
    }

    console.log('\nClaim reflects token validity');
    {
      const wrong = await hit('claim', {token: WRONG_TOKEN});
      check(
        wrong.text.includes('"current":0'),
        '/api/claim with wrong token reports current:0',
        wrong.text.slice(0, 80)
      );
      const good = await hit('claim', {token});
      check(
        good.text.includes('"current":1'),
        '/api/claim with valid token reports current:1',
        good.text.slice(0, 80)
      );
      check(good.acao === null, '/api/claim has no Access-Control-Allow-Origin');
    }

    console.log('\nRead-only routes work without a token and carry no CORS');
    for (const route of OPEN_API_ROUTES) {
      const res = await hit(route);
      check(
        !res.text.includes(UNAUTHORIZED_REJECT_BODY),
        `/api/${route} usable without token`,
        `got: ${res.text.slice(0, 80)}`
      );
      check(res.acao === null, `/api/${route} has no Access-Control-Allow-Origin`);
    }

    console.log('\nValid token → the gate lets requests through (business errors are fine)');
    for (const route of GATED_API_ROUTES) {
      // self-update with a GET hits the network; POST an empty payload instead
      // so it fails fast on parsing, past the gate.
      const res =
        route === 'self-update' ?
          await hit(route, {token, method: 'POST', body: '{}'})
        : await hit(route, {token});
      check(
        !res.text.includes(UNAUTHORIZED_REJECT_BODY),
        `/api/${route} passes with valid token`,
        `got: ${res.text.slice(0, 80)}`
      );
      check(res.acao === null, `/api/${route} has no Access-Control-Allow-Origin`);
    }

    console.log('\nStalled connection cannot wedge the single-threaded serve loop');
    {
      // ADR 0010 availability note: the serve loop is single-threaded, so one
      // stalled connection once blocked every request behind it. Accepted
      // sockets now carry an idle deadline (SO_RCVTIMEO) plus a total
      // per-request read bound (a dribbling client defeats an idle timeout
      // alone). A connection that sends nothing must be answered 408 and
      // closed — and the server must keep serving afterwards.
      const stalled = net.connect({host: '127.0.0.1', port: PORT});
      const saw408 = await new Promise(resolve => {
        let buf = '';
        const giveUp = setTimeout(
          () => resolve({ok: false, detail: 'no response within 10 s'}),
          10_000
        );
        stalled.on('data', d => {
          buf += d.toString();
          if (buf.startsWith('HTTP/1.0 408') || buf.startsWith('HTTP/1.1 408')) {
            clearTimeout(giveUp);
            resolve({ok: true, detail: buf.split('\r\n')[0]});
          }
        });
        stalled.on('error', err => {
          clearTimeout(giveUp);
          resolve({ok: false, detail: err.message});
        });
        stalled.on('close', () => {
          clearTimeout(giveUp);
          resolve({
            ok: false,
            detail: `closed without 408 (got: ${buf.slice(0, 40) || 'nothing'})`,
          });
        });
      });
      stalled.destroy();
      check(saw408.ok, 'idle connection gets 408 Request Timeout', saw408.detail);

      // The bound is only useful if the server survived it: a full
      // valid-token round-trip must still work.
      const after = await hit('claim', {token});
      check(
        after.text.includes('"current":1'),
        'server still serves after the stalled connection',
        after.text.slice(0, 80)
      );
    }

    console.log('\nDribbling client hits the total read bound despite idle resets');
    {
      // A dribbler defeats the idle deadline: every byte arrives before
      // SO_RCVTIMEO can fire, so the recv loop never sees an error. Only the
      // total per-request read bound can shed it — this is exactly why the
      // fix ships two independent deadlines instead of one.
      const dribbler = net.connect({host: '127.0.0.1', port: PORT});
      const started = Date.now();
      const saw408 = await new Promise(resolve => {
        let buf = '';
        const giveUp = setTimeout(
          () => resolve({ok: false, detail: 'no response within 15 s'}),
          15_000
        );
        const drip = setInterval(() => dribbler.write('x'), 300); // well under the 1000 ms idle deadline
        dribbler.on('data', d => {
          buf += d.toString();
          if (buf.startsWith('HTTP/1.0 408') || buf.startsWith('HTTP/1.1 408')) {
            clearInterval(drip);
            clearTimeout(giveUp);
            resolve({
              ok: true,
              detail: `${buf.split('\r\n')[0]} after ${Date.now() - started} ms`,
            });
          }
        });
        dribbler.on('error', err => {
          clearInterval(drip);
          clearTimeout(giveUp);
          resolve({ok: false, detail: err.message});
        });
        dribbler.on('close', () => {
          clearInterval(drip);
          clearTimeout(giveUp);
          resolve({
            ok: false,
            detail: `closed without 408 (got: ${buf.slice(0, 40) || 'nothing'})`,
          });
        });
      });
      dribbler.destroy();
      check(saw408.ok, 'dribbling client gets 408 from the total read bound', saw408.detail);
      // Surviving ~5 s against a 1 s idle deadline is itself the proof that
      // the dribble kept resetting the idle bound — i.e. the total read
      // bound, not SO_RCVTIMEO, is what shed this connection.
      check(
        saw408.ok && Date.now() - started >= 4000,
        'dribble survived past the idle deadline (total bound did the shedding)',
        `elapsed ${Date.now() - started} ms`
      );

      // And the loop must still be alive after shedding it.
      const after = await hit('claim', {token});
      check(
        after.text.includes('"current":1'),
        'server still serves after the dribbling client',
        after.text.slice(0, 80)
      );
    }

    console.log('\nShutdown (last): valid token stops the server');
    const shut = await hit(SHUTDOWN_API_ROUTE, {token});
    check(
      !shut.text.includes(UNAUTHORIZED_REJECT_BODY) && !shut.text.includes(SHUTDOWN_REJECT_BODY),
      '/api/shutdown honors valid token',
      shut.text.slice(0, 80)
    );
    check(shut.acao === null, '/api/shutdown has no Access-Control-Allow-Origin');
    const exited = await Promise.race([
      new Promise(r => child.once('exit', code => r(code))),
      new Promise(r => setTimeout(() => r('timeout'), 10_000)),
    ]);
    check(
      exited !== 'timeout',
      `installer exited after shutdown (code ${exited})`,
      exited === 'timeout' ? 'still running' : ''
    );
  } catch (err) {
    failures += 1;
    console.log(`  ✗ smoke test error: ${err.message}`);
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await new Promise(r => setTimeout(r, 500));
    }
  }

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures > 0) {
    console.log(`\n✗ ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log('\n✓ all security smoke checks passed');
}

main().catch(err => {
  console.error(`✗ ${err.message}`);
  process.exit(1);
});
