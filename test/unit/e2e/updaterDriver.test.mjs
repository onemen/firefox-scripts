// test/unit/e2e/updaterDriver.test.mjs — the #309 updater-E2E driver harness.
//
// What is pinned here (all of it is coupling that would fail silently at
// runtime, inside a browser, on a runner):
//
//   - the driver page lands where chrome.manifest actually serves chrome://
//     content from (`content firefox-scripts <dir>` in the utils package), so
//     DRIVER_URL resolves — a wrong directory would just render an error page,
//     and the session would fall back to "driver mode unavailable";
//   - the driver's updater URL is EXACTLY the URI the scheduler's tab scan and
//     the tab engine's twin guard compare against (equality, not prefix): one
//     drifted character and the driver counts its own page as an updater tab,
//     or the twin guard closes the tab the harness asserts on;
//   - the driver page never ships: it is written into the seeded profile at
//     runtime, and the hashed utils file list comes from the built zip, so a
//     copy of it under core/chrome/utils would change every package hash.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  UPDATER_URL,
  DRIVER_URL,
  DRIVER_PAGE,
  DRIVER_SCRIPT,
  installDriverPage,
  driverScriptSource,
} from '../../../test/e2e/shared/updaterDriver.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const CHROME_MANIFEST = path.join(REPO_ROOT, 'core', 'chrome', 'utils', 'chrome.manifest');
const UPDATER_E2E = path.join(REPO_ROOT, 'test', 'e2e', 'updater', 'updater-e2e.mjs');
const SCHEDULER = path.join(
  REPO_ROOT,
  'core',
  'chrome',
  'utils',
  'updater',
  'scriptsUpdater.sys.mjs'
);
const TAB_ENGINE = path.join(REPO_ROOT, 'tools', 'publish', 'remote-ui', 'updater.js');

/** Every `chrome://firefox-scripts/content/...` specifier in a source file. */
function firefoxScriptsUris(source) {
  return [...source.matchAll(/'(chrome:\/\/firefox-scripts\/content\/[^']*)'/g)].map(m => m[1]);
}

test('installDriverPage writes the page into the package the manifest serves', () => {
  const chromeManifest = fs.readFileSync(CHROME_MANIFEST, 'utf-8');
  const mapping = /^content\s+firefox-scripts\s+(\S+)/m.exec(chromeManifest);
  assert.ok(mapping, 'chrome.manifest must map the firefox-scripts content package');
  const contentDir = mapping[1];

  // The chrome URL path minus the content root = the file inside the package.
  const relFromContent = DRIVER_URL.slice('chrome://firefox-scripts/content/'.length);
  assert.equal(relFromContent, DRIVER_PAGE, 'DRIVER_URL must address exactly the driver page file');

  const chromeUtils = fs.mkdtempSync(path.join(os.tmpdir(), 'fxs-driver-unit-'));
  try {
    const url = installDriverPage(chromeUtils);
    assert.equal(url, DRIVER_URL);
    const served = path.join(chromeUtils, contentDir, relFromContent);
    assert.ok(fs.existsSync(served), `driver page must land at ${served}`);
    const script = path.join(chromeUtils, contentDir, DRIVER_SCRIPT);
    assert.ok(fs.existsSync(script), `driver script must land at ${script}`);
    assert.ok(
      fs
        .readFileSync(path.join(chromeUtils, contentDir, DRIVER_PAGE), 'utf-8')
        .includes(`script src="${DRIVER_SCRIPT}"`),
      'the page must load the driver script from its own package'
    );
  } finally {
    fs.rmSync(chromeUtils, {recursive: true, force: true});
  }
});

test('the driver targets the scheduler/tab-engine updater URI exactly', () => {
  const schedulerUris = firefoxScriptsUris(fs.readFileSync(SCHEDULER, 'utf-8'));
  assert.ok(
    schedulerUris.includes(UPDATER_URL),
    "UPDATER_URL must match the scheduler's UPDATER_UI_URI (exact equality is how it scans for an open tab)"
  );
  const engineUris = firefoxScriptsUris(fs.readFileSync(TAB_ENGINE, 'utf-8'));
  assert.ok(
    engineUris.includes(UPDATER_URL),
    "UPDATER_URL must match the tab engine's URI (the twin-tab guard compares the same string)"
  );
  assert.notEqual(
    DRIVER_URL,
    UPDATER_URL,
    'the driver page must not be addressable as the updater tab'
  );

  // The driver re-imports the scheduler module the tab engine imports — same
  // specifier, hence the same per-realm module instance contract.
  const script = driverScriptSource();
  const schedulerSpecifier = 'chrome://firefox-scripts/content/scriptsUpdater.sys.mjs';
  assert.ok(
    engineUris.includes(schedulerSpecifier) && script.includes(`'${schedulerSpecifier}'`),
    'the driver must import the same scheduler module specifier as the tab engine'
  );
  assert.match(
    script,
    /async check\(\)[\s\S]*?scheduler\.checkForUpdates\(\)/,
    'check() must drive the production orchestrator (the #309 export)'
  );
});

test('driver mode never trades the stale trio away for the one-browser collapse', () => {
  const source = fs.readFileSync(UPDATER_E2E, 'utf-8');

  // The trio the session drives in-browser.
  assert.match(
    source,
    /const STALE_VARIANTS = \['utils-stale', 'config-stale', 'both-stale'\]/,
    'the trio list must exist as one shared constant'
  );

  // Where the driver realm cannot come up, the trio must still be asserted —
  // in the tab the startup check opened (the pre-#309 loop). Dropping it there
  // would pass the leg with three variants silently unchecked.
  const probeAt = source.indexOf('if (!driver) {');
  const driverReadyAt = source.indexOf('driverAvailable = true;');
  assert.ok(probeAt !== -1 && driverReadyAt > probeAt, 'the driver probe branch must exist');
  assert.match(
    source.slice(probeAt, driverReadyAt),
    /assertStaleTrioInTab\(/,
    'the driver-unavailable branch must fall back to the in-tab trio, not skip it'
  );

  // ...and the fallback must run the real card assertions, per variant.
  const trioAt = source.indexOf('async function assertStaleTrioInTab(');
  assert.ok(trioAt !== -1, 'assertStaleTrioInTab must exist');
  const trioBody = source.slice(trioAt, source.indexOf('\n}', trioAt));
  assert.match(trioBody, /for \(const variant of STALE_VARIANTS\)/);
  assert.match(trioBody, /assertStaleCard\(counter, page, variant, pageErrors\)/);
});

test('the driver page is a harness artifact, never a shipped package file', () => {
  const shipped = path.join(REPO_ROOT, 'core', 'chrome', 'utils');
  const strays = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === DRIVER_PAGE || entry.name === DRIVER_SCRIPT) strays.push(full);
    }
  };
  walk(shipped);
  assert.deepEqual(
    strays,
    [],
    'the driver page lives in the seeded profile at runtime — a copy in the utils source would change the package hash'
  );
});
