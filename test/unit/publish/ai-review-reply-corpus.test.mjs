'use strict';

// test/unit/publish/ai-review-reply-corpus.test.mjs
//
// Provider-reply fixture corpus for reviewFiles: every row is one observed or
// conceivable provider-reply shape, and one shared test body runs it through
// the real reviewFiles with an injected requestImpl. A future malformed-reply
// regression is fixed by adding a row — the table names the shape, the body
// asserts the contract.
//
// Contract under test, per reply shape:
//   outcome   — how reviewFiles must classify it
//   summary   — 0 or 1 lines, matched against `wantSummary`
//   findings  — how many normalized diagnostics reach rdjson
//
// shapes marked proven:'live' came out of real provider runs; 'hypothetical'
// rows are cheap insurance against the next weird reply.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {reviewFiles} from '../../../tools/ai-review.mjs';

const GOOD_FINDING = {severity: 'minor', line: 3, message: 'possible off-by-one'};

const okBody = parsed => ({choices: [{message: {content: JSON.stringify(parsed)}}]});
const rawBody = text => ({choices: [{message: {content: text}}]});

const CORPUS = [
  // ── Happy path ────────────────────────────────────────────────────────────
  {
    name: 'valid reply with one finding',
    body: okBody({summary: 'looks fine', findings: [GOOD_FINDING]}),
    outcome: 'normal',
    wantFindings: 1,
  },

  // ── Unusable payloads that must fail soft per file (no crash, no findings).
  // Every row here crashed or would have crashed before the #117 guard, or
  // guards a shape the guard does not explicitly cover.
  {
    name: 'bare null — JSON.parse("null") succeeds (crashed the run before #117)',
    provenance: 'live',
    body: rawBody('null'),
    outcome: 'skip',
    wantSummary: /unusable JSON reply/,
  },
  {
    name: 'a bare number',
    body: rawBody('42'),
    outcome: 'skip',
    wantSummary: /unusable JSON reply/,
  },
  {
    name: 'a bare string',
    body: rawBody('"just a string"'),
    outcome: 'skip',
    wantSummary: /unusable JSON reply/,
  },
  {
    name: 'a bare boolean',
    body: rawBody('true'),
    outcome: 'skip',
    wantSummary: /unusable JSON reply/,
  },
  {
    name: 'an empty array — object-shaped, but no summary/findings slots',
    body: rawBody('[]'),
    outcome: 'skip',
    wantSummary: /unusable JSON reply/,
  },
  {
    name: 'plain prose, not JSON at all',
    body: rawBody('not json at all'),
    outcome: 'skip',
    wantSummary: /unusable JSON reply/,
  },
  {
    name: 'markdown-fenced JSON (```json … ```) — parse error',
    body: rawBody('```json\n{"summary":"s","findings":[]}\n```'),
    outcome: 'skip',
    wantSummary: /unusable JSON reply/,
  },
  {
    name: 'missing message slot entirely',
    body: {choices: [{}]},
    outcome: 'skip',
    wantSummary: /unusable JSON reply/,
  },
  {
    name: 'no choices at all',
    body: {choices: []},
    outcome: 'skip',
    wantSummary: /unusable JSON reply/,
  },
  {
    name: 'content is JSON null literal inside an otherwise fine body',
    body: {choices: [{message: {content: null}}]},
    outcome: 'skip',
    wantSummary: /unusable JSON reply/,
  },

  // ── Usable object, degenerate contents: not a skip — normalize findings
  // and never trust the model's arithmetic.
  {
    name: 'findings not an array — ignored, zero findings',
    body: okBody({summary: 's', findings: 'everything is fine'}),
    outcome: 'normal',
    wantFindings: 0,
  },
  {
    name: 'null entries inside findings — normalized to INFO with empty message, then filtered',
    body: okBody({summary: 's', findings: [null, GOOD_FINDING]}),
    outcome: 'normal',
    wantFindings: 1,
  },
  {
    name: 'line as a string with junk — clamped, not trusted',
    body: okBody({
      summary: 's',
      findings: [{severity: 'minor', line: 'line 12 or so', message: 'm'}],
    }),
    outcome: 'normal',
    wantFindings: 1,
  },
  {
    name: 'negative line — clamped to 1',
    body: okBody({summary: 's', findings: [{severity: 'minor', line: -5, message: 'm'}]}),
    outcome: 'normal',
    wantFindings: 1,
  },
  {
    name: 'empty message — dropped by the message.trim() filter',
    body: okBody({summary: 's', findings: [{severity: 'minor', line: 1, message: '   '}]}),
    outcome: 'normal',
    wantFindings: 0,
  },
];

// One thing the per-row table cannot express: a malformed reply must stay
// isolated to its own file. The corpus rows are single-file by design; this
// companion test proves a bad reply for one file neither crashes the run nor
// contaminates a good file reviewed concurrently — the #117 crash did exactly
// that (one null reply killed the whole multi-file review).
test('reply corpus: a malformed reply for one file does not touch its peers', async () => {
  const providers = [{name: 'test', model: 'm1', key: 'k', endpoint: 'https://x'}];
  const requestImpl = async (_provider, body) => {
    const file = /Review the diff of ([^\s:]+)/.exec(body.messages[1].content)?.[1] ?? '?';
    return file === 'bad.js' ?
        {kind: 'success', body: rawBody('null')} // the live #117 killer shape
      : {kind: 'success', body: okBody({summary: `fine ${file}`, findings: [GOOD_FINDING]})};
  };
  const result = await reviewFiles({
    files: ['bad.js', 'good1.js', 'good2.js'],
    fileDiffs: new Map([
      ['bad.js', 'd'],
      ['good1.js', 'd'],
      ['good2.js', 'd'],
    ]),
    providers,
    requestImpl,
  });
  // The good files' findings survive; only the malformed file is skipped.
  assert.equal(result.rdjson.diagnostics.length, 2);
  assert.ok(result.rdjson.diagnostics.every(d => d.location.path !== 'bad.js'));
  const skip = result.summary.filter(line => /unusable JSON reply/.test(line));
  assert.equal(skip.length, 1, 'exactly one per-file skip note');
  assert.match(skip[0], /bad\.js/);
});

/** Run one corpus row through the real reviewFiles with an injected provider. */
async function runOne(row) {
  const providers = [{name: 'test', model: 'm1', key: 'k', endpoint: 'https://x'}];
  const requestImpl = async () => ({kind: 'success', body: row.body});
  return reviewFiles({
    files: ['a.js'],
    fileDiffs: new Map([['a.js', 'diff']]),
    providers,
    requestImpl,
  });
}

for (const row of CORPUS) {
  test(`reply corpus: ${row.name}`, async () => {
    const result = await runOne(row);

    if (row.outcome === 'skip') {
      assert.equal(result.rdjson.diagnostics.length, 0, 'skipped replies must yield no findings');
      assert.equal(result.summary.length, 1, 'skipped replies must explain themselves once');
      assert.match(result.summary[0], row.wantSummary);
    } else {
      assert.equal(result.summary.length, 1);
      assert.doesNotMatch(result.summary[0], /skipped|unusable/);
      const findings = result.rdjson.diagnostics.length;
      assert.equal(findings, row.wantFindings, `expected ${row.wantFindings} diagnostics`);
    }
  });
}

test('reply corpus: the table itself stays honest (unique names, known outcomes)', () => {
  const names = CORPUS.map(r => r.name);
  assert.equal(new Set(names).size, names.length, 'corpus row names must be unique');
  for (const row of CORPUS) {
    assert.ok(['skip', 'normal'].includes(row.outcome), `${row.name}: unknown outcome`);
  }
});
