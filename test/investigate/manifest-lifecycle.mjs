#!/usr/bin/env node
/**
 * Investigation harness for onemen/firefox-scripts discussion #101.
 *
 * Compares 4 loader variants for how their temporarily-registered chrome
 * manifest survives (or breaks) across Firefox sessions:
 *
 * repo — current core/chrome/utils/BootstrapLoader.js (fixed name
 * chrome.manifest, immediate checkForNewChrome, manual remove on non-shutdown)
 * discussion — the loader pasted in discussion #101 (UUID name,
 * deleteTemporaryFileOnExit, NO immediate checkForNewChrome) discussion+cfnc —
 * discussion variant + immediate checkForNewChrome uuid-manual — UUID name, no
 * immediate checkForNewChrome, manual cleanup instead of
 * deleteTemporaryFileOnExit
 *
 * Each variant runs 3 sessions on the SAME profile: S1 fresh profile launch, S2
 * plain restart, S3 restart after clearing the startup cache (simulates "clear
 * cache and restart").
 *
 * A probe appended to GreD config.js tries to READ
 * chrome://testext/content/test.html at T+0 and every 5 s (8 ticks) and logs
 * OK/ERR to <ProfD>/chrome-probe.log — the signal for whether the legacy
 * extension's chrome registration is live.
 *
 * --delay=<ms>: wraps createManifestTemporarily so the extension's manifest is
 * registered LATE, past the platform's addon-startup chrome re-scan, to expose
 * the 'addon startup late' race: with no immediate checkForNewChrome (the
 * discussion variant) a late registration may never get re-scanned, leaving the
 * extension's chrome dead for the whole session.
 *
 * Usage: node test/investigate/manifest-lifecycle.mjs --variant <name> node
 * test/investigate/manifest-lifecycle.mjs --all node
 * test/investigate/manifest-lifecycle.mjs --variant repo --delay=30000
 * --sessions=1
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  REPO_ROOT,
  launchFirefox,
  attachProcessLogging,
  tempDir,
  rmDir,
} from '../e2e/shared/helpers.mjs';
import {findZip, extractZip, findGreDir} from '../e2e/shared/browsers.mjs';

// ── Config ─────────────────────────────────────────────────────────────────

const FIREFOX_BIN = 'C:/code/TabMixPlus-Hub/ff-portable/core/firefox.exe';
const GRE_DIR = findGreDir(FIREFOX_BIN);
const SNAPSHOT_DIR = path.join(REPO_ROOT, 'dist', 'dev-postv1-manifest-lifecycle-e2e-70951d3');

const EXT_ID = 'testext@example.com';
const EXT_DIR_NAME = `${EXT_ID}`;
const CHROME_PROBE = 'chrome://testext/content/test.html';

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

const EXT_CHROME_MANIFEST = `content testext content/
`;

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

function greProbeSource(ticks) {
  return `
// [fxs-investigate probe] check whether the test extension's chrome package
// is resolvable+readable, immediately and on a repeating timer.
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
        if (++_ticks <= ${ticks}) _probe.run();
        else _timer.cancel();
      },
    },
    1000,
    Ci.nsITimer.TYPE_REPEATING_SLACK
  );
} catch (e) {}
// [fxs-investigate probe end]
`;
}

// ── Loader variants ────────────────────────────────────────────────────────

function variantLoaderSource(variant, delayMs = 0) {
  const src = fs.readFileSync(
    path.join(REPO_ROOT, 'core', 'chrome', 'utils', 'BootstrapLoader.js'),
    'utf-8'
  );

  let out;
  if (variant === 'repo') {
    out = src;
  } else {
    const start = src.indexOf('function createManifestTemporarily');
    const end = src.indexOf('\n    return {', start);
    if (start < 0 || end < 0)
      throw new Error(`cannot locate createManifestTemporarily (${variant})`);
    const head = src.slice(0, start);
    const tail = src.slice(end); // starts with '\n    return {'

    const cfnc =
      "      Cc['@mozilla.org/chrome/chrome-registry;1']\n" +
      '        .getService(Ci.nsIXULChromeRegistry)\n' +
      '        .checkForNewChrome();\n';

    const body = [];
    body.push('    function createManifestTemporarily(manifestText) {');
    body.push('      const tempFile = tempDir.clone();');
    body.push('      tempFile.append(`chrome.manifest.${Services.uuid.generateUUID()}`);');
    body.push(
      "      const foStream = Cc['@mozilla.org/network/file-output-stream;1'].createInstance("
    );
    body.push('        Ci.nsIFileOutputStream');
    body.push('      );');
    body.push(
      '      foStream.init(tempFile, 0x02 | 0x08 | 0x20, 0o664, 0); // write, create, truncate'
    );
    body.push('      foStream.write(manifestText, manifestText.length);');
    body.push('      foStream.close();');
    body.push(
      '      Components.manager.QueryInterface(Ci.nsIComponentRegistrar).autoRegister(tempFile);'
    );
    if (variant === 'discussion+cfnc') body.push(cfnc.replace(/\n$/, ''));
    if (variant !== 'uuid-manual') {
      body.push("      Cc['@mozilla.org/uriloader/external-helper-app-service;1']");
      body.push('        .getService(Ci.nsPIExternalAppLauncher)');
      body.push('        .deleteTemporaryFileOnExit(tempFile);');
    }
    body.push('      return function () {');
    body.push('        tempFile.fileSize = 0; // truncate the manifest');
    body.push("        Cc['@mozilla.org/chrome/chrome-registry;1']");
    body.push('          .getService(Ci.nsIXULChromeRegistry)');
    body.push('          .checkForNewChrome();');
    if (variant === 'uuid-manual') body.push('        tempFile.remove(false);');
    body.push('      };');
    body.push('    }');
    out = head + body.join('\n') + tail;
  }

  if (delayMs > 0) {
    const fStart = out.indexOf('function createManifestTemporarily');
    const fEnd = out.indexOf('\n    return {', fStart);
    if (fStart < 0 || fEnd < 0)
      throw new Error(`cannot locate createManifestTemporarily for delay wrap (${variant})`);
    const fnDecl = out.slice(fStart, fEnd).trim();
    const wrapper =
      `    const createManifestTemporarilySync = ${fnDecl};\n` +
      "    // Race probe: register the manifest LATE, past the platform's\n" +
      "    // addon-startup chrome re-scan, to expose the 'addon startup late'\n" +
      '    // failure mode the discussion variant risks.\n' +
      '    function createManifestTemporarily(manifestText) {\n' +
      '      let cleanup = null;\n' +
      // The cleanup closure below closes over the timer, keeping it alive
      // until it fires — an unreferenced nsITimer is released (and never
      // fires) the moment this function returns.
      "      const timer = Cc['@mozilla.org/timer;1'].createInstance(Ci.nsITimer);\n" +
      '      timer.initWithCallback(\n' +
      '        {\n' +
      '          notify() {\n' +
      '            cleanup = createManifestTemporarilySync(manifestText);\n' +
      '          },\n' +
      '        },\n' +
      `        ${delayMs},\n` +
      '        Ci.nsITimer.TYPE_ONE_SHOT\n' +
      '      );\n' +
      '      return function () {\n' +
      '        timer.cancel(); // pending registration not needed anymore\n' +
      '        if (cleanup) cleanup();\n' +
      '      };\n' +
      '    }\n';
    out = out.slice(0, fStart) + wrapper + out.slice(fEnd);
  }

  return out;
}

// ── Seed helpers ───────────────────────────────────────────────────────────

function seedProfile(snapshotDir, variant, delayMs = 0) {
  const profileDir = tempDir('fxs-101');
  fs.mkdirSync(profileDir, {recursive: true});

  // utils → chrome/utils
  const utilsZip = findZip(snapshotDir, ['utils-dev.zip', 'utils.zip']);
  if (!utilsZip) throw new Error('no utils zip in snapshot');
  const chromeUtils = path.join(profileDir, 'chrome', 'utils');
  extractZip(utilsZip, chromeUtils);
  // replace BootstrapLoader.js with the variant under test
  fs.writeFileSync(
    path.join(chromeUtils, 'BootstrapLoader.js'),
    variantLoaderSource(variant, delayMs)
  );

  // pre-create the dir the loader writes its temp manifest into
  const bed = path.join(profileDir, 'browser-extension-data', EXT_DIR_NAME);
  fs.mkdirSync(bed, {recursive: true});

  // test legacy extension → profile/extensions/<id>/
  const extDir = path.join(profileDir, 'extensions', EXT_DIR_NAME);
  fs.mkdirSync(path.join(extDir, 'content'), {recursive: true});
  fs.writeFileSync(path.join(extDir, 'install.rdf'), EXT_INSTALL_RDF);
  fs.writeFileSync(path.join(extDir, 'chrome.manifest'), EXT_CHROME_MANIFEST);
  fs.writeFileSync(path.join(extDir, 'bootstrap.js'), EXT_BOOTSTRAP_JS);
  fs.writeFileSync(path.join(extDir, 'content', 'test.html'), EXT_TEST_HTML);

  const prefs = {
    // silence the in-browser updater (not the subject of this test)
    'extensions.firefox-scripts.lastScriptsCheckDate': today(),
    'extensions.firefox-scripts.lastUpdateTabShown': today(),
    // keep the session quiet
    'app.update.disabledForTesting': true,
    'app.update.auto': false,
    'browser.shell.checkDefaultBrowser': false,
    'datareporting.policy.dataSubmissionEnabled': false,
    'extensions.autoDisableScopes': 0,
  };
  return {profileDir, chromeUtils, prefs};
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function seedGre(greDir, ticks) {
  const fxZip = findZip(SNAPSHOT_DIR, ['fx-folder-dev.zip', 'fx-folder.zip']);
  if (!fxZip) throw new Error('no fx-folder zip in snapshot');
  const staging = tempDir('fxs-fx');
  try {
    extractZip(fxZip, staging);
    const base = path.join(staging, 'fx-folder');
    for (const rel of ['config.js', 'defaults/pref/config-prefs.js']) {
      const src = path.join(base, ...rel.split('/'));
      const dst = path.join(greDir, ...rel.split('/'));
      if (!fs.existsSync(src)) throw new Error(`${rel} missing from fx-folder zip`);
      fs.mkdirSync(path.dirname(dst), {recursive: true});
      fs.writeFileSync(dst, fs.readFileSync(src));
    }
    fs.appendFileSync(path.join(greDir, 'config.js'), greProbeSource(ticks));
  } finally {
    rmDir(staging);
  }
}

function saveGreState(greDir) {
  const saved = {};
  for (const rel of ['config.js', 'defaults/pref/config-prefs.js']) {
    const p = path.join(greDir, ...rel.split('/'));
    saved[p] = fs.existsSync(p) ? fs.readFileSync(p) : null;
  }
  return saved;
}

function restoreGreState(saved) {
  for (const [p, data] of Object.entries(saved)) {
    if (data !== null) {
      fs.mkdirSync(path.dirname(p), {recursive: true});
      fs.writeFileSync(p, data);
    } else {
      try {
        fs.unlinkSync(p);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    }
  }
}

// ── Session helpers ────────────────────────────────────────────────────────

async function runSession(
  firefoxBin,
  profileDir,
  prefs,
  label,
  sessionNo,
  closeMode = 'clean',
  holdMs = 18_000
) {
  console.log(`\n  --- ${label}: session ${sessionNo} (close=${closeMode}, hold=${holdMs}ms) ---`);
  const logPath = path.join(profileDir, 'chrome-probe.log');
  const before = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;

  let browser;
  try {
    browser = await launchFirefox(firefoxBin, profileDir, {
      headless: true,
      extraPrefsFirefox: prefs,
    });
    attachProcessLogging(browser, label);
    // wait for the first page (window up), then let the probe timer run its ticks
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      try {
        if ((await browser.pages()).length > 0) break;
      } catch {
        /* not ready */
      }
      await new Promise(r => setTimeout(r, 250));
    }
    await new Promise(r => setTimeout(r, holdMs));
  } catch (err) {
    console.log(`  [${label}] launch/run error: ${err.message}`);
  } finally {
    if (browser) {
      if (closeMode === 'kill') {
        try {
          browser.process()?.kill('SIGKILL');
          console.log(`  [${label}] KILLED (unclean)`);
        } catch (err) {
          console.log(`  [${label}] kill failed: ${err.message}`);
        }
        await new Promise(r => setTimeout(r, 4_000));
      } else {
        try {
          await browser.close();
        } catch {
          /* ignore */
        }
        await new Promise(r => setTimeout(r, 3_000));
      }
    }
  }

  // collect probe lines added during this session (byte-offset slice, so
  // identical lines across sessions are not filtered)
  const newChunk = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8').slice(before) : '';
  const newLines = newChunk.split('\n').filter(l => l.trim());
  console.log(`  [${label}] probe (${newLines.length} new):`);
  for (const line of newLines) console.log(`      ${line}`);

  // what temp manifest files survive after close?
  const bedDir = path.join(profileDir, 'browser-extension-data', EXT_DIR_NAME);
  let files = [];
  try {
    files = fs.readdirSync(bedDir);
  } catch {
    /* bed dir may be missing */
  }
  console.log(`  [${label}] browser-extension-data after close: ${JSON.stringify(files)}`);

  // extension lifecycle
  const life = path.join(profileDir, 'ext-lifecycle.log');
  if (fs.existsSync(life)) {
    const lines = fs.readFileSync(life, 'utf-8').trimEnd().split('\n');
    console.log(`  [${label}] ext lifecycle (${lines.length}): ${lines.slice(-4).join(' | ')}`);
  } else {
    console.log(`  [${label}] ext lifecycle: NO LOG — extension never started`);
  }
}

