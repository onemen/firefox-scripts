// test/unit/tools/e2e-workflow-contracts.test.mjs — the static contracts of
// .github/workflows/e2e.yml.
//
// e2e.yml wires its jobs together through a handful of IMPLICIT couplings that
// nothing in the workflow file states and nothing else checks:
//
//   1. FIREFOX_BINARY      — a harness/assertion step reads the browser path a
//                            DIFFERENT step published. Only the setup-browser
//                            composite (downloads.mjs exportBinaryPath) and an
//                            explicit `FIREFOX_BINARY=… >> "$GITHUB_ENV"` write
//                            set it, and a new install path that does neither
//                            fails only when it next runs.
//   2. PORTABLE_BROWSER_DIR — only setup-browser's `portable: 'true'` mode sets
//                            it; a step that reads it in a job that installs
//                            normally asserts against an empty variable.
//   3. DOWNLOAD_TOTAL_BUDGET_MS — the workflow-level download budget. Its
//                            MARGIN rule lives in download-budget.test.mjs; what
//                            this registry pins is that there is exactly ONE
//                            workflow-level declaration, so a per-job override
//                            cannot quietly diverge from the documented value.
//   4. artifact names       — a job may only download an artifact some upload
//                            in the same workflow produces. The `dev-snapshot`
//                            name is the coupling between the snapshot job and
//                            every consuming leg; a rename on one side is
//                            otherwise a "no artifacts found" failure at run
//                            time.
//
// Each coupling is one CONTRACT below: a name, a one-line description, and a
// check that returns human-readable violations. The suite then asserts that the
// real workflow satisfies every contract, and each contract has a fixture test
// proving it catches its own regression (a contract that cannot fail is worse
// than no contract). The header of the first version of this file recorded the
// failure it was born from: the snap leg's offline-from-cache path skipped the
// FIREFOX_BINARY export, and #311's PR was green because its first run was a
// cold cache — the first red signal was the leg itself, on main, days later.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const E2E = path.join(REPO_ROOT, '.github', 'workflows', 'e2e.yml');

