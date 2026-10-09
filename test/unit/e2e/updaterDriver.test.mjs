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
  // in the tab the startup check opened (the fallback loop). Dropping it there
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
  // Default is the whole trio; a caller may pass a subset (a mid-session realm
  // death re-asserts only the variants the dead driver never reached).
  assert.match(trioBody, /for \(const variant of variants \?\? STALE_VARIANTS\)/);
  assert.match(trioBody, /assertStaleCard\(counter, page, variant, pageErrors\)/);
});

test('state-only scenarios fold into the session, and keep their launches as fallback', () => {
  const source = fs.readFileSync(UPDATER_E2E, 'utf-8');

  // The fold itself: install-applies + manual-install-no-ui run inside the
  // variant session's browser, driven by the driver page.
  const sessionAt = source.indexOf('async function runVariantSession(');
  assert.ok(sessionAt !== -1, 'runVariantSession must exist');
  assert.match(
    source,
    /async function runSessionExtras\(/,
    'the folded state-only scenarios must live in runSessionExtras'
  );
  assert.match(
    source.slice(sessionAt),
    /await runSessionExtras\(counter, \{/,
    'the session must invoke the folded scenarios in-browser'
  );

  // Coverage never drops: the driver-unavailable path runs the folded
  // scenarios as their own launches (the fallback shape).
  const probeAt = source.indexOf('if (session.driverAvailable) {');
  assert.ok(probeAt !== -1, 'step 1 must branch on driver availability');
  // Slice to the UNAVAILABLE branch only: the degraded branch above it resumes
  // the same launches conditionally (only what the dead realm never finished).
  const unavailableAt = source.indexOf('falling back to the launch-per-scenario path', probeAt);
  assert.ok(unavailableAt !== -1, 'the launch fallback must exist');
  const fallbackBody = source.slice(
    unavailableAt,
    source.indexOf('const upToDate = await runNoTabScenario', unavailableAt)
  );
  assert.match(
    fallbackBody,
    /await runInstallAppliesScenario\(counter, opts, snapshotDir/,
    'the fallback must still run install-applies as its own launch'
  );
  assert.match(
    fallbackBody,
    /await runManualInstallNoUiScenario\(counter, opts, snapshotDir/,
    'the fallback must still run manual-install-no-ui as its own launch'
  );

  // The folded copy asserts the same ground truth the launched one did: the
  // installed trees re-hash to the manifest, and the ui comes back from the
  // manifest's own host (the #102 regression).
  assert.match(
    source,
    /install-applies: installed utils re-hashes to the manifest/,
    'the folded install-applies must assert the installed tree hash'
  );
  assert.match(
    source,
    /no-ui: ui folder auto-installed/,
    'the folded no-ui must assert the ui was re-extracted'
  );

  // The mid-session degrade: only the phases that did NOT finish are resumed
  // out-of-session — the ones that already passed must not run twice.
  const degradedBody = source.slice(probeAt, unavailableAt);
  assert.match(
    degradedBody,
    /remaining.includes\('install-applies'\)/,
    'the degraded path must resume the unfinished install-applies launch'
  );
  assert.match(
    degradedBody,
    /remaining.includes\('manual-install-no-ui'\)/,
    'the degraded path must resume the unfinished no-ui launch'
  );
  assert.match(
    degradedBody,
    /remainingVariants\.includes\('up-to-date'\)/,
    'the degraded path must resume the unfinished up-to-date launch'
  );
  assert.match(
    degradedBody,
    /remainingVariants\.includes\('skipped'\)/,
    'the degraded path must resume the unfinished skipped launch'
  );
  // A realm death between variants defers the STALE cards to their launch
  // path: the startup tab was closed before the variant loop, so there is no
  // in-tab frame to re-assert in (the session-scope `page` would be a detached
  // frame). The launch path runs every remaining variant name — coverage is
  // preserved by the launches, never by the dead session's tab.
  const sessionAt2 = source.indexOf('async function runVariantSession(');
  const sessionBody = source.slice(sessionAt2, sessionAt2 + 60000);
  assert.match(
    sessionBody,
    /const staleLeft = remainingVariants\.filter\(v => STALE_VARIANTS\.includes\(v\)\)/,
    'the session must compute the stale variants the dead realm deferred'
  );
  assert.doesNotMatch(
    sessionBody,
    /assertStaleTrioInTab\(counter, \{[\s\S]{0,200}variants: staleLeft/,
    'the session must NOT re-assert stale cards on the closed startup tab'
  );
  assert.match(
    sessionBody,
    /keep their launch path/,
    'the deferred stale variants must be reported as keeping their launch path'
  );

  // The tab-cleanup call after a completed variant must produce the degrade
  // sentinel itself: a bare driver.closeUpdaterTabs() on a dead realm rejects
  // with a raw protocol error (no .driverLost) and would abort the leg
  // instead of degrading.
  const cleanupBody = source.slice(
    source.indexOf('Leave no updater tab behind'),
    source.indexOf('async function assertStaleTrioInTab(')
  );
  assert.match(
    cleanupBody,
    /driverCall\(driver, `\$\{variant\}: close tabs`, \(\) => driver\.closeUpdaterTabs\(\)\)\.catch/,
    'the per-variant tab cleanup must be wrapped in driverCall (the sentinel producer)'
  );

  // The session prelude's driver calls are wrapped too: initScheduler and the
  // startup-tab close run before any per-variant driverCall exists to catch
  // them.
  const preludeFrom = source.indexOf('driverAvailable = true;', sessionAt2);
  const preludeTo = source.indexOf('const manifest = JSON.parse', preludeFrom);
  const preludeBody = source.slice(preludeFrom, preludeTo);
  assert.match(
    preludeBody,
    /driverCall\(driver, `\$\{attemptLabel\}: init scheduler`/,
    'the session prelude must wrap initScheduler in driverCall'
  );
  assert.match(
    preludeBody,
    /driverCall\(driver, `\$\{attemptLabel\}: close startup tabs`/,
    'the session prelude must wrap the startup-tab close in driverCall'
  );

  // Clearing the skip prefs before the folded scenarios uses the SHIPPED
  // package keys: utils and fx-folder (the config package's key is fx-folder,
  // not 'config' — addSkipPrefs and the scheduler both use it).
  const clearBody = source.slice(
    source.indexOf("'clear skip prefs'"),
    source.indexOf('await runFoldedInstallApplies')
  );
  assert.match(clearBody, /setSkip\('utils', ''\)/);
  assert.match(clearBody, /setSkip\('fx-folder', ''\)/);
  assert.doesNotMatch(
    clearBody,
    /setSkip\('config'/,
    "'config' is not a package key — the config package's skip pref is skippedHash.fx-folder"
  );

  // helper-checksum-win stays a launch of its own (Windows-only; CI cannot
  // attach BiDi there, so folding it would buy nothing) — pin the intent so a
  // later edit has to update this test consciously.
  assert.match(source, /id: '9',/, 'helper-checksum must keep its own step');
  assert.doesNotMatch(
    source,
    /alias: \[[^\]]*'9'/,
    'helper-checksum must NOT be folded into the session (its Windows-only, BiDi-less CI legs would gain nothing)'
  );
});

test('a driver realm that dies mid-session degrades the folded phases, never fails the leg', () => {
  const source = fs.readFileSync(UPDATER_E2E, 'utf-8');

  // The three parts of the contract: a bounded liveness probe, a sentinel error
  // the coordinator can recognise, and a remaining-work report.
  assert.match(
    source,
    /class DriverLostError extends Error[\s\S]*?this\.driverLost = true;/,
    'the realm-lost sentinel must be distinguishable from a real assertion bug'
  );
  assert.match(
    source,
    /async function driverAlive\(driver, timeoutMs = 3_000\)/,
    'the liveness probe must exist and be bounded'
  );
  assert.match(
    source,
    /Promise\.race\(\[probe, cap\]\)/,
    'the probe must race the evaluate against a timeout so a wedged session cannot hang the leg'
  );
  assert.match(
    source,
    /async function driverCall\(driver, where, fn\)[\s\S]*?throw new DriverLostError/,
    'driverCall must convert a gone realm into the sentinel'
  );

  // The coordinator probes BEFORE the first phase, and reports what it could not
  // finish so run() can launch exactly that.
  const extrasAt = source.indexOf('async function runSessionExtras(');
  const installAt = source.indexOf('async function runFoldedInstallApplies(');
  assert.ok(extrasAt !== -1 && installAt > extrasAt, 'the coordinator must precede the phases');
  const coordinator = source.slice(extrasAt, installAt);
  assert.match(
    coordinator,
    /if \(!\(await driverAlive\(ctx\.driver\)\)\) \{[\s\S]*?remaining: \[\.\.\.FOLDED_SCENARIOS\]/,
    'a realm that is already gone must defer every folded scenario'
  );
  assert.match(
    coordinator,
    /if \(!err\?\.driverLost\) throw err;/,
    'only the sentinel degrades — an assertion failure must still fail the leg'
  );
  assert.match(
    coordinator,
    /FOLDED_SCENARIOS\.filter\(scenario => !completed\.includes\(scenario\)\)/,
    'only the phases that did not finish may be resumed'
  );

  // ...and the assertion that can outlive the realm (the tab's UI reflection) is
  // guarded, or a dead realm would read as a failed render.
  const installBody = source.slice(installAt, source.indexOf('async function runFoldedNoUi('));
  assert.match(
    installBody,
    /if \(!\(await driverAlive\(driver\)\)\) throw new DriverLostError\('install-applies: UI reflection'\)/,
    'the UI-reflection assertion must probe the realm first'
  ); // Every driver command inside the folded phases goes through driverCall (or at
  // least sits behind a driverAlive guard): a bare `driver.x()` would reject with
  // a raw protocol error and fail the leg instead of deferring the phase.
  const noUiAt = source.indexOf('async function runFoldedNoUi(');
  for (const [name, phase] of [
    ['install-applies', installAt],
    ['manual-install-no-ui', noUiAt],
  ]) {
    const body = source.slice(phase, source.indexOf('\n}\n', phase));
    assert.match(body, /await driverCall\(driver, '/, `${name} must drive the browser`);
    const lines = body.split('\n');
    for (const [i, line] of lines.entries()) {
      if (!/await driver\.\w+\(/.test(line)) continue;
      assert.match(
        lines.slice(Math.max(0, i - 3), i + 1).join('\n'),
        /driverCall\(driver, |driverAlive\(driver\)/,
        `${name}: every driver call must be wrapped in driverCall or guarded by driverAlive`
      );
    }
  }
});

test('install-applies binds to the page that rendered the fixture state, not the first updater page', () => {
  const source = fs.readFileSync(UPDATER_E2E, 'utf-8');

  // A BiDi page target OUTLIVES its tab, so findUpdaterPage (first page whose
  // UpdaterEngine.init exists) can hand back the tab closeUpdaterTabs just
  // closed — its card is still rendered, which is why the old
  // `card-title`-only wait passed 6 ms after the fresh tab opened. On
  // zen · windows-latest (2026-10-02) the install was clicked in that dying
  // document: nothing was installed, no progress was ever reported, and six
  // dependent assertions failed 30 s later.
  assert.match(
    source,
    /async function findRenderedUpdaterPage\(/,
    'the harness needs a page resolver that requires the fixture\u2019s rendered state'
  );
  assert.match(
    source,
    /findRenderedUpdaterPage\(browser, 'both-stale'\)/,
    'install-applies must resolve its page by the both-stale state it seeds'
  );
  assert.doesNotMatch(
    source,
    /install-applies: card tab available/,
    'the weak "a page exists" gate must not come back'
  );

  // A click on a disabled button is swallowed silently and the old standard
  // branch returned true regardless (the Snap branch checked it); the engine\u2019s
  // own first progress step is the acceptance proof.
  assert.match(source, /async function clickInstall\(/, 'the click must be verified');
  assert.match(source, /async function installCommandAccepted\(/, 'acceptance must be observed');
  assert.match(
    source,
    /if \(btn\.disabled\) \{\n\s+return \{\n\s+ok: false,/,
    'a disabled Update button must be reported, not clicked'
  );
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
