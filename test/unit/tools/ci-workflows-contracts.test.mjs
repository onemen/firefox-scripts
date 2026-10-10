// test/unit/tools/ci-workflows-contracts.test.mjs — the static contracts of
// .github/workflows/ci.yml, pages.yml and build-and-upload.yml.
//
// Companion to e2e-workflow-contracts.test.mjs (same registry shape: a named
// contract per implicit coupling, a check that returns violations, a fixture
// proving each contract can fail). The couplings enforced here are the ones
// nothing else checks — `pnpm check:gates` pins the GATE STRUCTURE (needs
// coverage, path-filter ifs, verify-gate wiring); these pin the couplings
// that would otherwise surface only as a wrong publish or a silently dead
// step:
//
//   ci.yml
//   - filter-outputs-exist   every `needs.changes.outputs.<x>` reference is
//                            an output the changes job declares; a typo'd or
//                            copied-from-e2e output name silently never runs
//                            every gated step built on it.
//   - canary-build-parity    the ubuntu-26.04 canary runs the SAME
//                            `snapshot:dev` build as the shipping
//                            publish gate — that identity is what makes a
//                            green canary mean anything.
//   - canary-stays-advisory  ADR 0017: the canary warns, never blocks. A
//                            copy-paste that moves it into `required:` turns
//                            an image hiccup into a merge outage.
//
//   pages.yml / build-and-upload.yml
//   - publish-single-writer  pages.yml: the gh-pages/release single-writer
//                            property is structural — exactly ONE job writes
//                            a publish target: the needs-chain must end at a
//                            lone `publishing` job that runs upload.mjs pass
//                            2 (--skip-build); the parallel matrix legs are
//                            pass 1 (--build-only, stage-only, artifact-out).
//                            A second --skip-build invocation, or a writer
//                            job beside the chain, is a concurrent-writer bug.
//   - baseline-artifact-pairing
//                            every `baseline-hashes` download has the
//                            baseline job's upload behind it (same coupling
//                            as e2e's artifact-pairing contract).
//   - upload-invocation-wiring
//                            every direct `node tools/publish/upload.mjs`
//                            invocation carries the wiring the invocation
//                            depends on: the FXS_INTERNAL_CI marker
//                            (prodCiGuard runs on every CI invocation), the
//                            prod baseline diff
//                            (FIREFOX_SCRIPTS_STORED_HASHES_FILE), and
//                            --include= (required by upload.mjs, ADR 0030).
//                            A missing piece here is a publish-time outage —
//                            the workflows run too rarely to debug live.
//   - staged-set-parity      build-and-upload.yml: the publish step's
//                            --platform list equals the build matrix's
//                            platform set; a platform added to one side only
//                            publishes stale (or missing) staged bytes.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const WORKFLOWS = '.github/workflows';

/** Read a workflow file with LF normalized (a local copy can linger as CRLF). */
function readWorkflow(file) {
  return fs.readFileSync(path.join(REPO_ROOT, WORKFLOWS, file), 'utf8').replace(/\r\n/g, '\n');
}

// ── parsing (deliberately small, like e2e-workflow-contracts.test.mjs) ─────

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
 * The step's `uses:` value (action or composite), or null. The key may sit
 * behind a list marker with no `name:` before it (`- uses: …` is a real form in
 * these workflows), so an optional `- ` is allowed.
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
 * A step body's `with:`/`env:` key value, or null. Scanned line by line: the
 * key is a parameter, and a dynamic pattern reads as
 * security/detect-non-literal-regexp even though every caller passes a literal.
 * The step's own `- name:` line cannot match — the first non-space character
 * there is `-`, not a key character.
 *
 * @param {string} stepText
 * @param {string} key
 * @returns {string | null}
 */
function stepKeyValue(stepText, key) {
  for (const line of stripComments(stepText).split('\n')) {
    const match = /^[ \t]+([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line);
    if (match && match[1] === key) return match[2].trim();
  }
  return null;
}

/**
 * A step's shell script: the value of its `run:` key. Both YAML forms occur:
 * the single-line scalar (`run: node foo.mjs`) and the block scalar (`run: |` +
 * indented body) — every real upload.mjs invocation lives in a block, so a
 * single-line-only reader would see none of them and the wiring contracts would
 * pass vacuously.
 *
 * @param {string} stepText
 * @returns {string}
 */
function stepRun(stepText) {
  const lines = stripComments(stepText).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const match = /^[ \t]+run:[ \t]*(.*)$/.exec(lines[i]);
    if (!match) continue;
    const inline = match[1].trim();
    if (inline && !/^[|>][-+]?[0-9]*$/.test(inline)) return inline;
    // Block scalar: collect the deeper-indented lines, dedented by their
    // common leading whitespace (blank lines contribute empty strings).
    const keyIndent = lines[i].search(/\S/);
    const body = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === '') {
        body.push('');
        continue;
      }
      if (lines[j].search(/\S/) <= keyIndent) break;
      body.push(lines[j]);
    }
    const indents = body.filter(l => l.trim() !== '').map(l => l.search(/\S/));
    const drop = indents.length > 0 ? Math.min(...indents) : 0;
    return body.map(l => (l.trim() === '' ? '' : l.slice(drop))).join('\n');
  }
  return '';
}

/**
 * A job's `needs:` list (scalar or inline array form).
 *
 * @param {string} jobBody
 * @returns {string[]}
 */
function jobNeeds(jobBody) {
  const match = jobBody.match(/^ {4}needs:[ \t]*(.+)$/m);
  if (!match) return [];
  const raw = match[1].trim();
  return raw.startsWith('[') ?
      raw
        .slice(1, -1)
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
    : [raw];
}

// ── contract: filter-outputs-exist (ci.yml) ────────────────────────────────

/**
 * Every `needs.changes.outputs.<x>` reference in a workflow, from
 * comment-stripped text so prose cannot satisfy the check.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function filterOutputRefs(text) {
  return [...stripComments(text).matchAll(/needs\.changes\.outputs\.([A-Za-z0-9_]+)/g)].map(
    m => m[1]
  );
}

/**
 * The output keys the workflow's `changes` job declares.
 *
 * @param {string} text
 * @returns {Set<string>}
 */
