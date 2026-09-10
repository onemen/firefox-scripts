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
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {killStrayProcesses} from '../shared/processHygiene.mjs';

// test/e2e/installer/smoke-security.mjs → repo root
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const PORT = 8777;
const BASE = `http://127.0.0.1:${PORT}`;
const WRONG_TOKEN = '0'.repeat(16);

// Every state-changing route must reject a missing/wrong token.  Keep this
// list in sync with the `request_has_valid_token` gates in installer/src/
// (main.c + http_server.c).  `/api/shutdown` is special: it replies
// {"status":"ignored"} instead of {"error":"unauthorized"}.
const GATED_ROUTES = [
  'status',
  'install',
  'self-update',
  'manifest',
  'upload',
  'waterfox',
  'hg-tags',
  'close-browser',
  'open-folder',
  'rescan',
  'restart',
];
const SHUTDOWN_ROUTE = 'shutdown';
const SHUTDOWN_REJECT = 'ignored';

// Read-only routes: usable without a token, but still must never carry CORS.
const OPEN_ROUTES = ['ping', 'build-info', 'browsers', 'package-urls'];

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
  return {status: res.status, text, acao: res.headers.get('access-control-allow-origin')};
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
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.on('data', d => (stdout += d.toString()));
  child.stderr.on('data', d => (stdout += d.toString()));

  let token = null;
  try {
    const deadline = Date.now() + 10_000;
    while (!token && Date.now() < deadline) {
      const m = stdout.match(/SMOKE_TEST_SESSION_TOKEN=([0-9a-f]{16})/);
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
    for (const route of [...GATED_ROUTES, SHUTDOWN_ROUTE]) {
      const reject = route === SHUTDOWN_ROUTE ? SHUTDOWN_REJECT : 'unauthorized';
      const res = await hit(route);
      check(
        res.text.includes(reject),
        `/api/${route} rejects missing token`,
        `got: ${res.text.slice(0, 80)}`
      );
      check(res.acao === null, `/api/${route} has no Access-Control-Allow-Origin`);
    }

    console.log('\nWrong token → must be refused on every state-changing route');
    for (const route of [...GATED_ROUTES, SHUTDOWN_ROUTE]) {
      const reject = route === SHUTDOWN_ROUTE ? SHUTDOWN_REJECT : 'unauthorized';
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
    for (const route of OPEN_ROUTES) {
      const res = await hit(route);
      check(
        !res.text.includes('unauthorized'),
        `/api/${route} usable without token`,
        `got: ${res.text.slice(0, 80)}`
      );
      check(res.acao === null, `/api/${route} has no Access-Control-Allow-Origin`);
    }

    console.log('\nValid token → the gate lets requests through (business errors are fine)');
    for (const route of GATED_ROUTES) {
      // self-update with a GET hits the network; POST an empty payload instead
      // so it fails fast on parsing, past the gate.
      const res =
        route === 'self-update' ?
          await hit(route, {token, method: 'POST', body: '{}'})
        : await hit(route, {token});
      check(
        !res.text.includes('unauthorized'),
        `/api/${route} passes with valid token`,
        `got: ${res.text.slice(0, 80)}`
      );
      check(res.acao === null, `/api/${route} has no Access-Control-Allow-Origin`);
    }

    console.log('\nShutdown (last): valid token stops the server');
    const shut = await hit(SHUTDOWN_ROUTE, {token});
    check(
      !shut.text.includes('unauthorized') && !shut.text.includes(SHUTDOWN_REJECT),
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
