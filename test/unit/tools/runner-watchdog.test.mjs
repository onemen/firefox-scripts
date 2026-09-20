// test/unit/tools/runner-watchdog.test.mjs — unit tests for the CI runner
// watchdog (tools/runner-watchdog.mjs): annotation classification, finding
// dedup, announcement filtering, issue-body rendering, and the scan flow's
// tolerance of per-job API failures.

import {test} from 'node:test';
import assert from 'node:assert/strict';

const {
  isDeprecationAnnotation,
  collectFindings,
  filterAnnouncementIssues,
  buildIssueBody,
  findingId,
  isOursFinding,
  parseLedger,
  scanRunAnnotations,
} = await import('../../../tools/runner-watchdog.mjs');

const MIGRATION_NOTICE =
  'The ubuntu-latest label will migrate to Ubuntu 26 beginning October 19, 2026.';

test('isDeprecationAnnotation: matches notice-level migration phrasing', () => {
  assert.equal(
    isDeprecationAnnotation({annotation_level: 'notice', message: MIGRATION_NOTICE}),
    true
  );
  assert.equal(
    isDeprecationAnnotation({
      annotation_level: 'warning',
      message: 'node 16 actions are deprecated',
    }),
    true
  );
  assert.equal(
    isDeprecationAnnotation({annotation_level: 'notice', message: 'image will be retired soon'}),
    true
  );
});

test('isDeprecationAnnotation: ignores unrelated notices and non-notice levels', () => {
  assert.equal(
    isDeprecationAnnotation({annotation_level: 'notice', message: 'canary skipped — no changes'}),
    false
  );
  assert.equal(
    isDeprecationAnnotation({annotation_level: 'failure', message: 'label will migrate'}),
    false
  );
  assert.equal(isDeprecationAnnotation({}), false);
  assert.equal(isDeprecationAnnotation(undefined), false);
});

test('collectFindings: dedupes one notice seen on many jobs into a single row', () => {
  const raw = [
    {message: MIGRATION_NOTICE, level: 'notice', workflow: 'E2E', job: 'a'},
    {message: MIGRATION_NOTICE, level: 'notice', workflow: 'E2E', job: 'b'},
    {message: MIGRATION_NOTICE, level: 'notice', workflow: 'CI', job: 'c'},
    {message: 'windows-latest will move to VS2026', level: 'notice', workflow: 'CI', job: 'c'},
  ];
  const findings = collectFindings(raw);
  assert.equal(findings.length, 2);
  const migration = findings.find(f => f.message === MIGRATION_NOTICE);
  assert.equal(migration.jobs, 3);
  assert.deepEqual(migration.workflows.sort(), ['CI', 'E2E']);
});

test('filterAnnouncementIssues: keeps only issues updated in the window', () => {
  const kept = filterAnnouncementIssues(
    [
      {
        number: 14748,
        title: '[Ubuntu] ubuntu-latest label will use Ubuntu 26.04',
        html_url: 'https://github.com/actions/runner-images/issues/14748',
        updated_at: '2026-09-17T00:00:00Z',
      },
      {
        number: 14000,
        title: 'old announcement',
        html_url: 'https://github.com/actions/runner-images/issues/14000',
        updated_at: '2026-08-01T00:00:00Z',
      },
    ],
    '2026-09-10T00:00:00Z'
  );
  assert.equal(kept.length, 1);
  assert.equal(kept[0].number, 14748);
  assert.equal(kept[0].url, 'https://github.com/actions/runner-images/issues/14748');
});

test('isOursFinding: run.path is the classifier; ambiguity → external', () => {
  const repoRoot = process.cwd(); // real repo: .github/workflows exists
  assert.equal(isOursFinding(['.github/workflows/ci.yml'], repoRoot), true);
  assert.equal(
    isOursFinding(['.github/workflows/runner-watchdog.yml', '.github/workflows/ci.yml'], repoRoot),
    true
  );
  // GitHub-managed runs: no path (pages build and deployment) or foreign path.
  assert.equal(isOursFinding([], repoRoot), false);
  assert.equal(isOursFinding([''], repoRoot), false);
  assert.equal(isOursFinding(['.github/workflows/foreign.yml'], repoRoot), false);
  // Dependabot runs OUR ci.yml on its branch — the name lies, the path truth:
  // path-based classification calls it ours (actionable advice: wait/deny).
  assert.equal(isOursFinding(['.github/workflows/ci.yml'], repoRoot), true);
  // No workflows dir available → fail-safe to external, never auto-ours.
  assert.equal(isOursFinding(['.github/workflows/ci.yml'], 'Z:/nonexistent-root'), false);
});

