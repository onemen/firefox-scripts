#!/usr/bin/env node

/**
 * tools/ci/e2eLegsTable.mjs — regenerate docs/e2e-legs.md from one real E2E
 * run.
 *
 * WHY To answer "how many legs block a merge", "which browser does this leg
 * cache" or "where did the wall-clock go", the workflow YAML plus a scroll
 * through the Actions UI is the only other source. Wall-clock work needs the
 * same two numbers every step: the leg list and the timing of one
 * representative run. This tool produces exactly that, so the doc is
 * regenerated rather than hand-maintained.
 *
 * WHAT IS DERIVED (never hand-written in the output)
 *
 * - The leg list, each leg's gate class, browser, OS, portable flag and cache key
 *   come from .github/workflows/e2e.yml: the gates' `required:` / `advisory:`
 *   contract (the required gate plus the warn-only advisory reporter), every
 *   job's `name:` template plus its matrix constraints, and the `with:` block
 *   of its setup-browser step.
 * - Durations and the wall-clock come from ONE run, read through the `gh` CLI.
 *
 * The only hand-written parts are JOB_PURPOSE (what each non-E2E job is FOR)
 * and the prose. An unclassified single-run job is a hard error, so the table
 * cannot silently lose a row when e2e.yml grows a job.
 *
 * USAGE node tools/ci/e2eLegsTable.mjs <run-id> [out.md]
 *
 * The run id is REQUIRED on purpose: the timing columns are a measurement, and
 * a hardcoded default would keep re-documenting a stale matrix the first time
 * e2e.yml changes. Pick one with: gh run list --workflow=e2e.yml --branch main
 * --limit 20
 *
 * A run is only a good reference when it actually RAN the legs (a docs-only PR
 * skips most of them), so prefer a `schedule` or a `push` on main, or a PR that
 * touched core/** or the updater packages.
 */

import {execFileSync} from 'node:child_process';
import {readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

import {load} from 'js-yaml';
import prettier from 'prettier';

import prettierConfig from '../../config/prettier.config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW_PATH = path.join(ROOT, '.github', 'workflows', 'e2e.yml');
const WATCHDOG_PATH = path.join(ROOT, 'tools', 'ci', 'watchdog-report.mjs');
const DOWNLOADS_PATH = path.join(ROOT, 'test', 'e2e', 'shared', 'downloads.mjs');
const DEFAULT_OUT = path.join(ROOT, 'docs', 'e2e-legs.md');

// docs/ sits one level below the repo root, so a link out of it climbs once.
const WORKFLOW_LINK = '../.github/workflows/e2e.yml';
const ACTION_LINK = '../.github/actions/setup-browser/action.yml';

/**
 * What each non-E2E job (a job with no matrix — one run, not N legs) is FOR. A
 * job the reference run contains but this map does not is a hard error, so the
 * table cannot quietly drop a row when e2e.yml grows a job.
 */
const JOB_PURPOSE = {
  'changes':
    'Path filter. Emits the per-family booleans the gate’s applicability and ' +
    'results entries read, so a docs-only PR skips the browser legs entirely.',
  'snapshot':
    'Builds the dev snapshot once; every leg restores it as an artifact instead ' +
    'of rebuilding it.',
  'esr-matrix':
    'Reads the watchdog baseline and prints the ESR leg matrix. Read-only, ' +
    'best-effort cache restore; esr-portable consumes the matrix.',
  'e2e-gate':
    'The E2E gate required check: verifies applicability + results and sets ' +
    'the branch-protection status.',
  'e2e-advisory':
    'Warn-only reporter for the advisory legs: emits ::warning:: per non-green ' +
    'advisory result and always exits 0 — never in branch protection.',
  'record-validation':
    'Records the exact browser versions the required legs installed. The publish ' +
    'pre-flight drift gate reads this, so a watchdog baseline refresh alone ' +
    'cannot satisfy it.',
  'record-fork-validation':
    'Same for the fork legs, so an unpinned fork leg installs the release a ' +
    'green leg validated instead of whatever is newest.',
  'snap-store-watch':
    'Snap store drift watchdog; re-publishes the snap when the store version ' +
    'drifts from the source.',
  'cleanup-ci-downloads':
    'Deletes the ci-downloads release a watchdog dispatch created. Never touches ' +
    'another release.',
  'e2e-triage':
    'Files the nightly revalidation’s deduped failure issue and closes it on a ' +
    'green night — the only E2E signal main gets (#380).',
};

// The three browser roles the watchdog keeps, read out of the module that owns
// them — parsed, never executed, so the doc does not depend on running the tool.
const WATCHDOG_SETS = {
  FORK_BROWSERS: /export const FORK_BROWSERS = \[([^\]]*)\]/,
  VALIDATED_BROWSERS: /export const VALIDATED_BROWSERS = \[([^\]]*)\]/,
  INFORMATIONAL_BROWSERS: /export const INFORMATIONAL_BROWSERS = \[([^\]]*)\]/,
};

