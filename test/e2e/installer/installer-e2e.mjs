#!/usr/bin/env node
/**
 * Installer E2E test.
 *
 * Three layers:
 *
 * 1. HTTP layer (always runs): starts installer in --smoke-test, exercises token
 *    gate and every /api endpoint (29 assertions). Fast, reliable, no browser
 *    needed.
 * 2. Test-surface layer (--test-surface, default on; --no-test-surface to skip):
 *    exercises the #129 installer test flags — `--port 0` (ephemeral bind,
 *    reported via env.json), `--server-only` (no scan, no UI tab) and the
 *    second-instance path (a second installer on the same port refuses to
 *    serve, the first keeps answering). No browser needed.
 * 3. UI layer (--ui flag): launches a real Firefox, starts the installer (normal
 *    mode, so it detects the browser), navigates to the web UI, and asserts
 *    cards render with expected statuses.
 *
 * Usage: node test/e2e/installer/installer-e2e.mjs --snapshot <dir> [--ui] pnpm
 * test:e2e:installer -- [--ui]
 */

import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {
  REPO_ROOT,
  check,
  createCounter,
  launchFirefox,
  waitForCondition,
  waitForProcessExit,
  screenshotPrivileged,
  tempDir,
  summary,
} from '../shared/helpers.mjs';
import {findSnapshot, discoverFirefoxBinary} from '../shared/browsers.mjs';

const PORT = 8777;
const BASE = `http://127.0.0.1:${PORT}`;
const TIMEOUT_MS = 15_000;

// ── Parse args ────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {ui: false, testSurface: true};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--snapshot' && args[i + 1]) opts.snapshot = args[++i];
    else if (args[i] === '--headless') opts.headless = true;
    else if (args[i] === '--ui') opts.ui = true;
    else if (args[i] === '--no-test-surface') opts.testSurface = false;
    else if (args[i] === '--help') {
      console.log(
        'Usage: node installer-e2e.mjs --snapshot <dir> [--ui] [--headless] [--no-test-surface]'
      );
      process.exit(0);
    }
  }
  return opts;
}

// ── Installer binary discovery ─────────────────────────────────────────────

function findInstaller(snapshotDir) {
  if (process.env.INSTALLER_BIN && fs.existsSync(process.env.INSTALLER_BIN)) {
    return process.env.INSTALLER_BIN;
  }

  const dir = snapshotDir;
  const isWin = process.platform === 'win32';
  const isMac = process.platform === 'darwin';
  const candidates =
    isWin ? ['installer_win-dev.exe', 'installer_win.exe']
    : isMac ? ['installer_mac-dev', 'installer_mac']
    : ['installer_linux-dev', 'installer_linux'];

  for (const name of candidates) {
    const bin = path.join(dir, name);
    if (fs.existsSync(bin)) return bin;
  }
  return null;
}

// ── HTTP helpers ───────────────────────────────────────────────────────────

function tokenQuery(token) {
  return token ? `?t=${encodeURIComponent(token)}` : '';
}

async function httpGet(pathStr, token = '') {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}${pathStr}${tokenQuery(token)}`, {
      signal: controller.signal,
    });
    const text = await res.text();
    return {status: res.status, headers: Object.fromEntries(res.headers), body: text};
  } finally {
    clearTimeout(timer);
  }
}

async function httpPost(pathStr, body, token = '') {
  return httpPostRaw(pathStr, JSON.stringify(body), token);
}

/**
 * POST a raw string body (for the self-update release JSON, which must be
 * passed verbatim — JSON.stringify would reorder nothing here, but the C parser
 * is string-based, so send the exact bytes).
 */
async function httpPostRaw(pathStr, rawBody, token = '') {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}${pathStr}${tokenQuery(token)}`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: rawBody,
      signal: controller.signal,
    });
    const text = await res.text();
    return {status: res.status, headers: Object.fromEntries(res.headers), body: text};
  } finally {
    clearTimeout(timer);
  }
}

// ── Assertions ─────────────────────────────────────────────────────────────

function assertNoCors(counter, res, msg) {
  const cors = res.headers['access-control-allow-origin'];
  check(counter, !cors, msg, cors ? `has CORS header: ${cors}` : '');
}

function assertUnauthorized(counter, res, msg) {
  check(counter, res.body.includes('unauthorized'), msg, `got: ${res.body.slice(0, 80)}`);
}