export function declaredFilterOutputs(text) {
  const lines = stripComments(text).split('\n');
  const changesStart = lines.findIndex(line => /^ {2}changes:[ \t]*$/.test(line));
  const outputs = new Set();
  if (changesStart === -1) return outputs;
  let inOutputs = false;
  for (let i = changesStart + 1; i < lines.length; i++) {
    if (/^ {4}outputs:[ \t]*$/.test(lines[i])) {
      inOutputs = true;
      continue;
    }
    if (inOutputs) {
      const key = lines[i].match(/^ {6}([A-Za-z0-9_]+):/);
      if (key) {
        outputs.add(key[1]);
        continue;
      }
      if (/^ {1,4}\S/.test(lines[i])) break; // dedented out of the outputs block
    }
  }
  return outputs;
}

/**
 * Every referenced changed-paths output must be declared — an undeclared output
 * interpolates to the empty string, so `== 'true'` gates never open and the
 * steps behind them silently never run.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function filterOutputViolations(text) {
  const declared = declaredFilterOutputs(text);
  if (declared.size === 0) {
    return ['ci.yml: the changes job declares no outputs — every gated step keys off one'];
  }
  return [...new Set(filterOutputRefs(text))]
    .filter(ref => !declared.has(ref))
    .map(
      ref =>
        `ci.yml: references needs.changes.outputs.${ref}, but the changes job declares only: ` +
        [...declared].sort().join(', ')
    );
}

// ── contract: publish-upload action wiring (pages.yml, build-and-upload.yml) ──

/**
 * Every upload.mjs invocation inside the two publish workflows must go through
 * the shared .github/actions/publish-upload composite action — one definition
 * instead of per-job copies that drift (the ARGS assembly, the FXS_INTERNAL_CI
 * marker and the baseline export are exactly the lines that must not fork). The
 * workflows may only mention `upload.mjs` in comments.
 *
 * @param {string} workflowText
 * @returns {string[]}
 */
