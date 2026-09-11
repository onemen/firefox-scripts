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
 * 3. Restart-scope layer (#180, default on; --no-restart-scope to skip): two
 *    copies of the discovered Firefox install (same image name, different
 *    binary dirs) run at once, a config install targets copy B, Restart — copy
 *    A must survive (the old image-name kill killed it). Needs a real
 *    (non-snap) Firefox; skips otherwise.
 * 4. UI layer (--ui flag): launches a real Firefox, starts the installer (normal
 *    mode, so it detects the browser), navigates to the web UI, and asserts
 *    cards render with expected statuses.
 *
 * Usage: node test/e2e/installer/installer-e2e.mjs --snapshot <dir> [--ui] pnpm
 * test:e2e:installer -- [--ui]
 */

import fs from 'node:fs';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {
  REPO_ROOT,
  check,
  createCounter,
  launchFirefox,
  waitForCondition,
  waitForProcessExit,
  screenshotPrivileged,
  tempDir,
  rmDir,
  summary,
} from '../shared/helpers.mjs';
import {findSnapshot, discoverFirefoxBinary, findZip, isSnapBinary} from '../shared/browsers.mjs';
import {
  closeBrowser,
  killStrayProcesses,
  removeProfileCompatibilityIni,
} from '../shared/processHygiene.mjs';

const PORT = 8777;
const BASE = `http://127.0.0.1:${PORT}`;
const TIMEOUT_MS = 15_000;

// ── Parse args ────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {ui: false, testSurface: true, restartScope: true};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--snapshot' && args[i + 1]) opts.snapshot = args[++i];
    else if (args[i] === '--headless') opts.headless = true;
    else if (args[i] === '--ui') opts.ui = true;
    else if (args[i] === '--no-test-surface') opts.testSurface = false;
    else if (args[i] === '--no-restart-scope') opts.restartScope = false;
    else if (args[i] === '--ui-fallback-open') opts.uiFallbackOpen = true;
    else if (args[i] === '--help') {
      console.log(
        'Usage: node installer-e2e.mjs --snapshot <dir> [--ui] [--headless] [--no-test-surface] [--no-restart-scope] [--ui-fallback-open]'
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

// ── Restart-scope layer (#180) ─────────────────────────────────────────
//
// Issue #180: after a config install, the restart worker closed EVERY process
// of the image name (firefox.exe) instead of the target install's processes.
// With ESR and Nightly running at once (both firefox.exe), restarting ESR
// closed Nightly too. The fix matches processes by full binary path
// (close_browser_binary); this leg is the regression test.
//
// Hermetic setup: the discovered Firefox install is copied into two temp
// dirs. Both copies share ONE image name (exactly the bug's precondition)
// but have different binary paths. Copy A (the bystander) and copy B (the
// target) each run a profile. The installer (in --smoke-test mode so it
// never opens a UI tab) scans them, a config zip is uploaded via /api/upload,
// /api/install runs a real config install for B (temp dirs are user-writable,
// so admin_copy_tree needs no elevation), and /api/restart is triggered.
// Assertions: copy A's processes survive throughout, copy B's old processes
// are gone and its profile relaunches with a new PID, and the installer
// server stays up.

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/** Poll fn (sync or async) until it returns truthy or the timeout passes. */
async function pollUntil(fn, timeoutMs, intervalMs = 500) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() >= end) return null;
    await sleep(intervalMs);
  }
}

