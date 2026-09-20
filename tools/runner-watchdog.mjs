#!/usr/bin/env node

/**
 * tools/runner-watchdog.mjs — CI runner/annotations watchdog.
 *
 * GitHub announces hosted-runner changes (image migrations, label deprecations,
 * …) as NOTICE annotations on workflow runs and as `Announcement` issues in
 * actions/runner-images. Nothing surfaces them to a maintainer who does not
 * happen to open a run page — and the annotations vanish from view once newer
 * runs stack on top. This watchdog makes them a tracked, deduped surface:
 *
 * - Weekly (schedule/dispatch): scans the latest run of every workflow from the
 *   lookback window, classifies notice/warning annotations that match
 *   migration/deprecation phrasing, and lists the open `Announcement` issues of
 *   actions/runner-images. Findings maintain ONE rolling tracking issue
 *   (`[runner-watchdog] CI runner deprecations`, deduped by title, auto-closed
 *   when a later run is all-clear) — the skills-watchdog pattern.
 * - PR (`--pr`): stateless and always green — the same scan runs read-only and
 *   findings surface as `::warning::` annotations, so the check can be required
 *   without ever blocking.
 * - `--dry-run`: print findings, no writes (API reads still happen).
 *
 * API access: `GITHUB_TOKEN` when set (CI), else unauthenticated (public
 * sources). Any lookup failure is reported and skipped, never a CI failure —
 * advisory by design, like the URL watchdog's fork legs (ADR 0017).
 *
 * Scan budget: one run per workflow (the newest in the window) × its jobs × one
 * annotations call per job ≈ 50-60 requests for this repo — well inside the
 * GITHUB_TOKEN rate limit at a weekly cadence.
 */

const API_ROOT = 'https://api.github.com';
const IMAGES_REPO = 'actions/runner-images';
const IMAGES_SEARCH_URL = `${API_ROOT}/search/issues?q=${encodeURIComponent(
  `repo:${IMAGES_REPO} is:issue is:open label:Announcement`
)}&sort=updated&order=desc&per_page=10`;
const ISSUE_TITLE = '[runner-watchdog] CI runner deprecations';
const ISSUE_LABEL = 'runner-watchdog';
const LOOKBACK_DAYS = 8;
const RUNS_PER_PAGE = 100;

/** True when running as the CLI entry point (vs imported by the unit tests). */
const isMain = process.argv[1] && process.argv[1].endsWith('runner-watchdog.mjs');

/** One line of log output, honuring the ambient CI formatting. */
const log = (...parts) => console.log(...parts);
const warnLog = (...parts) => console.warn(...parts);
const emitWarning = message => console.warn(`::warning::${message}`);

/**
 * The classification rule: which annotations does this watchdog surface? GitHub
 * attaches runner-image migration notices at `notice` level with stable
 * phrasing ("The ubuntu-latest label will migrate to Ubuntu 26 …"); match that
 * family broadly — any notice/warning mentioning a migration, deprecation,
 * retirement or a label change — so a NEW phrasing variant is still caught, at
 * the cost of the occasional informational extra.
 *
 * @param {{annotation_level?: string; message?: string}} annotation
 * @returns {boolean}
 */
export function isDeprecationAnnotation(annotation) {
  const level = annotation?.annotation_level;
  if (level !== 'notice' && level !== 'warning') return false;
  return /migrat|deprecat|retir|end[- ]of[- ]life|label will/i.test(annotation?.message ?? '');
}

/**
 * Collapse per-job annotations into deduped findings: the same migration notice
 * is attached to every job that ran on the affected label, and one row per
 * distinct message (with the jobs that carried it) reads far better than N
 * rows.
 *
 * @param {{
 *   message: string;
 *   level: string;
 *   workflow: string;
 *   job: string;
 * }[]} raw
 * @returns {{
 *   message: string;
 *   level: string;
 *   workflows: string[];
 *   jobs: number;
 * }[]}
 */
export function collectFindings(raw) {
  const byMessage = new Map();
  for (const item of raw) {
    const key = item.message.trim();
    const existing = byMessage.get(key);
    if (existing) {
      existing.jobs += 1;
      if (!existing.workflows.includes(item.workflow)) existing.workflows.push(item.workflow);
    } else {
      byMessage.set(key, {
        message: key,
        level: item.level,
        workflows: [item.workflow],
        jobs: 1,
      });
    }
  }
  return [...byMessage.values()];
}

/**
 * Keep only Announcement issues updated since `sinceIso` (the previous scan's
 * window edge); anything older was either reported or deliberately not reported
 * by an earlier run.
 *
 * @param {{
 *   number: number;
 *   title: string;
 *   html_url: string;
 *   updated_at: string;
 * }[]} issues
 * @param {string} sinceIso
 * @returns {{
 *   number: number;
 *   title: string;
 *   url: string;
 *   updated_at: string;
 * }[]}
 */