function clearStartupCache(profileDir) {
  for (const rel of ['startupCache', 'cache2']) {
    const p = path.join(profileDir, rel);
    if (fs.existsSync(p)) {
      fs.rmSync(p, {recursive: true, force: true});
      console.log(`  [cache-clear] removed ${rel}`);
    }
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

const VARIANTS = {
  'repo': 'repo — current loader (control)',
  'discussion': 'discussion — UUID + deleteTemporaryFileOnExit, no immediate checkForNewChrome',
  'discussion+cfnc': 'discussion + immediate checkForNewChrome',
  'uuid-manual': 'UUID + no immediate checkForNewChrome + manual cleanup',
};

async function main() {
  const args = process.argv.slice(2);
  const variantArg = args.find(a => a.startsWith('--variant='))?.split('=')[1];
  const doAll = args.includes('--all');
  const crash = args.includes('--crash');
  const delayMs = Number(args.find(a => a.startsWith('--delay='))?.split('=')[1]) || 0;
  const nSessions = Number(args.find(a => a.startsWith('--sessions='))?.split('=')[1]) || 3;
  const variants = doAll ? Object.keys(VARIANTS) : [variantArg || 'repo'];
  if (variants.some(v => !VARIANTS[v])) {
    console.error(`Unknown variant. Choose from: ${Object.keys(VARIANTS).join(', ')}`);
    process.exit(1);
  }

  // With a delay the probe must keep sampling past the late registration.
  const probeTicks = delayMs > 0 ? Math.ceil(delayMs / 1000) + 10 : 12;
  const holdMs = delayMs > 0 ? delayMs + 25_000 : 18_000;

  console.log(`Firefox: ${FIREFOX_BIN}\nGreD:    ${GRE_DIR}\nSnapshot: ${SNAPSHOT_DIR}`);
  console.log(
    `utils zip: ${findZip(SNAPSHOT_DIR, ['utils-dev.zip', 'utils.zip']) ? 'ok' : 'MISSING'}`
  );
  console.log(`delay=${delayMs}ms sessions=${nSessions} probeTicks=${probeTicks}`);

  const savedGre = saveGreState(GRE_DIR);
  try {
    seedGre(GRE_DIR, probeTicks);
    console.log('GreD seeded (config.js + probe).');

    for (const variant of variants) {
      console.log(`\n${'='.repeat(72)}`);
      console.log(`VARIANT: ${variant} — ${VARIANTS[variant]}`);
      console.log('='.repeat(72));
      const seeded = seedProfile(SNAPSHOT_DIR, variant, delayMs);
      console.log(`profile: ${seeded.profileDir}`);

      for (let s = 1; s <= nSessions; s++) {
        const closeMode = crash && s === 2 ? 'kill' : 'clean';
        await runSession(
          FIREFOX_BIN,
          seeded.profileDir,
          seeded.prefs,
          variant,
          s,
          closeMode,
          holdMs
        );
        if (crash && s === 2) {
          // after the unclean exit: are uuid manifests left behind?
          const bedDir = path.join(seeded.profileDir, 'browser-extension-data', EXT_DIR_NAME);
          try {
            console.log(
              `  [${variant}] browser-extension-data after KILL: ${JSON.stringify(fs.readdirSync(bedDir))}`
            );
          } catch {
            /* bed dir may be missing */
          }
        }
        if (s === 2 && nSessions >= 3) clearStartupCache(seeded.profileDir);
      }

      if (process.env.FXS_KEEP_PROFILES !== '1') rmDir(seeded.profileDir);
      else console.log(`profile kept: ${seeded.profileDir}`);
    }
  } finally {
    restoreGreState(savedGre);
  }
  console.log('\nDone.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