function readJsonIfExists(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function samePath(a, b) {
  if (!a || !b) return false;
  const norm = p => path.resolve(p);
  return process.platform === 'win32' ?
      norm(a).toLowerCase() === norm(b).toLowerCase()
    : norm(a) === norm(b);
}

/** Launch a Firefox binary+profile as a detached OS process. */
function launchDetachedFirefox(firefoxBin, profileDir, headless) {
  const args = ['--profile', profileDir, '--no-remote'];
  if (headless) args.push('-headless');
  // detached + unref'd: the browser must outlive harness steps that throw.
  const child = spawn(firefoxBin, args, {detached: true, stdio: 'ignore'});
  child.unref();
  return child;
}

/**
 * Copy the discovered Firefox install into a temp dir so two instances can run
 * under one image name with different binary paths (the bug's exact
 * precondition). Windows: robocopy of the install dir. Linux: cp -a of the
 * resolved binary's dir (discovered paths like /usr/bin/firefox are symlinks).
 * macOS: cp -a of the whole .app bundle so the Contents/Resources GreD layout
 * survives (config installs and detection both key on it). Returns {bin, dir}
 * or null on failure.
 */
function copyFirefoxInstall(firefoxBin, destDir) {
  if (process.platform === 'win32') {
    const src = path.dirname(firefoxBin);
    fs.mkdirSync(destDir, {recursive: true});
    // Exit codes < 8 are success (1 = files copied, 3 = copied + extra);
    // /R:1 /W:1 keeps a locked file from retrying for minutes.
    const r = spawnSync(
      'robocopy',
      [
        src,
        destDir,
        '/E',
        '/R:1',
        '/W:1',
        '/XD',
        'gtest',
        'xpcshell',
        'crashreporter',
        'uninstall',
        '/NFL',
        '/NDL',
        '/NJH',
        '/NJS',
        '/NP',
      ],
      {stdio: 'ignore'}
    );
    if ((r.status ?? 99) >= 8) return null;
    const bin = path.join(destDir, 'firefox.exe');
    return fs.existsSync(bin) ? {bin, dir: destDir} : null;
  }

  const real = fs.realpathSync(firefoxBin);
  if (process.platform === 'darwin') {
    // .../FirefoxA.app/Contents/MacOS/firefox → the .app root two levels up.
    const macosIdx = real.lastIndexOf('/Contents/MacOS/');
    if (macosIdx === -1) return null;
    const appRoot = real.slice(0, macosIdx);
    const appName = path.basename(appRoot);
    const r = spawnSync('cp', ['-a', appRoot, path.join(destDir, appName)], {
      stdio: 'pipe',
    });
    if (r.status !== 0) return null;
    const bin = path.join(destDir, appName, 'Contents', 'MacOS', path.basename(real));
    return fs.existsSync(bin) ? {bin, dir: path.join(destDir, appName)} : null;
  }
  // Linux: copy the binary's real dir (a tarball/system install layout).
  const src = path.dirname(real);
  fs.mkdirSync(destDir, {recursive: true});
  const r = spawnSync('cp', ['-a', src + '/.', destDir], {stdio: 'pipe'});
  if (r.status !== 0) return null;
  const bin = path.join(destDir, path.basename(real));
  return fs.existsSync(bin) ? {bin, dir: destDir} : null;
}

/**
 * Raw PID list of firefox.exe processes whose command line contains profileDir
 * (may contain a bogus 0 parsed from an empty tooling line). Returns null only
 * when the OS tooling itself failed.
 */
function rawFirefoxPidsForProfile(workDir, profileDir) {
  if (process.platform === 'win32') {
    const script = path.join(workDir, 'rs-list.ps1');
    fs.writeFileSync(
      script,
      [
        "$ErrorActionPreference = 'SilentlyContinue'",
        'Get-CimInstance Win32_Process -Filter "Name=\'firefox.exe\'" |',
        "  Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:RS_PROFILE) -and $_.CommandLine -notmatch '-contentproc' } |",
        '  ForEach-Object { "$($_.ProcessId)" }',
      ].join('\n')
    );
    const r = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
      {encoding: 'utf8', timeout: 30_000, env: {...process.env, RS_PROFILE: profileDir}}
    );
    if (r.error || (r.status !== 0 && !r.stdout)) return null;
    return (r.stdout || '')
      .split(/\r?\n/)
      .map(s => Number(s.trim()))
      .filter(Number.isFinite);
  }
  // POSIX: pgrep -a prints "PID cmdline" lines; drop contentproc children
  // (they are spawned/exit independently) and parse the leading PID.
  const pattern = profileDir.replace(/[\\^$.|?*+()[\]{}]/g, '\\$&');
  const r = spawnSync('pgrep', ['-af', pattern], {encoding: 'utf8', timeout: 15_000});
  if (r.error) return null;
  return (r.stdout || '')
    .split(/\r?\n/)
    .filter(line => !line.includes('-contentproc'))
    .map(line => Number(line.trim().split(/\s+/)[0]))
    .filter(Number.isFinite);
}

