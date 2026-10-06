// test/unit/tools/record-validation-condition.test.mjs — the record-validation
// job's dispatch condition (#380 / ADR 0039).
//
// The condition is where the validated-versions record's semantics live: what
// may advance the file the prod publish pre-flight compares against the
// current releases. Getting it wrong in either direction is expensive —
// recording a version no full run ever tested (publish ships untested
// releases), or NOT recording a run that did test them (the publish gate
// blocks on drift for a whole night for no reason).
//
// The rule after #380: the updater legs are the evidence, so THEIR result is
// what keys the record — the gate aggregates every leg, and a red advisory or
// an unrelated required leg must not block it. A nightly whose `installer` leg
// flaked used to skip the record entirely and freeze the publish gate until
// the next night.
//
// Parsed from the workflow itself, so a condition edit that breaks the rule
// fails here rather than only on the first red nightly.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** Read a file LF-normalized (a local CRLF working copy must parse the same). */
function readWorkflow(file) {
  return fs.readFileSync(path.join(REPO_ROOT, file), 'utf8').replace(/\r\n/g, '\n');
}

/** The `if:` value of one top-level job, LF-normalized, comments stripped. */
function jobIf(workflowFile, jobId) {
  const text = readWorkflow(workflowFile);
  const start = text.indexOf(`  ${jobId}:`);
  if (start === -1) throw new Error(`job '${jobId}' not found in ${workflowFile}`);
  // The job block ends at the NEXT key at exactly two-space indent — `\n  `
  // alone matches every four-space-indented line too, so anchor it.
  const rest = text.slice(start + 2);
  const nextJob = /^ {2}[A-Za-z0-9_-]+:/m.exec(rest);
  const block = nextJob ? text.slice(start, start + 2 + nextJob.index) : text.slice(start);
  const m = / {4}if: >-\n([\s\S]*?)(?=\n {4}[a-z-]+:|\n {2}[a-z-]+:)/.exec(block);
  if (!m) throw new Error(`job '${jobId}' has no folded if: block`);
  return m[1]
    .split('\n')
    .map(l => l.replace(/#.*$/, '').trim())
    .filter(Boolean)
    .join(' ');
}

test('record-validation keys on the updater legs alone (ADR 0039)', () => {
  const cond = jobIf('.github/workflows/e2e.yml', 'record-validation');
  assert.match(cond, /needs\.updater\.result == 'success'/, 'updater legs are the evidence');
  // The gate is a SUMMARY of every leg; a red unrelated required leg or a red
  // advisory must not be able to block the record.
  assert.doesNotMatch(cond, /needs\.e2e-gate\.result == 'success'/);
});

test('record-validation still needs both the gate and the updater matrix', () => {
  const text = readWorkflow('.github/workflows/e2e.yml');
  const block = text.slice(text.indexOf('  record-validation:'));
  const needs = / {4}needs: \[([^\]]*)\]/
    .exec(block)?.[1]
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  assert.ok(needs, 'record-validation declares its needs');
  assert.deepEqual(needs, ['e2e-gate', 'updater']);
});

test('record-validation never records from a PR', () => {
  const cond = jobIf('.github/workflows/e2e.yml', 'record-validation');
  assert.match(cond, /github\.event_name != 'pull_request'/);
});

test('record-validation never records from a partial dispatch (ADR 0021)', () => {
  const cond = jobIf('.github/workflows/e2e.yml', 'record-validation');
  // A single-browser escape validated one fork; the hard-gate record must not
  // move, or the publish gate could ship a release no full run ever tested.
  assert.match(
    cond,
    /github\.event_name == 'workflow_dispatch'\s*&&\s*inputs\.browser != ''\s*&&\s*inputs\.browser != 'all'/
  );
});

test('a full dispatch still records — the nightly revalidation refreshes the record', () => {
  // The negative of the partial-dispatch guard: browser == 'all' must NOT be
  // excluded, or the nightly revalidation (browser=all, #426) would run the
  // whole matrix nightly and never advance the record.
  const cond = jobIf('.github/workflows/e2e.yml', 'record-validation');
  assert.match(cond, /inputs\.browser != 'all'/);
  assert.doesNotMatch(cond, /inputs\.browser == 'all'/);
});

test('the recorder still refuses to write a record with holes', () => {
  // The condition widening is safe because the tool under the job keeps its
  // own contract: every VALIDATED_BROWSER needs one artifact per expected OS,
  // agreeing. A run whose updater legs only PARTIALLY passed has holes in
  // .e2e-versions/ and exits 1 — the record cannot silently weaken.
  const recorder = readWorkflow('.github/workflows/e2e.yml').slice(
    readWorkflow('.github/workflows/e2e.yml').indexOf('Record validated browser versions')
  );
  assert.match(recorder, /run: node tools\/ci\/record-validated-versions\.mjs/);
  const tool = fs
    .readFileSync(path.join(REPO_ROOT, 'tools', 'ci', 'record-validated-versions.mjs'), 'utf8')
    .replace(/\r\n/g, '\n');
  assert.match(tool, /missing version artifacts for/);
  assert.match(tool, /OS legs disagree on the validated version/);
});
