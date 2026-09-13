#!/usr/bin/env node
// test/e2e/updater/smoke-migration.mjs — ONE-OFF smoke test (untracked, not a
// repo gate): drives the ADR 0026 dead-dev-channel fallback in a real Firefox.
//
// Installs NOTHING: it uses the machine's existing Firefox (discovered, or
// FIREFOX_BINARY) with a throwaway profile in %TEMP%; launchFirefox launches
// it so it can never register itself in the user's Windows startup (see
// test/e2e/shared/helpers.mjs).
//
// Setup:
//   - discovered local Firefox + disposable %TEMP% profile
//   - profile seeded with the REAL dev-build-main-450468f utils (IS_DEV,
//     STABLE_* baked) and fx-folder into the browser's GreD (see the GreD
//     warning below — read before running on a personal machine)
//   - override prefs: HASHES_URL → a dead file:// path (the deleted branch),
//     STABLE_* + UI_BASE_URL → a local HTTP server serving the branch's own
//     manifest and zips under stable names
//   - utils forced stale so the check finds an update and opens the tab
//
// Asserts: fallback logged, migration persisted (activeChannel +
// activeChannelBuild), tab opened, migration banner visible, the local stable
// server served hashes.json + utils.zip, and the installed file was replaced.
//
// Usage: node test/e2e/updater/smoke-migration.mjs [--headless] [--firefox <path>]

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import {launchFirefox, attachProcessLogging, tempDir, rmDir} from '../shared/helpers.mjs';
import {findGreDir, extractZip, discoverFirefoxBinary} from '../shared/browsers.mjs';
import {closeBrowser, removeProfileCompatibilityIni} from '../shared/processHygiene.mjs';

const BRANCH = 'dev-build-main-450468f';
const RAW = `https://raw.githubusercontent.com/onemen/firefox-scripts/${BRANCH}`;
const PORT = 8791;
const HEADLESS = process.argv.includes('--headless');
const FIREFOX_FLAG = process.argv[process.argv.indexOf('--firefox') + 1];
const STALE_FILE = 'RDFDataSource.sys.mjs';
const STALE_MARKER = '\n// fxs-smoke: forced stale\n';

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fxs-smoke-'));
const pkgDir = path.join(work, 'pkg');
const serverHits = [];
let server;