export function publishUploadActionViolations(workflowText) {
  const violations = [];
  for (const line of workflowText.split('\n')) {
    if (!line.includes('node tools/publish/upload.mjs')) continue;
    const stripped = line.replace(/(^|\s)#.*$/, ''); // a comment mentioning it is fine
    if (!stripped.includes('node tools/publish/upload.mjs')) continue;
    violations.push(
      'publish workflows must invoke upload.mjs via ./.github/actions/publish-upload, ' +
        'not an inline run step: ' +
        line.trim().slice(0, 80)
    );
  }
  return violations;
}

// ── contract: canary-build-parity + canary-stays-advisory (ci.yml) ─────────

/**
 * The `pnpm snapshot` invocation of a build-shaped job (there is exactly one
 * per job), or null.
 *
 * @param {{name: string; body: string}} job
 * @returns {string | null}
 */
function buildInvocation(job) {
  const runs = jobSteps(job.body)
    .map(stepRun)
    .filter(run => run.includes('pnpm snapshot'));
  return runs.length === 1 ? runs[0] : null;
}

/**
 * The canary must run the SAME build command as the shipping publish gate: its
 * entire value (ci.yml's own comment) is exercising that build on the next
 * runner image. A drifted flag means it validates something else.
 *
 * @param {{name: string; body: string}[]} jobs
 * @returns {string[]}
 */
export function canaryBuildParityViolations(jobs) {
  const byName = new Map(jobs.map(job => [job.name, job]));
  const build = buildInvocation(byName.get('build') ?? {name: 'build', body: ''});
  const canary = buildInvocation(byName.get('build-canary') ?? {name: 'build-canary', body: ''});
  if (build === null) return ['ci.yml: the build job has no single `pnpm snapshot` step'];
  if (canary === null) {
    return ['ci.yml: the build-canary job has no single `pnpm snapshot` step'];
  }
  return build === canary ?
      []
    : [
        `ci.yml: canary build drift — build runs \`${build}\` but build-canary runs \`${canary}\`; ` +
          'the canary only proves something if it runs the same build',
      ];
}

/**
 * The gate's verify-gate classification lists (required/advisory/…), split from
 * the single-line `with:` values.
 *
 * @param {{name: string; body: string}[]} jobs
 * @param {string} gate
 * @returns {Record<string, string[]>}
 */
function gateClassifications(jobs, gate) {
  const byName = new Map(jobs.map(job => [job.name, job]));
  const gateJob = byName.get(gate);
  if (!gateJob) return {};
  const keys = ['required', 'advisory', 'always-report', 'always-verify', 'skip-guard'];
  /** @type {Record<string, string[]>} */
  const out = {};
  for (const step of jobSteps(gateJob.body)) {
    if (!stepUses(step) || !/verify-gate/.test(stepUses(step) ?? '')) continue;
    for (const key of keys) {
      const raw = stepKeyValue(step, key);
      if (raw) out[key] = raw.split(/\s+/).filter(Boolean);
    }
  }
  return out;
}

/**
 * ADR 0017: the canary is advisory — visible when red, never blocking. Pin the
 * classification so a copy-paste into `required:` cannot silently turn an image
 * hiccup into a merge outage.
 *
 * @param {{name: string; body: string}[]} jobs
 * @returns {string[]}
 */
export function canaryClassificationViolations(jobs) {
  const cls = gateClassifications(jobs, 'ci-gate');
  const violations = [];
  if (!(cls.required ?? []).includes('build')) {
    violations.push("ci.yml: ci-gate must classify 'build' as required (it is the publish gate)");
  }
  if (!(cls.advisory ?? []).includes('build-canary')) {
    violations.push(
      "ci.yml: ci-gate must classify 'build-canary' as advisory (ADR 0017 — a red canary warns, never blocks)"
    );
  }
  if ((cls.required ?? []).includes('build-canary')) {
    violations.push(
      "ci.yml: ci-gate classifies 'build-canary' as required — the canary must stay advisory (ADR 0017)"
    );
  }
  return violations;
}

// ── contract: publish-single-writer (pages.yml) ────────────────────────────

/** The staged-set matrix legs (pass 1) and the lone writer (pass 2). */
const PUBLISH_STAGE_JOBS = ['publish', 'publishing'];

/** The full publish needs-chain: the two plumbing jobs plus the stage jobs. */
const PUBLISH_CHAIN_JOBS = [...PUBLISH_STAGE_JOBS, 'pre-publish', 'baseline'];

/**
 * The gh-pages/release single-writer property, enforced structurally: exactly
 * ONE pages.yml job runs upload.mjs pass 2 (--skip-build) — the lone
 * `publishing` job at the end of the needs-chain — and the parallel `publish`
 * matrix legs run pass 1 (--build-only) only. The chain runs win/linux/mac in
 * PARALLEL and the exclusivity is bought by the two-pass upload.mjs
 * architecture. A second --skip-build invocation, a --build-only job outside
 * the matrix, a missing writer, or a reordered edge is a concurrent-writer bug
 * or a publish outage.
 *
 * @param {{name: string; body: string}[]} jobs
 * @param {string} file file name for messages
 * @returns {string[]}
 */
export function publishSingleWriterViolations(jobs, file) {
  const violations = [];
  const byName = new Map(jobs.map(job => [job.name, job]));
  for (const name of PUBLISH_STAGE_JOBS) {
    if (!byName.has(name)) violations.push(`${file}: publish job '${name}' is missing`);
  }
  for (const name of byName.keys()) {
    if (!PUBLISH_CHAIN_JOBS.includes(name)) {
      violations.push(
        `${file}: job '${name}' is not part of the publish needs-chain — extend ` +
          'PUBLISH_STAGE_JOBS consciously: a job beside the chain can write gh-pages concurrently'
      );
    }
  }

  // Edge shape: pre-publish → baseline → {publish (matrix) → publishing}.
  const expectedNeeds = {'pre-publish': [], 'baseline': ['pre-publish'], 'publish': ['baseline']};
  for (const [name, expected] of Object.entries(expectedNeeds)) {
    const job = byName.get(name);
    if (!job) continue;
    const needs = jobNeeds(job.body);
    if (needs.length !== expected.length || expected.some((n, i) => needs[i] !== n)) {
      violations.push(
        `${file}: '${name}' needs [${needs.join(', ')}] but the publish chain pins ` +
          `[${expected.join(', ')}]`
      );
    }
  }

  // The writer takes the staging matrix as its input, and the gates stay
  // upstream of every publish: pre-publish + baseline are explicit needs and
  // are required to succeed, so a failed drift gate can never be published
  // past. The matrix legs may be legitimately 'skipped' (packages-only
  // dispatch: include=packages stages nothing) — the writer then runs alone
  // via the always() branch.
  const publishing = byName.get('publishing');
  if (publishing) {
    const needs = jobNeeds(publishing.body);
    const expectedPublishingNeeds = ['pre-publish', 'baseline', 'publish'];
    if (
      needs.length !== expectedPublishingNeeds.length ||
      expectedPublishingNeeds.some((n, i) => needs[i] !== n)
    ) {
      violations.push(
        `${file}: 'publishing' needs [${needs.join(', ')}] but the single writer pins ` +
          `[${expectedPublishingNeeds.join(', ')}]`
      );
    }
    const publishingIf = stripComments(publishing.body);
    if (!publishingIf.includes('always()')) {
      violations.push(
        `${file}: 'publishing' must carry an always() branch — a packages-only dispatch ` +
          '(include=packages) skips every staging leg, and a plain needs would skip the writer too'
      );
    }
    for (const gate of ['pre-publish', 'baseline']) {
      if (!publishingIf.includes(`needs.${gate}.result == 'success'`)) {
        violations.push(
          `${file}: 'publishing' must require needs.${gate}.result == 'success' — the drift ` +
            'gate stays upstream of every publish (a failed gate must not be published past)'
        );
      }
    }
  }

  // Exactly ONE pass-2 (--skip-build) invocation across the whole workflow,
  // and it lives in the writer; every other publish job is pass 1.
  const sawBuildOnly = job => stripComments(job.body).includes('--build-only');
  const sawSkipBuild = job => stripComments(job.body).includes('--skip-build');
  const publishingJob = byName.get('publishing');
  if (publishingJob && !sawSkipBuild(publishingJob)) {
    violations.push(
      `${file}: 'publishing' does not run upload.mjs pass 2 (--skip-build) — it is the ` +
        'single writer and must be the only job performing the release + Pages publish'
    );
  }
  for (const job of jobs) {
    if (job.name !== 'publishing' && sawSkipBuild(job)) {
      violations.push(
        `${file}: '${job.name}' invokes upload.mjs pass 2 (--skip-build) — only the lone ` +
          `'publishing' job may write the release + Pages targets`
      );
    }
    if (job.name !== 'publish' && sawBuildOnly(job)) {
      violations.push(
        `${file}: '${job.name}' runs a --build-only staging pass outside the publish matrix — ` +
          'staging happens only in the parallel publish legs'
      );
    }
  }
  return violations;
}

// ── contract: artifact pairing (pages.yml, build-and-upload.yml) ───────────

/**
 * Artifact uploads/downloads of a workflow: kind, name and pattern per step.
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
        name: stepKeyValue(step, 'name'),
        pattern: stepKeyValue(step, 'pattern'),
      });
    }
  }
  return artifacts;
}

/**
 * Every literal `name:` download must be produced by an upload in the same
 * workflow (the baseline-hashes artifact is the coupling every publish job
 * depends on — a rename on one side is a "path not found" failure at publish
 * time).
 *
 * @param {{name: string; body: string}[]} jobs
 * @param {string} file file name for messages
 * @returns {string[]}
 */
export function baselineArtifactViolations(jobs, file) {
  const artifacts = artifactSteps(jobs);
  const uploaded = new Set(artifacts.filter(a => a.kind === 'upload' && a.name).map(a => a.name));
  const violations = [];
  for (const artifact of artifacts) {
    if (artifact.kind !== 'download' || !artifact.name) continue;
    if (!uploaded.has(artifact.name)) {
      violations.push(
        `${file}: "${artifact.step}" downloads artifact "${artifact.name}", but no upload step ` +
          'in this workflow produces that name'
      );
    }
  }
  return violations;
}

// ── contract: upload-invocation-wiring (pages.yml, build-and-upload.yml) ───

/**
 * The env keys a step declares.
 *
 * @param {string} stepText
 * @returns {Set<string>}
 */
function stepEnvKeys(stepText) {
  const keys = new Set();
  let inEnv = false;
  for (const line of stripComments(stepText).split('\n')) {
    if (/^ {8}env:[ \t]*$/.test(line)) {
      inEnv = true;
      continue;
    }
    if (inEnv) {
      const key = line.match(/^ {10}([A-Za-z0-9_]+):/);
      if (key) {
        keys.add(key[1]);
        continue;
      }
      if (/^ {1,7}\S/.test(line)) break;
    }
  }
  return keys;
}

/**
 * The workflow's direct `node tools/publish/upload.mjs` invocations, with their
 * job and step text.
 *
 * @param {{name: string; body: string}[]} jobs
 * @returns {{job: string; step: string; stepText: string; run: string}[]}
 */
export function uploadInvocations(jobs) {
  const invocations = [];
  for (const job of jobs) {
    for (const step of jobSteps(job.body)) {
      const run = stepRun(step);
      if (stripComments(run).includes('node tools/publish/upload.mjs')) {
        invocations.push({job: job.name, step: stepName(step), stepText: step, run});
      }
    }
  }
  return invocations;
}

/**
 * Every direct upload.mjs invocation must carry the wiring it depends on: the
 * FXS_INTERNAL_CI marker (prodCiGuard runs on EVERY CI invocation — pages.yml
 * convention), the prod baseline diff (FIREFOX_SCRIPTS_STORED_HASHES_FILE), and
 * --include= (required by upload.mjs, ADR 0030). A missed piece fails only when
 * the publish workflow next runs — by then it is an outage, not a review
 * comment.
 *
 * @param {{name: string; body: string}[]} jobs
 * @param {string} file file name for messages
 * @returns {string[]}
 */
export function uploadInvocationViolations(jobs, file) {
  const violations = [];
  for (const invocation of uploadInvocations(jobs)) {
    if (stripComments(invocation.stepText).length === 0) continue; // pure comment step
    const env = stepEnvKeys(invocation.stepText);
    if (!env.has('FXS_INTERNAL_CI')) {
      violations.push(
        `${file}: ${invocation.job}: "${invocation.step}" invokes upload.mjs without ` +
          'FXS_INTERNAL_CI in its env — prodCiGuard would not treat it as a CI invocation'
      );
    }
    if (!invocation.run.includes('FIREFOX_SCRIPTS_STORED_HASHES_FILE')) {
      violations.push(
        `${file}: ${invocation.job}: "${invocation.step}" invokes upload.mjs without the ` +
          'FIREFOX_SCRIPTS_STORED_HASHES_FILE baseline diff — a prod publish would rebuild ' +
          'from whatever an earlier job already pushed'
      );
    }
    if (!invocation.run.includes('--include=')) {
      violations.push(
        `${file}: ${invocation.job}: "${invocation.step}" invokes upload.mjs without --include= ` +
          '(required by upload.mjs, ADR 0030 — the run aborts instead of defaulting a scope)'
      );
    }
  }
  return violations;
}

/**
 * The workflow-level env must expose the publish token under the fixed
 * GITHUB_TOKEN_VAR name (upload.mjs reads that name and nothing else).
 *
 * @param {string} text
 * @param {string} file file name for messages
 * @returns {string[]}
 */
export function tokenVarViolations(text, file) {
  return /^env:[ \t]*\n {2}GITHUB_TOKEN_VAR:/m.test(stripComments(text)) ?
      []
    : [
        `${file}: workflow env must define GITHUB_TOKEN_VAR — upload.mjs reads its token from that fixed name`,
      ];
}

// ── contract: staged-set-parity (build-and-upload.yml) ─────────────────────

/**
 * The build matrix's platform values.
 *
 * @param {{name: string; body: string}[]} jobs
 * @returns {string[]}
 */
export function matrixPlatforms(jobs) {
  const byName = new Map(jobs.map(job => [job.name, job]));
  const build = byName.get('build');
  if (!build) return [];
  // [A-Za-z0-9_-]+, not \S+: a quoted value's closing quote must not join the
  // platform name.
  return [...stripComments(build.body).matchAll(/- platform: ([A-Za-z0-9_-]+)/g)].map(m => m[1]);
}

/**
 * The publish step's `--platform=` values.
 *
 * @param {{name: string; body: string}[]} jobs
 * @returns {string[]}
 */
export function publishPlatforms(jobs) {
  const byName = new Map(jobs.map(job => [job.name, job]));
  const publish = byName.get('publish');
  if (!publish) return [];
  // Post publish-upload-action: the invocation lives in the composite action,
  // which takes the platform set as `platforms: 'win linux mac'` and expands it
  // to per-flag --platform arguments — read that input when the step uses it.
  const usesAction =
    [...publish.body.matchAll(/uses: \s*\.\/\.github\/actions\/publish-upload/g)].length > 0;
  if (usesAction) {
    const platforms = publish.body.match(/^ {10}platforms: '(.+)'$/m);
    return platforms ? platforms[1].trim().split(/\s+/) : [];
  }
  return [
    ...uploadInvocations([publish]).flatMap(i => [
      ...i.run.matchAll(/--platform=([A-Za-z0-9_-]+)/g),
    ]),
  ].map(m => m[1]);
}

/**
 * The publish step must publish exactly the platform set the build matrix
 * staged — one platform missing publishes without its binaries, one extra
 * publishes stale bytes from a previous stage.
 *
 * @param {{name: string; body: string}[]} jobs
 * @param {string} file file name for messages
 * @returns {string[]}
 */
export function stagedSetViolations(jobs, file) {
  const staged = matrixPlatforms(jobs);
  const published = publishPlatforms(jobs);
  if (staged.length === 0) return [`${file}: the build matrix declares no platforms`];
  if (published.length === 0) return [`${file}: the publish step declares no --platform flags`];
  const stagedSet = [...new Set(staged)].sort();
  const publishedSet = [...new Set(published)].sort();
  return (
      stagedSet.length === publishedSet.length && stagedSet.every((p, i) => publishedSet[i] === p)
    ) ?
      []
    : [
        `${file}: publish --platform [${publishedSet.join(', ')}] ≠ build matrix ` +
          `[${stagedSet.join(', ')}] — a platform is staged but not published, or published but never staged`,
      ];
}

// ── the registries ─────────────────────────────────────────────────────────

/** Contract registry shape: id, one-line description, check(text) → violations. */
const CI_CONTRACTS = [
  {
    id: 'filter-outputs-exist',
    description: 'every needs.changes.outputs.* reference is declared by the changes job',
    check: text => filterOutputViolations(text),
  },
  {
    id: 'canary-build-parity',
    description: 'the ubuntu-26.04 canary runs the same snapshot build as the publish gate',
    check: text => canaryBuildParityViolations(workflowJobs(text)),
  },
  {
    id: 'publish-upload-action-wiring',
    description:
      'the publish/upload.mjs invocation lives in ONE composite action, not inlined per job',
    check: text => publishUploadActionViolations(text),
  },
  {
    id: 'canary-stays-advisory',
    description: 'ci-gate classifies build as required and build-canary as advisory (ADR 0017)',
    check: text => canaryClassificationViolations(workflowJobs(text)),
  },
];

const PAGES_CONTRACTS = [
  {
    id: 'publish-single-writer',
    description:
      'exactly one job writes the release + Pages targets: the needs-chain ends at the lone publishing job (pass 2), the parallel publish matrix is pass 1',
    check: text => publishSingleWriterViolations(workflowJobs(text), 'pages.yml'),
  },
  {
    id: 'baseline-artifact-pairing',
    description: 'every downloaded artifact name is produced by an upload in the same workflow',
    check: text => baselineArtifactViolations(workflowJobs(text), 'pages.yml'),
  },
  {
    id: 'upload-invocation-wiring',
    description:
      'every direct upload.mjs invocation carries FXS_INTERNAL_CI, the baseline diff and --include=',
    check: text => [
      ...uploadInvocationViolations(workflowJobs(text), 'pages.yml'),
      ...tokenVarViolations(text, 'pages.yml'),
    ],
  },
];

const BUILD_AND_UPLOAD_CONTRACTS = [
  {
    id: 'baseline-artifact-pairing',
    description: 'every downloaded artifact name is produced by an upload in the same workflow',
    check: text => baselineArtifactViolations(workflowJobs(text), 'build-and-upload.yml'),
  },
  {
    id: 'upload-invocation-wiring',
    description:
      'every direct upload.mjs invocation carries FXS_INTERNAL_CI, the baseline diff and --include=',
    check: text => [
      ...uploadInvocationViolations(workflowJobs(text), 'build-and-upload.yml'),
      ...tokenVarViolations(text, 'build-and-upload.yml'),
    ],
  },
  {
    id: 'staged-set-parity',
    description: 'the publish step --platform set equals the build matrix platform set',
    check: text => stagedSetViolations(workflowJobs(text), 'build-and-upload.yml'),
  },
];

/** Run one registry against its workflow and join the violations. */
function checkFile(file, contracts) {
  const text = readWorkflow(file);
  return contracts.flatMap(contract => contract.check(text));
}

// ── tests: the real files satisfy every contract ───────────────────────────

test('ci.yml satisfies every declared contract', () => {
  const failures = checkFile('ci.yml', CI_CONTRACTS);
  assert.deepEqual(failures, [], failures.join('\n'));
});

test('pages.yml satisfies every declared contract', () => {
  const failures = checkFile('pages.yml', PAGES_CONTRACTS);
  assert.deepEqual(failures, [], failures.join('\n'));
});

test('build-and-upload.yml satisfies every declared contract', () => {
  const failures = checkFile('build-and-upload.yml', BUILD_AND_UPLOAD_CONTRACTS);
  assert.deepEqual(failures, [], failures.join('\n'));
});

test('the shape-sensitive detectors stay populated on the real files', () => {
  // A contract whose detector stops matching anything would pass vacuously
  // (the e2e registry pins the same property).
  assert.ok(filterOutputRefs(readWorkflow('ci.yml')).length > 0, 'expected output references');
  // Post publish-upload-action: the invocation lives in the composite action,
  // so the workflows carry uses:-steps, not direct upload.mjs invocations.
  assert.ok(
    readWorkflow('pages.yml').includes('uses: ./.github/actions/publish-upload'),
    'pages.yml wires the composite action'
  );
  assert.ok(
    readWorkflow('build-and-upload.yml').includes('uses: ./.github/actions/publish-upload'),
    'build-and-upload.yml wires the composite action'
  );
  assert.ok(matrixPlatforms(workflowJobs(readWorkflow('build-and-upload.yml'))).length > 0);
});

// ── tests: each contract catches its own regression ────────────────────────

test('filter-outputs-exist: a referenced-but-undeclared output is a violation', () => {
  const fixture = [
    'jobs:',
    '  changes:',
    '    outputs:',
    '      publish: ${{ steps.filter.outputs.publish }}',
    '  build:',
    '    steps:',
    '      - name: Gated step',
    "        if: needs.changes.outputs.core == 'true'",
    '        run: echo hi',
  ].join('\n');
  const violations = filterOutputViolations(fixture);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /outputs\.core/);
  assert.match(violations[0], /publish/);

  const fixed = fixture.replace(
    '      publish: ${{ steps.filter.outputs.publish }}',
    '      publish: ${{ steps.filter.outputs.publish }}\n      core: ${{ steps.filter.outputs.core }}'
  );
  assert.deepEqual(filterOutputViolations(fixed), []);
});