/**
 * `${{ … }}` — the matrix placeholders inside a job's `name:` template. The
 * split form carries NO capture group on purpose: String.split splices capture
 * groups into its result, which would turn the literal list into [prefix, expr,
 * middle, …] instead of [prefix, middle, …].
 */
const EXPR_SPLIT_RE = /\$\{\{[^{}]*\}\}/;
const EXPR_ALL_RE = /\$\{\{([^}]*)\}\}/g;
const EXPR_ANY_RE = /\$\{\{[^{}]*\}\}/g;

/** runner label → `runner.os`, the token the cache keys are built from. */
/** Runner image → the key's lowercase os token (`runner.os`, lowercased). */
const OS_TAG = {ubuntu: 'linux', windows: 'windows', macos: 'macos'};

/** A leg that started more than this long after the first leg was queued. */
const QUEUE_THRESHOLD_MS = 60_000;

/**
 * Run `gh` and return its stdout.
 *
 * @param {string[]} args `gh` argv (no shell, so nothing is word-split)
 * @returns {string} stdout
 */
function gh(args) {
  try {
    return execFileSync('gh', args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 32 << 20,
    });
  } catch (err) {
    const detail = String(err.stderr || err.message || '').trim();
    throw new Error(`gh ${args.join(' ')} failed: ${detail || 'no output'}`, {cause: err});
  }
}

/**
 * The workflow's job map.
 *
 * @returns {Record<string, any>} job id → job
 */
function loadJobs() {
  const doc = /** @type {any} */ (load(readFileSync(WORKFLOW_PATH, 'utf8')));
  return doc.jobs ?? {};
}

/**
 * The gate contract: which job ids block a merge and which only warn. The
 * required gate owns `required:`; the advisory legs moved to the warn-only
 * `e2e-advisory` reporter, whose `advisory:` list is unioned in (it must define
 * no `required:` — pinned by `pnpm check:gates`).
 *
 * @param {Record<string, any>} jobs
 * @returns {{required: Set<string>; advisory: Set<string>}}
 */
function gateContract(jobs) {
  const withOf = gateId => {
    const step = (jobs[gateId]?.steps ?? []).find(s =>
      String(s?.uses ?? '').endsWith('verify-gate')
    );
    if (!step?.with)
      throw new Error(`${gateId} has no verify-gate step — gate contract unreadable`);
    return step.with;
  };
  const split = value =>
    new Set(
      String(value ?? '')
        .trim()
        .split(/\s+/)
        .filter(Boolean)
    );
  const requiredGate = withOf('e2e-gate');
  const advisoryGate = withOf('e2e-advisory');
  return {
    required: split(requiredGate.required),
    advisory: new Set([...split(requiredGate.advisory), ...split(advisoryGate.advisory)]),
  };
}