/**
 * PIDs of firefox.exe MAIN processes for a profile: content processes are
 * spawned and exit independently, so survivor assertions track mains only.
 * Filters the raw list (drops the bogus 0). Returns null only when the OS
 * tooling itself failed.
 */
function firefoxPidsForProfile(workDir, profileDir) {
  const raw = rawFirefoxPidsForProfile(workDir, profileDir);
  if (!raw) return null;
  return raw.filter(pid => pid > 0);
}

/** Force-kill every firefox.exe whose command line matches one of the paths. */
function killFirefoxMatching(workDir, pathPatterns) {
  if (process.platform === 'win32') {
    const script = path.join(workDir, 'rs-kill.ps1');
    const env = {...process.env};
    pathPatterns.forEach((p, i) => {
      env[`RS_P${i}`] = p;
    });
    const clauses = pathPatterns
      .map((_, i) => `$_.CommandLine.Contains($env:RS_P${i})`)
      .join(' -or ');
    fs.writeFileSync(
      script,
      [
        "$ErrorActionPreference = 'SilentlyContinue'",
        'Get-CimInstance Win32_Process -Filter "Name=\'firefox.exe\'" |',
        `  Where-Object { $_.CommandLine -and (${clauses}) } |`,
        '  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }',
      ].join('\n')
    );
    spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
      {encoding: 'utf8', timeout: 30_000, env}
    );
    return;
  }
  for (const p of pathPatterns) {
    const pattern = p.replace(/[\\^$.|?*+()[\]{}]/g, '\\$&');
    spawnSync('pkill', ['-f', pattern], {encoding: 'utf8', timeout: 15_000});
  }
}

