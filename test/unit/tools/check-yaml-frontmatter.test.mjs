// test/unit/tools/check-yaml-frontmatter.test.mjs — the changed-YAML gate.
//
// The centrepiece is a real case: `.agents/skills/ai-review/SKILL.md`
// shipped a `: ` inside a multi-line plain frontmatter scalar, the host read no
// `description` and silently never registered the skill. prettier's
// markdown-frontmatter path exits 0 on it and `@eslint/markdown`'s
// `frontmatter: 'yaml'` does not validate, so nothing else in the toolchain
// catches it. These tests must therefore prove the gate is NON-VACUOUS: the
// exact buggy text is asserted to be flagged, and the one-line fix to pass.
//
// The string is built from parts so this file is itself valid frontmatter-free
// YAML-quoted source and so the fixture is unmistakably the historical text.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';

import {
  changedYamlMap,
  frontmatterRange,
  parseAddedLines,
  parseCandidate,
  rangeTouched,
  yamlCandidates,
} from '../../../tools/check-yaml-frontmatter.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const TOOL = path.join(REPO_ROOT, 'tools/check-yaml-frontmatter.mjs');

/**
 * The `.agents/skills/ai-review/SKILL.md` frontmatter body as it shipped in
 * `main` — note the `: ` inside the plain scalar, which terminates the
 * `description` value and starts a new mapping entry.
 *
 * @param {boolean} [fixed] emit the one-line fix instead
 * @returns {string}
 */
function aiReviewBody(fixed = false) {
  const fallback =
    fixed ?
      '  finding as its own line-anchored, individually resolvable review thread (fallback `gh pr review'
    : '  finding as its own line-anchored, individually resolvable review thread (fallback: `gh pr review';
  return [
    'name: ai-review',
    'description:',
    '  Review a PR the ADR 0020 way — run the local `pnpm review:local` reviewer, assess every',
    '  finding as right / wrong / useless with the disputed line quoted before any rejection, and',
    fallback,
    '  <n> --comment`, never `gh pr comment`), resolving each thread as its fix lands.',
    'metadata:',
    '  class: authored',
  ].join('\n');
}

/** A frontmatter candidate carrying its own body — no filesystem access. */
function candidate(body) {
  return {file: '.agents/skills/ai-review/SKILL.md', range: {start: 2, end: 11, body}};
}

// ── the incident (non-vacuity) ─────────────────────────────────────────────

test('the real ai-review frontmatter bug is flagged, with file-accurate line/column', () => {
  const finding = parseCandidate(candidate(aiReviewBody()));
  assert.ok(finding, 'the gate must flag the historical bug — otherwise it proves nothing');
  assert.equal(finding.reason, 'bad indentation of a mapping entry');
  assert.equal(finding.file, '.agents/skills/ai-review/SKILL.md');
  // The offending scalar is the 4th line of the body; line 1 of the file is the
  // opening fence, so the body's 4th line is file line 5... plus the offset that
  // makes js-yaml's 0-based mark 1-based.
  assert.equal(finding.line, 6);
  assert.ok(finding.column > 1, 'the column must be carried through for an actionable report');
});

test('dropping the colon is enough — the same text with the fix parses clean', () => {
  assert.equal(parseCandidate(candidate(aiReviewBody(true))), null);
});

test('quoting the whole description on one line is the other valid fix', () => {
  // The message's advice ("quote the value") is only actionable if it really
  // works — a multi-line scalar cannot be quoted line by line.
  const quoted = [
    'name: ai-review',
    'description: "Review a PR the ADR 0020 way (fallback: `gh pr review <n> --comment`)"',
    'metadata:',
    '  class: authored',
  ].join('\n');
  assert.equal(parseCandidate(candidate(quoted)), null);
});

test("the repo's own ai-review SKILL.md frontmatter parses (no live regression)", () => {
  const text = fs
    .readFileSync(path.join(REPO_ROOT, '.agents/skills/ai-review/SKILL.md'), 'utf8')
    .replace(/\r\n/g, '\n');
  const range = frontmatterRange(text);
  assert.ok(range, 'the SKILL.md must carry a frontmatter block');
  assert.equal(parseCandidate({file: '.agents/skills/ai-review/SKILL.md', range}), null);
});

test('a real workflow YAML file parses through the file-candidate path', () => {
  const finding = parseCandidate({file: '.github/workflows/ci.yml'});
  assert.equal(finding, null);
});

// ── frontmatterRange ───────────────────────────────────────────────────────

test('frontmatterRange reports the body span and the body text', () => {
  const text = '---\nname: x\ndescription: y\n---\n\n# Title\n';
  const range = frontmatterRange(text);
  assert.equal(range.start, 2);
  assert.equal(range.end, 3);
  assert.equal(range.body, 'name: x\ndescription: y');
});

test('frontmatterRange needs the opening fence on line 1 and a closing fence', () => {
  assert.equal(frontmatterRange('# Title\n---\nname: x\n---\n'), null, 'not on line 1');
  assert.equal(frontmatterRange('--- \nname: x\n'), null, 'no closing fence');
  assert.equal(frontmatterRange(''), null);
});

test('frontmatterRange tolerates CRLF after normalization', () => {
  const text = '---\r\nname: x\r\n---\r\n\r\n# Title\r\n'.replace(/\r\n/g, '\n');
  assert.deepEqual(frontmatterRange(text), {start: 2, end: 2, body: 'name: x'});
});

// ── rangeTouched: only frontmatter lines that changed count ────────────────