export function filterAnnouncementIssues(issues, sinceIso) {
  const since = Date.parse(sinceIso);
  return issues
    .filter(issue => Date.parse(issue.updated_at) > since)
    .map(({number, title, html_url, updated_at}) => ({
      number,
      title,
      url: html_url,
      updated_at,
    }));
}

/**
 * The rolling tracking issue body. Pure string building — unit-tested.
 *
 * @param {{
 *   findings: ReturnType<typeof collectFindings>;
 *   announcements: {
 *     number: number;
 *     title: string;
 *     url: string;
 *     updated_at: string;
 *   }[];
 *   runUrl: string;
 *   generatedAt: string;
 *   lookbackDays: number;
 * }} parts
 * @returns {string}
 */
export function buildIssueBody({findings, announcements, runUrl, generatedAt, lookbackDays}) {
  const lines = [
    '<!-- runner-watchdog:status -->',
    '## 🏃 Runner watchdog — CI deprecations & image migrations',
    '',
    `_Scanned the newest run of every workflow from the last ${lookbackDays} days ` +
      `(check-run annotations) and the open \`Announcement\` issues of ` +
      `[actions/runner-images](https://github.com/${IMAGES_REPO}/issues?q=label%3AAnnouncement). ` +
      `Generated ${generatedAt} from [this run](${runUrl})._`,
    '',
  ];
  if (findings.length === 0) {
    lines.push('**No migration/deprecation annotations found in the scanned runs.**');
  } else {
    lines.push('### Run annotations', '', '| Level | Message | Seen in |', '| --- | --- | --- |');
    for (const f of findings) {
      lines.push(
        `| ${f.level} | ${f.message.replaceAll('|', '\\|')} | ${f.workflows.join(', ')} (${f.jobs} job${f.jobs === 1 ? '' : 's'}) |`
      );
    }
  }
  if (announcements.length > 0) {
    lines.push('', '### actions/runner-images announcements (open, updated in the window)', '');
    for (const a of announcements) {
      lines.push(`- [#${a.number}](${a.url}) ${a.title} _(updated ${a.updated_at})_`);
    }
  } else {
    lines.push('', '_No new actions/runner-images Announcement issues in the window._');
  }
  lines.push(
    '',
    '### House rules',
    '',
    '- Hosted-runner labels are **pinned** where artifacts are shipped (`ubuntu-24.04`), with an',
    '  advisory `ubuntu-26.04` canary leg in ci.yml validating the next image.',
    '- Move pins forward only via a dedicated reviewed PR after the canary has been green.',
    '- Runner *labels* are not covered by Dependabot — this watchdog is their monitor.'
  );
  return lines.join('\n');
}