test('publish-upload-action-wiring: an inline upload.mjs run step is a violation', () => {
  const inline = [
    'jobs:',
    '  publish-win:',
    '    steps:',
    '      - name: Publish',
    '        run: node tools/publish/upload.mjs --mode=prod --platform=win',
  ].join('\n');
  const violations = publishUploadActionViolations(inline);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /publish-upload/);
});

test('publish-upload-action-wiring: the composite action users are clean', () => {
  const wired = [
    'jobs:',
    '  publish-win:',
    '    steps:',
    '      - uses: ./.github/actions/publish-upload',
    '        with:',
    '          mode: prod',
    '      # node tools/publish/upload.mjs is documented here',
    '  docs:',
    '    steps:',
    '      - run: echo "upload.mjs runs via the composite action"',
  ].join('\n');
  assert.deepEqual(publishUploadActionViolations(wired), []);
});

test('the real publish workflows invoke upload.mjs only through the composite action', async () => {
  const {readFileSync} = await import('node:fs');
  for (const wf of ['pages.yml', 'build-and-upload.yml']) {
    const text = readFileSync(new URL(`../../../.github/workflows/${wf}`, import.meta.url), 'utf8');
    assert.deepEqual(
      publishUploadActionViolations(text),
      [],
      `${wf} must use ./.github/actions/publish-upload`
    );
    assert.match(text, /uses: \.\/\.github\/actions\/publish-upload/);
  }
});

