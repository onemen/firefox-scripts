// test/unit/tools/check-hygiene.test.mjs — the leftover-reference gates.
//
// Three guards over tracked files (tools/check-hygiene.mjs, `lint:hygiene`
// stage): no dot-local dir references in code (and no concrete
// dot-local/<path> references in docs), no leftover batch/audit markers in
// code, and authored skills stay under the line cap (third-party skills carry
// github-repo frontmatter and are exempt per ADR 0022).
//
// Fixture hygiene: the tokens under test are built by concatenation, never
// written literally — otherwise this file would flag itself.

import {test} from 'node:test';
import assert from 'node:assert/strict';

import {
  LOCAL_CONCRETE_RE,
  LOCAL_REF_RE,
  MARKER_RE,
  SKILL_LINE_CAP,
  findLocalRefs,
  findMarkers,
  overlongSkills,
} from '../../../tools/check-hygiene.mjs';

// The literal tokens, assembled so this file never contains them.
const DOT_LOCAL_SLASH = '.loc' + 'al/';
const BATCH_MARK = 'batch #' + '3';
const AUDIT_MARK = 'audit P' + '2-10';

// ── dot-local references ───────────────────────────────────────────────────

test('findLocalRefs: a code file touching the dot-local dir is a violation', () => {
  const violations = findLocalRefs([
    {path: 'tools/foo.mjs', lines: ['const p = ' + `'.${DOT_LOCAL_SLASH}plan.md';`]},
  ]);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /tools\/foo\.mjs/);
});

test('findLocalRefs: clean code passes', () => {
  const violations = findLocalRefs([
    {path: 'tools/foo.mjs', lines: ['const p = path.join(a, b);']},
  ]);
  assert.deepEqual(violations, []);
});

test('findLocalRefs: bare prose about the ignored dir is not a concrete reference', () => {
  // docs may explain the gitignore rule ("never base work on the dot-local
  // dir"); only a concrete dot-local/<path> reference counts there.
  assert.equal(LOCAL_CONCRETE_RE.test('never base work on `.local` drafts'), false);
  assert.equal(LOCAL_CONCRETE_RE.test('see ' + DOT_LOCAL_SLASH + 'review/plan.md'), true);
  assert.equal(LOCAL_REF_RE.test('x' + DOT_LOCAL_SLASH + 'y'), true);
});

// ── leftover markers ───────────────────────────────────────────────────────

test('findMarkers: batch and audit tokens in code are violations', () => {
  const violations = findMarkers([
    {path: 'tools/foo.mjs', lines: [`// ${BATCH_MARK} leftover`, `// ${AUDIT_MARK} note`]},
  ]);
  assert.equal(violations.length, 2);
});

test('findMarkers: the issue-style placeholders stay clean', () => {
  // "batch #N" / "audit P.." (no digits) are how issues describe the rule —
  // only digit-carrying tokens match.
  assert.equal(MARKER_RE.test('no batch #N tokens'), false);
  assert.equal(MARKER_RE.test('audit P.. tokens'), false);
  assert.equal(MARKER_RE.test('prefix ' + BATCH_MARK), true);
  assert.equal(MARKER_RE.test('prefix ' + AUDIT_MARK), true);
});

// ── skill size cap ─────────────────────────────────────────────────────────

test('overlongSkills: authored skills over the cap are violations, vendored ones exempt', () => {
  const longBody = Array.from({length: SKILL_LINE_CAP + 1}, (_, i) => `line ${i}`).join('\n');
  const authored = {
    path: '.agents/skills/mine/SKILL.md',
    frontmatter: 'name: mine\n',
    lines: SKILL_LINE_CAP + 1,
  };
  const vendored = {
    path: '.agents/skills/theirs/SKILL.md',
    frontmatter: 'name: theirs\nmetadata:\n  github-repo: https://example.com/x\n',
    lines: SKILL_LINE_CAP + 50,
  };
  void longBody;
  const violations = overlongSkills([authored, vendored]);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /mine/);
});

test('overlongSkills: an authored skill at exactly the cap passes', () => {
  const violations = overlongSkills([
    {path: '.agents/skills/mine/SKILL.md', frontmatter: 'name: mine\n', lines: SKILL_LINE_CAP},
  ]);
  assert.deepEqual(violations, []);
});
