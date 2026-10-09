// test/unit/tools/check-md-list-markers.test.mjs — the fused-list-marker gate.
// The four fixtures: the real AGENTS.md line
// (must flag), the quoted example inside code spans (must not), a legitimate
// mid-line dash (must not), and a fenced-block line (must not) — plus the
// whole-file fence-state rule (an ADDED line inside an UNCHANGED fenced block
// must not flag; a line after the fence has closed must still scan) and the
// diff plumbing (added-line hunk parsing, changed-lines-only scope, the
// vendored skills exclusion).

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';

// Strings below that QUOTE the buggy pattern use template literals on purpose:
// the gate strips code spans before matching, so this file can edit its own
// fixtures without tripping the gate (the same principle as the SKILL.md
// quoted example in the issue).

import {
  FUSED_MARKER_RE,
  changedMarkdownFiles,
  collectAddedLines,
  findFusedMarkers,
  fusedSnippet,
  stripCodeSpans,
} from '../../../tools/check-md-list-markers.mjs';

// ── the four fixtures from the issue ───────────────────────────────────────

test('fixture 1: the real AGENTS.md fused line is flagged', () => {
  const line = `  record to roughly half a page (Context / Decision / Consequences). -One decision`;
  const findings = findFusedMarkers('docs/x.md', [line], {
    baseSha: 'HEAD~1',
    runGit: () => '@@ -1 +1 @@\n+' + line,
  });
  assert.equal(findings.length, 1);
  assert.match(findings[0].snippet, /\)\. -One decision/);
  assert.equal(findings[0].line, 1);
});

test('fixture 2: the quoted example inside inline code spans is skipped', () => {
  // The incident note deliberately quotes the buggy string — quoting is not making.
  const line =
    'it flagged `SKILL.md:70` where the note quotes `… Consequences). -One decision` verbatim.';
  const findings = findFusedMarkers('docs/x.md', [line], {
    baseSha: 'HEAD~1',
    runGit: () => '@@ -1 +1 @@\n+' + line,
  });
  assert.deepEqual(findings, []);
});

test('fixture 3: a legitimate mid-line dash inside a sentence is skipped', () => {
  const line = 'the range is 3 - 5 items wide, and the dash-dash compounds are fine.';
  const findings = findFusedMarkers('docs/x.md', [line], {
    baseSha: 'HEAD~1',
    runGit: () => '@@ -1 +1 @@\n+' + line,
  });
  assert.deepEqual(findings, []);
});

test('fixture 4: a line inside a fenced block is skipped', () => {
  const lines = [
    '```markdown',
    `… keep the record to roughly half a page (Context / Decision / Consequences). -One decision`,
    '```',
  ];
  const diff = ['@@ -1,3 +1,3 @@', '+```markdown', '+' + lines[1], '+```'].join('\n');
  const findings = findFusedMarkers('docs/x.md', lines, {baseSha: 'HEAD~1', runGit: () => diff});
  assert.deepEqual(findings, []);
});

test('fixture 5: an ADDED line inside an UNCHANGED fenced block is skipped (whole-file fence state)', () => {
  const lines = [
    'intro paragraph',
    '```markdown',
    `… keep the record to roughly half a page (Context / Decision / Consequences). -One decision`,
    'still fenced prose',
    '```',
    'outro',
  ];
  // Only line 4 is added; the opening fence (line 2) is UNCHANGED, so a
  // changed-lines-only fence walk would treat line 4 as prose and flag it.
  // Fence state must come from walking the whole file.
  const diff = ['@@ -4 +4 @@', '+' + lines[3]].join('\n');
  const findings = findFusedMarkers('docs/x.md', lines, {baseSha: 'HEAD~1', runGit: () => diff});
  assert.deepEqual(findings, []);
});

test('an added line after the same fence has CLOSED still scans (fence tracking is exact)', () => {
  const lines = ['```', 'fenced', '```', `a fused marker after the fence:). -Tail rule`];
  const diff = ['@@ -4 +4 @@', '+' + lines[3]].join('\n');
  const findings = findFusedMarkers('docs/x.md', lines, {baseSha: 'HEAD~1', runGit: () => diff});
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 4);
});

// ── the detector itself ────────────────────────────────────────────────────

