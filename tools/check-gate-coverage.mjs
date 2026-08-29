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
  text = text.replace(/\r\n/g, '\n');
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
    if (f) jobs.get(current).ifs.push(f[1]);
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
    // the gate's `applicability:` block.
    gatedIfs: {
      'snapshot': "needs.changes.outputs.updater == 'true' || needs.changes.outputs.core == 'true'",
      'installer': "needs.changes.outputs.installer == 'true'",
      'helper': "needs.changes.outputs.updater == 'true'",
      'updater': "needs.changes.outputs.updater == 'true'",
      'browser-matrix':
        "needs.changes.outputs.updater == 'true' || needs.changes.outputs.core == 'true'",
    },
    applicability: ['snapshot', 'installer', 'helper', 'updater', 'browser-matrix'],
    // Runs after e2e-gate: records the validated browser versions (#4) only
    // when every browser leg passed.
    postGate: ['record-validation'],
  },
  {
    file: '.github/workflows/ci.yml',
    gate: 'ci-gate',
    noJobIf: ['build'], // always-report design — heavy steps gated, job always runs
  },
];

export function main() {
  const errors = [];
  for (const contract of CONTRACTS) {
    const text = fs.readFileSync(path.join(REPO_ROOT, contract.file), 'utf-8');
    errors.push(...checkWorkflow(text, contract));
  }
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
