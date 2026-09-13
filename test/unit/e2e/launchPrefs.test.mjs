// test/unit/e2e/launchPrefs.test.mjs — pin the Windows-startup-hygiene prefs
// that launchFirefox injects into every test browser (issue #191).
//
// The E2E suites are path-filtered CI legs, so nothing routinely executes
// launchFirefox on PRs. These static assertions keep the guarantee from
// silently regressing: a fresh-profile test Firefox of an official build
// auto-enables launch-on-login on first run (HKCU Run
// "Mozilla-Firefox-<installHash>" → the Startup apps page) unless these
// prefs are set before launch. If this test fails, an E2E run on a Windows
// dev machine will add startup debris again.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const source = fs.readFileSync(
  path.join(REPO_ROOT, 'test', 'e2e', 'shared', 'helpers.mjs'),
  'utf-8'
);

test('launchFirefox injects the launch-on-login kill switch into every test browser', () => {
  assert.match(
    source,
    /'browser\.startup\.windowsLaunchOnLogin\.defaultEnabled': false/,
    'DefaultLaunchOnLogin must never auto-enable (Run key on first run)'
  );
  assert.match(
    source,
    /'browser\.startup\.windowsLaunchOnLogin\.alreadyApplied': true/,
    'alreadyApplied skips the auto-enable path entirely'
  );
  assert.match(
    source,
    /'toolkit\.winRegisterApplicationRestart': false/,
    'Restart Manager registration stays off (belt and suspenders)'
  );
});

test('caller-supplied extraPrefsFirefox still win over the hygiene defaults', () => {
  // The spread order is the contract: defaults first, ...extraPrefsFirefox last.
  assert.match(
    source,
    /'toolkit\.winRegisterApplicationRestart': false,\s*\.\.\.extraPrefsFirefox,/
  );
});

test('no launch path may register startup debris: no sweep, defaults centralized', () => {
  // The registry sweep was deliberately removed (review: a user may register
  // their own Firefox intentionally — never touch the user's Run key).
  // Prevention is the only mechanism, so it must live in launchFirefox.
  assert.doesNotMatch(
    source,
    /removeStartupRegistration/,
    'startup-registry mutation must not exist in the E2E helpers'
  );
});