/**
 * A job's matrix constraints. `null` means "no matrix" (a single-run job); a
 * `null` inside the object means "not statically knowable" (a fromJSON dynamic
 * matrix), which leaves that axis unconstrained.
 *
 * @param {any} job
 * @returns {null | {
 *   os: null | string[];
 *   browser: null | string[];
 *   pairs: null | Set<string>;
 * }}
 */
function matrixOf(job) {
  const matrix = job?.strategy?.matrix;
  if (!matrix) return null;
  return {
    os: Array.isArray(matrix.os) ? matrix.os : null,
    browser: Array.isArray(matrix.browser) ? matrix.browser : jsonListFallback(matrix.browser),
    pairs:
      Array.isArray(matrix.include) ?
        new Set(
          matrix.include
            .filter(entry => entry && typeof entry === 'object')
            .map(entry => `${entry.browser}|${entry.os}`)
        )
      : null,
  };
}

/**
 * The literal list a `fromJSON(… || '["a", "b"]')` matrix falls back to — the
 * full matrix a non-dispatch run expands.
 *
 * @param {unknown} value the raw `matrix.browser` value
 * @returns {null | string[]} the list, or null when it is not statically
 *   readable
 */
function jsonListFallback(value) {
  if (typeof value !== 'string') return null;
  const m = /\|\|\s*'(\[[^\]]*\])'/.exec(value);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[1]);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Match a rendered run job name against a job's `name:` template.
 * Literal-string walking rather than a regex: the template comes from the
 * workflow, and a regex built from workflow text would need a lint
 * suppression.
 *
 * @param {string} template the job's `name:`, with `${{ }}` placeholders
 * @param {string} name the rendered name GitHub reports for one matrix leg
 * @returns {null | {values: string[]; exprs: string[]}} the placeholder values
 */
function matchTemplate(template, name) {
  const literals = template.split(EXPR_SPLIT_RE);
  const exprs = [...template.matchAll(EXPR_ALL_RE)].map(m => m[1].trim());
  if (!name.startsWith(literals[0])) return null;
  let pos = literals[0].length;
  const values = [];
  for (let i = 0; i < exprs.length; i++) {
    const sep = literals[i + 1];
    if (sep === '') {
      values.push(name.slice(pos));
      pos = name.length;
      continue;
    }
    const at = name.indexOf(sep, pos);
    if (at === -1) return null;
    values.push(name.slice(pos, at));
    pos = at + sep.length;
  }
  return pos === name.length ? {values, exprs} : null;
}

/**
 * The jobs the E2E gates evaluate — the required gate's `required:` plus the
 * advisory reporter's `advisory:` — in workflow declaration order. That set,
 * not "has a matrix", is what makes a job a leg: `snap-firefox` and
 * `updater-waterfox` render one job each and are still legs, while `snapshot`
 * and `esr-matrix` are gate entries that run once. Order matters: the first
 * candidate whose template AND matrix constraints accept a run job name owns
 * it. `updater` and `browser-matrix` render the same name shape (`updater E2E ·
 * <browser> · windows-latest`), so it is the matrix, not the name, that
 * separates them.
 *
 * @param {Record<string, any>} jobs
 * @param {{required: Set<string>; advisory: Set<string>}} gate
 * @returns {{jobId: string; name: string; matrix: any}[]}
 */
function legCandidates(jobs, gate) {
  const tracked = new Set([...gate.required, ...gate.advisory]);
  return Object.entries(jobs)
    .filter(([jobId, job]) => tracked.has(jobId) && typeof job?.name === 'string')
    .map(([jobId, job]) => ({jobId, name: job.name, matrix: matrixOf(job)}));
}

/**
 * Attribute one rendered run job to the workflow job that produced it.
 *
 * @param {string} name rendered job name from the run
 * @param {ReturnType<typeof legCandidates>} candidates
 * @returns {null | {
 *   jobId: string;
 *   browser: null | string;
 *   os: null | string;
 * }}
 */