function assertAuthorized(counter, res, msg) {
  check(counter, !res.body.includes('unauthorized'), msg, `got: ${res.body.slice(0, 80)}`);
}

// ── Wait for server ────────────────────────────────────────────────────────

async function waitForServer(maxWaitMs = 15_000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await fetch(`${BASE}/api/ping`, {signal: AbortSignal.timeout(800)});
      if (res.ok) return true;
    } catch {
      // not ready yet
    }
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

// ── HTTP layer tests ───────────────────────────────────────────────────────

async function runHttpLayer(counter, sessionToken) {
  const WRONG_TOKEN = '0'.repeat(16);
  const gatedRoutes = [
    {method: 'GET', path: '/api/status'},
    {method: 'POST', path: '/api/install', body: {packages: []}},
    {method: 'POST', path: '/api/rescan'},
    {method: 'POST', path: '/api/close-browser'},
    {method: 'GET', path: '/api/self-update'},
    {method: 'POST', path: '/api/manifest'},
  ];

  // Test 1: /api/ping (no token required)
  console.log('\nTest 1: /api/ping');
  {
    const res = await httpGet('/api/ping');
    check(counter, res.status === 200, 'ping returns 200');
    assertNoCors(counter, res, 'ping has no CORS header');
    const body = JSON.parse(res.body);
    check(counter, body.ok === 1, 'ping returns {ok:1}');
  }

  // Test 2: /api/browsers (no token required for read)
  console.log('\nTest 2: /api/browsers');
  {
    const res = await httpGet('/api/browsers');
    check(counter, res.status === 200, 'browsers returns 200');
    assertNoCors(counter, res, 'browsers has no CORS header');
    const body = JSON.parse(res.body);
    check(counter, Array.isArray(body) || body.browsers, 'browsers returns array or object');
  }

  // Test 3: Missing token on gated routes
  console.log('\nTest 3: Missing token on gated routes');
  for (const route of gatedRoutes) {
    const res =
      route.method === 'GET' ?
        await httpGet(route.path)
      : await httpPost(route.path, route.body || {});
    assertUnauthorized(counter, res, `${route.method} ${route.path} → unauthorized without token`);
    assertNoCors(counter, res, `${route.path} has no CORS header`);
  }

  // Test 4: Wrong token on gated routes
  console.log('\nTest 4: Wrong token on gated routes');
  for (const route of gatedRoutes) {
    const res =
      route.method === 'GET' ?
        await httpGet(route.path, WRONG_TOKEN)
      : await httpPost(route.path, route.body || {}, WRONG_TOKEN);
    assertUnauthorized(
      counter,
      res,
      `${route.method} ${route.path} → unauthorized with wrong token`
    );
  }

  // Test 5: Valid token on gated routes
  console.log('\nTest 5: Valid token on gated routes');
  if (!sessionToken) {
    console.error('  SKIP: no session token captured');
    check(counter, false, 'session token captured');
  } else {
    console.log(`  session token: ${sessionToken.slice(0, 8)}...`);

    {
      const res = await httpGet('/api/status', sessionToken);
      check(counter, res.status === 200, '/api/status → 200 with valid token');
      assertAuthorized(counter, res, '/api/status passes the gate');
    }
    {
      const res = await httpPost('/api/rescan', {}, sessionToken);
      check(
        counter,
        res.status === 200 || res.status === 202,
        `/api/rescan → ${res.status} with valid token`
      );
      assertAuthorized(counter, res, '/api/rescan passes the gate');
    }
    {
      const res = await httpPost('/api/self-update', {}, sessionToken);
      assertAuthorized(counter, res, '/api/self-update passes the gate');
    }

    // Test 6: self-update flow — POST a release JSON, then GET reports the
    // parsed version + matching asset URL (installer/src/self_update.c).
    // The E2E installer is a -dev build, so INSTALLER_BINARY_NAME carries the
    // -dev suffix; the fixture must match it.
    console.log('\nTest 6: self-update flow');
    {
      const plainBase =
        process.platform === 'win32' ? 'installer_win'
        : process.platform === 'darwin' ? 'installer_mac'
        : 'installer_linux';
      const asset = `${plainBase}-dev${process.platform === 'win32' ? '.exe' : ''}`;
      const releaseJson = JSON.stringify({
        tag_name: 'v1.0.1',
        assets: [
          {name: 'helper_win-dev.exe', browser_download_url: 'https://example.invalid/helper'},
          {name: asset, browser_download_url: 'https://example.invalid/installer-download'},
        ],
      });
      const post = await httpPostRaw('/api/self-update', releaseJson, sessionToken);
      check(
        counter,
        post.status === 200 && post.body.includes('"ok"'),
        'POST release JSON → stored'
      );
      const got = await httpGet('/api/self-update', sessionToken);
      let su = null;
      try {
        su = JSON.parse(got.body);
      } catch {
        /* parse error handled by the check below */
      }
      check(counter, Boolean(su), 'GET /api/self-update returns JSON', got.body.slice(0, 80));
      if (su) {
        check(counter, su.updateAvailable === true, 'update available detected');
        // Raw tag passthrough (the UI prepends 'v', so a v-less release tag
        // renders "v1.0.1" — see the test_self_update.mjs contract note).
        check(counter, su.latestVersion === 'v1.0.1', `latest version parsed: ${su.latestVersion}`);
        check(
          counter,
          su.downloadUrl === 'https://example.invalid/installer-download',
          `matching asset URL extracted: ${su.downloadUrl}`
        );
        check(counter, su.currentVersion === '1.0.0', 'current version reported');
      }
    }
  }
}

