#!/usr/bin/env node

/**
 * tools/check-gate-coverage.mjs — static contract for the aggregate gates.
 *
 * `e2e-gate` / `ci-gate` are the repo's single branch-protection checks, so a
 * green aggregate check must cover every job. Two regressions are invisible to
 * the runtime guards in .github/actions/verify-gate:
 *
 * 1. A NEW job added to a workflow is silently INVISIBLE to the gate unless it is
 *    listed in the gate's `needs:`.
 * 2. A path-filter `if:` removed from a gated job silently un-gates it (the
 *    runtime skip-guard only fires on the NEXT docs-only PR).
 *
 * This script parses the two workflow files and asserts the contract:
 *
 * - needs-coverage: every job (except the gate itself) is in the gate's needs.
 * - gated-if: each independently filtered job carries its expected job-level
 *   changed-paths `if:` (the e2e workflow uses separate installer/updater/core
 *   outputs, so a single branchKey no longer describes it).
 * - no-job-if: jobs that must always run/report (the always-report design) carry
 *   NO job-level `if:`.
 * - gate-if: the gate job carries `if: always()`.
 * - applicability: every independently filtered job is listed in the gate's
 *   `applicability:` block, so verify.sh can require it skipped when not
 *   applicable.
 * - verify-gate-uses: the gate job invokes ./.github/actions/verify-gate exactly
 *   once, and ONLY that step's `with:` block is parsed as gate wiring (another
 *   action's inputs must not satisfy the contract).
 * - post-gate: jobs declared in the contract's `postGate` list run AFTER the gate
 *   (they `needs:` it — e.g. the E2E workflow's validated-versions recorder,
 *   #4). They cannot bypass the gate, so they are exempt from needs-coverage,
 *   but they must exist, must need the gate, and must not be wired into the
 *   gate's verify-gate results (that would create a cycle).
 *
 * Exit code 0 = contract holds. Run via `pnpm check:gates` (part of the
 * `checks` CI job). The parser is deliberately small — the workflow files are
 * ours and simple; YAML anchors or folded job definitions would need a real
 * parser, and the gate engine (verify-gate) would need re-testing anyway.
 */

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const JOB_LINE = /^ {2}([A-Za-z0-9_-]+):\s*$/;
const NEEDS_LINE = /^ {4}needs:\s*(.+)$/;
const IF_LINE = /^ {4}if:\s*(.+)$/;
const STEP_LINE = /^ {6}- /;
// `uses:` appears either inline with the step dash (`      - uses: x`) or
// keyed under `- name:` (`        uses: x`). Strip a trailing `# comment`.
const USES_LINE = /^(?: {6}- | {8})uses:\s*(.+)$/;
const WITH_LINE = /^ {8}with:\s*$/;
const WITH_INPUT = /^ {10}([A-Za-z0-9_-]+):\s*(.*)$/;
const RESULTS_PAIR = /^ {12}([A-Za-z0-9_-]+):/;
const VERIFY_GATE_USES = './.github/actions/verify-gate';

/**
 * Split a workflow YAML into per-job blocks. Only the top-level `jobs:` map is
 * parsed; within a job block, job-level `needs:`/`if:` lines (4-space indent)
 * are captured — step-level `if:`s live at deeper indents and are ignored. The
 * verify-gate `with:` block (10-space inputs, 12-space `results:` pairs) is
 * captured per job for the wiring assertions.
 *
 * @param {string} text
 * @returns {Map<
 *   string,
 *   {
 *     ifs: string[];
 *     needs: string[];
 *     with: Object<string, any>;
 *     verifyGateUses: number;
 *   }
 * >}
 */