test('buildIssueBody: status board — needs action / informational split, no false TODOs', () => {
  const repoRoot = process.cwd(); // the real repo: .github/workflows exists
  const body = buildIssueBody({
    findings: [
      {
        message: 'a | b',
        level: 'notice',
        workflows: ['E2E'],
        paths: ['.github/workflows/e2e.yml'],
        jobs: 2,
      },
      {
        message: MIGRATION_NOTICE,
        level: 'notice',
        workflows: ['pages build and deployment'],
        paths: [],
        jobs: 1,
      },
    ],
    announcements: [
      {
        number: 14748,
        title: '[Ubuntu] ubuntu-latest → 26.04',
        url: 'https://x/14748',
        updated_at: '2026-09-17',
      },
    ],
    runUrl: 'https://github.com/onemen/firefox-scripts/actions/runs/1',
    generatedAt: '2026-09-20T00:00:00Z',
    lookbackDays: 8,
    repoRoot,
  });
  // Counts strip first.
  assert.match(body, /🔧 \*\*1\*\* needs action/);
  assert.match(body, /👀 \*\*1\*\* informational/);
  // Ours renders under Needs action WITH a checkbox; section membership is
  // pinned (the row text alone is section-agnostic).
  const oursSection = body.split('### 👀')[0];
  assert.match(oursSection, /### 🔧 Needs action/);
  assert.match(oursSection, /- \[ \] a \\\| b/);
  // External renders as informational — 👀 and NO checkbox (an empty box must
  // never read as a TODO on a row no commit here can fix).
  const infoSection = body.split('### 👀 Informational')[1] ?? '';
  assert.match(infoSection, /- 👀 The ubuntu-latest label will migrate/);
  assert.doesNotMatch(infoSection, /- \[ \]/);
  // Announcements live in a collapsed list without checkboxes.
  assert.match(body, /<summary>📡 Upstream announcements/);
  assert.match(body, /\[#14748\]/);
  const annSection = body.split('<summary>📡')[1] ?? '';
  assert.doesNotMatch(annSection, /- \[ \]/);
  // House rules collapsed too.
  assert.match(body, /House rules: hosted-runner labels are pinned/);
  // Ledger present; dates recorded for both findings + the announcement.
  const ledger = parseLedger(body);
  assert.equal(Object.keys(ledger.firstSeen).length, 3);
  assert.deepEqual(ledger.handled, {});
});

test('buildIssueBody: ticking moves a finding to the checked Fixed section', () => {
  const repoRoot = process.cwd();
  const first = buildIssueBody({
    findings: [
      {
        message: MIGRATION_NOTICE,
        level: 'notice',
        workflows: ['CI'],
        paths: ['.github/workflows/ci.yml'],
        jobs: 1,
      },
    ],
    announcements: [],
    runUrl: 'r1',
    generatedAt: '2026-09-13T00:00:00Z',
    lookbackDays: 8,
    repoRoot,
  });
  // Human ticks the box (the same edit a maintainer makes on GitHub).
  const ticked = first.replace('- [ ]', '- [x]');
  const second = buildIssueBody({
    findings: [
      {
        message: MIGRATION_NOTICE,
        level: 'notice',
        workflows: ['CI'],
        paths: ['.github/workflows/ci.yml'],
        jobs: 1,
      },
    ],
    announcements: [],
    runUrl: 'r2',
    generatedAt: '2026-09-20T00:00:00Z',
    lookbackDays: 8,
    repoRoot,
    previousBody: ticked,
  });
  // Needs action is empty now; the finding renders CHECKED in Fixed.
  const needsSection = second.split('### ✅')[0];
  assert.match(needsSection, /_Nothing — all clear on our workflows\._/);
  const fixedSection = (second.split('### ✅ Fixed / handled')[1] ?? '').split('### 👀')[0];
  assert.match(fixedSection, /- \[x\] ✅ ~~The ubuntu-latest label will migrate/);
  assert.match(fixedSection, /firing since 2026-09-13/); // persisted, not today
  assert.match(fixedSection, /handled 2026-09-20/);
  const ledger = parseLedger(second);
  assert.ok(ledger.handled[findingId(MIGRATION_NOTICE)]);
});

test('buildIssueBody: unticking a fixed row reopens it', () => {
  const repoRoot = process.cwd();
  const first = buildIssueBody({
    findings: [
      {
        message: MIGRATION_NOTICE,
        level: 'notice',
        workflows: ['CI'],
        paths: ['.github/workflows/ci.yml'],
        jobs: 1,
      },
    ],
    announcements: [],
    runUrl: 'r1',
    generatedAt: '2026-09-13T00:00:00Z',
    lookbackDays: 8,
    repoRoot,
  });
  const ticked = first.replace('- [ ]', '- [x]');
  // The maintainer changes their mind: [x] back to [ ]. The ledger must not
  // silently re-tick on the next rewrite.
  const unticked = ticked.replace('- [x]', '- [ ]');
  const second = buildIssueBody({
    findings: [
      {
        message: MIGRATION_NOTICE,
        level: 'notice',
        workflows: ['CI'],
        paths: ['.github/workflows/ci.yml'],
        jobs: 1,
      },
    ],
    announcements: [],
    runUrl: 'r2',
    generatedAt: '2026-09-20T00:00:00Z',
    lookbackDays: 8,
    repoRoot,
    previousBody: unticked,
  });
  assert.match(second, /### 🔧 Needs action/);
  assert.match(second, /- \[ \] The ubuntu-latest label/);
  assert.doesNotMatch(second, /- \[x\]/);
  assert.doesNotMatch(second, /### ✅ Fixed/);
});

test('buildIssueBody: a stop-firing finding drops out of the board entirely', () => {
  const repoRoot = process.cwd();
  const withFinding = buildIssueBody({
    findings: [
      {
        message: MIGRATION_NOTICE,
        level: 'notice',
        workflows: ['CI'],
        paths: ['.github/workflows/ci.yml'],
        jobs: 1,
      },
    ],
    announcements: [],
    runUrl: 'r1',
    generatedAt: '2026-09-13T00:00:00Z',
    lookbackDays: 8,
    repoRoot,
  });
  const ticked = withFinding.replace('- [ ]', '- [x]');
  const afterClear = buildIssueBody({
    findings: [],
    announcements: [],
    runUrl: 'r2',
    generatedAt: '2026-09-27T00:00:00Z',
    lookbackDays: 8,
    repoRoot,
    previousBody: ticked,
  });
  // No zombie rows: the stale tick must not resurrect the finding (and the
  // issue can auto-close when the scan is all-clear).
  assert.doesNotMatch(afterClear, /- \[x\]/);
  assert.match(afterClear, /🔧 nothing needs action/);
  assert.match(afterClear, /_Nothing — all clear on our workflows\._/);
});

test('buildIssueBody: all-clear board when nothing was found', () => {
  const body = buildIssueBody({
    findings: [],
    announcements: [],
    runUrl: 'r',
    generatedAt: 'g',
    lookbackDays: 8,
  });
  assert.match(body, /🔧 nothing needs action/);
  assert.match(body, /_Nothing — all clear on our workflows\._/);
  assert.match(body, /_No open announcements in the window\._/);
});

/** Route-table fetch stub: path regex → response builder (may throw). */
function fakeFetch(routes) {
  const calls = [];
  const fn = async path => {
    calls.push(path);
    const handler = routes.find(([re]) => re.test(path));
    if (!handler) throw new Error(`no route for ${path}`);
    return handler[1](path);
  };
  fn.calls = calls;
  return fn;
}

test('scanRunAnnotations: newest run per workflow; per-job API failures tolerated', async () => {
  const routes = [
    [
      /\/actions\/runs\?/,
      () => ({
        workflow_runs: [
          {
            id: 1,
            name: 'E2E',
            path: '.github/workflows/e2e.yml',
            created_at: '2026-09-19T10:00:00Z',
          },
          {
            id: 2,
            name: 'E2E',
            path: '.github/workflows/e2e.yml',
            created_at: '2026-09-18T10:00:00Z',
          },
          {id: 3, name: 'CI', path: '.github/workflows/ci.yml', created_at: '2026-09-19T11:00:00Z'},
        ],
      }),
    ],
    [
      /\/actions\/runs\/1\/jobs/,
      () => ({
        jobs: [
          {id: 11, name: 'leg a'},
          {id: 12, name: 'leg b'},
        ],
      }),
    ],
    [
      /\/actions\/runs\/3\/jobs/,
      () => {
        throw new Error('HTTP 500');
      },
    ],
    [
      /\/check-runs\/11\/annotations/,
      () => [{annotation_level: 'notice', message: MIGRATION_NOTICE}],
    ],
    [
      /\/check-runs\/12\/annotations/,
      () => {
        throw new Error('HTTP 502');
      },
    ],
  ];
  const fetchJson = fakeFetch(routes);
  const {findings, scannedWorkflows, incomplete} = await scanRunAnnotations(fetchJson, {
    repo: 'onemen/firefox-scripts',
    now: new Date('2026-09-20T00:00:00Z'),
  });

  // The older E2E run is skipped; the CI workflow is still counted even though
  // its jobs listing failed.
  assert.equal(scannedWorkflows, 2);
  // Proves the older run was never fetched (no vacuous-some() pass).
  assert.equal(
    fetchJson.calls.some(p => p.includes('/actions/runs/2/jobs')),
    false
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].message, MIGRATION_NOTICE);
  assert.deepEqual(findings[0].workflows, ['E2E']);
  assert.equal(findings[0].jobs, 1);
  // A failed jobs listing / annotations call means the scan is INCOMPLETE —
  // callers must not treat the empty-ish result as an all-clear.
  assert.equal(incomplete, true);
});

test('scanRunAnnotations: all lookups succeed → incomplete is false', async () => {
  const routes = [
    [
      /\/actions\/runs\?/,
      () => ({
        workflow_runs: [
          {
            id: 1,
            name: 'E2E',
            path: '.github/workflows/e2e.yml',
            created_at: '2026-09-19T10:00:00Z',
          },
        ],
      }),
    ],
    [/\/actions\/runs\/1\/jobs/, () => ({jobs: [{id: 11, name: 'leg a'}]})],
    [/\/check-runs\/11\/annotations/, () => []],
  ];
  const fetchJson = fakeFetch(routes);
  const {findings, incomplete} = await scanRunAnnotations(fetchJson, {
    repo: 'onemen/firefox-scripts',
    now: new Date('2026-09-20T00:00:00Z'),
  });
  assert.deepEqual(findings, []);
  assert.equal(incomplete, false);
});