// ── Test-surface layer (issue #129 flags) ───────────────────────────────

/**
 * Spawn an installer with arbitrary args and resolve when its env.json manifest
 * appears (or the process exits — a refusal path). Returns the parsed manifest
 * plus the ChildProcess for cleanup.
 */
function spawnWithEnvFile(bin, args, envFile, timeoutMs = 15_000) {
  return new Promise(resolve => {
    const proc = spawn(bin, args, {stdio: ['ignore', 'pipe', 'pipe']});
    let out = '';
    proc.stdout.on('data', d => (out += d.toString()));
    proc.stderr.on('data', d => (out += d.toString()));
    const started = Date.now();
    const poll = setInterval(() => {
      let manifest = null;
      try {
        manifest = JSON.parse(fs.readFileSync(envFile, 'utf8'));
      } catch {
        // not written yet (or process refused to start)
      }
      const exited = proc.exitCode !== null || proc.signalCode !== null || proc.killed;
      if (manifest || exited || Date.now() - started > timeoutMs) {
        clearInterval(poll);
        if (!manifest) {
          // Failure diagnostics: why did no manifest appear?
          console.log(
            `  [spawnWithEnvFile] no manifest for "${args.join(' ')}" — ` +
              `exitCode=${proc.exitCode} killed=${proc.killed} timedOut=${
                Date.now() - started > timeoutMs
              } envFile=${envFile} exists=${fs.existsSync(envFile)}\n` +
              `    output: ${out.slice(0, 400).replace(/\n/g, '\n    ')}`
          );
        }
        resolve({proc, manifest, output: out, timedOut: !manifest && !exited});
      }
    }, 100);
  });
}

