// test/unit/e2e/launchPrefs.test.mjs — pin the Windows-startup-hygiene prefs
// that keep every test browser out of the user's Startup apps (issue #191).
//
// The E2E suites are path-filtered CI legs, so nothing routinely executes
// launchFirefox/launchDetachedFirefox on PRs. These tests keep the guarantee
// from silently regressing: a fresh-profile test Firefox of an official build
// auto-enables launch-on-login on first run (HKCU Run
// "Mozilla-Firefox-<installHash>" → the Startup apps page) unless these prefs
// are set before launch. If this test fails, an E2E run on a Windows dev
// machine will add startup debris again.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const helpersPath = path.join(REPO_ROOT, 'test', 'e2e', 'shared', 'helpers.mjs');
const installerE2ePath = path.join(REPO_ROOT, 'test', 'e2e', 'installer', 'installer-e2e.mjs');
const source = fs.readFileSync(helpersPath, 'utf-8');
const installerSource = fs.readFileSync(installerE2ePath, 'utf-8');

const {STARTUP_HYGIENE_PREFS, seedStartupHygienePrefs} = await import(
  pathToFileURL(helpersPath).href
);

test('STARTUP_HYGIENE_PREFS carries the three kill switches', () => {
  assert.deepEqual(STARTUP_HYGIENE_PREFS, {
    // DefaultLaunchOnLogin must never auto-enable (Run key on first run).
    'browser.startup.windowsLaunchOnLogin.defaultEnabled': false,
    // alreadyApplied skips the auto-enable path entirely.
    'browser.startup.windowsLaunchOnLogin.alreadyApplied': true,
    // Restart Manager registration stays off (belt; invisible on the page).
    'toolkit.winRegisterApplicationRestart': false,
  });
});

test('launchFirefox injects the hygiene prefs ahead of caller prefs', () => {
  // The spread order is the contract: defaults first, ...extraPrefsFirefox
  // last, so a caller can still override for a test that needs real behavior.
  assert.match(source, /\.\.\.STARTUP_HYGIENE_PREFS,\s*\.\.\.extraPrefsFirefox,/);
});

test('seedStartupHygienePrefs writes the prefs into a fresh profile user.js', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fxs-launchprefs-'));
  try {
    seedStartupHygienePrefs(dir);
    const userJs = fs.readFileSync(path.join(dir, 'user.js'), 'utf-8');
    for (const [name, value] of Object.entries(STARTUP_HYGIENE_PREFS)) {
      assert.match(userJs, new RegExp(`user_pref\\("${name}", ${value}\\);`));
    }
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('seedStartupHygienePrefs is idempotent and preserves other user.js content', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fxs-launchprefs-'));
  try {
    fs.writeFileSync(path.join(dir, 'user.js'), 'user_pref("keep.me", true);\n');
    seedStartupHygienePrefs(dir);
    seedStartupHygienePrefs(dir);
    const userJs = fs.readFileSync(path.join(dir, 'user.js'), 'utf-8');
    assert.match(userJs, /user_pref\("keep\.me", true\);/);
    assert.equal(userJs.match(/fxs-e2e startup hygiene/g)?.length, 1, 'one block only');
    assert.equal(
      userJs.match(/user_pref\("browser\.startup\.windowsLaunchOnLogin/g)?.length,
      2,
      'two launch-on-login prefs, not duplicated'
    );
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('the detached-spawn path (launchDetachedFirefox) seeds the prefs too', () => {
  // installer-e2e spawns Firefox directly with fresh profiles — bypassing
  // puppeteer — so user.js seeding is the only protection on that path.
  assert.match(
    installerSource,
    /function launchDetachedFirefox\([^)]*\) \{\s*[\s\S]*?seedStartupHygienePrefs\(profileDir\);/,
    'seedStartupHygienePrefs must run before the detached spawn'
  );
});

test('no launch path may register startup debris: no sweep, defaults centralized', () => {
  // The registry sweep was deliberately removed (review: a user may register
  // their own Firefox intentionally — never touch the user's Run key).
  // Prevention is the only mechanism, so it must live in the launch helpers.
  assert.doesNotMatch(
    source,
    /removeStartupRegistration/,
    'startup-registry mutation must not exist in the E2E helpers'
  );
});