function attribute(name, candidates) {
  for (const candidate of candidates) {
    const hit = matchTemplate(candidate.name, name);
    if (!hit) continue;
    let browser = null;
    let os = null;
    hit.exprs.forEach((expr, i) => {
      if (/matrix\.browser/.test(expr)) browser = hit.values[i];
      else if (/matrix\.os/.test(expr)) os = hit.values[i];
    });
    const m = candidate.matrix;
    if (m?.os && !m.os.includes(os)) continue;
    if (m?.browser && !m.browser.includes(browser)) continue;
    if (m?.pairs && !m.pairs.has(`${browser}|${os}`)) continue;
    return {jobId: candidate.jobId, browser, os};
  }
  return null;
}

/**
 * The `.github/actions/setup-browser` step of a job, if it has one — the single
 * copy of the resolve/cache/install group every browser leg shares.
 *
 * @param {any} job
 * @returns {null | any} the step
 */
function setupBrowserStep(job) {
  return (job?.steps ?? []).find(s => String(s?.uses ?? '').includes('setup-browser')) ?? null;
}

/**
 * The browser a leg installs: the `matrix.browser` its rendered name carries,
 * else the literal the setup-browser step is given. A leg with neither (snap —
 * it installs from the store) has no browser key.
 *
 * @param {any} job
 * @param {null | string} captured the `matrix.browser` value from the name
 * @returns {null | string} the downloads.mjs browser key
 */
function browserOf(job, captured) {
  if (captured) return captured;
  const input = setupBrowserStep(job)?.with?.browser;
  return typeof input === 'string' && !input.includes('${{') ? input : null;
}

/**
 * The cache-name half of a browser's keys (ADR 0045): the browser itself,
 * except for ESR, whose name is positional — the serving watched line is `esr`,
 * the line it replaced `esr-prev`. The runtime source of that order is
 * `esrCacheName()` in tools/ci/watchdog-report.mjs (the ESR matrix hands the
 * name to the leg); the table only sees the legs, so it derives the same
 * positions from the majors in the run it is documenting.
 *
 * @param {string} browser
 * @param {string[]} esrMajors the ESR browser keys in this run, lowest first
 * @returns {string}
 */
function cacheNameOf(browser, esrMajors) {
  if (!browser) return '<name>';
  if (!/^firefox-esr-\d+$/.test(browser)) return browser;
  const rank = esrMajors.length - 1 - esrMajors.indexOf(browser);
  if (rank === 0) return 'esr';
  if (rank === 1) return 'esr-prev';
  return `esr-prev-${browser.slice('firefox-esr-'.length)}`;
}

/**
 * Channels whose download URL is a `latest` alias, so the key digests their
 * release identity instead of the URL (test/e2e/shared/downloads.mjs owns that
 * resolution; here it only decides which placeholder the table renders). Parsed
 * from that module's source, like the watchdog roles, so the two cannot drift
 * apart.
 */
const IDENTITY_CHANNELS_RE = /const LATEST_URL_CHANNELS = new Set\(\[([^\]]*)\]\)/;

/** @type {null | Set<string>} */
let identityKeyed = null;