test('canary-build-parity: a drifted canary build is a violation', () => {
  const job = (name, mode) =>
    [
      `  ${name}:`,
      '    steps:',
      '      - name: Build all packages and binaries',
      `        run: pnpm snapshot:${mode}`,
    ].join('\n');
  const drifted = ['jobs:', job('build', 'dev'), job('build-canary', 'prod')].join('\n');
  const violations = canaryBuildParityViolations(workflowJobs(drifted));
  assert.equal(violations.length, 1);
  assert.match(violations[0], /canary build drift/);
  assert.deepEqual(
    canaryBuildParityViolations(
      workflowJobs(['jobs:', job('build', 'dev'), job('build-canary', 'dev')].join('\n'))
    ),
    []
  );
});

test('canary-stays-advisory: classifying the canary as required is a violation', () => {
  const gate = advisory =>
    [
      'jobs:',
      '  ci-gate:',
      '    steps:',
      '      - uses: ./.github/actions/verify-gate',
      '        with:',
      '          required: build',
      `          advisory: ${advisory}`,
    ].join('\n');
  assert.deepEqual(canaryClassificationViolations(workflowJobs(gate('build-canary'))), []);
  const required = canaryClassificationViolations(workflowJobs(gate('')));
  assert.equal(required.length, 1, 'missing advisory classification is a violation');
  assert.match(required[0], /advisory/);

  const promoted = gate('').replace(
    '          required: build',
    '          required: build build-canary'
  );
  const violations = canaryClassificationViolations(workflowJobs(promoted));
  assert.equal(violations.length, 2);
  assert.match(violations[1], /must stay advisory/);
});

