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
//   - publish-serialization  pages.yml's publish jobs form ONE needs-chain
//                            (pre-publish → baseline → win → linux → mac);
//                            the gh-pages/release single-writer property is
//                            bought with that chain, so a new parallel
//                            branch is a concurrent-writer bug, not a speedup.
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

// ── contract: publish-serialization (pages.yml) ────────────────────────────

/** The single-writer needs-chain pages.yml must keep. */
const PUBLISH_CHAIN = {
  'pre-publish': [],
  'baseline': ['pre-publish'],
  'publish-win': ['baseline'],
  'publish-linux': ['publish-win'],
  'publish-mac': ['publish-linux'],
};

/**
 * The publish jobs must form exactly one needs-chain. The gh-pages commits and
 * release uploads have no lock — the serialization IS the correctness mechanism
 * (pages.yml header: "they can never interleave"). A job added beside the
 * chain, or a reordered edge, is a concurrent-writer bug.
 *
 * @param {{name: string; body: string}[]} jobs
 * @param {string} file file name for messages
 * @returns {string[]}
 */
export function publishChainViolations(jobs, file) {
  const violations = [];
  const actual = new Set(jobs.map(job => job.name));
  for (const name of Object.keys(PUBLISH_CHAIN)) {
    if (!actual.has(name)) violations.push(`${file}: publish job '${name}' is missing`);
  }
  for (const name of actual) {
    if (!(name in PUBLISH_CHAIN)) {
      violations.push(
        `${file}: job '${name}' is not part of the publish needs-chain — extend ` +
          'PUBLISH_CHAIN consciously: a job beside the chain can write gh-pages concurrently'
      );
    }
  }
  const byName = new Map(jobs.map(job => [job.name, job]));
  for (const [name, expected] of Object.entries(PUBLISH_CHAIN)) {
    const job = byName.get(name);
    if (!job) continue;
    const needs = jobNeeds(job.body);
    if (needs.length !== expected.length || expected.some((n, i) => needs[i] !== n)) {
      violations.push(
        `${file}: '${name}' needs [${needs.join(', ')}] but the single-writer chain pins ` +
          `[${expected.join(', ')}]`
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
    id: 'publish-serialization',
    description: 'the publish jobs form exactly one single-writer needs-chain',
    check: text => publishChainViolations(workflowJobs(text), 'pages.yml'),
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

test('publish-serialization: a job beside the chain is a violation', () => {
  const job = (name, needs) =>
    [
      'jobs:',
      `  ${name}:`,
      ...(needs ? [`    needs: ${needs}`] : []),
      '    runs-on: ubuntu-24.04',
    ].join('\n');
  const chain = [
    job('pre-publish', ''),
    job('baseline', 'pre-publish'),
    job('publish-win', 'baseline'),
    job('publish-linux', 'publish-win'),
    job('publish-mac', 'publish-linux'),
  ].join('\n');
  assert.deepEqual(publishChainViolations(workflowJobs(chain), 'pages.yml'), []);

  const parallel = `${chain}\n${job('publish-arm', 'baseline')}`;
  const violations = publishChainViolations(workflowJobs(parallel), 'pages.yml');
  assert.equal(violations.length, 1);
  assert.match(violations[0], /publish-arm/);
  assert.match(violations[0], /concurrently/);

  const reordered = chain.replace('    needs: publish-win', '    needs: baseline');
  const reorderedViolations = publishChainViolations(workflowJobs(reordered), 'pages.yml');
  assert.equal(reorderedViolations.length, 1);
  assert.match(reorderedViolations[0], /publish-linux/);
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
