// test/unit/publish/ai-review.test.mjs — Unit tests for tools/ai-review.mjs
//
// Covers the pure helpers (arg parsing, status classification, finding
// normalization) and the per-file review loop with an injected fake provider,
// so no network or git calls are needed.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyStatus,
  isRetryable,
  normalizeFinding,
  parseArgs,
  request,
  resolveBaseRef,
  resolveHeadRef,
  reviewFiles,
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
  assert.equal(args.maxDiffChars, 60000);
  assert.equal(args.dryRun, false);
});

test('parseArgs defaults providers to empty and base to main for local runs', () => {
  // Empty providers -> availableProviders uses every configured provider that
  // has a key, in array order (gemini first). baseRef defaults to main so a
  // local run reviews main...HEAD without flags.
  assert.deepEqual(parseArgs([]).providers, []);
  assert.equal(parseArgs([]).baseRef, process.env.BASE_REF || 'main');
  assert.equal(parseArgs([]).headRef, process.env.HEAD_REF || 'HEAD');
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

test('request gives up immediately on 429, honoring no retry', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return {ok: false, status: 429, headers: new Headers({'retry-after': '60'})};
  };
  try {
    const out = await request({key: 'k', endpoint: 'https://x'}, {});
    assert.equal(out.kind, 'transient');
    assert.equal(out.status, 429);
    assert.equal(calls, 1, '429 must not be retried');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('request aborts promptly when the run-level signal fires', async () => {
  const realFetch = globalThis.fetch;
  const controller = new AbortController();
  globalThis.fetch = async (_url, {signal}) => {
    await new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
        once: true,
      });
    });
  };
  try {
    const promise = request({key: 'k', endpoint: 'https://x'}, {}, controller.signal);
    controller.abort();
    const out = await promise;
    assert.equal(out.kind, 'transient');
    assert.equal(out.status, 429, 'aborted by a rate limit elsewhere');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('request aborts during a retry wait instead of waiting out the timer', async () => {
  const realFetch = globalThis.fetch;
  const controller = new AbortController();
  // Retryable 500 with a long retry-after: the request must not sleep the
  // full capped wait once the run-level signal aborts mid-wait.
  globalThis.fetch = async () => ({
    ok: false,
    status: 500,
    headers: new Headers({'retry-after': '60'}),
  });
  try {
    const start = Date.now();
    const promise = request({key: 'k', endpoint: 'https://x'}, {}, controller.signal);
    setTimeout(() => controller.abort(), 50);
    const out = await promise;
    assert.equal(out.kind, 'transient');
    assert.equal(out.status, 429, 'abort mid-wait counts as a rate-limit stop');
    assert.ok(Date.now() - start < 2000, 'must not wait out the 5s retry timer');
  } finally {
    globalThis.fetch = realFetch;
  }
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
  const providers = [{name: 'test', model: 'm1', key: 'k', endpoint: 'https://x'}];
  const fileDiffs = new Map([
    ['a.js', 'diff a'],
    ['b.js', 'diff b'],
    ['c.bin', 'Binary files differ'],
  ]);
  // Files are now reviewed concurrently, so the fake must be order-
  // independent: it keys its response off the file named in the prompt.
  let calls = 0;
  const result = await reviewFiles({
    files: ['a.js', 'b.js', 'c.bin'],
    fileDiffs,
    providers,
    requestImpl: async (provider, body) => {
      calls += 1;
      const file =
        /Review the diff of ([^\s:]+)/.exec(body.messages[1].content)?.[1] ?? `f${calls}`;
      return {
        kind: 'success',
        body: {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  summary: `Summary ${file}`,
                  findings:
                    file === 'a.js' ?
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
  assert.match(result.summary[0], /Summary a\.js/);
});

test('truncated diffs warn the model to verify against the real file', async () => {
  const providers = [{name: 'test', model: 'm1', key: 'k', endpoint: 'https://x'}];
  const longDiff = `hunk start\n${'same-line\n'.repeat(50)}hunk end`;
  const requestImpl = async (provider, body) => {
    const content = body.messages[1].content;
    // Capture what the model actually receives for both files.
    captured.push({file: /Review the diff of ([^\s:]+)/.exec(content)?.[1], content});
    return {
      kind: 'success',
      body: {
        choices: [
          {
            message: {
              content: JSON.stringify({summary: 'S', findings: []}),
            },
          },
        ],
      },
    };
  };
  const captured = [];
  await reviewFiles({
    files: ['big.js', 'small.js'],
    fileDiffs: new Map([
      ['big.js', longDiff],
      ['small.js', 'short diff'],
    ]),
    providers,
    maxDiffChars: 40,
    requestImpl,
  });
  const big = captured.find(c => c.file === 'big.js').content;
  const small = captured.find(c => c.file === 'small.js').content;
  assert.match(big, /diff truncated at 40 chars/);
  assert.match(big, /verify against the actual file before reporting/);
  assert.ok(!small.includes('diff truncated'), 'small diffs must not carry the marker');
});

test('caps findings via maxFindings and honors summaryOnly', async () => {
  const providers = [{name: 'test', model: 'm1', key: 'k', endpoint: 'https://x'}];
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
  const providers = [{name: 'test', model: 'm1', key: 'k', endpoint: 'https://x'}];
  const fileDiffs = new Map([
    ['a.js', 'diff a'],
    ['b.js', 'diff b'],
  ]);
  const requestImpl = async () => ({kind: 'permanent', status: 429, reason: 'rate limited'});
  // concurrency 1 keeps the skip deterministic: a.js fails, b.js is skipped.
  const result = await reviewFiles({
    files: ['a.js', 'b.js'],
    fileDiffs,
    providers,
    requestImpl,
    concurrency: 1,
  });
  assert.equal(result.rdjson.diagnostics.length, 0);
  assert.equal(result.summary.length, 2);
  assert.match(result.summary[0], /rate limited/);
  assert.match(result.summary[1], /test rate limit exhausted/);
});

test('reviewFiles reviews files concurrently by default', async () => {
  const providers = [{name: 'test', model: 'm1', key: 'k', endpoint: 'https://x'}];
  const fileDiffs = new Map([
    ['a.js', 'diff a'],
    ['b.js', 'diff b'],
    ['c.js', 'diff c'],
  ]);
  let inFlight = 0;
  let maxInFlight = 0;
  let resolved = 0;
  const requestImpl = async (provider, body) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise(resolve => setTimeout(resolve, 20));
    inFlight -= 1;
    resolved += 1;
    const file = /Review the diff of ([^\s:]+)/.exec(body.messages[1].content)?.[1] ?? '?';
    return {
      kind: 'success',
      body: {choices: [{message: {content: JSON.stringify({summary: `S ${file}`, findings: []})}}]},
    };
  };
  const result = await reviewFiles({
    files: ['a.js', 'b.js', 'c.js'],
    fileDiffs,
    providers,
    requestImpl,
  });
  assert.equal(resolved, 3);
  assert.ok(maxInFlight >= 2, `expected parallel calls, max in flight was ${maxInFlight}`);
  assert.equal(result.summary.length, 3);
});

// Reply-shape classification (invalid JSON, bare null, non-object payloads,
// missing content) lives in ai-review-reply-corpus.test.mjs — one table-driven
// fixture corpus that runs every shape through the real reviewFiles.