/** @returns {Set<string>} */
function identityKeyedBrowsers() {
  if (identityKeyed) return identityKeyed;
  const src = readFileSync(DOWNLOADS_PATH, 'utf8');
  const m = IDENTITY_CHANNELS_RE.exec(src);
  if (!m) throw new Error('test/e2e/shared/downloads.mjs: LATEST_URL_CHANNELS not found');
  identityKeyed = new Set([...m[1].matchAll(/'([^']+)'/g)].map(entry => entry[1]));
  return identityKeyed;
}

/**
 * The cache key a leg restores, rendered from the composite's key shape (ADR
 * 0045): `<name>-<type>-<os>-<hash>-<layout>`, where a hard gate's hash is
 * `<url16>` (the download URL's sha256 prefix) when that URL carries the
 * release and `<id16>` (the version or nightly build id) when it is a `latest`
 * alias; a sticky fork leg's is `v<version>`. A portable leg adds the extracted
 * tree (`<name>-portable-<os>-…-dir`) beside its installer. A leg with no
 * setup-browser step shows its own actions/cache namespace — the save key when
 * it also saves (the row then names the entry shape it writes), the restore
 * prefix when the step only restores — or an em dash when it caches nothing.
 *
 * @param {any} job
 * @param {{browser: null | string; os: string}} leg
 * @param {{forkBrowsers: Set<string>}} roles
 * @param {string[]} esrMajors the ESR browser keys in this run, lowest first
 * @returns {string} the cell text
 */
function cacheCell(job, leg, roles, esrMajors = []) {
  const step = setupBrowserStep(job);
  if (!step) {
    // A leg that restores AND saves (snap-firefox) shows the save key: the
    // restore is prefix-based, so the prefix alone would render a key shape no
    // other row has. Only a restore-only leg (esr-matrix) shows the prefix.
    const cacheSteps = (job?.steps ?? []).filter(s =>
      String(s?.uses ?? '').includes('actions/cache')
    );
    const own = cacheSteps.find(s => String(s.uses).includes('/save@')) ?? cacheSteps[0];
    if (!own?.with) return '—';
    const restoresOnly = String(own.uses).includes('/restore@');
    const key = restoresOnly ? (own.with['restore-keys'] ?? own.with.key) : own.with.key;
    if (!key) return '—';
    return String(key).replace(EXPR_ANY_RE, '<…>');
  }
  const inputs = step.with ?? {};
  const browser = leg.browser ?? String(inputs.browser ?? '');
  const portable = String(inputs.portable ?? 'false') === 'true';
  const osTag = OS_TAG[String(leg.os).split('-')[0]] ?? leg.os;
  const name = cacheNameOf(browser, esrMajors);
  const hash =
    roles.forkBrowsers.has(browser) ? 'v<version>'
    : identityKeyedBrowsers().has(browser) ? '<id16>'
    : '<url16>';
  const installer = `${name}-dl-${osTag}-${hash}-plain`;
  return portable ? `${installer} / ${name}-portable-${osTag}-${hash}-dir` : installer;
}

/**
 * The watchdog's three browser roles, parsed out of the module that owns them.
 *
 * @returns {{
 *   forkBrowsers: Set<string>;
 *   validatedBrowsers: Set<string>;
 *   informationalBrowsers: Set<string>;
 * }}
 */
function watchdogRoles() {
  const src = readFileSync(WATCHDOG_PATH, 'utf8');
  const sets = {};
  for (const [key, re] of Object.entries(WATCHDOG_SETS)) {
    const m = re.exec(src);
    if (!m) throw new Error(`tools/ci/watchdog-report.mjs: ${key} not found`);
    sets[key] = new Set(
      m[1]
        .split(',')
        .map(entry => entry.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean)
    );
  }
  return {
    forkBrowsers: sets.FORK_BROWSERS,
    validatedBrowsers: sets.VALIDATED_BROWSERS,
    informationalBrowsers: sets.INFORMATIONAL_BROWSERS,
  };
}

/**
 * A duration as `2m 56s` / `48s` — the unit a CI leg is read in.
 *
 * @param {number} ms
 * @returns {string}
 */
function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return (
    min ?
      sec ? `${min}m ${sec}s`
      : `${min}m`
    : `${sec}s`
  );
}

/**
 * Render a markdown table the way prettier formats one: every cell padded to
 * the column width, a dashed separator of at least three dashes per column.
 *
 * @param {string[]} headers
 * @param {string[][]} rows
 * @returns {string} the table, ending in a newline
 */
