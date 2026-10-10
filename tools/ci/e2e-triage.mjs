#!/usr/bin/env node

/**
 * tools/ci/e2e-triage.mjs — file (and auto-close) the nightly revalidation
 * issue.
 *
 * The nightly E2E run is the only E2E run `main` gets: e2e.yml's own `push:
 * [main]` and `schedule:` triggers are gone, and the url-watchdog dispatches
 * one full run a night. That makes a red leg there invisible unless someone
 * happens to be reading the Actions UI — the coverage it replaces at least
 * turned a push red in the maintainer's face.
 *
 * So the run converts its own failures into one deduped issue, and closes it
 * again on a green night — the same self-healing shape the url-watchdog uses
 * for vendor rot. Reads the run's job list through the API rather than `needs`,
 * so the job stays one entry in the workflow and can never grow the gate's
 * needs list.
 *
 * Dedupe: the title carries a 12-char hash of the SORTED failed-leg names, so a
 * second night with the same failures comments on the existing issue (at most
 * one comment per 24 h) instead of opening a duplicate, while a night with a
 * DIFFERENT failure set opens its own issue — a stale "updater failed" issue
 * must not hide a new "installer failed" one.
 *
 * Exit code 0 = triaged (or nothing to triage). Run from the `e2e-triage` job.
 * Local dry run: `node tools/ci/e2e-triage.mjs --dry-run`.
 */

import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

// The per-browser discovery contract (#136 rework): the watchdog's table links
// `[e2e-triage] failed updater legs · <browser>` — import the title-maker from
// the reporting layer so both sides cannot drift (script runs from its own
// repo root; resolve the sibling module explicitly).
const HERE = path.dirname(fileURLToPath(import.meta.url));
const {triageIssueTitle, VALIDATED_BROWSERS} = await import(
  pathToFileURL(path.join(HERE, 'watchdog-report.mjs')).href
);

/** The job that runs this script — never a failed "leg" of its own report. */
export const TRIAGE_JOB_NAME = 'triage nightly revalidation';

/** The aggregate gate: it fails because a leg failed, so it is never the news. */
export const GATE_JOB_NAME = 'E2E gate';

/** Every triage issue title starts with this — the close-on-green selector. */
export const TRIAGE_TITLE_PREFIX = '[e2e nightly]';

/**
 * Label for the triage issues. Deliberately NOT the watchdog's `url-watchdog`
 * label: that surface has its own close-on-green sweep, and a nightly E2E
 * failure must not be swept away by a green vendor check.
 */
export const TRIAGE_LABEL = 'e2e-nightly';

/**
 * Conclusions that mean "this leg did not validate anything". `skipped` is
 * deliberately absent: a path-filtered leg is a legitimate outcome, not a
 * failure, and the nightly dispatch forces the full set anyway. `cancelled` is
 * absent too — a cancelled run validated nothing, and its triage job is
 * cancelled with it (a leg cancelled inside a live run means the run is going
 * away, not that the code is broken).
 */
export const FAILED_CONCLUSIONS = new Set([
  'failure',
  'timed_out',
  'startup_failure',
  'action_required',
]);

/**
 * The failed legs of a run, sorted by name. The gate and this job itself are
 * excluded: both fail as a CONSEQUENCE of a leg failing.
 *
 * @param {{name: string; conclusion: string; html_url?: string}[]} jobs
 * @returns {{name: string; conclusion: string; html_url: string}[]}
 */
