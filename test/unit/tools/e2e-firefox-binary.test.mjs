// test/unit/tools/e2e-firefox-binary.test.mjs — every E2E step that provisions a
// browser binary must publish FIREFOX_BINARY.
//
// The harness (installer-e2e.mjs, updater-e2e.mjs, browsers.mjs) resolves the
// browser from `$FIREFOX_BINARY` first, and the workflow's own assertion steps
// (`Assert portable layout`, `Verify snap GreD`) read it directly. Only two
// things put it into the environment, and neither is obvious from the YAML:
//
//   1. the `setup-browser` composite action, which runs
//      `node test/e2e/shared/downloads.mjs <browser>` — the CLI appends
//      `FIREFOX_BINARY=<path>` to `$GITHUB_ENV` (downloads.mjs exportBinaryPath);
//   2. a step that writes that line to `$GITHUB_ENV` itself.
//
// A NEW install path that does neither is silently broken until it next runs:
// that is exactly how the snap leg's offline-from-cache path (`snap ack` +
// `snap install`) went red on every cache-hit run after #311 — `Verify snap
// GreD` died with `FIREFOX_BINARY: unbound variable`, and the PR that added the
// path was green because the first run was a cold cache (the store path ran
// downloads.mjs instead). PR CI cannot catch it either: the snap leg is off the
// PR path, so the first red signal is the leg itself.
//
// The rule is static, so it is checked here against the real workflow file:
// every step in e2e.yml that provisions a browser binary must also publish
// FIREFOX_BINARY. Runs in the required `lint + format` CI job via
// `node --test test/unit/**`.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const E2E = path.join(REPO_ROOT, '.github', 'workflows', 'e2e.yml');