test('publish-single-writer: a writer job beside the chain is a violation', () => {
  const job = (name, needs) =>
    [
      'jobs:',
      `  ${name}:`,
      ...(needs ? [`    needs: ${needs}`] : []),
      '    runs-on: ubuntu-24.04',
    ].join('\n');
  const pass1 = [
    '    steps:',
    '      - name: Stage',
    '        uses: ./.github/actions/publish-upload',
    '        with:',
    '          extra-args: --build-only',
  ].join('\n');
  const pass2 = [
    '    steps:',
    '      - name: Publish',
    '        uses: ./.github/actions/publish-upload',
    '        with:',
    '          extra-args: --skip-build',
  ].join('\n');
  const graph = [
    job('pre-publish', ''),
    job('baseline', 'pre-publish'),
    `  publish:\n    needs: baseline\n    strategy:\n      matrix:\n        include:\n          - platform: win\n${pass1}`,
    `  publishing:\n    needs: [pre-publish, baseline, publish]\n    if: \${{ always() && needs.pre-publish.result == 'success' && needs.baseline.result == 'success' && (needs.publish.result == 'success' || (inputs.include == 'packages' && needs.publish.result == 'skipped')) }}\n${pass2}`,
  ].join('\n');
  assert.deepEqual(publishSingleWriterViolations(workflowJobs(graph), 'pages.yml'), []);

  // A second writer job beside the chain.
  const parallel = `${graph}\n  rogue:\n    steps:\n      - name: Rogue publish\n        uses: ./.github/actions/publish-upload\n        with:\n          extra-args: --skip-build`;
  const violations = publishSingleWriterViolations(workflowJobs(parallel), 'pages.yml');
  assert.equal(violations.length, 2); // beside the chain + a second --skip-build writer
  assert.match(violations[0], /rogue/);
  assert.match(violations[0], /concurrently/);
  assert.match(violations[1], /only the lone/);

  // A reordered edge: the matrix is no longer anchored to the baseline.
  const reordered = graph.replace(
    '    needs: baseline\n    strategy:',
    '    needs: pre-publish\n    strategy:'
  );
  const reorderedViolations = publishSingleWriterViolations(workflowJobs(reordered), 'pages.yml');
  assert.equal(reorderedViolations.length, 1);
  assert.match(reorderedViolations[0], /publish/);

  // The writer without its always() branch would skip on a packages-only
  // dispatch — and dropping the branch drops the gate-success checks with it.
  const noAlways = graph.replace(
    "    if: ${{ always() && needs.pre-publish.result == 'success' && needs.baseline.result == 'success' && (needs.publish.result == 'success' || (inputs.include == 'packages' && needs.publish.result == 'skipped')) }}",
    "    if: ${{ needs.publish.result == 'success' }}"
  );
  const noAlwaysViolations = publishSingleWriterViolations(workflowJobs(noAlways), 'pages.yml');
  assert.equal(noAlwaysViolations.length, 3);
  assert.match(noAlwaysViolations[0], /always\(\)/);
  assert.match(noAlwaysViolations[1], /pre-publish/);
  assert.match(noAlwaysViolations[2], /baseline/);

  // A second --skip-build invocation anywhere outside the writer is a violation.
  const doubleWriter = graph.replace(
    '          extra-args: --build-only',
    '          extra-args: --skip-build'
  );
  const doubleWriterViolations = publishSingleWriterViolations(
    workflowJobs(doubleWriter),
    'pages.yml'
  );
  assert.equal(doubleWriterViolations.length, 1);
  assert.match(doubleWriterViolations[0], /only the lone/);

  // A --build-only staging pass outside the matrix is a violation.
  const strayed = `${graph}\n  extra-stage:\n    steps:\n      - name: Stray stage\n        uses: ./.github/actions/publish-upload\n        with:\n          extra-args: --build-only`;
  const strayedViolations = publishSingleWriterViolations(workflowJobs(strayed), 'pages.yml');
  assert.equal(strayedViolations.length, 2); // beside the chain + staging outside the matrix
  assert.match(strayedViolations[0], /concurrently/);
  assert.match(strayedViolations[1], /outside the publish matrix/);
});