const ok = [];
const fail = [];
function check(name, cond, detail = '') {
  (cond ? ok : fail).push(name);
  console.log(`  ${cond ? '✔' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function fetchBranch(name, dest) {
  const res = await fetch(`${RAW}/${name}`);
  if (!res.ok) throw new Error(`${RAW}/${name} → HTTP ${res.status}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  console.log(`  downloaded ${name} (${dest})`);
}

/** Serve the branch manifest + zips under stable names; log every hit. */
function startServer(dir) {
  server = http.createServer((req, res) => {
    const rel = req.url.replace(/^\//, '').split('?')[0];
    const file = path.join(dir, rel);
    serverHits.push(rel);
    if (!fs.existsSync(file)) {
      console.log(`  [srv] 404 ${req.url}`);
      res.writeHead(404).end('nope');
      return;
    }
    console.log(`  [srv] 200 ${req.url}`);
    res.writeHead(200, {'content-type': 'application/octet-stream'});
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(resolve => server.listen(PORT, '127.0.0.1', resolve));
}

/** Same console mirror the E2E uses (autoconfig context, GreD config.js). */
const PROBE = `
// fxs-smoke probe
try {
  const Cc = Components.classes;
  const Ci = Components.interfaces;
  const cs = Cc['@mozilla.org/consoleservice;1'].getService(Ci.nsIConsoleService);
  const f = Cc['@mozilla.org/file/local;1'].createInstance(Ci.nsIFile);
  f.initWithPath(Services.dirsvc.get('ProfD', Ci.nsIFile).path + '/smoke-console.log');
  const fos = Cc['@mozilla.org/network/file-output-stream;1'].createInstance(
    Ci.nsIFileOutputStream
  );
  fos.init(f, 0x02 | 0x08 | 0x10, -1, 0);
  cs.registerListener({
    observe(aMessage, aTopic, aData) {
      try {
        const line =
          new Date().toISOString() + ' ' +
          (aMessage.QueryInterface(Ci.nsIScriptError)?.errorMessage || aData || '') + '\\n';
        fos.write(line, line.length);
      } catch (e) {}
    },
  });
  let polls = 0;
  let tabFound = false;
  let bannerLogged = false;
  const watcher = Cc['@mozilla.org/timer;1'].createInstance(Ci.nsITimer);
  watcher.initWithCallback({
    notify() {
      try {
        if (++polls > 45) { watcher.cancel();
          if (!bannerLogged) fos.write('BANNER_VISIBLE unknown (timeout)\\n', 34);
          return; }
        const win = Services.wm.getMostRecentWindow('navigator:browser');
        for (const tab of win?.gBrowser?.tabs || []) {
          const spec = tab.linkedBrowser?.currentURI?.spec || '';
          if (!spec.startsWith('chrome://firefox-scripts/content/ui/')) continue;
          if (!tabFound) {
            tabFound = true;
            fos.write('TAB_OPENED ' + spec + '\\n', ('TAB_OPENED ' + spec).length + 2);
          }
          // Trusted-tab DOM: only reachable from this privileged scope —
          // WebDriver BiDi cannot enumerate chrome:// pages at all.
          const doc = tab.linkedBrowser.contentDocument;
          const banner = doc?.getElementById?.('migration-banner');
          const build = doc?.getElementById?.('build-banner');
          if (banner && !bannerLogged) {
            bannerLogged = true;
            const line =
              'BANNER_VISIBLE ' + (!banner.hidden) +
              ' buildBanner=' + (build ? !build.hidden : 'missing') +
              ' title=' + (doc.getElementById('card-title')?.textContent || '') + '\\n';
            fos.write(line, line.length);
            watcher.cancel();
            return;
          }
        }
      } catch (e) {}
    },
  }, 1000, Ci.nsITimer.TYPE_REPEATING_SLACK);
} catch (e) {}
`;

async function main() {
  console.log('## 1. Fetch the real branch artifacts');
  fs.mkdirSync(pkgDir, {recursive: true});
  await fetchBranch('utils-dev.zip', path.join(pkgDir, 'utils-dev.zip'));
  await fetchBranch('fx-folder-dev.zip', path.join(pkgDir, 'fx-folder-dev.zip'));
  await fetchBranch('updater-ui-dev.zip', path.join(pkgDir, 'updater-ui-dev.zip'));
  await fetchBranch('hashes.json', path.join(pkgDir, 'hashes.json'));

  console.log('\n## 2. Firefox — discovered local install, nothing is installed');
  const exe = FIREFOX_FLAG || process.env.FIREFOX_BINARY || discoverFirefoxBinary();
  if (!exe || !fs.existsSync(exe)) {
    throw new Error('no local Firefox found (use --firefox <path> or FIREFOX_BINARY)');
  }
  console.log(`  using: ${exe}`);
  console.log(
    "  WARNING: config.js is copied into this browser's GreD (installation dir).\n" +
      '  On a personal machine prefer a throwaway portable copy you manage yourself.'
  );

  console.log('\n## 3. Seed GreD (fx-folder + console probe)');
  const greDir = findGreDir(exe);
  console.log(`  GreD: ${greDir}`);
  const staging = tempDir('fxs-smoke-fx');
  extractZip(path.join(pkgDir, 'fx-folder-dev.zip'), staging);
  for (const rel of ['config.js', 'defaults/pref/config-prefs.js']) {
    const src = path.join(staging, 'fx-folder', ...rel.split('/'));
    const dst = path.join(greDir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(dst), {recursive: true});
    fs.copyFileSync(src, dst);
  }
  rmDir(staging);
  fs.appendFileSync(path.join(greDir, 'config.js'), PROBE);

  console.log('\n## 4. Seed the profile (branch utils, forced stale) + overrides');
  const profileDir = tempDir('fxs-smoke-profile');
  removeProfileCompatibilityIni(profileDir);
  const chromeUtils = path.join(profileDir, 'chrome', 'utils');
  extractZip(path.join(pkgDir, 'utils-dev.zip'), chromeUtils);
  fs.appendFileSync(path.join(chromeUtils, STALE_FILE), STALE_MARKER);

  const dead = 'file:///' + path.join(work, 'dead-branch').replace(/\\/g, '/') + '/hashes.json';
  const base = `http://127.0.0.1:${PORT}`;
  const prefs = {
    'extensions.firefox-scripts.lastUpdateTabShown': '',
    'extensions.firefox-scripts.lastScriptsCheckDate': '',
    // Windows startup hygiene comes from launchFirefox's defaults; NEVER
    // register a Windows startup entry for this throwaway run.
    // The deleted dev channel — its manifest must be unreachable.
    'extensions.firefox-scripts.override.HASHES_URL': dead,
    // The stable channel resolves HERE (proves the fallback + URL getters).
    'extensions.firefox-scripts.override.STABLE_HASHES_URL': `${base}/hashes.json`,
    'extensions.firefox-scripts.override.STABLE_ZIP_BASE_URL': base,
    'extensions.firefox-scripts.override.STABLE_UI_BASE_URL': base,
    'extensions.firefox-scripts.override.STABLE_HELPER_BASE_URL': base,
    // Own-channel UI host → local too (ensureUpdaterUi runs pre-migration).
    'extensions.firefox-scripts.override.UI_BASE_URL': base,
    // Quiet the updater's own noise floor; keep errors visible.
    'app.update.disabledForTesting': true,
  };

  console.log('\n## 5. Local stable server (branch manifest + zips, stable names)');
  for (const [from, to] of [
    ['utils-dev.zip', 'utils.zip'],
    ['fx-folder-dev.zip', 'fx-folder.zip'],
    ['updater-ui-dev.zip', 'updater-ui.zip'],
    ['updater-ui-dev.zip', 'updater-ui-dev.zip'],
  ]) {
    fs.copyFileSync(path.join(pkgDir, from), path.join(pkgDir, to));
  }
  await startServer(pkgDir);

  console.log('\n## 6. Launch Firefox and watch the console mirror');
  const browser = await launchFirefox(exe, profileDir, {
    headless: HEADLESS,
    extraPrefsFirefox: prefs,
  });
  attachProcessLogging(browser, 'ff');
  try {
    // The tab + banner are observed by the autoconfig probe (BiDi cannot see
    // chrome:// tabs); wait for the mirror lines instead of pages().
    const mirror = path.join(profileDir, 'smoke-console.log');
    let tabLine = '';
    let bannerLine = '';
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && !(tabLine && bannerLine)) {
      await new Promise(r => setTimeout(r, 1000));
      try {
        const log = fs.readFileSync(mirror, 'utf-8');
        tabLine = tabLine || (/^.*TAB_OPENED.*$/m.exec(log)?.[0] ?? '');
        bannerLine = bannerLine || (/^.*BANNER_VISIBLE.*$/m.exec(log)?.[0] ?? '');
      } catch {
        // mirror not written yet
      }
    }
    check('updater tab opened', Boolean(tabLine), tabLine.trim());
    check('migration banner is VISIBLE', /BANNER_VISIBLE true/.test(bannerLine), bannerLine.trim());

    console.log('\n## 7. Wait for the auto-install to replace the stale file');
    const stalePath = path.join(chromeUtils, STALE_FILE);
    let installed = false;
    for (let i = 0; i < 45 && !installed; i++) {
      await new Promise(r => setTimeout(r, 1000));
      try {
        installed = !fs.readFileSync(stalePath, 'utf-8').includes(STALE_MARKER);
      } catch {
        // mid-replace
      }
    }
    check('stale utils file replaced by the stable-channel install', installed);
  } finally {
    await closeBrowser(browser, {log: console.log}).catch(() => {});
    server?.close();
  }

  console.log('\n## 8. Post-run evidence');
  let consoleLog = '';
  try {
    consoleLog = fs.readFileSync(path.join(profileDir, 'smoke-console.log'), 'utf-8');
  } catch {
    // probe never wrote (autoconfig failed) — the checks below will report it
  }
  check(
    'console: fallback fired',
    consoleLog.includes('falling back to the stable channel'),
    'smoke-console.log'
  );
  check(
    'console: migration recorded',
    consoleLog.includes('migrated to the stable channel'),
    'smoke-console.log'
  );

  const prefsJs = fs.readFileSync(path.join(profileDir, 'prefs.js'), 'utf-8');
  const chan = /user_pref\("extensions\.firefox-scripts\.activeChannel",\s*"([^"]+)"\)/.exec(
    prefsJs
  )?.[1];
  const chanBuild =
    /user_pref\("extensions\.firefox-scripts\.activeChannelBuild",\s*"([^"]+)"\)/.exec(
      prefsJs
    )?.[1];
  check('pref: activeChannel == stable', chan === 'stable', `got ${chan}`);
  check('pref: activeChannelBuild == this dev build', chanBuild === BRANCH, `got ${chanBuild}`);

  const hits = [...new Set(serverHits)];
  check('server served the stable manifest', hits.includes('hashes.json'), hits.join(', '));
  check('server served utils.zip (the update install)', hits.includes('utils.zip'));
  check(
    'server never saw a dev-suffix manifest fetch',
    !hits.includes('dev/hashes.json'),
    hits.join(', ')
  );

  console.log(`\n## Summary: ${ok.length} passed, ${fail.length} failed`);
  if (fail.length > 0) {
    console.log(`Failed: ${fail.join(' | ')}`);
    console.log(`(profile kept: ${profileDir})`);
    process.exitCode = 1;
  } else {
    fs.rmSync(work, {recursive: true, force: true});
    console.log('workspace cleaned');
  }
}

main().catch(e => {
  console.error('SMOKE FAILED:', e);
  server?.close();
  process.exitCode = 1;
});
