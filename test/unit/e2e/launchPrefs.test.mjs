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
const updaterE2ePath = path.join(REPO_ROOT, 'test', 'e2e', 'updater', 'updater-e2e.mjs');
const source = fs.readFileSync(helpersPath, 'utf-8');
const installerSource = fs.readFileSync(installerE2ePath, 'utf-8');
const updaterE2eSource = fs.readFileSync(updaterE2ePath, 'utf-8');

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

test('launchFirefox grants remote-agent system access via the environment', () => {
  // Firefox 159 (Bug 2054896, nightly 2026-09-29) removed the
  // -remote-allow-system-access CLI flag; privileged remote-agent calls now
  // require MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1 in the ENVIRONMENT — the flag
  // alone fails with "unsupported operation System access is required"
  // (updater E2E nightly legs). Harmless on Firefox <= 158. The env block
  // must also spread process.env so PATH et al. survive.
  assert.match(
    source,
    /\.\.\.process\.env,\s*MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1',/,
    'puppeteer launch must set MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1 on top of process.env'
  );
});

test('launchFirefox bounds the handshake and retries once (#384)', () => {
  // The launch handshake is raced against a hard deadline; a wedged start is
  // killed BY TAG (whole process tree — launcher-only kills orphan the
  // browser's children) and retried once. protocolTimeout (per protocol
  // command) defaults to 45_000 — this contract bounds the launch phase
  // only. Both bounds are caller-extendable (never shortenable) for a start
  // that is legitimately heavier than a plain launch — the deadline bounds a
  // wedged start, it does not assert performance.
  assert.match(source, /const LAUNCH_DEADLINE_MS = [\d_]+;/);
  assert.match(source, /Promise\.race\(\[launchPromise, deadline\]\)/);
  assert.match(source, /launchPromise\.catch\(\(\) => \{\}\);/);
  assert.match(source, /killProcessesByCmdline\(tag/);
  // The retry's OWN failure must sweep the tag too: the caller's
  // `finally { closeBrowser(browser) }` has no Browser to close when the launch
  // rejected, so a second wedged start would leak a browser still holding the
  // profileDir (CodeRabbit on #343, 2026-10-02).
  assert.match(source, /return await launchOnce\(\);/);
  assert.match(
    source,
    /catch \(retryErr\) \{[\s\S]*?killProcessesByCmdline\(tag, \{[\s\S]*?label: 'process\(es\) from the failed retry launch attempt',[\s\S]*?\}\);[\s\S]*?throw retryErr;/,
    'a rejected retry must kill the tagged tree before rethrowing'
  );
  // Every sweep names what it is sweeping: the default wording ("stray
  // process(es) from a previous run") read as a leaked browser when the sweep
  // was really the launch retry collecting its OWN wedged tree (2026-10-02
  // firefox-dev Windows leg).
  assert.doesNotMatch(
    source,
    /killProcessesByCmdline\(tag, \{log(?:: console\.log)?\}\)/,
    'the launch-retry sweeps must pass an explicit label'
  );
  assert.match(source, /protocolTimeout: protocolTimeoutMs \|\| 45_000/);
  assert.match(source, /Math\.max\(launchDeadlineMs, LAUNCH_DEADLINE_MS\)/);
});

test('scenario 11 launches with the extended bounds its restore start needs (#384)', () => {
  // Restoring a 2-window session with eager background tabs is the heaviest
  // startup any scenario launches: on busy Windows runners the handshake
  // outlived the stock 20 s deadline (esr-140 2026-10-01 — attempt AND retry
  // killed at exactly 20 s). The extension added for that reason was dropped by
  // accident in the #384 rework (1bd1ca3) and the wedge came straight back on
  // firefox-dev Windows 2026-10-02. Pin it so the next refactor cannot lose it
  // silently — the whole point is that the failure then lands on the
  // assertions instead of on the launch handshake.
  const at = updaterE2eSource.indexOf('async function runSessionRestoreScenario');
  assert.ok(at > -1, 'scenario 11 (session-restore) must exist');
  const until = updaterE2eSource.indexOf('\nasync function', at + 1);
  const scenario = updaterE2eSource.slice(at, until === -1 ? undefined : until);
  const launchAt = scenario.indexOf('launchFirefox(firefoxBin, seeded.profileDir');
  assert.ok(launchAt > -1, 'scenario 11 must launch via launchFirefox');
  const call = scenario.slice(launchAt, scenario.indexOf('});', launchAt) + 3);
  assert.match(call, /launchDeadlineMs: 60_000/, 'scenario 11 needs the 60 s launch deadline');
  assert.match(call, /protocolTimeoutMs: 120_000/, 'scenario 11 needs the 120 s protocol timeout');
});

test('launchFirefox embeds a unique per-launch tag in the browser argv', () => {
  // The deadline kill matches this tag in the process command lines, so it
  // must be unique per launch AND present in the launch args.
  assert.match(source, /--fxs-e2e-puppeteer-\$\{Date\.now\(\)\}/);
  assert.match(source, /args: \['-remote-allow-system-access', '--new-instance', tag\]/);
});

test('seedStartupHygienePrefs writes the prefs into a fresh profile user.js', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fxs-launchprefs-'));
  try {
    seedStartupHygienePrefs(dir);
    const userJs = fs.readFileSync(path.join(dir, 'user.js'), 'utf-8');
    for (const [name, value] of Object.entries(STARTUP_HYGIENE_PREFS)) {
      assert.ok(
        userJs.includes(`user_pref("${name}", ${value});`),
        `expected user.js to contain user_pref("${name}", ${value});`
      );
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
