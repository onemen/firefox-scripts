#!/usr/bin/env node

import {createHash} from 'node:crypto';
import {readdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

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
 *   when a later run is all-clear) — the skills-watchdog pattern. The issue
 *   body is a self-maintaining triage view: findings are split "ours" vs
 *   "external (GitHub-managed)", carry first-seen dates, and humans mark
 *   findings handled by ticking a checkbox — that state survives every body
 *   rewrite in an HTML-comment JSON ledger at the end of the body.
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
// Relative paths only — makeFetchJson prepends API_ROOT.
const IMAGES_SEARCH_URL = `/search/issues?q=${encodeURIComponent(
  `repo:${IMAGES_REPO} is:issue is:open label:Announcement`
)}&sort=updated&order=desc&per_page=10`;
const ISSUE_TITLE = '[runner-watchdog] CI runner deprecations';
const ISSUE_LABEL = 'runner-watchdog';
const LOOKBACK_DAYS = 8;
const RUNS_PER_PAGE = 100;
/** The machine-readable state blob at the end of every tracking-issue body. */
const LEDGER_COMMENT_RE = /<!--\s*runner-watchdog:ledger\s+([\s\S]*?)-->/;

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
      if (item.path && !existing.paths.includes(item.path)) existing.paths.push(item.path);
    } else {
      byMessage.set(key, {
        message: key,
        level: item.level,
        workflows: [item.workflow],
        paths: item.path ? [item.path] : [],
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
 * Stable id for a finding/announcement: sha256 of its text. The ledger keys on
 * this so a finding survives body rewrites (and formatting jitter in the "seen
 * in" column) without a human re-triaging it.
 *
 * @param {string} message
 * @returns {string}
 */
export function findingId(message) {
  return createHash('sha256').update(message.trim()).digest('hex').slice(0, 12);
}

/**
 * Classify a finding: does it come from a workflow file THIS REPO controls, or
 * from a GitHub-managed run ("pages build and deployment", Dependabot's own
 * checks) that no commit here can change?
 *
 * The reliable signal is the run's `path` (`.github/workflows/<file>`): a
 * dependabot-branch run of OUR ci.yml reports the PR title as its name but
 * still carries our path, while managed workflows have no repo file at all.
 * Ambiguity (no paths, no tree) classifies as EXTERNAL — informational, never
 * silently dismissed as ours.
 *
 * @param {string[]} runPaths run.path values, e.g. ['.github/workflows/ci.yml']
 * @param {string} repoRoot
 * @returns {boolean} true when at least one path is a repo-controlled workflow
 */
export function isOursFinding(runPaths, repoRoot) {
  if (runPaths.length === 0) return false;
  let names = [];
  try {
    names = new Set(readdirSync(path.join(repoRoot, '.github', 'workflows')));
  } catch {
    return false; // no tree available (partial checkout) — informational only
  }
  return runPaths.some(p => names.has(p.replace(/^\.github\/workflows\//, '')));
}

/**
 * Read the previous triage state from a tracking-issue body. Two sources,
 * merged with the rendered checkboxes winning:
 *
 * 1. the ledger comment blob (first-seen dates + handled entries with dates);
 * 2. the RENDERED `- [x]` checkboxes — a maintainer ticks the visible box, but the
 *    blob in that same body still says unticked, so the tick must be harvested
 *    from the row itself (the row's finding id is recomputed from its message
 *    text).
 *
 * Unknown/corrupt ledger → fresh state (nothing lost that a new scan would not
 * re-derive).
 *
 * @param {string | null | undefined} previousBody
 * @returns {{
 *   handled: Record<string, {note?: string; at: string}>;
 *   firstSeen: Record<string, string>;
 * }}
 */
export function parseLedger(previousBody) {
  const body = previousBody ?? '';
  const handled = {};
  const firstSeen = {};
  const m = LEDGER_COMMENT_RE.exec(body);
  if (m) {
    try {
      const parsed = JSON.parse(m[1].trim());
      Object.assign(firstSeen, parsed.firstSeen ?? {});
      Object.assign(handled, parsed.handled ?? {});
    } catch {
      // corrupt blob — the checkbox harvest below still works
    }
  }
  // Harvest ticks from the rendered rows (checkboxes are the human's edit).
  // Line-prefix check + string slicing keeps this free of the nested-optional
  // regex shape the security lint (rightly) flags. Announcement rows start
  // with [#N](url) and key as `ann-N`; finding rows key on the sha256 of
  // their message text.
  for (const line of body.split('\n')) {
    if (!line.startsWith('- [x] ')) continue;
    const rest = line.slice('- [x] '.length);
    const annMatch = /^\[#(\d+)\]\(/.exec(rest);
    let id;
    if (annMatch) {
      id = `ann-${annMatch[1]}`;
    } else {
      const sep = rest.indexOf(' — _first seen ');
      const text = (sep === -1 ? rest : rest.slice(0, sep)).replaceAll('\\|', '|');
      id = findingId(text);
    }
    const seenMatch = /_first seen (\d{4}-\d{2}-\d{2})/.exec(rest);
    const at = seenMatch?.[1] ?? handled[id]?.at ?? '';
    handled[id] = {at, note: handled[id]?.note};
  }
  return {handled, firstSeen};
}

/**
 * The rolling tracking issue body: a self-maintaining triage view. Pure string
 * building — unit-tested. Findings split "ours" (actionable in this repo) vs
 * "external" (GitHub-managed workflows; informational), each with a checkbox a
 * human can tick to mark it handled. Ticks, notes and first-seen dates persist
 * across rewrites in the HTML-comment ledger at the end of the body.
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
 *   repoRoot?: string;
 *   previousBody?: string | null;
 * }} parts
 * @returns {string}
 */
export function buildIssueBody({
  findings,
  announcements,
  runUrl,
  generatedAt,
  lookbackDays,
  repoRoot = process.cwd(),
  previousBody = null,
}) {
  const {handled, firstSeen: prevSeen} = parseLedger(previousBody);
  const today = generatedAt.slice(0, 10);

  // Rows with id + tick state; first-seen merges previous ledger with today.
  const findingRows = findings.map(f => {
    const id = findingId(f.message);
    return {...f, id, handled: Boolean(handled[id]), firstSeen: prevSeen[id] ?? today};
  });
  const announcementRows = announcements.map(a => {
    const key = `ann-${a.number}`;
    return {...a, id: key, handled: Boolean(handled[key]), firstSeen: prevSeen[key] ?? today};
  });

  // ours vs external — the actionable/noise split the maintainer asked for.
  const ours = findingRows.filter(f => isOursFinding(f.workflows, repoRoot));
  const external = findingRows.filter(f => !ours.includes(f));
  const oursAnnouncements = announcementRows.filter(a => !a.handled);
  const handledEverything = [
    ...findingRows.filter(f => f.handled),
    ...announcementRows.filter(a => a.handled),
  ];

  const esc = s => s.replaceAll('|', '\\|');
  const row = f =>
    `- [${f.handled ? 'x' : ' '}] ${esc(f.message)} — _first seen ${f.firstSeen}, last seen ${today}_`;
  const annRow = a =>
    `- [${a.handled ? 'x' : ' '}] [#${a.number}](${a.url}) ${esc(a.title)} — _first seen ${a.firstSeen}, updated ${a.updated_at}_`;

  const lines = [
    '<!-- runner-watchdog:status -->',
    '## 🏃 Runner watchdog — CI deprecations & image migrations',
    '',
    `_Scanned the newest run of every workflow from the last ${lookbackDays} days ` +
      `(check-run annotations) and the open \`Announcement\` issues of ` +
      `[actions/runner-images](https://github.com/${IMAGES_REPO}/issues?q=label%3AAnnouncement). ` +
      `Generated ${generatedAt} from [this run](${runUrl}). ` +
      `Ticks below are yours to set: mark an item \`[x]\` when triaged/handled — ` +
      `the watchdog preserves your ticks on every rewrite (and unticks anything that stops firing). ` +
      `**Ours** = a workflow file in this repo (actionable). **External** = GitHub-managed ` +
      `(pages build and deployment, Dependabot) — no commit here can change it; it clears when GitHub clears it._`,
    '',
  ];

  lines.push('### Ours — actionable in this repo', '');
  if (ours.length === 0) lines.push('_No open findings from our own workflows._');
  else for (const f of ours) lines.push(row(f));

  lines.push('', '### External (GitHub-managed — informational)', '');
  if (external.length === 0) lines.push('_No open findings from GitHub-managed workflows._');
  else for (const f of external) lines.push(row(f));

  lines.push('', '### actions/runner-images announcements (open, updated in the window)', '');
  if (oursAnnouncements.length === 0) lines.push('_No new announcements in the window._');
  else for (const a of oursAnnouncements) lines.push(annRow(a));

  if (handledEverything.length > 0) {
    lines.push(
      '',
      '<details>',
      '<summary>Handled (ticked by a maintainer; kept for provenance)</summary>',
      ''
    );
    for (const item of handledEverything) {
      lines.push(item.number === undefined ? row(item) : annRow(item));
    }
    lines.push('', '</details>');
  }

  lines.push(
    '',
    '### House rules',
    '',
    '- Hosted-runner labels are **pinned** where artifacts are shipped (`ubuntu-24.04`), with an',
    '  advisory `ubuntu-26.04` canary leg in ci.yml validating the next image.',
    '- Move pins forward only via a dedicated reviewed PR after the canary has been green.',
    '- Runner *labels* are not covered by Dependabot — this watchdog is their monitor.',
    ''
  );

  const ledger = {
    firstSeen: Object.fromEntries(
      findingRows.concat(announcementRows).map(f => [f.id, f.firstSeen])
    ),
    handled: Object.fromEntries(
      findingRows
        .concat(announcementRows)
        .filter(f => f.handled)
        .map(f => [f.id, {at: handled[f.id]?.at ?? today, note: handled[f.id]?.note}])
    ),
  };
  lines.push(`<!-- runner-watchdog:ledger ${JSON.stringify(ledger)} -->`);
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
  // Any lookup failure makes the scan INCOMPLETE — the caller must not treat an
  // incomplete scan as all-clear (a failed lookup can hide the active warning).
  let incomplete = false;
  for (const run of newestPerWorkflow.values()) {
    const workflow = run.name ?? run.path;
    let jobs;
    try {
      jobs = await fetchJson(`/repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`);
    } catch (error) {
      warnLog(`runner-watchdog: jobs listing failed for ${workflow}: ${error.message}`);
      incomplete = true;
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
              path: run.path ?? '',
              job: job.name,
            });
          }
        }
      } catch (error) {
        warnLog(`runner-watchdog: annotations failed for job ${job.name}: ${error.message}`);
        incomplete = true;
      }
    }
  }
  return {findings: collectFindings(raw), scannedWorkflows: newestPerWorkflow.size, incomplete};
}

/** Search the open Announcement issues of actions/runner-images. */
export async function scanRunnerImageAnnouncements(fetchJson, {sinceIso}) {
  const result = await fetchJson(IMAGES_SEARCH_URL);
  return filterAnnouncementIssues(result.items ?? [], sinceIso);
}

/** Find the open rolling tracking issue, if any. */
async function findOpenTrackingIssue(fetchJson, repo) {
  const query = encodeURIComponent(`repo:${repo} is:issue is:open in:title "${ISSUE_TITLE}"`);
  const result = await fetchJson(`/search/issues?q=${query}&per_page=1`);
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

  const {
    findings,
    scannedWorkflows,
    incomplete: scanIncomplete,
  } = await scanRunAnnotations(fetchJson, {repo});
  let announcements = [];
  let announcementsIncomplete = false;
  try {
    announcements = await scanRunnerImageAnnouncements(fetchJson, {
      sinceIso: new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString(),
    });
  } catch (error) {
    warnLog(`runner-watchdog: announcement search failed: ${error.message}`);
    announcementsIncomplete = true;
  }
  const incomplete = scanIncomplete || announcementsIncomplete;

  log(
    `runner-watchdog: ${scannedWorkflows} workflow(s) scanned, ` +
      `${findings.length} finding(s), ${announcements.length} announcement(s)` +
      (incomplete ? ' (INCOMPLETE — a lookup failed; issue state unchanged)' : '')
  );

  if (mode === 'pr') {
    // Stateless and always green: findings become annotations on this run.
    for (const f of findings) emitWarning(`${f.message} (seen in ${f.workflows.join(', ')})`);
    for (const a of announcements)
      emitWarning(`actions/runner-images announcement: ${a.title} (${a.url})`);
    if (incomplete) emitWarning('runner-watchdog: scan incomplete — a lookup failed');
    return;
  }

  // The previous body carries the triage ledger (ticks + first-seen dates) —
  // fetch it BEFORE rebuilding so human state survives the rewrite.
  const existing = await findOpenTrackingIssue(fetchJson, repo);
  let previousBody = null;
  if (existing) {
    try {
      const full = await fetchJson(`/repos/${repo}/issues/${existing.number}`);
      previousBody = full.body ?? null;
    } catch (error) {
      warnLog(`runner-watchdog: fetching the tracking issue body failed: ${error.message}`);
    }
  }

  const body = buildIssueBody({
    findings,
    announcements,
    runUrl,
    generatedAt,
    lookbackDays: LOOKBACK_DAYS,
    repoRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
    previousBody,
  });

  if (process.argv.includes('--dry-run')) {
    log('--- issue body (dry run) ---');
    log(body);
    return;
  }

  const hasContent = findings.length > 0 || announcements.length > 0;
  if (!hasContent && !incomplete) {
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
  if (!hasContent && incomplete) {
    // The scan could not see everything — an empty result is NOT an all-clear.
    // Leave any open tracking issue untouched so a live warning is not hidden,
    // and log the failure for the run log (already warned per-lookup).
    log('runner-watchdog: scan incomplete with no findings — keeping any open tracking issue open');
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
