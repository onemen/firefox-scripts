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

test('buildIssueBody: renders the findings table with escaped pipes and guidance', () => {
  const body = buildIssueBody({
    findings: [{message: 'a | b', level: 'notice', workflows: ['E2E'], jobs: 2}],
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
  });
  assert.match(body, /a \\\| b/);
  assert.match(body, /#14748/);
  assert.match(body, /ubuntu-24\.04/);
  assert.match(body, /advisory `ubuntu-26\.04` canary/);
  assert.match(body, /not covered by Dependabot/);
});

test('buildIssueBody: all-clear wording when nothing was found', () => {
  const body = buildIssueBody({
    findings: [],
    announcements: [],
    runUrl: 'r',
    generatedAt: 'g',
    lookbackDays: 8,
  });
  assert.match(body, /No migration\/deprecation annotations found/);
  assert.match(body, /No new actions\/runner-images Announcement issues/);
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