export function failedLegs(jobs) {
  return jobs
    .filter(
      job =>
        FAILED_CONCLUSIONS.has(job.conclusion) &&
        job.name !== TRIAGE_JOB_NAME &&
        job.name !== GATE_JOB_NAME
    )
    .map(job => ({name: job.name, conclusion: job.conclusion, html_url: job.html_url ?? ''}))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The identity of a failure set: the leg names, sorted then hashed. Sorting is
 * done HERE, not only by the caller — the identity must not depend on the order
 * GitHub happens to list the jobs in.
 *
 * @param {{name: string}[]} legs
 * @returns {string} 12 hex chars
 */
export function failuresHash(legs) {
  return createHash('sha256')
    .update(
      legs
        .map(leg => leg.name)
        .sort((a, b) => a.localeCompare(b))
        .join('\n')
    )
    .digest('hex')
    .slice(0, 12);
}

/**
 * The deduped issue title for one failure set.
 *
 * @param {{name: string}[]} legs
 * @returns {string}
 */
export function triageTitle(legs) {
  const n = legs.length;
  return `${TRIAGE_TITLE_PREFIX} ${n} leg${n === 1 ? '' : 's'} failed — ${failuresHash(legs)}`;
}

/**
 * Is this an open triage issue? Prefix match only: the hash identifies the
 * failure set, and a green night closes every open one regardless of hash.
 *
 * @param {string} title
 * @returns {boolean}
 */
export function isTriageIssueTitle(title) {
  return typeof title === 'string' && title.startsWith(TRIAGE_TITLE_PREFIX);
}

/**
 * The per-browser issues' title shape (`[e2e-triage] failed updater legs ·
 * <browser>` — triageIssueTitle in watchdog-report.mjs): same label, same
 * close-on-green sweep, distinct prefix so the two shapes stay apart.
 *
 * @param {string} title
 * @returns {boolean}
 */
export function isPerBrowserTriageTitle(title) {
  return typeof title === 'string' && title.startsWith(triageIssueTitle(''));
}

/**
 * One GitHub REST call.
 *
 * @param {string} token
 * @param {string} pathname
 * @param {{method?: string; body?: object}} [opts]
 * @returns {Promise<any>} parsed JSON
 */
async function ghApi(token, pathname, {method = 'GET', body} = {}) {
  const res = await fetch(`https://api.github.com${pathname}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? {'Content-Type': 'application/json'} : {}),
    },
    ...(body ? {body: JSON.stringify(body)} : {}),
    signal: AbortSignal.timeout(30_000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`GitHub API ${method} ${pathname}: HTTP ${res.status} ${json.message || ''}`);
  }
  return json;
}

/**
 * Every job of one run (paged — a full nightly run is ~40 jobs, but the page
 * size is a GitHub constant, not ours).
 *
 * @param {string} token
 * @param {string} repo
 * @param {string} runId
 * @returns {Promise<{name: string; conclusion: string; html_url?: string}[]>}
 */
async function listRunJobs(token, repo, runId) {
  const jobs = [];
  for (let page = 1; ; page++) {
    const body = await ghApi(
      token,
      `/repos/${repo}/actions/runs/${runId}/jobs?per_page=100&page=${page}`
    );
    jobs.push(...(body.jobs ?? []));
    if (jobs.length >= (body.total_count ?? 0) || (body.jobs ?? []).length === 0) break;
  }
  return jobs;
}

/**
 * The open triage issues, oldest first: BOTH title shapes — the aggregate `[e2e
 * nightly] …` issues and the per-browser `[e2e-triage] failed updater legs ·
 * <browser>` ones the watchdog's status table links to. The dedup check and the
 * green-night close loop both iterate this list, and a per-browser title that
 * never matched caused a duplicate issue per failing night that no green night
 * ever closed.
 *
 * @param {string} token
 * @param {string} repo
 * @returns {Promise<{number: number; title: string}[]>}
 */
async function openTriageIssues(token, repo) {
  const open = await ghApi(
    token,
    `/repos/${repo}/issues?state=open&labels=${TRIAGE_LABEL}&per_page=100`
  );
  return open
    .filter(issue => isTriageIssueTitle(issue.title) || isPerBrowserTriageTitle(issue.title))
    .sort((a, b) => a.number - b.number);
}

/**
 * The issue body: what failed, where to look, and what closes it.
 *
 * @param {{name: string; conclusion: string; html_url: string}[]} legs
 * @param {string} runUrl
 * @returns {string}
 */
export function triageBody(legs, runUrl) {
  return [
    `Nightly revalidation: ${runUrl}`,
    '',
    'This is the only E2E run `main` gets (#380) — the workflow has no `push` or',
    '`schedule` trigger of its own, so a failure here is the whole signal.',
    '',
    '| Leg | Conclusion |',
    '| --- | --- |',
    ...legs.map(leg => `| \`${leg.name}\` | ${leg.conclusion} |`),
    '',
    'Re-run just the failing legs: `gh workflow run e2e.yml -f browser=<browser>`',
    '(or the full set with `-f browser=all`).',
    '',
    'This issue closes itself on the first green night.',
  ].join('\n');
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const token = process.env.GITHUB_TOKEN || '';
  const repo = process.env.GITHUB_REPOSITORY || '';
  const runId = process.env.GITHUB_RUN_ID || '';
  const server = process.env.GITHUB_SERVER_URL || 'https://github.com';
  if (!token || !repo || !runId) {
    throw new Error('GITHUB_TOKEN, GITHUB_REPOSITORY and GITHUB_RUN_ID are required');
  }
  const runUrl = `${server}/${repo}/actions/runs/${runId}`;

  const jobs = await listRunJobs(token, repo, runId);
  const legs = failedLegs(jobs);
  const open = await openTriageIssues(token, repo);

  if (legs.length === 0) {
    console.log(
      `${jobs.length} jobs, no failed legs — closing ${open.length} open triage issue(s)`
    );
    for (const issue of open) {
      console.log(`  close #${issue.number}: ${issue.title}`);
      if (dryRun) continue;
      await ghApi(token, `/repos/${repo}/issues/${issue.number}/comments`, {
        method: 'POST',
        body: {body: `Green nightly revalidation: ${runUrl} — closing.`},
      });
      await ghApi(token, `/repos/${repo}/issues/${issue.number}`, {
        method: 'PATCH',
        body: {state: 'closed', state_reason: 'completed'},
      });
    }
    return;
  }

  const title = triageTitle(legs);
  console.log(`${legs.length} failed leg(s): ${legs.map(leg => leg.name).join(', ')}`);
  const existing = open.find(issue => issue.title === title);
  if (existing) {
    // Same failure set as an already-open issue: append the fresh run link at
    // most once per 24 h (a nightly is nightly, not a flood), so the issue
    // stays actionable without a comment per run.
    const comments = await ghApi(
      token,
      `/repos/${repo}/issues/${existing.number}/comments?per_page=1&sort=created&direction=desc`
    );
    const last = comments[0];
    if (last && Date.now() - Date.parse(last.created_at) < 24 * 60 * 60 * 1000) {
      console.log(`  open issue already updated <24h ago: ${title}`);
    } else {
      console.log(`  comment on #${existing.number}: ${title}`);
      if (!dryRun) {
        await ghApi(token, `/repos/${repo}/issues/${existing.number}/comments`, {
          method: 'POST',
          body: {body: triageBody(legs, runUrl)},
        });
      }
    }
  } else {
    console.log(`  open issue: ${title}`);
    if (!dryRun) {
      await ghApi(token, `/repos/${repo}/issues`, {
        method: 'POST',
        body: {title, body: triageBody(legs, runUrl), labels: [TRIAGE_LABEL]},
      });
    }
  }

  // Per-browser issues (#136 rework): one issue per failed GATE browser with
  // the exact title the URL watchdog discovers while rendering #136's status
  // table (triageIssueTitle in watchdog-report.mjs) — the failed E2E-validated
  // cell links here. Advisory-only legs (a fork failure without any gate
  // browser failing) open none: nothing in the table would link them.
  const browsers = [
    ...new Set(
      legs
        .filter(leg => /updater|installer|portable-firefox|core-lifecycle/.test(leg.name))
        .map(browserOfLeg)
        .filter(Boolean)
    ),
  ];
  for (const browser of browsers) {
    const perTitle = triageIssueTitle(browser);
    if (open.some(issue => issue.title === perTitle)) continue;
    console.log(`  open per-browser issue: ${perTitle}`);
    if (dryRun) continue;
    await ghApi(token, `/repos/${repo}/issues`, {
      method: 'POST',
      body: {
        title: perTitle,
        body:
          `Failed nightly-revalidation updater legs for ${browser}:\n\n` +
          legs
            .filter(leg => browserOfLeg(leg) === browser)
            .map(leg => `- ${leg.name} (${leg.conclusion}) — ${leg.html_url || 'no link'}`)
            .join('\n') +
          `\n\nRun: ${runUrl}\n\n` +
          'The [url-watchdog] status table links here while this validation is owed; ' +
          'a green revalidation rewrites the validated-versions record and the table ' +
          'shows the ✅ run link again.',
        labels: [TRIAGE_LABEL],
      },
    });
  }

  // Recovery closes (#136 rework): on a night whose failures have ANOTHER
  // browser, the green close loop (legs.length === 0 above) never runs — a
  // per-browser issue for a browser that PASSED would stay open forever,
  // keep its stale ❌ triage link in the status table, and suppress
  // re-opening when it fails again. Close the ones this run did not fail
  // — and only when SOME gate leg actually validated this run: a run whose
  // every leg was cancelled/never-ran (FAILED_CONCLUSIONS is failure-shaped
  // only) validated nothing, and closing "recovered" on it would certify a
  // passing run behind the ❌ link that does not exist (batch #7 finding).
  const anySuccess = jobs.some(job => job.conclusion === 'success');
  const recovered = anySuccess ? recoveredPerBrowserIssues(open, browsers) : [];
  for (const issue of recovered) {
    console.log(`  close recovered per-browser issue: ${issue.title}`);
    if (dryRun) continue;
    await ghApi(token, `/repos/${repo}/issues/${issue.number}/comments`, {
      method: 'POST',
      body: {
        body:
          `This browser is not among this run's failed gate browsers and the run ` +
          `validated (a gate leg concluded success) — the recovery was partial ` +
          `(other legs still failed; see the aggregate issue). ` +
          `Nightly revalidation run: ${runUrl} — closing.`,
      },
    });
    await ghApi(token, `/repos/${repo}/issues/${issue.number}`, {
      method: 'PATCH',
      body: {state: 'closed', state_reason: 'completed'},
    });
  }
}