function table(headers, rows) {
  const cells = [headers, ...rows].map(row => row.map(cell => String(cell).replaceAll('|', '\\|')));
  const widths = headers.map((_, col) => Math.max(3, ...cells.map(row => (row[col] ?? '').length)));
  const line = row => `| ${row.map((cell, col) => (cell ?? '').padEnd(widths[col])).join(' | ')} |`;
  return (
    [
      line(cells[0]),
      `| ${widths.map(w => '-'.repeat(w)).join(' | ')} |`,
      ...cells.slice(1).map(line),
    ].join('\n') + '\n'
  );
}

/**
 * One leg or one single-run job, plus everything the doc prints about it.
 *
 * @typedef {object} Row
 * @property {string} name rendered job name from the run
 * @property {string} jobId workflow job id
 * @property {null | string} browser
 * @property {string} os
 * @property {boolean} portable
 * @property {number} startedAt epoch ms
 * @property {number} durationMs
 */

/**
 * Read the reference run and the workflow, and split its jobs into matrix legs
 * and single-run jobs.
 *
 * @param {string} runId
 * @returns {{
 *   run: any;
 *   jobs: Record<string, any>;
 *   legs: Row[];
 *   singles: Row[];
 * }}
 */
function collect(runId) {
  const run = JSON.parse(
    gh(['run', 'view', runId, '--json', 'jobs,url,createdAt,event,headBranch,headSha,conclusion'])
  );
  const jobs = loadJobs();
  const candidates = legCandidates(jobs, gateContract(jobs));
  const legs = [];
  const singles = [];
  for (const job of run.jobs ?? []) {
    if (job.conclusion === 'skipped') continue;
    const startedAt = Date.parse(job.startedAt);
    const durationMs = Math.max(0, Date.parse(job.completedAt) - startedAt);
    const found = attribute(job.name, candidates);
    if (!found) {
      // A single-run job: no matrix, so the name identifies it exactly.
      const entry = Object.entries(jobs).find(([, job_]) => job_?.name === job.name);
      if (!entry) throw new Error(`no e2e.yml job renders the name '${job.name}'`);
      const [jobId, job_] = entry;
      if (!JOB_PURPOSE[jobId]) {
        throw new Error(
          `JOB_PURPOSE has no entry for job '${jobId}' — add one in tools/ci/e2eLegsTable.mjs`
        );
      }
      singles.push({
        name: job.name,
        jobId,
        browser: null,
        os: String(job_['runs-on'] ?? '—'),
        portable: false,
        startedAt,
        durationMs,
      });
      continue;
    }
    const job_ = jobs[found.jobId] ?? {};
    const step = setupBrowserStep(job_);
    legs.push({
      name: job.name,
      jobId: found.jobId,
      browser: browserOf(job_, found.browser),
      os: found.os ?? String(job_['runs-on'] ?? '—'),
      portable: String(step?.with?.portable ?? 'false') === 'true',
      startedAt,
      durationMs,
    });
  }
  if (legs.length === 0) {
    throw new Error(
      `run ${runId} ran no matrix legs (${run.event} on ${run.headBranch}) — ` +
        'pick a run that actually exercised the matrix'
    );
  }
  return {run, jobs, legs, singles};
}

/**
 * Render the whole document.
 *
 * @param {string} runId
 * @param {ReturnType<typeof collect>} data
 * @returns {string} markdown
 */