test('rangeTouched ignores body-only edits and fires on a frontmatter edit', () => {
  const range = {start: 2, end: 5};
  assert.equal(rangeTouched(range, new Set([7, 9])), false);
  assert.equal(rangeTouched(range, new Set([4])), true);
  assert.equal(
    rangeTouched(range, new Set([1])),
    false,
    'the opening fence is not part of the body'
  );
  assert.equal(rangeTouched(range, undefined), true, 'no line info ⇒ treat as changed');
});

// ── parseAddedLines: one diff, files + added lines ─────────────────────────

test('parseAddedLines collects new-file line numbers per file from a -U0 diff', () => {
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
    'diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml',
    'index 333..444 100644',
    '--- a/.github/workflows/ci.yml',
    '+++ b/.github/workflows/ci.yml',
    '@@ -10 +10 @@',
    '-  old: value',
    '+  new: value',
  ].join('\n');
  const map = parseAddedLines(diff);
  assert.deepEqual(
    [...map.get('docs/x.md')].sort((a, b) => a - b),
    [2, 3, 21, 22]
  );
  // A modified line is a -/+ pair; the new side must count as changed.
  assert.deepEqual([...map.get('.github/workflows/ci.yml')], [10]);
});

test('parseAddedLines unquotes the path git wrapped in quotes', () => {
  const diff = [
    'diff --git "a/docs/a b.md" "b/docs/a b.md"',
    '--- "a/docs/a b.md"',
    '+++ "b/docs/a b.md"',
    '@@ -1 +1 @@',
    '+x',
  ].join('\n');
  assert.deepEqual([...parseAddedLines(diff).keys()], ['docs/a b.md']);
});

// ── yamlCandidates: the changed-only scope ─────────────────────────────────

test('yamlCandidates keeps a changed YAML file and a touched frontmatter block', () => {
  const map = new Map([
    ['.github/workflows/ci.yml', new Set([4])],
    ['.agents/skills/ai-review/SKILL.md', new Set([6])],
  ]);
  const files = yamlCandidates(map)
    .map(c => c.file)
    .sort();
  assert.deepEqual(files, ['.agents/skills/ai-review/SKILL.md', '.github/workflows/ci.yml']);
});

test('yamlCandidates drops a markdown file whose body changed but whose frontmatter did not', () => {
  const map = new Map([['.agents/skills/ai-review/SKILL.md', new Set([40, 41, 42])]]);
  assert.deepEqual(yamlCandidates(map), []);
});

test('yamlCandidates drops markdown without frontmatter and non-YAML files', () => {
  const map = new Map([
    ['docs/DEVELOPING.md', new Set([1, 2, 3])],
    ['tools/check-yaml-frontmatter.mjs', new Set([1])],
    ['README.md', new Set([1])],
  ]);
  assert.deepEqual(yamlCandidates(map), []);
});

test('yamlCandidates never scans build products or dependencies', () => {
  const map = new Map([
    ['dist/scratch/bad.yml', new Set([1])],
    ['node_modules/pkg/bad.yaml', new Set([1])],
    ['.git/config.yml', new Set([1])],
  ]);
  assert.deepEqual(yamlCandidates(map), []);
});

test('a missing file (deleted after staging) yields no candidate', () => {
  const map = new Map([['docs/gone.yml', new Set([1])]]);
  const candidates = yamlCandidates(map);
  assert.deepEqual(
    candidates.map(c => c.file),
    ['docs/gone.yml']
  );
  assert.equal(parseCandidate(candidates[0]), null, 'parse must not throw on a vanished file');
});

// ── the changed-file seam ──────────────────────────────────────────────────

test('CHANGED_FILES env bypasses git and marks files as wholly changed', () => {
  process.env.CHANGED_FILES = 'docs/a.md\ntools/b.ts\nconfig/c.yaml';
  try {
    const map = changedYamlMap(REPO_ROOT, 'unused', () => {
      throw new Error('git must not be called');
    });
    assert.deepEqual([...map.keys()], ['docs/a.md', 'config/c.yaml']);
    assert.equal(map.get('docs/a.md'), undefined, 'no line info ⇒ whole file is changed');
    const candidates = yamlCandidates(map);
    // docs/a.md has no frontmatter in this repo; the .yaml does.
    assert.deepEqual(
      candidates.map(c => c.file),
      ['config/c.yaml']
    );
  } finally {
    delete process.env.CHANGED_FILES;
  }
});

test('changedYamlMap issues exactly one git diff, with the YAML pathspecs', () => {
  const calls = [];
  changedYamlMap(REPO_ROOT, 'feedface', (cmd, args) => {
    calls.push(args.join(' '));
    return '';
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0], /diff -U0/);
  assert.match(calls[0], /--diff-filter=ACMR/);
  assert.match(calls[0], /feedface\.\.\.HEAD/);
  for (const spec of ['*.md', '*.mdx', '*.yaml', '*.yml']) {
    assert.ok(calls[0].includes(spec), `pathspec ${spec} must be passed`);
  }
});

// ── end to end against the real repository ────────────────────────────────

test('the real gate exits 0 on this branch and reports what it scanned', () => {
  const out = execFileSync(process.execPath, [TOOL], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: {...process.env, CHANGED_FILES: '.agents/skills/ai-review/SKILL.md\npackage.json'},
  });
  assert.match(out, /check-yaml-frontmatter: clean \(1 changed YAML file\(s\) parsed\)/);
});