/**
 * The ledger browser a failed gate leg belongs to: `updater E2E · firefox ·
 * macos-latest` → `firefox`. Null for non-browser legs (snapshot, helper).
 */
/**
 * The open PER-BROWSER triage issues whose browser recovered: not among this
 * run's failed browsers AND the run validates something. A night with OTHER
 * failures never runs the green close loop (it needs legs.length === 0), so
 * this is the only recovery signal such a night gets — the stale issue would
 * keep the status table rendering its ❌ triage link for a browser whose record
 * now covers a passing run, and would suppress re-opening on a repeat failure.
 * A run that validated nothing (all legs cancelled or never ran — see
 * FAILED_CONCLUSIONS) passes no failedBrowsers but closes nothing: close
 * filtered by that condition in the caller (main()), not here (batch #7
 * finding).
 *
 * @param {{number: number; title: string}[]} open open triage issues
 * @param {string[]} failedBrowsers this run's failed gate browsers
 * @returns {{number: number; title: string; browser: string}[]}
 */
export function recoveredPerBrowserIssues(open, failedBrowsers) {
  const recovered = [];
  for (const issue of open) {
    if (!isPerBrowserTriageTitle(issue.title)) continue;
    const browser = issue.title.slice(triageIssueTitle('').length);
    if (failedBrowsers.includes(browser)) continue;
    recovered.push({...issue, browser});
  }
  return recovered;
}

export function browserOfLeg(leg) {
  // Leg names read 'updater E2E · firefox-dev · macos-latest' — the browser is
  // the exact '·'-separated SEGMENT, not a substring: a substring probe (and
  // VALIDATED_BROWSERS' firefox-first order) attributed firefox-dev failures
  // to firefox. Plain string splitting, no RegExp (the name is GitHub-served
  // data, and the reports gate flags non-literal RegExp constructors).
  const parts = String(leg?.name ?? '')
    .split('·')
    .map(segment => segment.trim());
  for (const browser of VALIDATED_BROWSERS) {
    if (parts.includes(browser)) return browser;
  }
  return null;
}

if (process.argv[1] && process.argv[1].endsWith('e2e-triage.mjs')) {
  main().catch(err => {
    console.error(`✗ Error: ${err.message}`);
    process.exit(1);
  });
}