test('baseline-artifact-pairing: a download no upload produces is a violation', () => {
  const job = (name, action, extra = '') =>
    [
      'jobs:',
      `  ${name}:`,
      '    steps:',
      `      - uses: actions/${action}@deadbeef # vX`,
      '        with:',
      '          name: baseline-hashes',
      ...(extra ? [extra] : []),
    ].join('\n');
  const paired = `${job('baseline', 'upload-artifact')}\n${job('publish-win', 'download-artifact')}`;
  assert.deepEqual(baselineArtifactViolations(workflowJobs(paired), 'pages.yml'), []);
  const orphan = job('publish-win', 'download-artifact');
  const violations = baselineArtifactViolations(workflowJobs(orphan), 'pages.yml');
  assert.equal(violations.length, 1);
  assert.match(violations[0], /baseline-hashes/);
});

test('upload-invocation-wiring: a bare upload.mjs invocation is a violation', () => {
  const step = (envKeys, run) =>
    [
      'jobs:',
      '  publish-win:',
      '    steps:',
      '      - name: Publish',
      '        shell: bash',
      ...(envKeys ? ['        env:', ...envKeys.map(k => `          ${k}: '1'`)] : []),
      `        run: ${run}`,
    ].join('\n');
  const bare = step([], 'node tools/publish/upload.mjs --mode=dev');
  const violations = uploadInvocationViolations(workflowJobs(bare), 'pages.yml');
  assert.equal(violations.length, 3);
  assert.match(violations[0], /FXS_INTERNAL_CI/);
  assert.match(violations[1], /FIREFOX_SCRIPTS_STORED_HASHES_FILE/);
  assert.match(violations[2], /--include=/);

  const wired = step(
    ['FXS_INTERNAL_CI'],
    'ARGS="--mode=prod --include=all"; export FIREFOX_SCRIPTS_STORED_HASHES_FILE=x; node tools/publish/upload.mjs $ARGS'
  );
  assert.deepEqual(uploadInvocationViolations(workflowJobs(wired), 'pages.yml'), []);

  const noInclude = step(
    ['FXS_INTERNAL_CI'],
    'export FIREFOX_SCRIPTS_STORED_HASHES_FILE=x; node tools/publish/upload.mjs --mode=prod'
  );
  const noIncludeViolations = uploadInvocationViolations(workflowJobs(noInclude), 'pages.yml');
  assert.equal(noIncludeViolations.length, 1);
  assert.match(noIncludeViolations[0], /--include=/);
});

test('tokenVarViolations: a publish workflow without GITHUB_TOKEN_VAR is a violation', () => {
  const wired = 'env:\n  GITHUB_TOKEN_VAR: ${{ secrets.GITHUB_TOKEN }}\njobs:\n  a:';
  assert.deepEqual(tokenVarViolations(wired, 'pages.yml'), []);
  const violations = tokenVarViolations('env:\n  OTHER: x\njobs:\n  a:', 'pages.yml');
  assert.equal(violations.length, 1);
  assert.match(violations[0], /GITHUB_TOKEN_VAR/);
});

// ── the no-baseline verdict chain (#462 / #136 rework) ─────────────────────
// The chain is four files deep, and each hand could snap its own link:
// the drift-gate action must SURFACE the tool's `no-baseline:` marker as its
// own verdict, drift-check.yml must DISPATCH the watchdog for both verdicts
// that share the same remedy, and the two in-run consumers must treat a
// non-green verdict as failing the gate — never fall through to green.

/** The drift-gate composite action file, comments stripped. */
function readDriftGate() {
  return stripComments(
    fs
      .readFileSync(path.join(REPO_ROOT, '.github/actions/drift-gate/action.yml'), 'utf8')
      .replace(/\r\n/g, '\n')
  );
}

/**
 * The verdict chain across drift-gate + drift-check.yml + the in-run consumers.
 * `gate`/`probe` are injectable for the canary test — mutating a fixture copy
 * beats writing the real action.yml from a parallel test runner (node --test
 * runs files in processes, so a write-restore window is a race another file can
 * read, and a hard kill leaves the tree corrupted).
 *
 * @param {string} file file containing the coupling, for messages
 * @param {{gate?: string; probe?: string}} [texts] defaults read the real files
 * @returns {string[]}
 */