function buildDoc(runId, data) {
  const {run, jobs, legs, singles} = data;
  const gate = gateContract(jobs);
  const roles = watchdogRoles();
  const classOf = jobId =>
    gate.required.has(jobId) ? 'Required'
    : gate.advisory.has(jobId) ? 'Advisory'
    : '—';
  const byClass = c => legs.filter(leg => classOf(leg.jobId) === c);
  const sum = list => list.reduce((total, leg) => total + leg.durationMs, 0);
  const slowest = list => list.reduce((a, b) => (a.durationMs >= b.durationMs ? a : b));
  const fmt = formatDuration;

  const required = byClass('Required');
  const advisory = byClass('Advisory');
  const firstStart = Math.min(...legs.map(leg => leg.startedAt));
  const lastStart = Math.max(...legs.map(leg => leg.startedAt));
  const queued = legs.filter(leg => leg.startedAt - firstStart > QUEUE_THRESHOLD_MS);
  const starts = [...legs, ...singles].map(row => row.startedAt);
  const ends = [...legs, ...singles].map(row => row.startedAt + row.durationMs);
  const wallClock = Math.max(...ends) - Math.min(...starts);

  const esrMajors = [
    ...new Set(
      [...required, ...advisory]
        .map(leg => leg.browser)
        .filter(b => /^firefox-esr-\d+$/.test(String(b)))
    ),
  ].sort((a, b) => Number(a.slice('firefox-esr-'.length)) - Number(b.slice('firefox-esr-'.length)));

  const legRows = [...required, ...advisory]
    .sort(
      (a, b) => a.jobId.localeCompare(b.jobId) || String(a.browser).localeCompare(String(b.browser))
    )
    .map(leg => [
      classOf(leg.jobId),
      '`' + leg.jobId + '`',
      leg.browser ? '`' + leg.browser + '`' : '—',
      '`' + leg.os + '`',
      leg.portable ? 'yes' : 'no',
      '`' + cacheCell(jobs[leg.jobId] ?? {}, leg, roles, esrMajors) + '`',
      fmt(leg.durationMs),
    ]);

  const singleRows = [...singles]
    .sort((a, b) => a.jobId.localeCompare(b.jobId))
    .map(row => [
      '`' + row.jobId + '`',
      '`' + row.os + '`',
      JOB_PURPOSE[row.jobId],
      fmt(row.durationMs),
    ]);

  const longest = c => {
    const list = byClass(c);
    if (list.length === 0) return '—';
    const s = slowest(list);
    const what = '`' + s.jobId + (s.browser ? ' (' + s.browser + ')' : '') + ' · ' + s.os + '`';
    return what + ' — ' + fmt(s.durationMs);
  };

  const totalRows = [
    ['Legs', String(required.length), String(advisory.length), String(legs.length)],
    ['Runner-minutes', fmt(sum(required)), fmt(sum(advisory)), fmt(sum(required) + sum(advisory))],
    ['Longest leg', longest('Required'), longest('Advisory'), '—'],
    ['Run wall-clock', '', '', fmt(wallClock)],
  ];

  const when = new Date(run.createdAt).toISOString().replace('T', ' ').slice(0, 16);

  return [
    '# E2E legs',
    '',
    '<!-- Generated by `pnpm ci:legs-table <run-id>` — do not hand-edit. -->',
    '',
    'Source run: [' +
      runId +
      '](' +
      run.url +
      ') · `' +
      run.event +
      '` on `' +
      run.headBranch +
      '` · ' +
      when +
      ' UTC · `' +
      run.headSha.slice(0, 7) +
      '` · ' +
      run.conclusion +
      '.',
    '',
    'Every job the E2E gates evaluate — the required gate\u2019s `required:` plus the advisory',
    'reporter\u2019s `advisory:` — as one row, with',
    'the browser it installs and the cache it restores; two of them (`snapshot`, `esr-matrix`)',
    'render a single job rather than a matrix. The job list, the gate classes and the cache keys',
    'are read out of [e2e.yml](' + WORKFLOW_LINK + '); the durations are that one run — a',
    'measurement, not a contract.',
    '',
    '## E2E legs',
    '',
    '`Required` legs must pass for the `E2E gate` check to go green; `Advisory` legs only warn',
    'via the `E2E advisory` reporter. The gates\u2019 `required:` / `advisory:` lists in',
    '[e2e.yml](' + WORKFLOW_LINK + ') are the',
    'contract, and `pnpm check:gates` keeps them in step with the job list.',
    '',
    table(['Gate', 'Job', 'Browser', 'OS', 'Portable', 'Cache key', 'Wall-clock'], legRows),
    'Every cache key is `<name>-<type>-<os>-<hash>-<layout>` (ADR 0045): `name` is the browser the',
    'entry belongs to, `type` the payload (`dl` installer, `portable` extracted tree), `os` the',
    'runner OS lowercased (`snap` for the snap leg) and `layout` its spelling (`plain` / `dir`).',
    'A hard gate\u2019s `hash` is the download URL\u2019s release identity: the download URL\u2019s sha256 prefix (`<url16>`) when that URL carries the',
    'release (waterfox\u2019s CDN path, ESR\u2019s release-tagged ftp URL) and the published version or',
    'nightly build id (`<id16>`) when it does not \u2014 Mozilla\u2019s `?product=\u2026-latest` URLs are one',
    'fixed string per OS, so a URL-derived key could never be superseded. Either way a release change',
    'mints a new key and retires its predecessor; a sticky fork leg keys on `v<version>` instead',
    '(ADR 0034), so a fork release cannot delay a PR. Entries are written on the default branch only',
    '(ADR 0044): a PR run saves none and restores main\u2019s copy, because a `refs/pull/<n>/merge`',
    'entry is restorable by that PR alone. The composite that builds these keys is',
    '[setup-browser](' + ACTION_LINK + '); an em dash means the leg caches nothing of its own.',
    '',
    '## Non-E2E jobs',
    '',
    'Everything the workflow runs that the gate does not evaluate: the path filter, the gate',
    'itself, the recorders and the watch. A job skipped by its own `if:` is absent here.',
    '',
    table(['Job', 'Runs on', 'Purpose', 'Wall-clock'], singleRows),
    '## Totals',
    '',
    table(['Metric', 'Required', 'Advisory', 'All'], totalRows),
    'All ' + legs.length + ' legs fit in ' + fmt(wallClock) + ' of wall-clock: the last one',
    'started ' +
      fmt(lastStart - firstStart) +
      ' after the first, and ' +
      queued.length +
      ' of them',
    'started more than ' + fmt(QUEUE_THRESHOLD_MS) + ' in — queued behind the concurrency cap,',
    'not behind their own download.',
    '',
    'That gap is the number issue #380 works on: wall-clock is runner-queue-bound, so trimming',
    'per-leg seconds only pays off if the legs start earlier.',
    '',
  ].join('\n');
}