async function runRestartScopeLayer(counter, opts, snapshotDir, installerBin) {
  console.log(
    '\nRestart-scope layer (#180): config restart must not close other same-image installs'
  );

  const firefoxBin = opts.firefox || process.env.FIREFOX_BINARY || discoverFirefoxBinary();
  if (!firefoxBin || isSnapBinary(firefoxBin)) {
    console.log('  SKIP: no non-snap Firefox binary found (restart-scope layer needs one)');
    check(
      counter,
      process.env.FXS_REQUIRE_RESTART_SCOPE !== '1',
      'RS-00 non-snap Firefox available (skip tolerated unless FXS_REQUIRE_RESTART_SCOPE=1)'
    );
    return;
  }

  // 'fxs-e2e' prefix so the shared stray-process sweep also cleans up after a
  // crashed run (leftover copies/profiles + the --env-file installer).
  const workDir = tempDir('fxs-e2e');
  const dirA = path.join(workDir, 'install-a');
  const dirB = path.join(workDir, 'install-b');
  const profA = path.join(workDir, 'profile-a');
  const profB = path.join(workDir, 'profile-b');
  fs.mkdirSync(profA, {recursive: true});
  fs.mkdirSync(profB, {recursive: true});
  removeProfileCompatibilityIni(profA);
  removeProfileCompatibilityIni(profB);

  // Headless relaunch: the restart worker spawns the browser without a
  // -headless flag, so the env var is what keeps a display-less runner alive.
  // The spawned installer inherits it, and the relaunched browser inherits
  // it from the installer. Restored in finally so a headed --ui run after
  // this layer is unaffected.
  const prevHeadless = process.env.MOZ_HEADLESS;
  let installer = null;
  try {
    if (opts.headless) process.env.MOZ_HEADLESS = '1';

    console.log('  copying the Firefox install into two temp dirs...');
    const copyA = copyFirefoxInstall(firefoxBin, dirA);
    const copyB = copyFirefoxInstall(firefoxBin, dirB);
    check(
      counter,
      Boolean(copyA && copyB),
      'RS-01 two temp copies of the Firefox install created (same image name, distinct binary paths)'
    );
    if (!copyA || !copyB) return;

    console.log(`  launching bystander A (${copyA.bin})`);
    launchDetachedFirefox(copyA.bin, profA, opts.headless);
    console.log(`  launching target B (${copyB.bin})`);
    launchDetachedFirefox(copyB.bin, profB, opts.headless);

    const setA = await pollUntil(() => {
      const s = firefoxPidsForProfile(workDir, profA);
      return s && s.length > 0 ? s : null;
    }, 30_000);
    check(counter, Boolean(setA), 'RS-02 bystander A is running');
    const setB = await pollUntil(() => {
      const s = firefoxPidsForProfile(workDir, profB);
      return s && s.length > 0 ? s : null;
    }, 30_000);
    check(counter, Boolean(setB), 'RS-03 target B is running');
    if (!setA || !setB) throw new Error('copied Firefox instances did not start');

    // Installer in smoke mode: scans browsers, serves, never opens a tab.
    const envFile = path.join(workDir, 'env.json');
    installer = spawn(installerBin, ['--smoke-test', '--env-file', envFile], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    installer.stdout.on('data', d => console.log(`  [installer] ${d}`.trimEnd()));
    installer.stderr.on('data', d => console.log(`  [installer-err] ${d}`.trimEnd()));

    const manifest = await pollUntil(() => readJsonIfExists(envFile), 20_000, 200);
    check(
      counter,
      Boolean(manifest?.token && manifest?.port),
      'RS-04 installer env manifest written (token + port)'
    );
    if (!manifest) throw new Error('installer did not write its env manifest');
    const base = `http://127.0.0.1:${manifest.port}`;
    const tq = `?t=${encodeURIComponent(manifest.token)}`;

    // Detection must see both copies as distinct rows (strong cmdline profile
    // match; rows selected by profile path — C returns the cmdline value
    // verbatim, immune to GetModuleFileName casing/short-path differences).
    const rows = await pollUntil(async () => {
      try {
        const res = await fetch(`${base}/api/browsers`, {signal: AbortSignal.timeout(3000)});
        const arr = JSON.parse(await res.text());
        const a = arr.find(r => samePath(r.profilePath, profA));
        const b = arr.find(r => samePath(r.profilePath, profB));
        return a && b ? {a, b} : null;
      } catch {
        return null;
      }
    }, 20_000);
    check(
      counter,
      Boolean(rows),
      'RS-05 installer detected both installs as distinct rows (same image name, different binary paths)'
    );
    if (!rows) throw new Error('installer did not detect both copies');
    check(
      counter,
      !samePath(rows.a.binaryPath, rows.b.binaryPath),
      'RS-06 detected rows have distinct binary paths'
    );

    // Real config install for B (drives exactly what the UI tab drives).
    const fxZip = findZip(snapshotDir, ['fx-folder-dev.zip', 'fx-folder.zip']);
    check(counter, Boolean(fxZip), 'RS-07 fx-folder zip present in the snapshot');
    if (!fxZip) throw new Error('no fx-folder zip in snapshot');
    const up = await fetch(`${base}/api/upload${tq}`, {
      method: 'POST',
      body: fs.readFileSync(fxZip),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    check(counter, up.ok, 'RS-08 config zip uploaded to the installer');

    const started = await fetch(
      `${base}/api/install?browser=${rows.b.index}&config=1${tq.replace('?t=', '&t=')}`,
      {method: 'POST', signal: AbortSignal.timeout(TIMEOUT_MS)}
    );
    const startedBody = await started.json().catch(() => null);
    check(
      counter,
      startedBody?.status === 'started',
      'RS-09 config install started for target B',
      JSON.stringify(startedBody)?.slice(0, 80)
    );

    const done = await pollUntil(
      async () => {
        try {
          const res = await fetch(`${base}/api/status${tq}`, {signal: AbortSignal.timeout(3000)});
          const j = JSON.parse(await res.text());
          if (j.step === 'done') return j;
          if (j.step === 'error') return {error: j.message};
        } catch {
          /* transient */
        }
        return null;
      },
      45_000,
      400
    );
    check(
      counter,
      Boolean(done) && !done.error,
      'RS-10 config install completed (no elevation needed: temp dir is user-writable)',
      done?.error || ''
    );
    if (!done || done.error) throw new Error('config install did not complete');

    // Restart B. On Windows the worker is async (response returns first); on
    // POSIX the work runs inside the request.
    //
    // Baselines are sampled AFTER the launch has settled: Firefox may fork a
    // launcher process at startup that hands off and exits, so the exact PID
    // set churns in the first seconds. The anti-bug invariant (#180) is not
    // "same PIDs" — an image-name kill closed EVERY instance, so the fixed
    // behavior is: bystander A never drops to zero main processes, and B
    // comes back with a fresh main-PID set.
    const stablePids = async profile => {
      for (let i = 0; i < 5; i++) {
        const s1 = firefoxPidsForProfile(workDir, profile) || [];
        await sleep(2500);
        const s2 = firefoxPidsForProfile(workDir, profile) || [];
        if (
          s1.length > 0 &&
          s2.length > 0 &&
          s1.length === s2.length &&
          s1.every(pid => s2.includes(pid))
        )
          return s2;
      }
      return firefoxPidsForProfile(workDir, profile) || [];
    };
    const preA = await stablePids(profA);
    const preB = await stablePids(profB);
    check(counter, preA.length > 0, 'RS-12a bystander A baseline stable before the restart');
    const rres = await fetch(
      `${base}/api/restart?browser=${rows.b.index}${tq.replace('?t=', '&t=')}`,
      {method: 'POST', signal: AbortSignal.timeout(60_000)}
    );
    const rbody = await rres.json().catch(() => null);
    check(
      counter,
      rbody?.status === 'restarted',
      'RS-11 restart accepted for target B',
      JSON.stringify(rbody)?.slice(0, 80)
    );

    // The window: A must keep running the whole time (the bug killed it here),
    // and B must come back with a fresh process set. The worker may take a
    // few seconds (WM_CLOSE + wait) before B's relaunch appears.
    //
    // The close+fresh-PID behavior is Windows-specific: the pre-fix kill was
    // Windows-only (EnumWindows/taskkill), and the POSIX config branch has
    // never closed processes (pre-existing behavior, outside #180). So the
    // full window poll runs on Windows only; POSIX asserts A was untouched.
    if (process.platform === 'win32') {
      const deadline = Date.now() + 45_000;
      let survived = true;
      let relaunched = false;
      let sawBClosed = false;
      let detail = '';
      while (Date.now() < deadline) {
        const nowA = firefoxPidsForProfile(workDir, profA) || [];
        if (nowA.length === 0) {
          survived = false;
          detail = `bystander A dropped to zero main processes (baseline was ${preA.join(',')})`;
          break;
        }
        const nowB = firefoxPidsForProfile(workDir, profB) || [];
        if (nowB.length === 0) {
          sawBClosed = true;
        } else if (sawBClosed || nowB.every(pid => !preB.includes(pid))) {
          // Closed then something reappeared, or fresh PIDs right away.
          // (PID-reuse safe: a recycled PID alone doesn't count unless we
          // saw B fully closed first.)
          relaunched = true;
          break;
        }
        await sleep(500);
      }
      check(
        counter,
        survived,
        'RS-12 bystander A (same image name) kept running through the whole restart',
        detail
      );
      check(counter, relaunched, 'RS-13 target B was closed and relaunched with a fresh PID');
    } else {
      const nowA = firefoxPidsForProfile(workDir, profA);
      check(
        counter,
        Boolean(nowA) && nowA.length > 0,
        'RS-12 bystander A (same image name) survived the restart (POSIX)'
      );
      console.log(
        '  (POSIX: the config restart has no process-close step — fresh-PID assertion is Windows-only)'
      );
    }

    const ping = await fetch(`${base}/api/ping`, {signal: AbortSignal.timeout(3000)});
    check(counter, ping.ok, 'RS-14 installer server still answering after the restart');
  } catch (err) {
    check(counter, false, 'RS-FIN restart-scope layer completed', err.message);
  } finally {
    try {
      installer?.kill();
      if (installer) await waitForProcessExit(installer, 5000);
    } catch {
      /* ignore */
    }
    // Kill both copies (and any worker-relaunched instance) before the tree
    // is removed — Windows keeps dir handles open otherwise.
    try {
      killFirefoxMatching(workDir, [dirA, dirB, profA, profB]);
    } catch {
      /* ignore */
    }
    await sleep(1500);
    if (prevHeadless === undefined) delete process.env.MOZ_HEADLESS;
    else process.env.MOZ_HEADLESS = prevHeadless;
    rmDir(workDir);
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
  // Profile hygiene (issue #130): never reuse stale GRE-compatibility state.
  removeProfileCompatibilityIni(testProfile);

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

    // The snap leg passes --ui-fallback-open: the installer's cross-process
    // relaunch cannot hand its URL into a BiDi-driven snap instance under CI
    // (headless AND headed, confined AND unconfined attempts all failed; the
    // tarball legs pass). When the relaunch does not surface the tab, the UI
    // URL is opened IN this browser instead so the detection/rendering
    // assertions still run. Ask the installer for an --env-file manifest so
    // the exact port + session token are known.
    const envDir = opts.uiFallbackOpen ? tempDir('fxs-installer-ui-env') : null;
    const envFile = envDir ? path.join(envDir, 'env.json') : null;
    const installerArgs = opts.uiFallbackOpen ? ['--env-file', envFile] : [];
    installerProc = spawn(bin, installerArgs, {
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
    // --ui-fallback-open (snap leg): when the installer's cross-process
    // relaunch does not surface the tab in this BiDi browser, open the exact
    // UI URL (port + token from the installer's --env-file manifest) in a new
    // page here so the detection/rendering assertions still run.  The relaunch
    // itself cannot hand off into a BiDi-driven snap instance under CI — the
    // tarball legs hand off fine, the snap build does not (headless and headed,
    // unconfined and snap-wrapped relaunch all verified failing) — so the UI
    // is opened in-process instead and the caveat is surfaced in the log.
    if (!page && opts.uiFallbackOpen && envFile) {
      let uiUrl = null;
      try {
        uiUrl = JSON.parse(fs.readFileSync(envFile, 'utf-8')).uiUrl;
      } catch (err) {
        console.log(
          `  [diag] could not read installer env manifest for the fallback open: ${err.message}`
        );
      }
      if (uiUrl) {
        console.log(
          '  [diag] installer relaunch did not surface the tab in this browser; ' +
            `opening the UI in-process: ${uiUrl}`
        );
        try {
          page = await browser.newPage();
          await page.goto(uiUrl, {waitUntil: 'domcontentloaded'});
        } catch (err) {
          console.log(`  [diag] in-process UI open failed: ${err.message}`);
          page = null;
        }
      }
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
      await closeBrowser(browser);
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

  // Process hygiene (issue #130): a cancelled previous run can leave the
  // detached installer holding port 8777 — the HTTP layer below would then
  // probe the DEAD run's server. Sweep first.
  await killStrayProcesses();

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

  // Restart-scope layer (#180, default on) — needs a real Firefox + the
  // snapshot's fx-folder zip; skips gracefully when neither is available.
  if (opts.restartScope) {
    await runRestartScopeLayer(counter, opts, snapshotDir, bin);
  }

  // UI layer (optional) — spawns a fresh installer that now owns the port.
  if (opts.ui) {
    await runUiLayer(counter, opts, snapshotDir);
  }

  if (!summary(counter)) process.exitCode = 1;

  // Hard-exit instead of letting node unwind naturally: the UI layer spawns the
  // installer detached, and the installer relaunches the detected browser,
  // which inherits the installer's stdio pipes. A browser that outlives this
  // process (e.g. the snap leg's relaunch, which starts its own instance when
  // it cannot hand the URL off) keeps those pipes open, so the event loop never
  // drains and the job hangs until CI cancels it. The summary is final.
  process.exit(process.exitCode || 0);
}

run().catch(err => {
  console.error('Test runner failed:', err);
  process.exit(1);
});