/** Minimal GitHub REST client over fetch; injectable in unit tests. */
export function makeFetchJson({token} = {}) {
  return async function fetchJson(path, init = {}) {
    const response = await fetch(`${API_ROOT}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        'accept': 'application/vnd.github+json',
        'user-agent': 'runner-watchdog',
        ...(init.body ? {'content-type': 'application/json'} : {}),
        ...(token ? {authorization: `Bearer ${token}`} : {}),
      },
      body: init.body,
    });
    if (!response.ok) {
      throw new Error(`${init.method ?? 'GET'} ${path} → HTTP ${response.status}`);
    }
    return response.json();
  };
}

/**
 * Scan the newest run of every workflow in the lookback window and return the
 * deduped deprecation findings.
 *
 * @param {(path: string) => Promise<any>} fetchJson
 * @param {{repo: string; now?: Date; lookbackDays?: number}} opts
 */
export async function scanRunAnnotations(
  fetchJson,
  {repo, now = new Date(), lookbackDays = LOOKBACK_DAYS}
) {
  const since = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();
  const runs = await fetchJson(
    `/repos/${repo}/actions/runs?per_page=${RUNS_PER_PAGE}&created=${encodeURIComponent('>=' + since)}`
  );
  // One run per workflow: the annotations repeat across runs of the same
  // workflow, and the newest is the authoritative current state.
  const newestPerWorkflow = new Map();
  for (const run of runs.workflow_runs ?? []) {
    const key = run.path ?? run.name;
    const prev = newestPerWorkflow.get(key);
    if (!prev || run.created_at > prev.created_at) newestPerWorkflow.set(key, run);
  }

  const raw = [];
  for (const run of newestPerWorkflow.values()) {
    const workflow = run.name ?? run.path;
    let jobs;
    try {
      jobs = await fetchJson(`/repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`);
    } catch (error) {
      warnLog(`runner-watchdog: jobs listing failed for ${workflow}: ${error.message}`);
      continue;
    }
    for (const job of jobs.jobs ?? []) {
      try {
        // For Actions jobs the job id IS the check-run id.
        const annotations = await fetchJson(`/repos/${repo}/check-runs/${job.id}/annotations`);
        for (const annotation of annotations) {
          if (isDeprecationAnnotation(annotation)) {
            raw.push({
              message: annotation.message ?? '',
              level: annotation.annotation_level ?? 'notice',
              workflow,
              job: job.name,
            });
          }
        }
      } catch (error) {
        warnLog(`runner-watchdog: annotations failed for job ${job.name}: ${error.message}`);
      }
    }
  }
  return {findings: collectFindings(raw), scannedWorkflows: newestPerWorkflow.size};
}

/** Search the open Announcement issues of actions/runner-images. */
export async function scanRunnerImageAnnouncements(fetchJson, {sinceIso}) {
  const result = await fetchJson(IMAGES_SEARCH_URL);
  return filterAnnouncementIssues(result.items ?? [], sinceIso);
}

/** Find the open rolling tracking issue, if any. */
async function findOpenTrackingIssue(fetchJson, repo) {
  const query = encodeURIComponent(`repo:${repo} is:issue is:open in:title "${ISSUE_TITLE}"`);
  const result = await fetchJson(`${API_ROOT}/search/issues?q=${query}&per_page=1`);
  return result.items?.[0] ?? null;
}

async function main({mode}) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY ?? 'onemen/firefox-scripts';
  const runUrl =
    process.env.RUN_URL ??
    `https://github.com/${repo}/actions/runs/${process.env.GITHUB_RUN_ID ?? 'local'}`;
  const fetchJson = makeFetchJson({token});
  const generatedAt = new Date().toISOString();

  const {findings, scannedWorkflows} = await scanRunAnnotations(fetchJson, {repo});
  let announcements = [];
  try {
    announcements = await scanRunnerImageAnnouncements(fetchJson, {
      sinceIso: new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString(),
    });
  } catch (error) {
    warnLog(`runner-watchdog: announcement search failed: ${error.message}`);
  }

  log(
    `runner-watchdog: ${scannedWorkflows} workflow(s) scanned, ` +
      `${findings.length} finding(s), ${announcements.length} announcement(s)`
  );

  if (mode === 'pr') {
    // Stateless and always green: findings become annotations on this run.
    for (const f of findings) emitWarning(`${f.message} (seen in ${f.workflows.join(', ')})`);
    for (const a of announcements)
      emitWarning(`actions/runner-images announcement: ${a.title} (${a.url})`);
    return;
  }

  const body = buildIssueBody({
    findings,
    announcements,
    runUrl,
    generatedAt,
    lookbackDays: LOOKBACK_DAYS,
  });

  if (process.argv.includes('--dry-run')) {
    log('--- issue body (dry run) ---');
    log(body);
    return;
  }

  const existing = await findOpenTrackingIssue(fetchJson, repo);
  const hasContent = findings.length > 0 || announcements.length > 0;
  if (!hasContent) {
    if (existing) {
      await fetchJson(`/repos/${repo}/issues/${existing.number}`, {
        method: 'PATCH',
        body: JSON.stringify({state: 'closed'}),
      });
      await fetchJson(`/repos/${repo}/issues/${existing.number}/comments`, {
        method: 'POST',
        body: JSON.stringify({
          body: `✓ all clear at ${runUrl} — auto-closed by the runner watchdog.`,
        }),
      });
      log(`runner-watchdog: closed tracking issue #${existing.number} (no findings)`);
    } else {
      log('runner-watchdog: no findings, no open tracking issue — nothing to do');
    }
    return;
  }

  if (existing) {
    await fetchJson(`/repos/${repo}/issues/${existing.number}`, {
      method: 'PATCH',
      body: JSON.stringify({body}),
    });
    log(`runner-watchdog: updated tracking issue #${existing.number}`);
  } else {
    await fetchJson(`/repos/${repo}/issues`, {
      method: 'POST',
      body: JSON.stringify({title: ISSUE_TITLE, body, labels: [ISSUE_LABEL]}),
    });
    log(`runner-watchdog: opened tracking issue (${ISSUE_TITLE})`);
  }
}

if (isMain) {
  const mode = process.argv.includes('--pr') ? 'pr' : 'weekly';
  main({mode}).catch(error => {
    // Advisory watchdog: a crash is a finding to read in the log, never a red CI run.
    warnLog(`runner-watchdog: run failed: ${error.message}`);
    process.exit(0);
  });
}
