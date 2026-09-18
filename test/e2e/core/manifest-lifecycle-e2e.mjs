#!/usr/bin/env node
/**
 * Legacy chrome lifecycle E2E — regression test for the SHIPPED
 * core/chrome/utils/BootstrapLoader.js (discussion #101 on
 * onemen/firefox-scripts).
 *
 * A legacy (non-WebExtension) bootstrap extension's chrome is registered per
 * session from a temporary manifest the loader writes into
 * <ProfD>/browser-extension-data/<id>/ and autoRegisters. The chrome registry
 * does NOT persist dynamic registrations across sessions, so every restart must
 * re-derive them — this test asserts the shipped loader does that reliably:
 *
 * S1 fresh profile — chrome://testext/content/test.html becomes readable S2
 * plain restart — still readable (same profile) S3 cache-cleared — still
 * readable after removing startupCache + cache2 ("clear cache and restart"
 * ritual)
 *
 * The liveness signal is a probe appended to GreD config.js (autoconfig) that
 * tries to READ the extension's chrome URL at T+0 and every 1 s, logging OK/ERR
 * to <ProfD>/chrome-probe.log; the extension's bootstrap.js appends its own
 * lifecycle events to <ProfD>/ext-lifecycle.log so a session with no probe line
 * at all (loader never ran) is distinguishable from one where the chrome stayed
 * dead.
 *
 * The utils package is used VERBATIM from the snapshot — no source patching —
 * so the test guards the loader exactly as shipped.
 *
 * Stale-manifest sweep (crash litter): before the first launch the profile is
 * seeded with leftover `chrome.manifest.<uuid>` files and a 0-byte
 * `chrome.manifest` (what a killed session leaves behind). The loader's startup
 * sweep must remove them while re-writing its own manifest, and the extension's
 * chrome must still come up.
 *
 * Usage: node test/e2e/core/manifest-lifecycle-e2e.mjs [--firefox <bin>]
 * [--snapshot <dir>] [--headless] [--keep-profile]
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  launchFirefox,
  attachProcessLogging,
  check,
  createCounter,
  tempDir,
  rmDir,
  summary,
} from '../shared/helpers.mjs';
import {
  findSnapshot,
  findZip,
  extractZip,
  discoverFirefoxBinary,
  findGreDir,
} from '../shared/browsers.mjs';

const EXT_ID = 'testext@example.com';
const CHROME_PROBE = 'chrome://testext/content/test.html';
const BED_REL = path.join('browser-extension-data', EXT_ID);
const PROBE_TICKS = 12; // 1 s interval after the T+0 sample
const PROBE_OK_DEADLINE = 60_000;

// ── Test legacy extension (unpacked, bootstrap) ────────────────────────────

const EXT_INSTALL_RDF = `<?xml version="1.0"?>
<RDF xmlns="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
     xmlns:em="http://www.mozilla.org/2004/em-rdf#">
  <Description about="urn:mozilla:install-manifest">
    <em:id>${EXT_ID}</em:id>
    <em:type>2</em:type>
    <em:name>Test Ext</em:name>
    <em:version>1.0</em:version>
    <em:bootstrap>true</em:bootstrap>
    <em:unpack>true</em:unpack>
    <em:targetApplication>
      <Description>
        <em:id>{ec8030f7-c20a-464f-9b0e-13a3a9e97384}</em:id>
        <em:minVersion>100.0</em:minVersion>
        <em:maxVersion>200.0</em:maxVersion>
      </Description>
    </em:targetApplication>
  </Description>
</RDF>
`;

const EXT_CHROME_MANIFEST = 'content testext content/\n';

const EXT_TEST_HTML = `<!DOCTYPE html>
<html>
<head><title>TESTEXT-CHROME-OK</title></head>
<body>testext chrome content loaded</body>
</html>
`;

const EXT_BOOTSTRAP_JS = `'use strict';
// Test extension lifecycle logger: appends one line per event to
// <ProfD>/ext-lifecycle.log so the harness can prove the extension started
// and shut down in every session.
const Services = globalThis.Services;
function log(msg) {
  try {
    const f = Services.dirsvc.get('ProfD', Ci.nsIFile);
    f.append('ext-lifecycle.log');
    const fos = Cc['@mozilla.org/network/file-output-stream;1'].createInstance(
      Ci.nsIFileOutputStream
    );
    fos.init(f, 0x02 | 0x08 | 0x10, -1, 0); // write | create | append
    const line = new Date().toISOString() + ' ' + msg + '\\n';
    fos.write(line, line.length);
    fos.close();
  } catch (e) {}
}
function startup(data, reason) { log('startup reason=' + reason); }
function shutdown(data, reason) { log('shutdown reason=' + reason); }
function install(data, reason) { log('install reason=' + reason); }
function uninstall(data, reason) { log('uninstall reason=' + reason); }
`;

// ── GreD probe (appended to config.js) ─────────────────────────────────────

const GRE_PROBE = `
// [manifest-lifecycle-e2e probe] check whether the test extension's chrome
// package is resolvable+readable, immediately and on a repeating timer.
try {
  const _probe = {
    run() {
      let result;
      try {
        const uri = Services.io.newURI('${CHROME_PROBE}');
        const channel = Services.io.newChannelFromURI(
          uri, null, Services.scriptSecurityManager.getSystemPrincipal(), null,
          Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL,
          Ci.nsIContentPolicy.TYPE_OTHER
        );
        const input = channel.open();
        const strm = Cc['@mozilla.org/scriptableinputstream;1'].createInstance(
          Ci.nsIScriptableInputStream
        );
        strm.init(input);
        const data = strm.read(4096);
        strm.close();
        input.close();
        result = 'OK ' + (data.slice(0, 24) || '(empty)').replace(/\\s+/g, ' ');
      } catch (e) {
        result = 'ERR ' + (e && e.name || '?') + ':' + String(e && e.message || '').slice(0, 60);
      }
      const t = Services.telemetry ? Services.telemetry.msSinceProcessStart() : Date.now();
      const f = Services.dirsvc.get('ProfD', Ci.nsIFile);
      f.append('chrome-probe.log');
      const fos = Cc['@mozilla.org/network/file-output-stream;1'].createInstance(
        Ci.nsIFileOutputStream
      );
      fos.init(f, 0x02 | 0x08 | 0x10, -1, 0);
      const line = 'T+' + Math.round(t) + 'ms ${CHROME_PROBE} => ' + result + '\\n';
      fos.write(line, line.length);
      fos.close();
    },
  };
  _probe.run();
  let _ticks = 0;
  const _timer = Cc['@mozilla.org/timer;1'].createInstance(Ci.nsITimer);
  _timer.initWithCallback(
    {
      notify() {
        if (++_ticks <= ${PROBE_TICKS}) _probe.run();
        else _timer.cancel();
      },
    },
    1000,
    Ci.nsITimer.TYPE_REPEATING_SLACK
  );
} catch (e) {}
// [manifest-lifecycle-e2e probe end]
`;

// ── Args ───────────────────────────────────────────────────────────────────

function parseArgs() {
  // pnpm run forwards a literal `--` separator argument; skip it so both
  // `pnpm test:e2e:legacy -- --headless` and direct `node … --headless` work.
  const args = process.argv.slice(2).filter(a => a !== '--');
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--firefox' && args[i + 1]) opts.firefox = args[++i];
    else if (args[i] === '--snapshot' && args[i + 1]) opts.snapshot = args[++i];
    else if (args[i] === '--headless') opts.headless = true;
    else if (args[i] === '--keep-profile') opts.keepProfile = true;
    else if (args[i] === '--help') {
      console.log(`Usage: node test/e2e/core/manifest-lifecycle-e2e.mjs
  [--firefox <bin>] [--snapshot <dir>] [--headless] [--keep-profile]`);
      process.exit(0);
    }
  }
  return opts;
}

// ── GreD helpers ───────────────────────────────────────────────────────────

function saveGreState(greDir) {
  const saved = {};
  for (const rel of ['config.js', 'defaults/pref/config-prefs.js']) {
    const p = path.join(greDir, ...rel.split('/'));
    saved[p] = fs.existsSync(p) ? fs.readFileSync(p) : null;
  }
  return saved;
}

function restoreGreState(saved) {
  const errors = [];
  for (const [p, data] of Object.entries(saved)) {
    try {
      if (data !== null) {
        fs.mkdirSync(path.dirname(p), {recursive: true});
        fs.writeFileSync(p, data);
      } else {
        try {
          fs.unlinkSync(p);
        } catch (err) {
          if (err.code !== 'ENOENT') throw err;
        }
        const dir = path.dirname(p);
        try {
          if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
        } catch (err) {
          if (err.code !== 'ENOENT' && err.code !== 'ENOTEMPTY') throw err;
        }
      }
    } catch (err) {
      errors.push(`${p}: ${err.message}`);
    }
  }
  return errors;
}

/** Seed fx-folder config.js + config-prefs.js into GreD, then append the probe. */
function seedGre(greDir, snapshotDir) {
  const fxZip = findZip(snapshotDir, ['fx-folder-dev.zip', 'fx-folder.zip']);
  if (!fxZip) return `no fx-folder zip in ${snapshotDir}`;
  const staging = tempDir('fxs-fx');
  try {
    extractZip(fxZip, staging);
    const base = path.join(staging, 'fx-folder');
    for (const rel of ['config.js', 'defaults/pref/config-prefs.js']) {
      const src = path.join(base, ...rel.split('/'));
      const dst = path.join(greDir, ...rel.split('/'));
      if (!fs.existsSync(src)) return `${rel} missing from ${path.basename(fxZip)}`;
      try {
        fs.mkdirSync(path.dirname(dst), {recursive: true});
        fs.writeFileSync(dst, fs.readFileSync(src));
      } catch (err) {
        return `cannot write ${dst}: ${err.message}`;
      }
    }
    try {
      fs.appendFileSync(path.join(greDir, 'config.js'), GRE_PROBE);
    } catch (err) {
      return `cannot append probe to ${path.join(greDir, 'config.js')}: ${err.message}`;
    }
    return null;
  } finally {
    rmDir(staging);
  }
}