/** Drop whole-line YAML/shell comments so prose can never satisfy a check. */
function stripComments(text) {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter(line => !/^\s*#/.test(line))
    .join('\n');
}

/**
 * Every job in a workflow file, with the raw text of its body.
 *
 * Deliberately small, like the parser in download-budget.test.mjs: the workflow
 * files are ours and simple, and a real YAML parser is not a dependency.
 *
 * @param {string} text a workflow file
 * @returns {{name: string; body: string}[]}
 */
export function workflowJobs(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const jobsStart = lines.findIndex(line => /^jobs:\s*$/.test(line));
  if (jobsStart === -1) return [];
  /** @type {{name: string; body: string[]}[]} */
  const jobs = [];
  for (let i = jobsStart + 1; i < lines.length; i++) {
    const header = lines[i].match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (header) {
      jobs.push({name: header[1], body: []});
      continue;
    }
    jobs.at(-1)?.body.push(lines[i]);
  }
  return jobs.map(job => ({name: job.name, body: job.body.join('\n')}));
}

/**
 * The steps of a job body, with the raw text of each step. A step begins at the
 * first list item at the `steps:` child indentation (6 spaces).
 *
 * @param {string} jobBody
 * @returns {string[]}
 */
export function jobSteps(jobBody) {
  /** @type {string[]} */
  const steps = [];
  for (const line of jobBody.replace(/\r\n/g, '\n').split('\n')) {
    if (/^ {6}- /.test(line)) {
      steps.push(line);
      continue;
    }
    if (steps.length > 0) steps[steps.length - 1] += `\n${line}`;
  }
  return steps;
}

/** The step's `uses:` value (action or composite), or null. */
function stepUses(stepText) {
  const match = stripComments(stepText).match(/^\s+uses:\s*(\S+)\s*$/m);
  return match ? match[1] : null;
}

/**
 * True when the line is a `snap install ...` invocation (the offline install
 * path). Token-based rather than a regex: the whitespace quantifiers a regex
 * needs here (`^\s*(?:sudo\s+)?`) read as ambiguous to
 * security/detect-unsafe-regex, and a token check is clearer anyway.
 */
function isSnapInstallLine(line) {
  const tokens = line.trim().split(/\s+/);
  const start = tokens[0] === 'sudo' ? 1 : 0;
  return tokens[start] === 'snap' && tokens[start + 1] === 'install';
}

/** Non-comment lines that invoke downloads.mjs as an INSTALL. */
function downloadsInstallLines(stepText) {
  return stripComments(stepText)
    .split('\n')
    .filter(line => line.includes('downloads.mjs'))
    .filter(line => !line.includes('--installed-version') && !line.includes('--pr'));
}

/**
 * True when the step installs a browser binary — the composite action, a snap
 * install from a local artifact, or a downloads.mjs install invocation.
 *
 * `snap install` is matched only in command position so the offline step's own
 * `::error::snap install ran, but ...` message (and job prose) never counts.
 *
 * @param {string} stepText
 * @returns {boolean}
 */
export function provisionsBrowser(stepText) {
  const uses = stepUses(stepText);
  if (uses && /actions\/setup-browser/.test(uses)) return true;
  if (downloadsInstallLines(stepText).length > 0) return true;
  return stripComments(stepText)
    .split('\n')
    .some(line => isSnapInstallLine(line));
}

/**
 * True when the step makes FIREFOX_BINARY visible to later steps — the
 * setup-browser composite, a downloads.mjs install (both export it through
 * $GITHUB_ENV), or an explicit `FIREFOX_BINARY=... >> "$GITHUB_ENV"` write.
 *
 * @param {string} stepText
 * @returns {boolean}
 */
export function publishesFirefoxBinary(stepText) {
  const uses = stepUses(stepText);
  if (uses && /actions\/setup-browser/.test(uses)) return true;
  if (downloadsInstallLines(stepText).length > 0) return true;
  return /FIREFOX_BINARY=[^\n]*GITHUB_ENV/.test(stripComments(stepText));
}

/** The step's `name:` value, for the violation message. */
function stepName(stepText) {
  const match = stepText.match(/^\s*- name:\s*(.+?)\s*$/m);
  return match ? match[1] : '(unnamed step)';
}

/**
 * Every provisioning step that does not publish FIREFOX_BINARY.
 *
 * @param {{name: string; body: string}[]} jobs
 * @returns {string[]} human-readable violations (empty = the contract holds)
 */
export function firefoxBinaryViolations(jobs) {
  const violations = [];
  for (const job of jobs) {
    for (const step of jobSteps(job.body)) {
      if (!provisionsBrowser(step)) continue;
      if (publishesFirefoxBinary(step)) continue;
      violations.push(
        `${job.name}: "${stepName(step)}" provisions a browser but never publishes ` +
          'FIREFOX_BINARY — later steps read it and fail with "FIREFOX_BINARY: unbound variable"'
      );
    }
  }
  return violations;
}

test('e2e.yml: every browser-provisioning step publishes FIREFOX_BINARY', () => {
  const jobs = workflowJobs(fs.readFileSync(E2E, 'utf8'));
  assert.ok(jobs.length > 0, 'expected jobs in e2e.yml');
  const provisioning = jobs
    .flatMap(job => jobSteps(job.body))
    .filter(step => provisionsBrowser(step));
  assert.ok(
    provisioning.length > 0,
    'expected browser-provisioning steps in e2e.yml — the detector or the workflow shape changed'
  );
  const violations = firefoxBinaryViolations(jobs);
  assert.deepEqual(violations, [], violations.join('\n'));
});

test('e2e.yml: the snap leg publishes FIREFOX_BINARY on BOTH install paths', () => {
  // The regression this guard exists for: the store path (downloads.mjs) and the
  // cache path (snap install from the pinned pair) must each satisfy the
  // contract, because they are mutually exclusive at runtime.
  const snap = workflowJobs(fs.readFileSync(E2E, 'utf8')).find(j => j.name === 'snap-firefox');
  assert.ok(snap, 'expected a `snap-firefox` job in e2e.yml');
  const steps = jobSteps(snap.body).filter(step => provisionsBrowser(step));
  assert.equal(steps.length, 2, 'expected exactly the two snap install paths');
  for (const step of steps) {
    assert.ok(
      publishesFirefoxBinary(step),
      `snap path "${stepName(step)}" must publish FIREFOX_BINARY`
    );
  }
});

test('provisionsBrowser: the snap offline install counts, its error message does not', () => {
  const offline = [
    '      - name: Install Firefox (snap, offline from cache)',
    '        run: |',
    '          sudo snap ack ~/snap-pkg/firefox_*.assert',
    '          sudo snap install ~/snap-pkg/firefox_*.snap --classic',
    "          test -x /snap/bin/firefox || { echo '::error::snap install ran, but /snap/bin/firefox not found'; exit 1; }",
  ].join('\n');
  assert.equal(provisionsBrowser(offline), true);
  // A step that only reports the version installs nothing.
  const version = [
    '      - name: Capture installed firefox version',
    '        run: VER="$(node test/e2e/shared/downloads.mjs firefox --installed-version)"',
  ].join('\n');
  assert.equal(provisionsBrowser(version), false);
  // Prose in a comment is not a command.
  const prose = [
    '      - name: Cache snap download',
    '        # cacheable, unlike `snap install`, whose revision negotiation is not',
    '        run: echo hi',
  ].join('\n');
  assert.equal(provisionsBrowser(prose), false);
});

test('firefoxBinaryViolations: a provisioning step without the export is a violation', () => {
  // The pre-fix snap job, reduced: two install paths, only one publishes.
  const fixture = [
    'jobs:',
    '  snap-firefox:',
    '    steps:',
    '      - name: Install Firefox (snap, offline from cache)',
    '        run: |',
    '          sudo snap install ~/snap-pkg/firefox_*.snap --classic',
    '      - name: Install Firefox (snap)',
    '        run: node test/e2e/shared/downloads.mjs firefox-snap',
    '      - name: Verify snap GreD',
    '        run: BIN="$FIREFOX_BINARY"',
  ].join('\n');
  const violations = firefoxBinaryViolations(workflowJobs(fixture));
  assert.equal(violations.length, 1);
  assert.match(violations[0], /snap-firefox/);
  assert.match(violations[0], /offline from cache/);

  // The fix: the offline path writes the launcher to $GITHUB_ENV.
  const fixed = fixture.replace(
    '          sudo snap install ~/snap-pkg/firefox_*.snap --classic',
    '          sudo snap install ~/snap-pkg/firefox_*.snap --classic\n' +
      '          echo "FIREFOX_BINARY=/snap/bin/firefox" >> "$GITHUB_ENV"'
  );
  assert.deepEqual(firefoxBinaryViolations(workflowJobs(fixed)), []);
});

test('jobSteps: step bodies stop at the next step', () => {
  const body = [
    '    steps:',
    '      - name: one',
    '        run: echo one',
    '      - name: two',
    '        run: echo two',
  ].join('\n');
  const steps = jobSteps(body);
  assert.equal(steps.length, 2);
  assert.match(steps[0], /echo one/);
  assert.doesNotMatch(steps[0], /echo two/);
});
