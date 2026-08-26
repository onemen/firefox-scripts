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
 * - gated-if: jobs that must be path-filtered carry the filter's job-level `if:
 *   needs.changes.outputs.<key> == 'true'`.
 * - no-job-if: jobs that must always run/report (the publish gate's always-report
 *   design) carry NO job-level `if:`.
 * - gate-if: the gate job carries `if: always()`.
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
const WITH_LINE = /^ {8}with:\s*$/;
const WITH_INPUT = /^ {10}([A-Za-z0-9_-]+):\s*(.*)$/;
const RESULTS_PAIR = /^ {12}([A-Za-z0-9_-]+):/;

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
 *   {ifs: string[]; needs: string[]; with: Object<string, any>}
 * >}
 */
export function parseJobs(text) {
  const jobs = new Map();
  let current = null;
  let inJobs = false;
  let withKey = null;
  for (const line of text.split('\n')) {
    if (/^jobs:\s*$/.test(line)) {
      inJobs = true;
      continue;
    }
    if (!inJobs) continue;
    if (/^\S/.test(line)) break; // a top-level key after `jobs:`

    // Inside a `with:` block: 12-space `results:` pairs, 10-space inputs, or
    // an outdent that ends the block.
    if (withKey !== null) {
      const rl = RESULTS_PAIR.exec(line);
      if (rl && withKey === 'results') {
        jobs.get(current).with.results.push(rl[1]);
        continue;
      }
      const wi = WITH_INPUT.exec(line);
      if (wi) {
        withKey = wi[1] === 'results' ? 'results' : wi[1];
        if (withKey === 'results') jobs.get(current).with.results = [];
        else jobs.get(current).with[wi[1]] = wi[2].trim();
        continue;
      }
      withKey = null; // left the with block
    }

    const m = JOB_LINE.exec(line);
    if (m) {
      current = m[1];
      jobs.set(current, {ifs: [], needs: [], with: {}});
      continue;
    }
    if (!current) continue;
    if (WITH_LINE.test(line)) {
      withKey = '__with__';
      continue;
    }
    const wi = WITH_INPUT.exec(line);
    if (wi) {
      withKey = wi[1] === 'results' ? 'results' : wi[1];
      if (withKey === 'results') jobs.get(current).with.results = [];
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
 *   branchKey: string;
 *   gated?: string[];
 *   noJobIf?: string[];
 * }} contract
 * @returns {string[]}
 */
export function checkWorkflow(text, contract) {
  const {file, gate, branchKey, gated = [], noJobIf = []} = contract;
  const errors = [];
  const jobs = parseJobs(text);
  const gateJob = jobs.get(gate);
  if (!gateJob) {
    errors.push(`${file}: gate job '${gate}' not found`);
    return errors;
  }

  for (const name of jobs.keys()) {
    if (name === gate) continue;
    if (!gateJob.needs.includes(name)) {
      errors.push(
        `${file}: job '${name}' is not in ${gate}'s needs — it would bypass the gate silently`
      );
    }
  }
  for (const name of gateJob.needs) {
    if (!jobs.has(name)) {
      errors.push(`${file}: ${gate} needs unknown job '${name}'`);
    }
  }

  const expectIf = `needs.changes.outputs.${branchKey} == 'true'`;
  for (const name of gated) {
    const job = jobs.get(name);
    if (!job) {
      errors.push(`${file}: gated job '${name}' not found`);
      continue;
    }
    if (!job.ifs.includes(expectIf)) {
      errors.push(`${file}: '${name}' must carry the path-filter 'if: ${expectIf}'`);
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
  return errors;
}

const CONTRACTS = [
  {
    file: '.github/workflows/e2e.yml',
    gate: 'e2e-gate',
    branchKey: 'e2e',
    gated: ['snapshot', 'installer', 'helper', 'updater', 'browser-matrix'],
  },
  {
    file: '.github/workflows/ci.yml',
    gate: 'ci-gate',
    branchKey: 'publish',
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
