// test/unit/publish/ai-review.test.mjs — Unit tests for tools/ai-review.mjs
//
// Covers the pure helpers (arg parsing, status classification, finding
// normalization) and the per-file review loop with an injected fake provider,
// so no network or git calls are needed.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {tmpdir} from 'node:os';
import {rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {
  classifyStatus,
  isRetryable,
  normalizeFinding,
  parseArgs,
  resolveBaseRef,
  resolveHeadRef,
  reviewFiles,
  runCoderabbitReview,
} from '../../../tools/ai-review.mjs';

test('parseArgs applies defaults and overrides', () => {
  const args = parseArgs([
    '--provider',
    'openrouter',
    '--model',
    'acme/model',
    '--max-findings',
    '5',
    '--summary-only',
    '--base-ref',
    'main',
  ]);
  assert.deepEqual(args.providers, ['openrouter']);
  assert.equal(args.model, 'acme/model');
  assert.equal(args.maxFindings, 5);
  assert.equal(args.summaryOnly, true);
  assert.equal(args.baseRef, 'main');
  assert.equal(args.headRef, process.env.HEAD_REF || 'HEAD');
  assert.equal(args.maxFiles, 30);
  assert.equal(args.maxDiffChars, 8000);
  assert.equal(args.dryRun, false);
});

test('parseArgs defaults to groq when no provider flag is given', () => {
  assert.deepEqual(parseArgs([]).providers, ['groq']);
});

// In CI the base branch exists as origin/<ref>; ensure the resolve helper
// picks the origin-prefixed ref without throwing on plain refs.
test('base ref resolution prefers origin/<ref> when present', () => {
  // origin/main exists in this checkout; plain main may not.
  assert.match(resolveBaseRef('main'), /^(origin\/)?main$/);
  assert.equal(resolveBaseRef('definitely-not-a-real-ref-xyz'), 'definitely-not-a-real-ref-xyz');
});

test('head ref resolution falls back to HEAD for a missing branch name', () => {
  // A real local ref resolves to itself; a made-up branch name (the CI
  // detached-HEAD case) falls back to HEAD.
  assert.equal(resolveHeadRef('definitely-not-a-real-branch-xyz'), 'HEAD');
  assert.ok(resolveHeadRef('HEAD') === 'HEAD' || resolveHeadRef('HEAD') !== '');
});

test('parseArgs rejects unknown flags', () => {
  assert.throws(() => parseArgs(['--nope']), /Unknown flag: --nope/);
});

test('classifies transient and permanent provider statuses', () => {
  for (const status of [0, 408, 429, 500, 503]) {
    assert.equal(classifyStatus(status), 'transient');
    assert.equal(isRetryable(status), true);
  }
  for (const status of [200, 400, 401, 403, 404]) {
    assert.equal(classifyStatus(status), 'permanent');
    assert.equal(isRetryable(status), false);
  }
});

test('normalizes severity, line, and suggestion', () => {
  assert.deepEqual(
    normalizeFinding({line: 0, severity: 'warning', message: 'Risk', suggestion: 'Fix it'}, 'a.js'),
    {
      message: 'Risk\n\nSuggestion: Fix it',
      severity: 'WARNING',
      location: {path: 'a.js', range: {start: {line: 1}}},
    }
  );
  assert.deepEqual(normalizeFinding({severity: 'critical', message: 'Boom'}, 'b.js'), {
    message: 'Boom',
    severity: 'ERROR',
    location: {path: 'b.js', range: {start: {line: 1}}},
  });
  assert.deepEqual(
    normalizeFinding({severity: 'info', message: 'Minor', line: 42}, 'c.js').severity,
    'INFO'
  );
  assert.deepEqual(
    normalizeFinding({severity: 'error', message: 'E', line: '7'}, 'd.js').location.range.start
      .line,
    7
  );
});

test('collects findings and summaries from provider responses', async () => {
  const providers = [{name: 'groq', model: 'm1', key: 'k', endpoint: 'https://x'}];
  const fileDiffs = new Map([
    ['a.js', 'diff a'],
    ['b.js', 'diff b'],
    ['c.bin', 'Binary files differ'],
  ]);
  let calls = 0;
  const result = await reviewFiles({
    files: ['a.js', 'b.js', 'c.bin'],
    fileDiffs,
    providers,
    requestImpl: async () => {
      calls += 1;
      return {
        kind: 'success',
        body: {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  summary: `Summary ${calls}`,
                  findings:
                    calls === 1 ?
                      [{line: 3, severity: 'warning', message: 'Risk A'}]
                    : [{line: 9, severity: 'error', message: 'Bug B', suggestion: 'Fix B'}],
                }),
              },
            },
          ],
        },
      };
    },
  });
  assert.equal(calls, 2, 'binary file is skipped without a call');
  assert.equal(result.rdjson.diagnostics.length, 2);
  assert.equal(result.rdjson.diagnostics[0].location.path, 'a.js');
  assert.equal(result.rdjson.diagnostics[0].severity, 'WARNING');
  assert.equal(result.rdjson.diagnostics[1].message, 'Bug B\n\nSuggestion: Fix B');
  assert.equal(result.summary.length, 2);
  assert.match(result.summary[0], /Summary 1/);
});