export function noBaselineChainViolations(
  file,
  {gate = readDriftGate(), probe = readWorkflow('drift-check.yml')} = {}
) {
  const violations = [];

  // 1. The gate surfaces the tool's marker as a distinct output + verdict:
  //    the marker is echoed into a no-baseline output, and the verdict step
  //    reads it FIRST (a drift/unknown read would lose the wipe condition).
  if (!/no-baseline=/m.test(gate) || !/verdict=no-baseline/.test(gate)) {
    violations.push(
      `${file}: drift-gate does not map the no-baseline marker to verdict=no-baseline`
    );
  }
  if (!/NO_BASELINE: \$\{\{ steps.drift.outputs.no-baseline \}\}/.test(gate)) {
    violations.push(`${file}: the verdict step does not read steps.drift.outputs.no-baseline`);
  }
  // The wipe verdict must win over the drift branch: inside the verdict
  // SCRIPT, the `$NO_BASELINE = 'true'` branch test must sit before the
  // `$DRIFT_STATUS != '0'` one. (An earlier version indexed the bare tokens
  // NO_BASELINE/DRIFT_STATUS — that compared the env: block keys, and the
  // folded guard made the inner push unreachable.)
  const nbIdx = gate.indexOf(`[ "$NO_BASELINE" = 'true' ]`);
  const driftBranchIdx = gate.indexOf(`[ "$DRIFT_STATUS" != '0' ]`);
  if (nbIdx === -1 || driftBranchIdx === -1 || nbIdx > driftBranchIdx) {
    violations.push(
      `${file}: verdict=no-baseline is checked after the drift branch — a wipe could read as drift and lose its auto-dispatch remedy`
    );
  }

  // 2. drift-check.yml dispatches the watchdog for BOTH baseline-side verdicts.
  const probeJobs = workflowJobs(probe);
  const dispatch = probeJobs
    .flatMap(job => jobSteps(job.body))
    .find(stepText => /workflow run url-watchdog/.test(stripComments(stepText)));
  if (!dispatch) {
    violations.push(`${file}: drift-check.yml has no url-watchdog dispatch step`);
  } else {
    // The condition can be line-folded YAML — match across the raw step text
    // instead of the single stepKeyValue value.
    const cond = stripComments(dispatch).replace(/\s+/g, ' ');
    if (!cond.includes("'drift'") || !cond.includes("'no-baseline'")) {
      violations.push(
        `${file}: the drift-check dispatch step's if is not pinned to BOTH drift and no-baseline (got: ${cond})`
      );
    }
    // A `--ref main` dispatch is required so the watchdog re-baselines the
    // default branch's cache entry the publish gate will read.
    if ((stepRun(dispatch) || '').includes('url-watchdog')) {
      const run = stepRun(dispatch);
      if (!run.includes('--ref main') && !run.includes("--ref 'main'")) {
        violations.push(
          `${file}: the watchdog dispatch must target --ref main (publish-gate caches live on the default branch)`
        );
      }
      if (!run.includes('gh workflow run')) {
        violations.push(
          `${file}: the dispatch step must call gh workflow run (say the tool's --dispatch shape)`
        );
      }
    }
  }

  // 3. The in-run consumers (pages.yml, build-and-upload.yml) keep failing
  //    closed: their verdict handlers may hand NO branch a green path except
  //    the literal 'green' — a no-baseline verdict falling into an else that
  //    exits 0 is the regression (the old fail-open hole).
  for (const consumer of ['pages.yml', 'build-and-upload.yml']) {
    const jobs = workflowJobs(readWorkflow(consumer));
    const actor = jobs
      .flatMap(job => jobSteps(job.body))
      .find(stepText => (stepName(stepText) || '').includes('Act on the gate verdict'));
    if (!actor) {
      violations.push(
        `${consumer}: no 'Act on the gate verdict' step — the drift gate's verdict goes unread`
      );
      continue;
    }
    const run = stepRun(actor);
    // Pin the shape: the ONLY exit-0 path in that script is the literal
    // 'green' comparison (or a dev-mode warn). A no-baseline line that falls
    // into a green exit is the regression the Publish pre-flight hole proved.
    const greenOnly = /if \[ "\$VERDICT" = 'green' \]/.test(run);
    if (!greenOnly) {
      violations.push(
        `${consumer}: the gate-actor's only green path must be the literal 'green' comparison`
      );
    }
    if (!run.trimEnd().endsWith('exit 1')) {
      violations.push(
        `${consumer}: the gate-actor script must end on exit 1 (fail-closed on every non-green verdict)`
      );
    }
  }

  return violations;
}

test('staged-set-parity: a platform staged but not published is a violation', () => {
  const jobs = platforms => [
    {
      name: 'build',
      body: [
        '    strategy:',
        '      matrix:',
        '        include:',
        ...platforms.map(p => `          - platform: ${p}`),
      ].join('\n'),
    },
    {
      name: 'publish',
      body: [
        '    steps:',
        '      - name: Publish',
        `        run: ARGS="--skip-build ${platforms.map(p => `--platform=${p}`).join(' ')}"; node tools/publish/upload.mjs $ARGS`,
      ].join('\n'),
    },
  ];
  assert.deepEqual(stagedSetViolations(jobs(['win', 'linux', 'mac']), 'build-and-upload.yml'), []);
  const extra = jobs(['win', 'linux', 'mac']);
  extra[1].body = extra[1].body.replace('--platform=linux ', '');
  const violations = stagedSetViolations(extra, 'build-and-upload.yml');
  assert.equal(violations.length, 1);
  assert.match(violations[0], /≠/);
});

// ── tests: the no-baseline verdict chain (#136 rework / #462) ──────────────

test('the real drift-gate + drift-check + publish consumers satisfy the no-baseline chain contract', () => {
  const failures = [...noBaselineChainViolations('drift-check.yml')];
  assert.deepEqual(failures, [], failures.join('\n'));
});

test('no-baseline chain: each link catches its own regression', () => {
  // Link 1: the gate must map the marker to its own verdict. Deleting the
  // verdict step's no-baseline branch breaks the chain — a MUTATED COPY passed
  // through the {gate} seam, never a write to the real action.yml (node --test
  // runs files in parallel processes; a write-then-restore window is a race
  // another file can read, and a hard kill would leave the tree corrupted).
  const brokenGate = stripComments(
    readDriftGate()
      .replace(/verdict=no-baseline' /g, '')
      .replace(/'verdict=no-baseline'/g, "'verdict=drift'")
  );
  const violations = noBaselineChainViolations('drift-check.yml', {gate: brokenGate});
  assert.ok(
    violations.some(v => /does not map the no-baseline marker/.test(v)),
    `expected the gate link to fail; got ${JSON.stringify(violations)}`
  );
});