/**
 * Run the generated markdown through the repo's own prettier config, so the
 * committed file is byte-identical to what `pnpm format` expects and a
 * regeneration is a no-op rather than a reflow diff. The jsdoc plugin is
 * dropped: it does nothing for markdown and would have to resolve from the
 * process's working directory.
 *
 * @param {string} source the generated markdown
 * @param {string} filepath decides the parser (markdown)
 * @returns {Promise<string>} the formatted markdown
 */
async function prettierFormat(source, filepath) {
  return prettier.format(source, {...prettierConfig, plugins: [], filepath});
}

async function main() {
  const [runId, outPath] = process.argv.slice(2);
  if (!runId) {
    throw new Error(
      'usage: pnpm ci:legs-table <run-id> [out.md]\n' +
        '  find a run: gh run list --workflow=e2e.yml --branch main --limit 20'
    );
  }
  const out = outPath ? path.resolve(process.cwd(), outPath) : DEFAULT_OUT;
  const doc = await prettierFormat(buildDoc(runId, collect(runId)), out);
  writeFileSync(out, doc, 'utf8');
  console.log('e2eLegsTable: wrote ' + path.relative(ROOT, out) + ' from run ' + runId);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (err) {
    console.error(`e2eLegsTable: ${err.message}`);
    process.exit(1);
  }
}