async function runTestSurfaceLayer(counter, bin) {
  console.log('\nTest-surface layer (--port 0 / --server-only / env.json / second instance)');
  const workDir = tempDir('fxs-installer-surface');
  fs.mkdirSync(workDir, {recursive: true});

  // TS-1: --port 0 binds an OS-ephemeral port and reports it via env.json.
  // No --port probe may hijack the run onto the default port: the manifest's
  // port must differ from 8777 and answer /api/ping.
  console.log('\nTS-1: --port 0 (ephemeral bind) + --env-file manifest');
  {
    const envFile = path.join(workDir, 'env-ephemeral.json');
    const {proc, manifest} = await spawnWithEnvFile(
      bin,
      ['--server-only', '--port', '0', '--env-file', envFile],
      envFile
    );
    try {
      check(counter, Boolean(manifest), 'env.json manifest written for --port 0');
      if (manifest) {
        check(
          counter,
          Number.isInteger(manifest.port) && manifest.port > 0 && manifest.port !== PORT,
          `manifest port is ephemeral and not the default (${manifest?.port} vs ${PORT})`
        );
        check(
          counter,
          typeof manifest.token === 'string' && /^[a-f0-9]{16}$/.test(manifest.token),
          'manifest carries a 16-hex session token'
        );
        check(
          counter,
          manifest.uiUrl === `http://localhost:${manifest.port}/?t=${manifest.token}`,
          'manifest uiUrl matches port + token'
        );
        check(
          counter,
          Number.isInteger(manifest.runId) && manifest.runId > 0,
          'manifest carries a run id'
        );
        const ping = await fetch(`http://127.0.0.1:${manifest.port}/api/ping`, {
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        check(counter, ping.ok, `server answers on the ephemeral port ${manifest.port}`);
      }
    } finally {
      proc.kill();
      await waitForProcessExit(proc, 5000);
    }
  }

  // TS-2: --port <fixed> binds exactly that port; the manifest reports it.
  console.log('\nTS-2: --port <fixed>');
  // Grab a free port by binding and closing a server, then hand it to the
  // installer (inherently racy, but the window is tiny and failure is
  // surfaced by the ping check below).
  const {createServer} = await import('node:net');
  const fixedPort = await new Promise(resolve => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
  {
    const envFile = path.join(workDir, 'env-fixed.json');
    const {proc, manifest} = await spawnWithEnvFile(
      bin,
      ['--server-only', '--port', String(fixedPort), '--env-file', envFile],
      envFile
    );
    try {
      check(counter, manifest?.port === fixedPort, `manifest reports the fixed port ${fixedPort}`);
      if (manifest?.port) {
        const ping = await fetch(`http://127.0.0.1:${fixedPort}/api/ping`, {
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        check(counter, ping.ok, `server answers on the fixed port ${fixedPort}`);
      }
    } finally {
      proc.kill();
      await waitForProcessExit(proc, 5000);
    }
  }

  // TS-3: second-instance handoff (the production contract). A plain second
  // installer (no --port) while another one serves the DEFAULT port must NOT
  // start its own server: it detects the listener, exits, and the first keeps
  // answering. (Probing an explicit --port busy-port is NOT portable: Windows
  // SO_REUSEADDR lets a second bind succeed there.)
  //
  // The first instance takes the default port: --server-only (no scan/tab) +
  // NO --port flag — the exact production shape, only headless.
  console.log('\nTS-3: second instance defers to the one on the default port');
  {
    const envFile = path.join(workDir, 'env-first.json');
    const first = spawn(bin, ['--server-only', '--env-file', envFile], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      const ready = await waitForServerOn(PORT, 15_000);
      check(counter, ready, `first installer serves on the default port ${PORT}`);
      if (ready) {
        const second = await spawnWithEnvFile(
          bin,
          ['--server-only'],
          path.join(workDir, 'env-second.json'),
          8000
        );
        try {
          // The second run must detect the running installer and exit
          // without serving (no env.json — its bind never happened).
          check(
            counter,
            second.output.includes('A Firefox Scripts Installer is already running'),
            'second instance reports the running installer'
          );
          check(
            counter,
            !second.manifest,
            'second instance wrote no env.json (it did not start a server)'
          );
          check(
            counter,
            second.proc.exitCode !== null,
            `second instance exited (${second.proc.exitCode})`
          );
          const ping = await fetch(`${BASE}/api/ping`, {signal: AbortSignal.timeout(TIMEOUT_MS)});
          check(counter, ping.ok, 'first server still answers after the collision');
        } finally {
          second.proc.kill();
        }
      }
    } finally {
      first.kill();
      await waitForProcessExit(first, 5000);
    }
  }

  // TS-4: --server-only never runs the browser scan and never opens a tab.
  // Verified via the startup output: no "Scanning for running browsers" line.
  console.log('\nTS-4: --server-only skips the browser scan');
  {
    const envFile = path.join(workDir, 'env-scan.json');
    const {proc, output} = await spawnWithEnvFile(
      bin,
      ['--server-only', '--env-file', envFile],
      envFile
    );
    try {
      check(
        counter,
        !output.includes('Scanning for running browsers'),
        '--server-only output has no browser-scan line'
      );
      check(
        counter,
        output.includes('Server-only mode: skipping browser scan'),
        '--server-only announces the skipped scan'
      );
    } finally {
      proc.kill();
      await waitForProcessExit(proc, 5000);
    }
  }

  fs.rmSync(workDir, {recursive: true, force: true});
}

/**
 * Poll a specific port's /api/ping until it answers or the deadline passes.
 * (waitForServer above is hard-wired to the default PORT.)
 */
async function waitForServerOn(port, maxWaitMs = 15_000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/ping`, {
        signal: AbortSignal.timeout(800),
      });
      if (res.ok) return true;
    } catch {
      // not ready yet
    }
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

// ── UI layer tests (optional, --ui flag) ───────────────────────────────────

async function runUiLayer(counter, opts, snapshotDir) {
  const firefoxBin = opts.firefox || process.env.FIREFOX_BINARY || discoverFirefoxBinary();
  if (!firefoxBin) {
    console.log('\n  UI layer skipped: no Firefox binary found.');
    return;
  }

  console.log(`\nUI layer: launching Firefox (${firefoxBin})...`);

  // UI assertions are numbered so CI failures identify the exact observable
  // behavior that failed, rather than only printing a generic label.
  const uiCheck = (ok, id, expected, detail = '') =>
    check(counter, ok, `${id}: ${expected}`, detail);

  // 1. Create a fresh profile for the test browser
  const testProfile = tempDir('fxs-installer-ui');

  // 2. Launch Firefox via puppeteer
  let browser;
  let page;
  // Hoisted so the catch/finally blocks can kill a detached installer that is
  // still holding port 8777 when the UI layer throws.
  let installerProc = null;
  try {
    browser = await launchFirefox(firefoxBin, testProfile, {
      headless: opts.headless,
      extraPrefsFirefox: opts.headless ? {'browser.display.background_color': '#ffffff'} : {},
    });

    // 3. Start the installer (separate process, without --smoke-test)
    const bin = findInstaller(snapshotDir);
    if (!bin) {
      uiCheck(false, 'UI-02', 'installer binary found for UI layer');
      return;
    }

    installerProc = spawn(bin, [], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    // Surface the installer's own diagnostics ([installer] … detection/launch
    // lines) in the test log so a missing tab is attributable.
    installerProc.stdout.on('data', d => console.log(`  [installer-out] ${d}`.trimEnd()));
    installerProc.stderr.on('data', d => console.log(`  [installer-err] ${d}`.trimEnd()));

    // 4. Wait for the installer server
    const ready = await waitForServer(60_000);
    if (!ready) {
      uiCheck(false, 'UI-03', 'installer server became ready');
      return;
    }

    // 5. The installer opens its tab in the detected browser — wait for it.
    const deadline = Date.now() + 30_000;
    let observedUrls = [];
    while (Date.now() < deadline) {
      const pages = await browser.pages();
      observedUrls = pages.map(p => {
        try {
          return p.url();
        } catch {
          return '<unreadable URL>';
        }
      });
      page = pages.find(p => {
        try {
          return p.url().startsWith('http://127.0.0.1:') || p.url().startsWith('http://localhost:');
        } catch {
          return false;
        }
      });
      if (page) break;
      await new Promise(r => setTimeout(r, 500));
    }
    uiCheck(
      Boolean(page),
      'UI-04',
      'installer tab appeared in browser (URL starts with http://127.0.0.1: or http://localhost:)',
      page ? '' : `observed pages after 30s: ${observedUrls.join(' | ') || '(none)'}`
    );

    if (page) {
      console.log(`  tab URL: ${page.url()}`);

      // Wait for cards to render
      const rendered = await waitForCondition(
        page,
        () => {
          const container = document.getElementById('browser-list');
          if (!container) return false;
          const cards = container.querySelectorAll('.browser-card');
          if (cards.length === 0) {
            // May show empty state if no browsers detected
            const empty = container.querySelector('.empty-state');
            return empty !== null;
          }
          return true;
        },
        30_000,
        'browser cards to render'
      );
      uiCheck(rendered, 'UI-05', 'installer UI rendered');

      // Header visibility
      const header = await page.evaluate(() => ({
        title: document.querySelector('.header h1')?.textContent || '',
        rescan: Boolean(document.getElementById('btn-rescan')),
        exit: Boolean(document.getElementById('btn-exit')),
      }));
      uiCheck(header.title.length > 0, 'UI-06', 'header title shown');
      uiCheck(header.rescan, 'UI-07', 'Rescan button present');
      uiCheck(header.exit, 'UI-08', 'Close button present');

      // Browser cards (may be empty if no browsers detected)
      const cards = await page.evaluate(() => {
        const container = document.getElementById('browser-list');
        if (!container) return {count: 0};
        const cardEls = container.querySelectorAll('.browser-card');
        const empty = container.querySelector('.empty-state');
        return {
          count: cardEls.length,
          empty: Boolean(empty),
          badges: [...cardEls].map(c => {
            const badge = c.querySelector('.card-status-badge');
            return badge?.textContent?.trim() || '';
          }),
        };
      });
      if (cards.empty) {
        uiCheck(true, 'UI-09', 'empty state shown (no browsers detected)');
      } else {
        uiCheck(cards.count > 0, 'UI-09', `browser cards rendered (${cards.count})`);
        // At least one card with a badge
        uiCheck(cards.badges.some(Boolean), 'UI-10', 'card status badges present');
      }

      // Screenshot
      const shotDir = path.join(REPO_ROOT, 'dist');
      fs.mkdirSync(shotDir, {recursive: true});
      const shotPath = path.join(shotDir, 'installer-e2e-screenshot.png');
      const shotOk = await screenshotPrivileged(page, shotPath);
      if (shotOk) uiCheck(true, 'UI-11', 'installer screenshot saved');
    }

    return;
  } catch (err) {
    console.error(`  UI layer error: ${err.message}`);
    uiCheck(false, 'UI-01', 'Firefox and installer UI layer completed', err.message);
  } finally {
    // Single cleanup path: every exit (success, early return, throw) closes
    // Firefox and the detached installer before the profile is removed.
    try {
      await browser?.close();
    } catch {
      /* ignore */
    }
    try {
      installerProc?.kill();
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(testProfile, {recursive: true, force: true});
    } catch {
      /* ignore */
    }
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

async function run() {
  const opts = parseArgs();
  const counter = createCounter();

  // Snapshot discovery
  let snapshotDir = opts.snapshot;
  if (!snapshotDir) {
    const snap = findSnapshot({branchCheck: false});
    if (!snap) {
      console.error('No snapshot found. Run `pnpm upload:local --mode=dev` first.');
      process.exit(1);
    }
    snapshotDir = snap.dir;
  }
  console.log(`Installer E2E\n  snapshot: ${snapshotDir}`);

  const bin = findInstaller(snapshotDir);
  if (!bin) {
    console.error('No installer binary found in snapshot.');
    process.exit(1);
  }
  console.log(`  binary: ${bin}`);

  // Start installer with --smoke-test for HTTP layer
  const proc = spawn(bin, ['--smoke-test'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  proc.on('error', err => {
    console.error('Failed to start installer:', err.message);
    process.exit(1);
  });

  let sessionToken = '';
  let stderr = '';
  proc.stdout.on('data', data => {
    const line = data.toString();
    const match = line.match(/SMOKE_TEST_SESSION_TOKEN=([a-f0-9]+)/);
    if (match) sessionToken = match[1];
  });
  proc.stderr.on('data', data => {
    stderr += data.toString();
  });

  proc.on('exit', code => {
    if (code !== null && code !== 0) {
      console.error(`Installer exited with code ${code}`);
      if (stderr) console.error('stderr:', stderr.slice(0, 500));
    }
  });

  console.log('Waiting for server to start...');
  const ready = await waitForServer();
  if (!ready) {
    console.error('Server did not start within 15s');
    proc.kill();
    process.exit(1);
  }
  console.log('Server ready.');
  await new Promise(r => setTimeout(r, 500)); // wait for token

  // Run HTTP layer — the smoke-test installer must be killed before the UI
  // layer starts its own installer in normal mode, or both fight over port
  // 8777 and waitForServer answers from the wrong process.
  try {
    await runHttpLayer(counter, sessionToken);
  } finally {
    proc.kill();
    await waitForProcessExit(proc, 10_000);
  }

  // Test-surface layer (default on) — spawns its own installers on
  // non-default ports, so it must also wait for the smoke-test instance to
  // be gone first.
  if (opts.testSurface) {
    await runTestSurfaceLayer(counter, bin);
  }

  // UI layer (optional) — spawns a fresh installer that now owns the port.
  if (opts.ui) {
    await runUiLayer(counter, opts, snapshotDir);
  }

  if (!summary(counter)) process.exitCode = 1;
}

run().catch(err => {
  console.error('Test runner failed:', err);
  process.exit(1);
});