test('the detector matches the three sentence-end forms and no lowercase or comma form', () => {
  assert.match(`… Consequences). -One decision`, FUSED_MARKER_RE);
  assert.match(`… half a page: -One decision`, FUSED_MARKER_RE);
  assert.match(`… two rules. -One decision`, FUSED_MARKER_RE);
  assert.doesNotMatch('… record, -one decision', FUSED_MARKER_RE);
  assert.doesNotMatch('… record, -One decision', FUSED_MARKER_RE);
  assert.doesNotMatch('the range 3 - 5 items', FUSED_MARKER_RE);
  // em dash / minus are not hyphen-minus
  assert.doesNotMatch('… Consequences). —One decision', FUSED_MARKER_RE);
});

test('fusedSnippet carves a bounded window from the original text', () => {
  const s = fusedSnippet('x'.repeat(40) + `). -Rule` + 'y'.repeat(40));
  assert.ok(s.startsWith('…') && s.endsWith('…'));
  assert.match(s, /\) \. -Rule|\. -Rule/);
});

test('stripCodeSpans blanks code spans but keeps length for column math', () => {
  const text = 'before `a). -Rule` after';
  assert.equal(stripCodeSpans(text).length, text.length);
  assert.doesNotMatch(stripCodeSpans(text), FUSED_MARKER_RE);
});

// ── changed-lines-only scope (the issue: added/changed lines of changed files) ─

test('collectAddedLines parses -U0 hunks and skips context and minus lines', () => {
  const diff = [
    'diff --git a/docs/x.md b/docs/x.md',
    'index 111..222 100644',
    '--- a/docs/x.md',
    '+++ b/docs/x.md',
    '@@ -1,3 +1,4 @@',
    ' context line',
    '-removed line',
    '+added line 1',
    '+added line 2',
    ' context',
    '@@ -20 +21,2 @@',
    '+added line 3',
    '+added line 4',
    '\\ No newline at end of file',
  ].join('\n');
  const added = new Set();
  collectAddedLines(diff, added);
  assert.deepEqual(
    [...added].sort((a, b) => a - b),
    [2, 3, 21, 22]
  );
});

test('findFusedMarkers only scans added lines — a fused line in unchanged prose stays silent', () => {
  const lines = ['old untouched prose with a fused marker (like this). -Preexisting', 'clean line'];
  // hunk only touches line 2
  const findings = findFusedMarkers('docs/x.md', lines, {
    baseSha: 'HEAD~1',
    runGit: () => '@@ -1 +2 @@\n+clean line',
  });
  assert.deepEqual(findings, []);
});

test('findFusedMarkers with no base treats every line as changed (worst case)', () => {
  delete process.env.BASE_SHA;
  const lines = [`fused (a). -Rule here`];
  const findings = findFusedMarkers('docs/x.md', lines, {
    runGit: () => {
      throw new Error('git must not be called');
    },
  });
  assert.equal(findings.length, 1);
});

test('files under .agents/skills are excluded (ADR 0022 — vendored text stays pristine)', () => {
  const abs = fileURLToPath(new URL('../../../.agents/skills/lavish/SKILL.md', import.meta.url));
  const findings = findFusedMarkers(abs, [`fused (a). -Rule`], {
    runGit: () => {
      throw new Error('git must not be called');
    },
  });
  assert.deepEqual(findings, []);
});

// ── changedMarkdownFiles (seams; no real git) ──────────────────────────────

test('changedMarkdownFiles filters the diff to markdown only', () => {
  const files = changedMarkdownFiles([], {
    baseSha: 'deadbeef',
    runGit: () => '.github/workflows/pages.yml\ndocs/x.md\nREADME.md\n',
  });
  assert.deepEqual(files, ['docs/x.md', 'README.md']);
});

test('CHANGED_FILES env wins over git (test harness escape)', () => {
  process.env.CHANGED_FILES = 'docs/a.md\ntools/b.ts';
  try {
    assert.deepEqual(
      changedMarkdownFiles([], {
        runGit: () => {
          throw new Error('git must not be called');
        },
      }),
      ['docs/a.md']
    );
  } finally {
    delete process.env.CHANGED_FILES;
  }
});

test('BASE_SHA env pins the base without a merge-base lookup', () => {
  process.env.BASE_SHA = 'feedface';
  const calls = [];
  try {
    const files = changedMarkdownFiles([], {
      runGit: (cmd, args) => {
        calls.push(args.join(' '));
        return 'docs/only-this.md\n';
      },
    });
    assert.deepEqual(files, ['docs/only-this.md']);
    assert.equal(calls.length, 1, 'only the name-only diff runs');
    assert.match(calls[0], /diff --name-only/);
    assert.ok(!calls.some(c => c.includes('merge-base')), 'env base skips merge-base resolution');
  } finally {
    delete process.env.BASE_SHA;
  }
});