// ── Profile seeding ────────────────────────────────────────────────────────

/**
 * Fresh profile with the test extension + stale-manifest litter, utils
 * extracted verbatim from the snapshot.
 */
function seedProfile(snapshotDir) {
  const profileDir = tempDir('fxs-legacy');
  fs.mkdirSync(profileDir, {recursive: true});

  // utils → chrome/utils (shipped loader, no source patching)
  const utilsZip = findZip(snapshotDir, ['utils-dev.zip', 'utils.zip']);
  if (!utilsZip) throw new Error(`no utils zip in ${snapshotDir}`);
  const chromeUtils = path.join(profileDir, 'chrome', 'utils');
  extractZip(utilsZip, chromeUtils);

  // browser-extension-data/<id> — pre-created, seeded with crash litter:
  // two uuid-named temp manifests (what a uuid-named loader variant leaves
  // behind when killed) and a 0-byte chrome.manifest (the shipped loader's
  // own truncate-then-remove can be interrupted the same way).
  const bedDir = path.join(profileDir, BED_REL);
  fs.mkdirSync(bedDir, {recursive: true});
  const litter = [
    ['chrome.manifest.e1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e', EXT_CHROME_MANIFEST],
    ['chrome.manifest.a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d', ''],
    ['chrome.manifest', ''],
  ];
  for (const [name, data] of litter) {
    fs.writeFileSync(path.join(bedDir, name), data);
  }

  // test legacy extension → profile/extensions/<id>/
  const extDir = path.join(profileDir, 'extensions', EXT_ID);
  fs.mkdirSync(path.join(extDir, 'content'), {recursive: true});
  fs.writeFileSync(path.join(extDir, 'install.rdf'), EXT_INSTALL_RDF);
  fs.writeFileSync(path.join(extDir, 'chrome.manifest'), EXT_CHROME_MANIFEST);
  fs.writeFileSync(path.join(extDir, 'bootstrap.js'), EXT_BOOTSTRAP_JS);
  fs.writeFileSync(path.join(extDir, 'content', 'test.html'), EXT_TEST_HTML);

  const prefs = {
    // silence the in-browser updater (not the subject of this test); the
    // probe modifies GreD config.js, which would otherwise look like a stale
    // fx-folder to the daily check
    'extensions.firefox-scripts.lastScriptsCheckDate': today(),
    'extensions.firefox-scripts.lastUpdateTabShown': today(),
    // keep the session quiet
    'app.update.disabledForTesting': true,
    'app.update.auto': false,
    'browser.shell.checkDefaultBrowser': false,
    'datareporting.policy.dataSubmissionEnabled': false,
    'extensions.autoDisableScopes': 0,
  };
  return {profileDir, prefs, bedDir};
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// ── Probe / lifecycle log readers ──────────────────────────────────────────

function probeChunk(profileDir, byteOffset) {
  const logPath = path.join(profileDir, 'chrome-probe.log');
  if (!fs.existsSync(logPath)) return {size: 0, chunk: ''};
  const size = fs.statSync(logPath).size;
  return {size, chunk: fs.readFileSync(logPath, 'utf-8').slice(byteOffset)};
}

function countLifeLines(profileDir) {
  const p = path.join(profileDir, 'ext-lifecycle.log');
  if (!fs.existsSync(p)) return 0;
  return fs
    .readFileSync(p, 'utf-8')
    .split('\n')
    .filter(l => l.trim()).length;
}

function bedFiles(bedDir) {
  try {
    return fs.readdirSync(bedDir).sort();
  } catch {
    return [];
  }
}

// ── Session runner ─────────────────────────────────────────────────────────

async function runSession(firefoxBin, profileDir, prefs, label, sessionNo, opts) {
  console.log(`\n  --- ${label}: session ${sessionNo} ---`);
  const beforeProbe =
    fs.existsSync(path.join(profileDir, 'chrome-probe.log')) ?
      fs.statSync(path.join(profileDir, 'chrome-probe.log')).size
    : 0;
  const beforeLife = countLifeLines(profileDir);

  let browser;
  try {
    browser = await launchFirefox(firefoxBin, profileDir, {
      headless: opts.headless,
      extraPrefsFirefox: prefs,
    });
    attachProcessLogging(browser, label);

    // Wait for the first probe OK — the loader registers the extension's
    // chrome within a couple of seconds of startup.
    const deadline = Date.now() + PROBE_OK_DEADLINE;
    let okSeen = false;
    while (Date.now() < deadline) {
      const {chunk} = probeChunk(profileDir, beforeProbe);
      if (chunk.includes('=> OK')) {
        okSeen = true;
        break;
      }
      await new Promise(r => setTimeout(r, 500));
    }
    if (!okSeen) {
      console.log(`  [${label}] no probe OK within ${PROBE_OK_DEADLINE / 1000}s`);
    }

    // Hold the session up a few more seconds so the probe's repeating timer
    // keeps sampling — proves the registration stays live, not a one-off.
    await new Promise(r => setTimeout(r, 5_000));
  } catch (err) {
    console.log(`  [${label}] launch/run error: ${err.message}`);
  } finally {
    try {
      await browser?.close();
    } catch {
      /* ignore */
    }
    await new Promise(r => setTimeout(r, 3_000));
  }

  const {size, chunk} = probeChunk(profileDir, beforeProbe);
  const newLines = chunk.split('\n').filter(l => l.trim());
  const okCount = newLines.filter(l => l.includes('=> OK')).length;
  const errCount = newLines.filter(l => l.includes('=> ERR')).length;
  // ERR samples before the first OK are the pre-registration window (the T+0
  // probe fires before the loader has run) — only a fallback AFTER the first
  // OK indicates a real liveness break.
  const firstOk = newLines.findIndex(l => l.includes('=> OK'));
  const trailingErr =
    firstOk < 0 ? errCount : newLines.slice(firstOk).filter(l => l.includes('=> ERR')).length;
  console.log(
    `  [${label}] probe this session: ${newLines.length} samples, ${okCount} OK, ${errCount} ERR (${trailingErr} after first OK)`
  );
  for (const line of newLines.slice(0, 3)) console.log(`      ${line}`);

  const lifeDelta = countLifeLines(profileDir) - beforeLife;
  console.log(`  [${label}] extension lifecycle events this session: ${lifeDelta}`);
  console.log(
    `  [${label}] browser-extension-data: ${JSON.stringify(bedFiles(path.join(profileDir, BED_REL)))}`
  );

  return {okCount, errCount, trailingErr, lifeDelta, probeSize: size};
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();
  const counter = createCounter();
  const firefoxBin = opts.firefox || discoverFirefoxBinary();
  if (!firefoxBin) {
    console.error('Firefox binary not found — pass --firefox <path>');
    process.exit(1);
  }
  const snapshotDir = opts.snapshot || findSnapshot({branchCheck: false})?.dir;
  if (!snapshotDir) {
    console.error(
      'No snapshot found in dist/ — pass --snapshot <dir> or run pnpm upload:local --mode=dev'
    );
    process.exit(1);
  }
  const greDir = findGreDir(firefoxBin);
  console.log(`Firefox:  ${firefoxBin}`);
  console.log(`GreD:     ${greDir}`);
  console.log(`Snapshot: ${snapshotDir}`);

  // GreD seeding must succeed or every later assertion misfires — report it
  // as its own failed check and stop (mirrors updater-e2e.mjs).
  const savedGre = saveGreState(greDir);
  const seedErr = (() => {
    try {
      return seedGre(greDir, snapshotDir);
    } catch (err) {
      return err.message;
    }
  })();
  check(counter, !seedErr, 'seed GreD (config.js + probe)', seedErr || '');
  if (seedErr) {
    // Restore the installation dir before exiting — a partial seed must not
    // leave the Firefox install modified (the finally below does not run).
    for (const error of restoreGreState(savedGre)) {
      check(counter, false, 'GreD configuration restored (after seed failure)', error);
    }
    console.log(
      'GreD not writable? Pass a writable Firefox install (portable/tarball) or run elevated.'
    );
    process.exit(1);
  }

  const profiles = [];
  try {
    const seeded = seedProfile(snapshotDir);
    profiles.push(seeded.profileDir);
    const {profileDir, prefs, bedDir} = seeded;

    const preLitter = bedFiles(bedDir);
    console.log(`\nseeded browser-extension-data litter: ${JSON.stringify(preLitter)}`);
    check(
      counter,
      preLitter.length === 3,
      'crash litter seeded (2 uuid manifests + 0-byte chrome.manifest)',
      JSON.stringify(preLitter)
    );

    // ── S1: fresh profile ──
    // The very first probe sample (T+0, before the loader runs) is expected to
    // be ERR — what matters is that chrome comes up and STAYS up: no ERR after
    // the first OK.
    const s1 = await runSession(firefoxBin, profileDir, prefs, 'manifest-lifecycle', 1, opts);
    check(counter, s1.okCount > 0, 'S1 fresh: chrome live (probe OK)');
    check(
      counter,
      s1.trailingErr === 0,
      'S1 fresh: chrome stays live after the first OK (no trailing ERR)',
      `${s1.okCount} OK / ${s1.errCount} ERR`
    );
    check(counter, s1.lifeDelta > 0, 'S1 fresh: extension started (lifecycle log)');

    // ── sweep assertions (post S1) ──
    const afterS1 = bedFiles(bedDir);
    check(
      counter,
      !afterS1.some(f => f.startsWith('chrome.manifest.')),
      'startup sweep removed stale uuid manifests',
      JSON.stringify(afterS1)
    );
    const canonical = path.join(bedDir, 'chrome.manifest');
    // The loader absolutizes manifest paths, so the rewritten file reads
    // `content testext file:///…/extensions/testext@example.com/content/` —
    // size + the package registration line prove it is the real rewrite, not
    // an empty leftover.
    const canonicalContent = fs.existsSync(canonical) ? fs.readFileSync(canonical, 'utf-8') : '';
    const canonicalOk =
      afterS1.length === 1 &&
      afterS1[0] === 'chrome.manifest' &&
      canonicalContent.length > 0 &&
      canonicalContent.includes('content testext ');
    check(
      counter,
      canonicalOk,
      'loader re-wrote its own chrome.manifest (fixed name, real content)',
      JSON.stringify(afterS1)
    );

    // ── S2: plain restart ──
    const s2 = await runSession(firefoxBin, profileDir, prefs, 'manifest-lifecycle', 2, opts);
    check(counter, s2.okCount > 0, 'S2 restart: chrome live (probe OK)');
    check(
      counter,
      s2.trailingErr === 0,
      'S2 restart: chrome stays live after the first OK (no trailing ERR)',
      `${s2.okCount} OK / ${s2.errCount} ERR`
    );
    check(counter, s2.lifeDelta > 0, 'S2 restart: extension started again');
    check(
      counter,
      bedFiles(bedDir).length === 1 && bedFiles(bedDir)[0] === 'chrome.manifest',
      'S2 restart: no manifest litter after clean close',
      JSON.stringify(bedFiles(bedDir))
    );

    // ── S3: restart after clearing the startup cache ──
    for (const rel of ['startupCache', 'cache2']) {
      const p = path.join(profileDir, rel);
      if (fs.existsSync(p)) fs.rmSync(p, {recursive: true, force: true});
    }
    const s3 = await runSession(firefoxBin, profileDir, prefs, 'manifest-lifecycle', 3, opts);
    check(counter, s3.okCount > 0, 'S3 cache-clear restart: chrome live (probe OK)');
    check(
      counter,
      s3.trailingErr === 0,
      'S3 cache-clear restart: chrome stays live after the first OK (no trailing ERR)',
      `${s3.okCount} OK / ${s3.errCount} ERR`
    );
    check(counter, s3.lifeDelta > 0, 'S3 restart: extension started again');
    check(
      counter,
      bedFiles(bedDir).length === 1 && bedFiles(bedDir)[0] === 'chrome.manifest',
      'S3 cache-clear restart: no manifest litter',
      JSON.stringify(bedFiles(bedDir))
    );
  } finally {
    if (!opts.keepProfile) {
      for (const p of profiles) if (p) rmDir(p);
    }
    for (const error of restoreGreState(savedGre)) {
      check(counter, false, 'GreD configuration restored', error);
    }
  }

  if (!summary(counter)) process.exitCode = 1;
}

main().catch(err => {
  console.error('manifest-lifecycle E2E failed:', err);
  process.exit(1);
});