export function parseJobs(text) {
  // Normalize CRLF → LF so a Windows-edited working-tree workflow file (git
  // keeps it as CRLF locally even though it is committed/checked out as LF)
  // cannot smuggle a trailing `\r` into an `if:` capture and false-fail the
  // contract. Real-world trigger: e2e.yml parsed from a CRLF local copy.
  //
  // Also re-fold YAML plain-scalar continuations: prettier breaks a long
  // job-level `if:` into a bare `if:` key line plus indented continuation
  // lines, but the contract compares against the single-line expression.
  // Join ONLY that exact shape — a 4-space key with an empty value followed
  // by deeper-indented non-key lines — so with-blocks / block scalars
  // (10/12-space, keys with values) are untouched.
  const rawLines = text.replace(/\r\n/g, '\n').split('\n');
  const lines = [];
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];
    const prev = lines[lines.length - 1];
    const prevIsFoldableKey = prev !== undefined && /^ {4}[A-Za-z0-9_-]+:\s*$/.test(prev);
    const isContinuation =
      /^ {6,}\S/.test(raw) && !/^ {6,}[A-Za-z0-9_-]+:/.test(raw) && !/^ {6,}[-#]/.test(raw); // step dashes and comments are never scalar text
    if (prevIsFoldableKey && isContinuation) {
      // Fold the full continuation run (prettier may wrap a long scalar over
      // several lines) into the key line.
      let joined = `${prev} ${raw.trim()}`;
      while (
        i + 1 < rawLines.length &&
        /^ {6,}\S/.test(rawLines[i + 1]) &&
        !/^ {6,}[A-Za-z0-9_-]+:/.test(rawLines[i + 1]) &&
        !/^ {6,}[-#]/.test(rawLines[i + 1])
      ) {
        joined += ` ${rawLines[++i].trim()}`;
      }
      lines[lines.length - 1] = joined;
      continue;
    }
    lines.push(raw);
  }
  text = lines.join('\n');
  const jobs = new Map();
  let current = null;
  let inJobs = false;
  let withKey = null;
  // Step-level tracking: `uses:` of the current step, and whether we are
  // inside a `with:` block that belongs to a non-verify-gate step (those are
  // skipped — see WITH_LINE handling below).
  let currentUses = null;
  let skippingWith = false;
  for (const line of text.split('\n')) {
    if (/^jobs:\s*$/.test(line)) {
      inJobs = true;
      continue;
    }
    if (!inJobs) continue;
    if (/^\S/.test(line)) break; // a top-level key after `jobs:`

    // Inside a skipped `with:` block (a step that is NOT the verify-gate
    // action): consume 10+-space content lines silently until we dedent back
    // to step level — another action's inputs must never be read as gate
    // wiring.
    if (skippingWith) {
      if (/^ {10,}/.test(line)) continue;
      skippingWith = false;
    }

    // Inside a `with:` block: 12-space `results:` pairs, 10-space inputs, or
    // an outdent that ends the block.
    if (withKey !== null) {
      const rl = RESULTS_PAIR.exec(line);
      if (rl && withKey === 'results') {
        jobs.get(current).with.results.push(rl[1]);
        continue;
      }
      if (rl && withKey === 'applicability') {
        jobs.get(current).with.applicability.push(rl[1]);
        continue;
      }
      const wi = WITH_INPUT.exec(line);
      if (wi) {
        withKey = wi[1] === 'results' ? 'results' : wi[1];
        if (withKey === 'results') jobs.get(current).with.results = [];
        else if (withKey === 'applicability') jobs.get(current).with.applicability = [];
        else jobs.get(current).with[wi[1]] = wi[2].trim();
        continue;
      }
      // Continuation line: prettier wraps a long 10-space input value onto the
      // next line at 12 spaces (e.g. `required:` split over two lines). Append
      // it to the open scalar instead of treating it as an outdent — otherwise
      // the classification lists silently lose their tail.
      if (
        withKey !== null &&
        /^ {12}\S/.test(line) &&
        withKey !== 'results' &&
        withKey !== 'applicability'
      ) {
        jobs.get(current).with[withKey] =
          `${jobs.get(current).with[withKey]} ${line.trim()}`.trim();
        continue;
      }
      withKey = null; // left the with block
    }

    const m = JOB_LINE.exec(line);
    if (m) {
      current = m[1];
      jobs.set(current, {ifs: [], needs: [], with: {}, verifyGateUses: 0});
      continue;
    }
    if (!current) continue;
    // Step boundary: step-level tracking resets — every step must re-declare
    // its own `uses:`. (The dash line itself may carry the inline `uses:`,
    // so fall through to USES_LINE instead of continuing.)
    if (STEP_LINE.test(line)) currentUses = null;
    const u = USES_LINE.exec(line);
    if (u) {
      currentUses = u[1].replace(/\s+#.*$/, '').trim();
      if (currentUses === VERIFY_GATE_USES) jobs.get(current).verifyGateUses += 1;
      continue;
    }
    if (WITH_LINE.test(line)) {
      // Only the verify-gate action's `with:` block is gate wiring; any other
      // step's with-block (checkout's fetch-depth, …) is skipped wholesale.
      if (currentUses === VERIFY_GATE_USES) withKey = '__with__';
      else skippingWith = true;
      continue;
    }
    const wi = WITH_INPUT.exec(line);
    if (wi) {
      withKey = wi[1] === 'results' ? 'results' : wi[1];
      if (withKey === 'results') jobs.get(current).with.results = [];
      else if (withKey === 'applicability') jobs.get(current).with.applicability = [];
      else jobs.get(current).with[wi[1]] = wi[2].trim();
      continue;
    }
    const n = NEEDS_LINE.exec(line);
    if (n) {
      // Both forms appear in the workflows: 'needs: changes' and
      // 'needs: [changes, snapshot]'.
      const raw = n[1].trim();
      jobs.get(current).needs =
        raw.startsWith('[') ?
          raw
            .slice(1, -1)
            .split(',')
            .map(s => s.trim())
            .filter(Boolean)
        : [raw];
      continue;
    }
    const f = IF_LINE.exec(line);
    if (f) {
      // Prettier folds a long plain-scalar `if:` into a `key:` + indented
      // continuation (e.g. e2e.yml's browser-matrix filter). Join the indented
      // continuation lines so the captured value is the single-line expression
      // the contract compares against. A deeper indent would be a nested
      // object, but job-level `if:` values are always scalars.
      jobs.get(current).ifs.push(f[1].replace(/\s+#.*$/, '').trim());
      continue;
    }
  }
  return jobs;
}

/**
 * Assert the gate contract for one workflow. Returns a list of error strings
 * (empty = contract holds).
 *
 * @param {string} text workflow YAML
 * @param {{
 *   file: string;
 *   gate: string;
 *   gatedIfs?: Record<string, string>;
 *   noJobIf?: string[];
 *   applicability?: string[];
 *   postGate?: string[];
 * }} contract
 * @returns {string[]}
 */
export function checkWorkflow(text, contract) {
  const {file, gate, gatedIfs = {}, noJobIf = [], applicability = [], postGate = []} = contract;
  const errors = [];
  const jobs = parseJobs(text);
  const gateJob = jobs.get(gate);
  if (!gateJob) {
    errors.push(`${file}: gate job '${gate}' not found`);
    return errors;
  }

  for (const name of jobs.keys()) {
    if (name === gate) continue;
    // post-gate jobs run AFTER the gate (they need it) and are checked by
    // their own rules below — exempting them here is the point of postGate.
    if (postGate.includes(name)) continue;
    if (!gateJob.needs.includes(name)) {
      errors.push(
        `${file}: job '${name}' is not in ${gate}'s needs — it would bypass the gate silently`
      );
    }
  }
  for (const name of postGate) {
    const job = jobs.get(name);
    if (!job) {
      errors.push(`${file}: post-gate job '${name}' not found`);
      continue;
    }
    if (gateJob.needs.includes(name)) {
      errors.push(
        `${file}: post-gate job '${name}' must not be in ${gate}'s needs (it already needs the gate — a cycle)`
      );
    }
    if (!job.needs.includes(gate)) {
      errors.push(`${file}: post-gate job '${name}' must need '${gate}'`);
    }
  }
  for (const name of gateJob.needs) {
    if (!jobs.has(name)) {
      errors.push(`${file}: ${gate} needs unknown job '${name}'`);
    }
  }

  for (const [name, expectedIf] of Object.entries(gatedIfs)) {
    const job = jobs.get(name);
    if (!job) {
      errors.push(`${file}: gated job '${name}' not found`);
      continue;
    }
    if (!job.ifs.includes(expectedIf)) {
      errors.push(`${file}: '${name}' must carry the path-filter 'if: ${expectedIf}'`);
    }
  }
  for (const name of noJobIf) {
    const job = jobs.get(name);
    if (!job) {
      errors.push(`${file}: job '${name}' not found (noJobIf)`);
      continue;
    }
    if (job.ifs.length > 0) {
      errors.push(
        `${file}: '${name}' must have NO job-level if (always-report design), found: ${job.ifs.join(', ')}`
      );
    }
  }
  if (!gateJob.ifs.includes('always()')) {
    errors.push(`${file}: gate '${gate}' must carry 'if: always()'`);
  }

  // The `with:` wiring below is only meaningful for the verify-gate action.
  // Require the gate job to invoke it exactly once, so a renamed or swapped
  // `uses:` cannot detach the wiring from the engine it configures.
  if ((gateJob.verifyGateUses ?? 0) !== 1) {
    errors.push(
      `${file}: ${gate} must use ./.github/actions/verify-gate exactly once (found ${gateJob.verifyGateUses ?? 0})`
    );
  }

  // verify-gate `with:` wiring: every needed job (except `changes`, which is
  // verified through changes-result) must be in `results:`, every `results`
  // job must be classified in one of the branch inputs, and every classified
  // job must be in `results:`. A needed job absent from results would run
  // verify.sh's lookup with 'missing' — wrong behavior surfaced only at
  // runtime, so pin it statically.
  const w = gateJob.with;
  const splitList = v =>
    typeof v === 'string' && v.trim() ? v.trim().split(/\s+/).filter(Boolean) : [];
  const results = w.results || [];
  const classified = [
    ...splitList(w.required),
    ...splitList(w.advisory),
    ...splitList(w['skip-guard']),
    ...splitList(w['always-report']),
    ...splitList(w['always-verify']),
  ];
  for (const name of gateJob.needs) {
    if (name === 'changes') continue;
    if (!results.includes(name)) {
      errors.push(`${file}: ${gate} needs '${name}' but its verify-gate results do not include it`);
    }
  }
  for (const name of postGate) {
    if (results.includes(name)) {
      errors.push(`${file}: ${gate} results must not include post-gate job '${name}'`);
    }
  }
  for (const name of results) {
    if (!classified.includes(name)) {
      errors.push(
        `${file}: ${gate} results include '${name}' but it is not classified (required/advisory/skip-guard/always-report/always-verify)`
      );
    }
  }
  for (const name of classified) {
    if (!results.includes(name)) {
      errors.push(`${file}: ${gate} classifies '${name}' but it is not in the verify-gate results`);
    }
  }
  // Every independently filtered job must be listed in the gate's
  // `applicability:` block — otherwise verify.sh defaults it to "applies"
  // and a filtered-out job would be verified instead of required-skipped.
  const app = w.applicability || [];
  for (const name of applicability) {
    if (!app.includes(name)) {
      errors.push(`${file}: ${gate} applicability block is missing '${name}'`);
    }
  }
  return errors;
}

const CONTRACTS = [
  {
    file: '.github/workflows/e2e.yml',
    gate: 'e2e-gate',
    // Independent filter outputs (installer/updater/core) — each gated job
    // must carry exactly its expected changed-paths `if:` and be listed in
    // the gate's `applicability:` block. browser-matrix AND snapshot
    // additionally run for a single-browser manual-escape dispatch (ADR 0021;
    // snapshot must run because browser-matrix needs it and a needs-chain
    // skip is transitive, #143) — the combined `if:` is their contract.
    gatedIfs: {
      'snapshot':
        "needs.changes.outputs.updater == 'true' || needs.changes.outputs.core == 'true' || github.event_name == 'workflow_dispatch' && inputs.browser != 'all'",
      'installer': "needs.changes.outputs.installer == 'true'",
      'helper': "needs.changes.outputs.updater == 'true'",
      'updater': "needs.changes.outputs.updater == 'true'",
      'updater-waterfox':
        "needs.changes.outputs.updater == 'true' || needs.changes.outputs.core == 'true' || github.event_name == 'workflow_dispatch' && inputs.browser == 'waterfox'",
      'core-lifecycle': "needs.changes.outputs.core == 'true'",
      'browser-matrix':
        "needs.changes.outputs.updater == 'true' || needs.changes.outputs.core == 'true' || github.event_name == 'workflow_dispatch' && inputs.browser != 'all'",
      'fork-portable':
        "needs.changes.outputs.updater == 'true' || needs.changes.outputs.core == 'true' || github.event_name == 'workflow_dispatch' && inputs.browser != 'all' && inputs.browser != 'librewolf'",
    },
    applicability: [
      'snapshot',
      'installer',
      'helper',
      'updater',
      'updater-waterfox',
      'core-lifecycle',
      'browser-matrix',
      'fork-portable',
    ],
    // Runs after e2e-gate: records the validated browser versions (#4) only
    // when every browser leg passed, and cleans up the temporary
    // ci-downloads release after a single-browser manual escape (ADR 0021).
    postGate: ['record-validation', 'cleanup-ci-downloads'],
  },
  {
    file: '.github/workflows/ci.yml',
    gate: 'ci-gate',
    noJobIf: ['build'], // always-report design — heavy steps gated, job always runs
  },
];

/**
 * Script-coverage contract (the `test:e2e:legacy` rule, 2026-09): every
 * `test:*` npm script must be reachable from automation — a workflow step, the
 * `lint` pipeline, another test script, or a unit-test import — or be listed in
 * MANUAL_TEST_SCRIPTS with a reason. An unreferenced script is the exact
 * failure mode PR #245 shipped: `test:e2e:legacy` existed but nothing ever ran
 * it, so the legacy-chrome lifecycle it exercises was "tested" only on the
 * author's machine.
 *
 * The reachability closure starts from .github/workflows + .github/actions
 * texts and the package.json `lint`/`format` pipelines; every script a root (or
 * an already-reachable script) invokes joins the surfaces, and a script
 * invoking another script counts only once IT is reachable — an orphaned
 * wrapper cannot launder its callee. Names match exactly (`test:foo` is not
 * covered by `test:foo:bar`), YAML `#` comments are stripped, and explicit
 * allowlist entries pass. Unit tests importing the underlying .mjs directly
 * (e.g. manifest-lifecycle's helpers) do NOT count — the point is that the
 * end-to-end script runs.
 */
export const MANUAL_TEST_SCRIPTS = new Map([
  // test:e2e / :installer / :updater wrap the same scripts CI runs directly
  // (e2e.yml invokes installer-e2e.mjs / updater-e2e.mjs itself); run.mjs is
  // the local orchestrator. test:skills is the --skip-tests variant of the
  // check-skills stage that pnpm lint runs in full.
  ['test:e2e', 'local orchestrator — CI runs installer-e2e/updater-e2e directly'],
  ['test:e2e:installer', 'local convenience — e2e.yml runs installer-e2e.mjs directly'],
  ['test:e2e:updater', 'local convenience — e2e.yml runs updater-e2e.mjs directly'],
  ['test:skills', 'frontmatter-only variant of the lint pipeline stage'],
]);

/**
 * Collect every test:* script name from package.json and return the ones not
 * reachable from automation (see the contract comment above for the closure
 * rules).
 *
 * @param {{
 *   pkg?: string;
 *   workflowDir?: string;
 *   readFileSync?: typeof fs.readFileSync;
 * }} [opts]
 *   injectable paths/readers for unit tests
 * @returns {string[]} human-readable violations (empty = contract holds)
 */
export function checkTestScriptCoverage(opts = {}) {
  const read = opts.readFileSync ?? fs.readFileSync;
  const pkgPath = opts.pkg ?? path.join(REPO_ROOT, 'package.json');
  const wfDir = opts.workflowDir ?? path.join(REPO_ROOT, '.github');
  const errors = [];

  let pkg;
  try {
    pkg = JSON.parse(read(pkgPath, 'utf8'));
  } catch {
    return ['package.json unreadable — cannot verify test script coverage'];
  }
  const testScripts = Object.keys(pkg.scripts ?? {}).filter(s => s.startsWith('test:'));

  // Automation roots: every workflow/action file's text plus the lint and
  // format pipelines — the entry points CI actually executes.
  const roots = [];
  const stack = [wfDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, {withFileTypes: true});
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else roots.push(read(p, 'utf8'));
    }
  }
  roots.push(pkg.scripts?.lint ?? '', pkg.scripts?.format ?? '');

  // Reachability closure (CodeRabbit, #250): a script's command text joins
  // the surfaces only once the script itself is reachable from the roots, so
  // an unreferenced wrapper cannot launder the script it invokes. Names match
  // exactly — `test:foo` is not covered by a mention of `test:foo:bar` — and
  // YAML `#` comments are stripped so a commented-out invocation never counts.
  const allScripts = pkg.scripts ?? {};
  const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Script names come from our own package.json (never external input) — the
  // non-literal RegExp is exact-matching against an escaped literal.
  const patterns = new Map(
    Object.keys(allScripts).map(n => [
      n,
      // eslint-disable-next-line security/detect-non-literal-regexp -- names are our own package.json keys, escaped then exact-matched
      new RegExp(`(?<![\\w:-])${escapeRe(n)}(?![\\w:-])`),
    ])
  );
  const stripYamlComments = t => t.replace(/(^|\s)#[^\n]*/g, '$1');
  const texts = roots.map(stripYamlComments);
  const reachable = new Set();
  let grew = true;
  while (grew) {
    grew = false;
    for (const [name, pattern] of patterns) {
      if (reachable.has(name)) continue;
      if (texts.some(t => pattern.test(t))) {
        reachable.add(name);
        texts.push(stripYamlComments(String(allScripts[name])));
        grew = true;
      }
    }
  }

  for (const script of testScripts) {
    if (MANUAL_TEST_SCRIPTS.has(script)) continue;
    if (!reachable.has(script)) {
      errors.push(
        `test script '${script}' is not reachable from any workflow, action, the lint/format pipelines, or a reachable script chain (and is not allowlisted) — wire it into CI (like test:e2e:legacy now is) or add it to MANUAL_TEST_SCRIPTS with a reason`
      );
    }
  }
  return errors;
}

export function main() {
  const errors = [];
  for (const contract of CONTRACTS) {
    const text = fs.readFileSync(path.join(REPO_ROOT, contract.file), 'utf-8');
    errors.push(...checkWorkflow(text, contract));
  }
  errors.push(...checkTestScriptCoverage());
  if (errors.length > 0) {
    for (const e of errors) console.error(`✗ ${e}`);
    console.error(`\nGate contracts violated (${errors.length}).`);
    process.exit(1);
  }
  const jobCount = CONTRACTS.map(c => {
    const jobs = parseJobs(fs.readFileSync(path.join(REPO_ROOT, c.file), 'utf-8'));
    return `${c.file}: ${jobs.size} jobs, gate covers all`;
  }).join('\n  ');
  console.log(`✓ Gate contracts hold\n  ${jobCount}`);
}

const isMain = process.argv[1] && path.basename(process.argv[1]) === 'check-gate-coverage.mjs';
if (isMain) {
  main();
}