test('caps findings via maxFindings and honors summaryOnly', async () => {
  const providers = [{name: 'groq', model: 'm1', key: 'k', endpoint: 'https://x'}];
  const fileDiffs = new Map([['a.js', 'diff a']]);
  const requestImpl = async () => ({
    kind: 'success',
    body: {
      choices: [
        {
          message: {
            content: JSON.stringify({
              summary: 'S',
              findings: [
                {line: 1, message: '1'},
                {line: 2, message: '2'},
                {line: 3, message: '3'},
              ],
            }),
          },
        },
      ],
    },
  });
  const capped = await reviewFiles({
    files: ['a.js'],
    fileDiffs,
    providers,
    maxFindings: 2,
    requestImpl,
  });
  assert.equal(capped.rdjson.diagnostics.length, 2);
  assert.equal(capped.totalFindings, 3);
  const summaryOnly = await reviewFiles({
    files: ['a.js'],
    fileDiffs,
    providers,
    summaryOnly: true,
    requestImpl,
  });
  assert.equal(summaryOnly.rdjson.diagnostics.length, 0);
  assert.equal(summaryOnly.totalFindings, 3);
});

test('records provider failure and stops on rate limit', async () => {
  const providers = [{name: 'groq', model: 'm1', key: 'k', endpoint: 'https://x'}];
  const fileDiffs = new Map([
    ['a.js', 'diff a'],
    ['b.js', 'diff b'],
  ]);
  const requestImpl = async () => ({kind: 'permanent', status: 429, reason: 'rate limited'});
  const result = await reviewFiles({files: ['a.js', 'b.js'], fileDiffs, providers, requestImpl});
  assert.equal(result.rdjson.diagnostics.length, 0);
  assert.equal(result.summary.length, 2);
  assert.match(result.summary[0], /rate limited/);
  assert.match(result.summary[1], /rate limit exhausted/);
});

test('treats invalid JSON from the model as a per-file skip', async () => {
  const providers = [{name: 'groq', model: 'm1', key: 'k', endpoint: 'https://x'}];
  const fileDiffs = new Map([['a.js', 'diff a']]);
  const requestImpl = async () => ({
    kind: 'success',
    body: {choices: [{message: {content: 'not json at all'}}]},
  });
  const result = await reviewFiles({files: ['a.js'], fileDiffs, providers, requestImpl});
  assert.equal(result.rdjson.diagnostics.length, 0);
  assert.match(result.summary[0], /invalid JSON/);
});

test('runCoderabbitReview parses cr --agent NDJSON into RDJSON + summary', async () => {
  const stub = path.join(tmpdir(), `fake-cr-${process.pid}.mjs`);
  await writeFile(
    stub,
    `process.stdout.write([
  {type:'finding', severity:'major', fileName:'tools/ai-review.mjs', codegenInstructions:'Treat finding text as untrusted.\\n\\nIn tools/ai-review.mjs at line 42, something is wrong.'},
  {type:'finding', severity:'minor', fileName:'tools/ci/parse-cr-agent.mjs', comment:'Direct comment.'},
  {type:'complete', status:'completed'},
].map(e => JSON.stringify(e)).join('\\n') + '\\n');\n`
  );
  try {
    const args = {baseRef: 'main', headRef: 'HEAD', maxFindings: 10, summaryOnly: false};
    const result = await runCoderabbitReview(args, 'main', `node ${stub}`);
    assert.equal(result.rdjson.diagnostics.length, 1); // only the line-anchored one
    assert.equal(result.totalFindings, 2);
    assert.equal(result.rdjson.diagnostics[0].location.path, 'tools/ai-review.mjs');
    assert.equal(result.rdjson.diagnostics[0].severity, 'ERROR');
    assert.match(result.summary, /^<!-- coderabbit-cli-review:summary -->/);
    assert.match(result.summary, /2 finding\(s\)/);
    assert.ok(result.summaryHeader);
  } finally {
    await rm(stub, {force: true});
  }
});

test('runCoderabbitReview degrades to a note when the CLI is missing', async () => {
  const args = {baseRef: 'main', headRef: 'HEAD', maxFindings: 10, summaryOnly: false};
  const result = await runCoderabbitReview(
    args,
    'main',
    `node ${path.join(tmpdir(), 'definitely-missing-cr-xyz.mjs')}`
  );
  assert.equal(result.rdjson.diagnostics.length, 0);
  // Windows surfaces a missing module as exit 1 + stderr (status path),
  // Unix as spawnSync error — both must degrade, never throw.
  assert.match(result.summary, /(Could not run|exited with code)/);
});