/** Read a workflow file with LF normalized (a local copy can linger as CRLF). */
function readWorkflow(file) {
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

// ── parsing ────────────────────────────────────────────────────────────────

/** Drop whole-line YAML/shell comments so prose can never satisfy a check. */
function stripComments(text) {
  return text
    .split('\n')
    .filter(line => !/^[ \t]*#/.test(line))
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
  const lines = text.split('\n');
  const jobsStart = lines.findIndex(line => /^jobs:[ \t]*$/.test(line));
  if (jobsStart === -1) return [];
  /** @type {{name: string; body: string[]}[]} */
  const jobs = [];
  for (let i = jobsStart + 1; i < lines.length; i++) {
    const header = lines[i].match(/^ {2}([A-Za-z0-9_-]+):[ \t]*$/);
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
  for (const line of jobBody.split('\n')) {
    if (/^ {6}- /.test(line)) {
      steps.push(line);
      continue;
    }
    if (steps.length > 0) steps[steps.length - 1] += `\n${line}`;
  }
  return steps;
}

/**
 * The step's `uses:` value (action or composite), or null.
 *
 * The value is NOT anchored to end-of-line: every pinned remote action carries
 * an inline `# vX.Y.Z` comment (`uses: actions/upload-artifact@043f… #
 * v7.0.1`), and anchoring there silently hides those steps from the artifact
 * contract.
 *
 * The key may also sit behind a list marker with no `name:` before it — `-
 * uses: $/.github/actions/setup-repo` is a real form in e2e.yml — so an
 * optional `- ` before the key is allowed; requiring whitespace directly before
 * `uses:` would hide such steps from every contract.
 */
function stepUses(stepText) {
  const match = stripComments(stepText).match(/^[ \t]+(?:- )?uses:[ \t]*(\S+)/m);
  return match ? match[1] : null;
}

/** The step's `name:` value, for violation messages. */
function stepName(stepText) {
  const match = stepText.match(/^\s*- name:\s*(.+?)\s*$/m);
  return match ? match[1] : '(unnamed step)';
}

/**
 * A step body's `with:` key value, or null. Scanned line by line rather than
 * built into a RegExp: the key is a parameter, and a dynamic pattern reads as
 * security/detect-non-literal-regexp even though every caller passes a literal.
 * The step's own `- name:` line cannot match — the first non-space character
 * there is `-`, not a key character.
 */
function withValue(stepText, key) {
  for (const line of stripComments(stepText).split('\n')) {
    const match = /^[ \t]+([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line);
    if (match && match[1] === key) return match[2].trim();
  }
  return null;
}

// ── contract 1: FIREFOX_BINARY ─────────────────────────────────────────────

/** Non-comment lines that invoke downloads.mjs as an INSTALL. */
function downloadsInstallLines(stepText) {
  return stripComments(stepText)
    .split('\n')
    .filter(line => line.includes('downloads.mjs'))
    .filter(line => !line.includes('--installed-version') && !line.includes('--pr'));
}

/**
 * True when the line is a `snap install …` invocation (the offline install
 * path). Token-based rather than a regex: the whitespace quantifiers a regex
 * needs here (`^\s*(?:sudo\s+)?`) read as ambiguous to
 * security/detect-unsafe-regex, and a token check is clearer anyway.
 */
function isSnapInstallLine(line) {
  const tokens = line.trim().split(/\s+/);
  const start = tokens[0] === 'sudo' ? 1 : 0;
  return tokens[start] === 'snap' && tokens[start + 1] === 'install';
}

/**
 * True when the step installs a browser binary — the setup-browser composite, a
 * snap install from a local artifact, or a downloads.mjs install invocation.
 *
 * `snap install` is matched only in command position, so the offline step's own
 * `::error::snap install ran, but …` message (and job prose) never counts.
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
 * $GITHUB_ENV), or an explicit `FIREFOX_BINARY=… >> "$GITHUB_ENV"` write.
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

// ── contract 2: PORTABLE_BROWSER_DIR ───────────────────────────────────────

/**
 * True when the job's browser install runs in portable mode — setup-browser
 * with `portable: 'true'`, the only thing that sets PORTABLE_BROWSER_DIR.
 *
 * @param {{name: string; body: string}} job
 * @returns {boolean}
 */
export function installsPortably(job) {
  return jobSteps(job.body).some(step => {
    const uses = stepUses(step);
    if (!uses || !/actions\/setup-browser/.test(uses)) return false;
    return /^[ \t]+portable:[ \t]*['"]?true['"]?[ \t]*$/m.test(stripComments(step));
  });
}

/**
 * Every job that reads PORTABLE_BROWSER_DIR without installing portably. The
 * layout assertions compare FIREFOX_BINARY against it, so an unset variable
 * turns a real assertion into an empty-string comparison.
 *
 * @param {{name: string; body: string}[]} jobs
 * @returns {string[]}
 */
export function portableDirViolations(jobs) {
  const violations = [];
  for (const job of jobs) {
    const readers = jobSteps(job.body).filter(step =>
      stripComments(step).includes('PORTABLE_BROWSER_DIR')
    );
    if (readers.length === 0 || installsPortably(job)) continue;
    violations.push(
      `${job.name}: "${stepName(readers[0])}" reads PORTABLE_BROWSER_DIR, but the job never ` +
        "installs the browser portably (setup-browser with portable: 'true') — the variable " +
        'is unset and the layout assertion compares against an empty string'
    );
  }
  return violations;
}

// ── contract 3: DOWNLOAD_TOTAL_BUDGET_MS ───────────────────────────────────

/**
 * Every DOWNLOAD_TOTAL_BUDGET_MS declaration, with its indentation (the
 * workflow-level `env:` children sit at 2 spaces; a job-level one is deeper).
 *
 * @param {string} text a workflow file
 * @returns {{indent: number; value: string}[]}
 */
export function budgetDeclarations(text) {
  /** @type {{indent: number; value: string}[]} */
  const found = [];
  for (const line of stripComments(text).split('\n')) {
    const match = line.match(/^([ \t]*)DOWNLOAD_TOTAL_BUDGET_MS:[ \t]*['"]?([^'"\s]+)['"]?[ \t]*$/);
    if (match) found.push({indent: match[1].length, value: match[2]});
  }
  return found;
}

/**
 * The budget must be declared exactly once, at the workflow level.
 *
 * The margin arithmetic (budget + slack < every downloading leg's timeout) is
 * download-budget.test.mjs's job and is deliberately NOT repeated here — this
 * contract only guards the single-declaration property, which is what keeps the
 * documented 12-minute value authoritative for every leg.
 *
 * @param {string} text a workflow file
 * @returns {string[]}
 */
export function budgetDeclaredOnceViolations(text) {
  const declarations = budgetDeclarations(text);
  if (declarations.length === 0) {
    return [
      'DOWNLOAD_TOTAL_BUDGET_MS is not declared — a downloading leg would fall back to the ' +
        '20-minute default and tie the budget to the 20-minute job cap',
    ];
  }
  if (declarations.length > 1) {
    return [
      `DOWNLOAD_TOTAL_BUDGET_MS is declared ${declarations.length} times — keep one ` +
        'workflow-level value so the documented margin cannot drift per job',
    ];
  }
  const [declaration] = declarations;
  if (declaration.indent !== 2) {
    return [
      `DOWNLOAD_TOTAL_BUDGET_MS is declared at ${declaration.indent}-space indent — it must be ` +
        'a workflow-level env: entry (2 spaces) so every job inherits the same budget',
    ];
  }
  if (!(Number(declaration.value.replace(/_/g, '')) > 0)) {
    return [
      `DOWNLOAD_TOTAL_BUDGET_MS is not a positive number of milliseconds: ${declaration.value}`,
    ];
  }
  return [];
}

// ── contract 4: artifact names ─────────────────────────────────────────────

/**
 * Every upload/download-artifact step in the workflow, with the artifact name
 * (or glob pattern) it uses.
 *
 * @param {{name: string; body: string}[]} jobs
 * @returns {{
 *   job: string;
 *   step: string;
 *   kind: string;
 *   name: string | null;
 *   pattern: string | null;
 * }[]}
 */
export function artifactSteps(jobs) {
  const artifacts = [];
  for (const job of jobs) {
    for (const step of jobSteps(job.body)) {
      const uses = stepUses(step);
      if (!uses || !/actions\/(upload|download)-artifact/.test(uses)) continue;
      artifacts.push({
        job: job.name,
        step: stepName(step),
        kind: /upload-artifact/.test(uses) ? 'upload' : 'download',
        name: withValue(step, 'name'),
        pattern: withValue(step, 'pattern'),
      });
    }
  }
  return artifacts;
}

/** Translate an artifact glob (`*` wildcard) into an anchored RegExp. */
function globToRegExp(glob) {
  const parts = glob.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  // Every literal part is escaped on the line above, so the only metacharacter
  // the assembled pattern can contain is the `.*` wildcard; the rule cannot see
  // that through the interpolation.
  // eslint-disable-next-line security/detect-non-literal-regexp
  return new RegExp(`^${parts.join('.*')}$`);
}

/**
 * Every download whose artifact no upload produces. Upload names are literal
 * here even when they contain `${{ }}` expressions: the check only needs to
 * know a name COULD be produced, and a consumer's literal name or glob is
 * compared against that text.
 *
 * @param {{
 *   job: string;
 *   step: string;
 *   kind: string;
 *   name: string | null;
 *   pattern: string | null;
 * }[]} artifacts
 * @returns {string[]}
 */
export function artifactPairingViolations(artifacts) {
  const uploaded = artifacts.filter(a => a.kind === 'upload' && a.name).map(a => a.name);
  const violations = [];
  for (const artifact of artifacts) {
    if (artifact.kind !== 'download') continue;
    if (artifact.name) {
      if (!uploaded.includes(artifact.name)) {
        violations.push(
          `${artifact.job}: "${artifact.step}" downloads artifact "${artifact.name}", but no ` +
            'upload step in this workflow produces that name'
        );
      }
      continue;
    }
    if (artifact.pattern) {
      const matcher = globToRegExp(artifact.pattern);
      if (!uploaded.some(name => matcher.test(name))) {
        violations.push(
          `${artifact.job}: "${artifact.step}" downloads artifacts matching ` +
            `"${artifact.pattern}", but no upload produces a matching name`
        );
      }
    }
  }
  return violations;
}

// ── the registry ───────────────────────────────────────────────────────────

/**
 * Every static contract the suite enforces on e2e.yml. `check` takes the
 * workflow text and returns violations (empty = the contract holds).
 */
export const CONTRACTS = [
  {
    id: 'firefox-binary',
    description: 'every browser-provisioning step publishes FIREFOX_BINARY',
    check: text => firefoxBinaryViolations(workflowJobs(text)),
  },
  {
    id: 'portable-dir',
    description:
      'a job that reads PORTABLE_BROWSER_DIR installs the browser portably (setup-browser portable: true)',
    check: text => portableDirViolations(workflowJobs(text)),
  },
  {
    id: 'download-budget',
    description: 'DOWNLOAD_TOTAL_BUDGET_MS is declared exactly once, at the workflow level',
    check: budgetDeclaredOnceViolations,
  },
  {
    id: 'artifact-pairing',
    description: 'every downloaded artifact name is produced by an upload in the same workflow',
    check: text => artifactPairingViolations(artifactSteps(workflowJobs(text))),
  },
];

// ── tests ──────────────────────────────────────────────────────────────────

test('e2e.yml satisfies every declared contract', () => {
  const text = readWorkflow(E2E);
  assert.ok(
    workflowJobs(text).length > 0,
    'expected jobs in e2e.yml — the parser or the file shape changed'
  );
  const failures = CONTRACTS.flatMap(contract => contract.check(text));
  assert.deepEqual(failures, [], failures.join('\n'));
});

test('each contract is exercised by at least one provisioning/reading site', () => {
  // A contract whose detector stops matching anything would pass vacuously.
  // Assert the two shape-sensitive detectors stay populated on the real file.
  const jobs = workflowJobs(readWorkflow(E2E));
  const provisioning = jobs.flatMap(job => jobSteps(job.body)).filter(provisionsBrowser);
  assert.ok(provisioning.length > 0, 'expected browser-provisioning steps in e2e.yml');
  const portableReaders = jobs.filter(job =>
    jobSteps(job.body).some(step => stripComments(step).includes('PORTABLE_BROWSER_DIR'))
  );
  assert.ok(portableReaders.length > 0, 'expected PORTABLE_BROWSER_DIR readers in e2e.yml');
});

test('e2e.yml: the snapshot job publishes the dev-snapshot artifact the legs download', () => {
  // The named coupling behind contract 4: the snapshot job is the producer, and
  // the harness legs (which discover dist/dev-HEAD-<sha>/) depend on the name.
  const jobs = workflowJobs(readWorkflow(E2E));
  const snapshot = jobs.find(job => job.name === 'snapshot');
  assert.ok(snapshot, 'expected a `snapshot` job in e2e.yml');
  const uploads = artifactSteps([snapshot]).filter(a => a.kind === 'upload');
  assert.deepEqual(
    uploads.map(a => a.name),
    ['dev-snapshot'],
    'the snapshot job must upload exactly the dev-snapshot artifact'
  );
});

test('e2e.yml: the snap leg publishes FIREFOX_BINARY on BOTH install paths', () => {
  // The regression contract 1 was born from: the store path (downloads.mjs) and
  // the cache path (snap install from the pinned pair) are mutually exclusive at
  // runtime, so each has to satisfy the contract on its own.
  const snap = workflowJobs(readWorkflow(E2E)).find(job => job.name === 'snap-firefox');
  assert.ok(snap, 'expected a `snap-firefox` job in e2e.yml');
  const installs = jobSteps(snap.body).filter(step => provisionsBrowser(step));
  assert.equal(installs.length, 2, 'expected exactly the two snap install paths');
  for (const step of installs) {
    assert.ok(
      publishesFirefoxBinary(step),
      `snap path "${stepName(step)}" must publish FIREFOX_BINARY`
    );
  }
});

// ── per-contract fixtures: a contract that cannot fail is worthless ─────────

test('firefox-binary: a provisioning step without the export is a violation', () => {
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

  const fixed = fixture.replace(
    '          sudo snap install ~/snap-pkg/firefox_*.snap --classic',
    '          sudo snap install ~/snap-pkg/firefox_*.snap --classic\n' +
      '          echo "FIREFOX_BINARY=/snap/bin/firefox" >> "$GITHUB_ENV"'
  );
  assert.deepEqual(firefoxBinaryViolations(workflowJobs(fixed)), []);
});

test('firefox-binary: a step whose first key is uses: is still seen', () => {
  // `- uses: …` (list marker, no `name:` before the key) is a real step form in
  // this repo — e2e.yml opens its legs with `- uses: $/.github/actions/setup-repo`.
  // A parser that requires whitespace directly before `uses:` never sees such a
  // step, silently vacating every contract for it.
  const step = [
    '      - uses: ./.github/actions/setup-browser',
    '        with:',
    '          browser: firefox',
  ].join('\n');
  assert.equal(provisionsBrowser(step), true);
  assert.equal(publishesFirefoxBinary(step), true);

  const upload = [
    '      - uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0 # v7.0.1',
    '        with:',
    '          name: dev-snapshot',
  ].join('\n');
  const artifacts = artifactSteps([{name: 'leg', body: upload}]);
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].kind, 'upload');
  assert.equal(artifacts[0].name, 'dev-snapshot');
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
  const version = [
    '      - name: Capture installed firefox version',
    '        run: VER="$(node test/e2e/shared/downloads.mjs firefox --installed-version)"',
  ].join('\n');
  assert.equal(provisionsBrowser(version), false);
  const prose = [
    '      - name: Cache snap download',
    '        # cacheable, unlike `snap install`, whose revision negotiation is not',
    '        run: echo hi',
  ].join('\n');
  assert.equal(provisionsBrowser(prose), false);
});

test('portable-dir: reading PORTABLE_BROWSER_DIR without a portable install is a violation', () => {
  const fixture = portableLine =>
    [
      'jobs:',
      '  portable-firefox:',
      '    steps:',
      '      - name: Install Firefox Release portably',
      '        uses: ./.github/actions/setup-browser',
      '        with:',
      '          browser: firefox',
      ...(portableLine ? [portableLine] : []),
      '      - name: Assert portable layout (Linux/macOS)',
      '        run: |',
      '          case "$FIREFOX_BINARY" in',
      '            "$PORTABLE_BROWSER_DIR"/*) ;;',
      '          esac',
    ].join('\n');
  const violations = portableDirViolations(workflowJobs(fixture(undefined)));
  assert.equal(violations.length, 1);
  assert.match(violations[0], /portable-firefox/);
  assert.match(violations[0], /PORTABLE_BROWSER_DIR/);
  assert.deepEqual(portableDirViolations(workflowJobs(fixture("          portable: 'true'"))), []);
});

test('download-budget: the budget must be declared exactly once, at the workflow level', () => {
  const workflowLevel = ['env:', "  DOWNLOAD_TOTAL_BUDGET_MS: '720000'", 'jobs:', '  a:'].join(
    '\n'
  );
  assert.deepEqual(budgetDeclaredOnceViolations(workflowLevel), []);

  assert.match(budgetDeclaredOnceViolations('jobs:\n  a:\n')[0], /not declared/);

  const twice = [
    'env:',
    "  DOWNLOAD_TOTAL_BUDGET_MS: '720000'",
    'jobs:',
    '  a:',
    '    env:',
    "      DOWNLOAD_TOTAL_BUDGET_MS: '60000'",
  ].join('\n');
  assert.match(budgetDeclaredOnceViolations(twice)[0], /declared 2 times/);

  const jobLevel = ['jobs:', '  a:', '    env:', "      DOWNLOAD_TOTAL_BUDGET_MS: '720000'"].join(
    '\n'
  );
  assert.match(budgetDeclaredOnceViolations(jobLevel)[0], /6-space indent/);

  const nonNumeric = ['env:', '  DOWNLOAD_TOTAL_BUDGET_MS: soon'].join('\n');
  assert.match(budgetDeclaredOnceViolations(nonNumeric)[0], /not a positive number/);

  // A name in a comment is prose, not a declaration.
  assert.match(
    budgetDeclaredOnceViolations('# DOWNLOAD_TOTAL_BUDGET_MS: 720000\njobs:')[0],
    /not declared/
  );
});

test('artifact-pairing: a download no upload produces is a violation', () => {
  const fixture = downloadName =>
    [
      'jobs:',
      '  snapshot:',
      '    steps:',
      '      - name: Upload dev snapshot',
      '        uses: actions/upload-artifact@v4',
      '        with:',
      '          name: dev-snapshot',
      '  updater:',
      '    steps:',
      '      - name: Download dev snapshot',
      '        uses: actions/download-artifact@v4',
      '        with:',
      `          name: ${downloadName}`,
    ].join('\n');
  assert.deepEqual(
    artifactPairingViolations(artifactSteps(workflowJobs(fixture('dev-snapshot')))),
    []
  );
  const violations = artifactPairingViolations(
    artifactSteps(workflowJobs(fixture('dev-snapshot2')))
  );
  assert.equal(violations.length, 1);
  assert.match(violations[0], /updater/);
  assert.match(violations[0], /dev-snapshot2/);
});

test('artifact-pairing: a glob pattern matches the dynamic upload names', () => {
  const fixture = [
    'jobs:',
    '  updater:',
    '    steps:',
    '      - name: Upload version artifact',
    '        uses: actions/upload-artifact@v4',
    '        with:',
    '          name: e2e-version-${{ matrix.browser }}-${{ matrix.os }}',
    '  record:',
    '    steps:',
    '      - name: Download tested versions',
    '        uses: actions/download-artifact@v4',
    '        with:',
    '          pattern: e2e-version-*',
  ].join('\n');
  assert.deepEqual(artifactPairingViolations(artifactSteps(workflowJobs(fixture))), []);
  const mismatch = fixture.replace('pattern: e2e-version-*', 'pattern: e2e-versions-*');
  assert.equal(artifactPairingViolations(artifactSteps(workflowJobs(mismatch))).length, 1);
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
