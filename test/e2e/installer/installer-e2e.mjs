#!/usr/bin/env node
/**
 * Installer E2E test.
 *
 * Two layers:
 *
 * 1. HTTP layer (always runs): starts installer in --smoke-test, exercises token
 *    gate and every /api endpoint (29 assertions). Fast, reliable, no browser
 *    needed.
 * 2. UI layer (--ui flag): launches a real Firefox, starts the installer (normal
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
  const opts = {ui: false};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--snapshot' && args[i + 1]) opts.snapshot = args[++i];
    else if (args[i] === '--headless') opts.headless = true;
    else if (args[i] === '--ui') opts.ui = true;
    else if (args[i] === '--help') {
      console.log('Usage: node installer-e2e.mjs --snapshot <dir> [--ui] [--headless]');
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
