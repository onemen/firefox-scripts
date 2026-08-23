#!/usr/bin/env node
/**
 * E2E orchestrator — the single local entry point (`pnpm test:e2e`).
 *
 * Resolves configuration (CLI > env vars > e2e.config.mjs at the repo root >
 * defaults), validates the snapshot (strict branch check by default), then
 * runs:
 *
 * - installer E2E (node tools/test/e2e/installer-e2e.mjs)
 * - updater E2E (node tools/test/e2e/updater-e2e.mjs, once per browser)
 *
 * Usage: pnpm test:e2e # installer + updater (auto-detect Firefox) pnpm
 * test:e2e --installer # installer only pnpm test:e2e --updater --browser
 * firefox,waterfox pnpm test:e2e --snapshot dist/dev-main-abc1234
 * --no-branch-check pnpm test:e2e --headless --keep-profile
 */

import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {REPO_ROOT, check, createCounter} from './helpers.mjs';
import {findSnapshot} from './browsers.mjs';

const CONFIG_PATH = path.join(REPO_ROOT, 'e2e.config.mjs');

// ── Arg parsing ────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    installer: false,
    updater: false,
    browsers: null, // null = not specified
    snapshot: '',
    branchCheck: null, // null = not specified
    headless: null,
    keepProfile: null,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--installer') opts.installer = true;
    else if (a === '--updater') opts.updater = true;
    else if (a === '--browser' && args[i + 1]) {
      opts.browsers = args[++i]
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
    } else if (a === '--snapshot' && args[i + 1]) opts.snapshot = args[++i];
    else if (a === '--no-branch-check') opts.branchCheck = false;
    else if (a === '--headless') opts.headless = true;
    else if (a === '--keep-profile') opts.keepProfile = true;
    else if (a === '--help') {
      console.log(`Usage: pnpm test:e2e [--installer] [--updater] [--browser a,b] [--snapshot <dir>]
  [--no-branch-check] [--headless] [--keep-profile]
Config file: e2e.config.mjs at the repo root (see config.example.mjs).`);
      process.exit(0);
    }
  }
  return opts;
}

// ── Config resolution (CLI > env > e2e.config.mjs > defaults) ──────────────

function loadConfigFile() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return import(pathToFileURL(CONFIG_PATH).href).then(m => m.default || {});
    }
  } catch (err) {
    console.warn(`  (e2e.config.mjs ignored: ${err.message})`);
  }
  return Promise.resolve({});
}

function pathToFileURL(p) {
  // Small helper to avoid an import; URL constructor handles Windows paths.
  return new URL('file://' + p.replace(/\\/g, '/'));
}

async function resolveConfig(opts) {
  const file = await loadConfigFile();
  const env = process.env;
  const first = (...vals) => vals.find(v => v !== undefined && v !== null && v !== '');

  // Browsers: CLI --browser names map to config entries or auto-detect.
  let browsers = file.browsers || [{name: 'firefox', binary: ''}];
  if (opts.browsers) {
    browsers = opts.browsers.map(name => {
      const known = browsers.find(b => b.name === name);
      return known ? {...known} : {name, binary: ''};
    });
  }
  // env FIREFOX_BINARY applies only to a firefox entry: assigning it to a
  // named non-Firefox browser would test Firefox under the wrong label and
  // bypass the runtime-browser guard in updater-e2e.
  if (env.FIREFOX_BINARY) {
    const ff = browsers.find(b => b.name === 'firefox' && !b.binary);
    if (ff) browsers[browsers.indexOf(ff)] = {...ff, binary: env.FIREFOX_BINARY};
  }

  const installerBrowsers = file.installerBrowsers || browsers;

  return {
    browsers,
    installerBrowsers,
    snapshotDir: first(opts.snapshot, env.E2E_SNAPSHOT_DIR, file.snapshotDir) || '',
    branchCheck: first(
      opts.branchCheck === null ? undefined : opts.branchCheck,
      env.E2E_BRANCH_CHECK === 'off' ? false : undefined,
      file.branchCheck === 'off' ? false : file.branchCheck,
      'strict'
    ),
    headless: first(
      opts.headless === null ? undefined : opts.headless,
      env.E2E_HEADLESS === '1' ? true : undefined,
      file.headless,
      false
    ),
    keepProfile: first(
      opts.keepProfile === null ? undefined : opts.keepProfile,
      file.keepProfile,
      false
    ),
    installerBin: first(env.INSTALLER_BIN, file.installerBin) || '',
    timeouts: file.timeouts || {},
  };
}

// ── Child test runners ─────────────────────────────────────────────────────

function runChild(script, args, env) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [script, ...args], {
      stdio: 'inherit',
      env: {...process.env, ...env},
    });
    child.on('exit', code => resolve(code === 0));
    child.on('error', err => {
      console.error(`  failed to start ${script}: ${err.message}`);
      resolve(false);
    });
  });
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();
  const cfg = await resolveConfig(opts);
  const counter = createCounter();

  console.log('Firefox Scripts E2E');
  console.log('===================\n');

  // Snapshot validation (shared by both tests).
  let snapshot = null;
  try {
    snapshot = findSnapshot({override: cfg.snapshotDir, branchCheck: cfg.branchCheck});
  } catch (err) {
    console.error(`  ${err.message}`);
    process.exit(1);
  }
  if (!snapshot) {
    console.error(
      'No matching snapshot found in dist/. Run `pnpm upload:local --mode=dev` ' +
        'on the current branch first, or pass --snapshot <dir> / --no-branch-check.'
    );
    process.exit(1);
  }
  check(counter, true, `snapshot: ${snapshot.dir}${snapshot.matches ? ' (branch match)' : ''}`);

  const commonArgs = [`--snapshot`, snapshot.dir];
  if (cfg.headless) commonArgs.push('--headless');

  let ok = true;

  if (opts.installer || (!opts.installer && !opts.updater)) {
    console.log('\n--- Installer E2E ---');
    const env = {INSTALLER_BIN: cfg.installerBin};
    if (cfg.installerBrowsers.length) {
      env.E2E_INSTALLER_BROWSERS = JSON.stringify(cfg.installerBrowsers);
    }
    const pass = await runChild(
      path.join(REPO_ROOT, 'tools', 'test', 'e2e', 'installer-e2e.mjs'),
      commonArgs,
      env
    );
    ok = ok && pass;
  }

  if (opts.updater || (!opts.installer && !opts.updater)) {
    for (const browser of cfg.browsers) {
      console.log(`\n--- Updater E2E · ${browser.name} ---`);
      const args = [...commonArgs];
      const env = {};
      if (browser.binary) {
        args.push('--firefox', browser.binary);
      } else if (browser.name && browser.name !== 'firefox') {
        // No binary configured but a non-Firefox browser is selected — tell
        // discoverFirefoxBinary() which browser to look for.
        env.RUNTIME_BROWSER = browser.name;
      }
      if (cfg.keepProfile) args.push('--keep-profile');
      const pass = await runChild(
        path.join(REPO_ROOT, 'tools', 'test', 'e2e', 'updater-e2e.mjs'),
        args,
        env
      );
      ok = ok && pass;
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(ok ? 'E2E: ALL GREEN' : 'E2E: FAILURES');
  console.log(`${'='.repeat(60)}`);
  process.exit(ok ? 0 : 1);
}

main().catch(err => {
  console.error('E2E runner failed:', err);
  process.exit(1);
});
