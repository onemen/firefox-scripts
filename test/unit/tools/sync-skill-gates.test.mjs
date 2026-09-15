// test/unit/tools/sync-skill-gates.test.mjs — Unit tests for the pure helpers
// in tools/sync-skill-gates.mjs (block rendering + live-repo sync), plus the
// gate contract: eslint derives its ignores from the same frontmatter, so the
// .prettierignore and .markdownlint-cli2.jsonc managed blocks are the only
// static lists to keep honest.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const syncUrl = pathToFileURL(path.join(REPO_ROOT, 'tools', 'sync-skill-gates.mjs')).href;
const {
  classifySkills,
  renderPrettierignore,
  renderMarkdownlintConfig,
  findStraySkillLines,
  BEGIN_MARKER,
  END_MARKER,
  MDLINT_BEGIN_MARKER,
  MDLINT_END_MARKER,
  REPO_ROOT: TOOL_ROOT,
} = await import(syncUrl);

test('classifySkills: live repo — five third-party, four authored', () => {
  const {thirdParty, authored} = classifySkills(TOOL_ROOT);
  assert.deepEqual(thirdParty, [
    'cavecrew',
    'code-review',
    'debugging-firefox',
    'grill-me',
    'lavish',
  ]);
  assert.deepEqual(authored, ['ai-review', 'change-workflow', 'generated-files', 'publishing']);
});

test('renderPrettierignore: appends a managed block to a fresh file', () => {
  const out = renderPrettierignore('', ['vendor-b'], ['mine-a']);
  assert.match(out, /^# BEGIN managed:/m);
  assert.match(out, /\*\*\/\.agents\/skills\/\*\n!.*mine-a/);
  assert.match(out, /# third-party \(gh metadata\): vendor-b/);
  assert.match(out, /# END managed/);
  assert.ok(out.endsWith('\n'));
});

test('renderPrettierignore: replaces only the managed block, preserves the rest', () => {
  const before = [
    '# pre-existing',
    '*.css',
    BEGIN_MARKER,
    '**/.agents/skills/*',
    '!**/.agents/skills/old-authored',
    END_MARKER,
    'trailing-entry',
  ].join('\n');
  const out = renderPrettierignore(before, ['vendor-b'], ['mine-a']);
  assert.match(out, /# pre-existing/);
  assert.match(out, /trailing-entry/);
  assert.doesNotMatch(out, /old-authored/);
  assert.match(out, /!.*mine-a/);
  assert.match(out, /vendor-b/);
  // exactly one block
  assert.equal(out.split(BEGIN_MARKER).length - 1, 1);
  assert.equal(out.split(END_MARKER).length - 1, 1);
});

test('renderPrettierignore: stable when already in sync (idempotent)', () => {
  const once = renderPrettierignore('# base\n', ['vendor-b'], ['mine-a']);
  assert.equal(renderPrettierignore(once, ['vendor-b'], ['mine-a']), once);
});

test('renderPrettierignore: normalizes CRLF in the existing file', () => {
  const crlf = '# base\r\nold-block-start\r\nEND\r\n';
  const out = renderPrettierignore(crlf, [], ['mine-a']);
  assert.doesNotMatch(out, /\r/);
  assert.match(out, /# base/);
});

test('findStraySkillLines: catches the 4dd6640 duplicate-list regression', () => {
  // The exact state committed in 46e6b3c: the old static list (from 4dd6640)
  // survived above the generated block. check must fail; fix must strip it.
  const stale = [
    '# third-party agent skills — kept byte-identical to upstream (ADR 0022: gh-installed,',
    '# pristine; classification via metadata.github-repo in SKILL.md). Patterns need the',
    '# double-star prefix: this file lives in config/, so slashful patterns would anchor there.',
    '**/.agents/skills/cavecrew',
    '**/.agents/skills/code-review',
    '**/.agents/skills/debugging-firefox',
    '**/.agents/skills/grill-me',
    '**/.agents/skills/lavish',
  ].join('\n');
  const buggy = `${stale}\n${BEGIN_MARKER}\n**/.agents/skills/*\n!**/.agents/skills/ai-review\n# third-party (gh metadata): cavecrew\n${END_MARKER}\n`;
  const stray = findStraySkillLines(buggy);
  assert.equal(stray.length, 5);
  assert.deepEqual(
    stray.map(s => s.line),
    [
      '**/.agents/skills/cavecrew',
      '**/.agents/skills/code-review',
      '**/.agents/skills/debugging-firefox',
      '**/.agents/skills/grill-me',
      '**/.agents/skills/lavish',
    ]
  );
  assert.deepEqual(
    stray.map(s => s.number),
    [4, 5, 6, 7, 8]
  );
  // fix fully heals: stale list gone, block intact, provenance comment preserved.
  const fixed = renderPrettierignore(buggy, ['cavecrew'], ['ai-review']);
  assert.doesNotMatch(fixed, /\*\*\/\.agents\/skills\/cavecrew/);
  assert.match(fixed, /# third-party \(gh metadata\): cavecrew/);
  assert.match(fixed, /# BEGIN managed:/);
  assert.equal(findStraySkillLines(fixed).length, 0);
});

test('findStraySkillLines: prose and comments outside the block are not violations', () => {
  const doc = [
    '# see .agents/skills/ for skills — patterns need the double-star prefix',
    '',
    '  # indented comment mentioning **/.agents/skills/vendor',
    BEGIN_MARKER,
    '**/.agents/skills/*',
    END_MARKER,
    '',
  ].join('\n');
  assert.deepEqual(findStraySkillLines(doc), []);
});

test('findStraySkillLines: flags stray gating lines below the block too', () => {
  const doc = [BEGIN_MARKER, '**/.agents/skills/*', END_MARKER, '**/.agents/skills/vendor'].join(
    '\n'
  );
  assert.deepEqual(findStraySkillLines(doc), [{number: 4, line: '**/.agents/skills/vendor'}]);
});

test('findStraySkillLines: tolerates unbalanced markers conservatively', () => {
  // BEGIN without END — block never valid, every gating line counts.
  const doc = `${BEGIN_MARKER}\n**/.agents/skills/*\n**/.agents/skills/vendor\n`;
  assert.deepEqual(findStraySkillLines(doc), [
    {number: 2, line: '**/.agents/skills/*'},
    {number: 3, line: '**/.agents/skills/vendor'},
  ]);
});

test('renderPrettierignore: orphan BEGIN converges in one --fix run', () => {
  const orphan = [BEGIN_MARKER, '**/.agents/skills/*', '!**/.agents/skills/old-authored', ''].join(
    '\n'
  );
  const out = renderPrettierignore(orphan, ['vendor-b'], ['mine-a']);
  // exactly one balanced block; the orphaned block's gating lines are gone
  assert.equal(out.split(BEGIN_MARKER).length - 1, 1);
  assert.equal(out.split(END_MARKER).length - 1, 1);
  assert.doesNotMatch(out, /old-authored/);
  assert.match(out, /!.*mine-a/);
  assert.equal(findStraySkillLines(out).length, 0);
  // and the healed file is stable
  assert.equal(renderPrettierignore(out, ['vendor-b'], ['mine-a']), out);
});

test('renderPrettierignore: duplicated marker pairs collapse to one block', () => {
  const dup = [BEGIN_MARKER, END_MARKER, 'middle-entry', BEGIN_MARKER, END_MARKER].join('\n');
  const out = renderPrettierignore(dup, [], ['mine-a']);
  assert.equal(out.split(BEGIN_MARKER).length - 1, 1);
  assert.equal(out.split(END_MARKER).length - 1, 1);
  assert.match(out, /middle-entry/);
  assert.equal(renderPrettierignore(out, [], ['mine-a']), out);
});

test('live repo: config/.prettierignore managed block matches the skill set', () => {
  const {thirdParty, authored} = classifySkills(TOOL_ROOT);
  const current = fs.readFileSync(path.join(TOOL_ROOT, 'config', '.prettierignore'), 'utf8');
  assert.equal(
    renderPrettierignore(current, thirdParty, authored),
    current.replace(/\r\n/g, '\n'),
    'out of sync — run: pnpm format:fix'
  );
});

test('live repo: eslint derives the same third-party set from frontmatter', async () => {
  const configUrl = pathToFileURL(path.join(REPO_ROOT, 'config', 'eslint.config.js')).href;
  const configModule = await import(configUrl);
  const config = configModule.default;
  const globalIgnore = config.find(c => c.name === 'global-ignore').ignores;

  const {thirdParty, authored} = classifySkills(TOOL_ROOT);
  for (const name of thirdParty) {
    assert.ok(
      globalIgnore.includes(`**/.agents/skills/${name}`),
      `eslint ignores missing third-party skill: ${name}`
    );
  }
  for (const name of authored) {
    assert.ok(
      !globalIgnore.includes(`**/.agents/skills/${name}`),
      `eslint must not ignore authored skill: ${name}`
    );
  }
});

test('live repo: no skill-gating lines outside the managed block', () => {
  const current = fs.readFileSync(path.join(TOOL_ROOT, 'config', '.prettierignore'), 'utf8');
  assert.deepEqual(
    findStraySkillLines(current),
    [],
    'stale hand-written skill list outside the managed block — run: pnpm format:fix'
  );
});

test('live repo: every skill dir is classified one way or the other', () => {
  const skillsRoot = path.join(TOOL_ROOT, '.agents', 'skills');
  const dirs = fs
    .readdirSync(skillsRoot, {withFileTypes: true})
    .filter(e => e.isDirectory())
    .map(e => e.name);
  const {thirdParty, authored} = classifySkills(TOOL_ROOT);
  for (const dir of dirs) {
    assert.ok(thirdParty.includes(dir) || authored.includes(dir), `unclassified skill dir: ${dir}`);
  }
});

test('markdownlint block: one entry per third-party skill, none per authored', () => {
  const block = renderMarkdownlintConfig('{\n  "ignores": [\n  ]\n}', [
    'vendor-a',
    'vendor-b',
  ]).split('\n');
  assert.deepEqual(block, [
    '{',
    '  "ignores": [',
    `    ${MDLINT_BEGIN_MARKER}`,
    '    "**/.agents/skills/vendor-a/**",',
    '    "**/.agents/skills/vendor-b/**",',
    `    ${MDLINT_END_MARKER}`,
    '  ]',
    '}',
  ]);
});

test('markdownlint: authored skills stay linted (absent from the block)', () => {
  const out = renderMarkdownlintConfig('{\n  "ignores": [\n  ]\n}', ['vendor-a']);
  assert.ok(!out.includes('authored-one'));
  assert.ok(out.includes('vendor-a'));
});

test('markdownlint: replaces a stale block and strips stray skill entries', () => {
  const stale = [
    '{',
    '  "globs": ["**/*.md"],',
    '  "ignores": [',
    `    ${MDLINT_BEGIN_MARKER}`,
    '    "**/.agents/skills/old-vendor/**",',
    `    ${MDLINT_END_MARKER}`,
    '    "**/.agents/skills/hand-written/**", // stray — the 4dd6640 class',
    '    "**/node_modules/**",',
    '  ],',
    '}',
  ].join('\n');
  const out = renderMarkdownlintConfig(stale, ['new-vendor']);
  assert.ok(out.includes('new-vendor'));
  assert.ok(!out.includes('old-vendor'));
  assert.ok(!out.includes('hand-written'), 'stray entry must be stripped');
  assert.ok(out.includes('**/node_modules/**'), 'unrelated entries preserved');
  assert.equal(out.split(MDLINT_BEGIN_MARKER).length - 1, 1, 'exactly one block');
  assert.equal(out.split(MDLINT_END_MARKER).length - 1, 1);
  assert.equal(renderMarkdownlintConfig(out, ['new-vendor']), out, 'idempotent');
});

test('markdownlint: comments and ordering survive byte-for-byte', () => {
  const withComments = [
    '// header comment',
    '{',
    '  "ignores": [',
    '    // hand-written reason for node_modules',
    '    "**/node_modules/**",',
    '  ],',
    '}',
  ].join('\n');
  const out = renderMarkdownlintConfig(withComments, ['vendor-a']);
  assert.ok(out.startsWith('// header comment'));
  assert.ok(out.includes('// hand-written reason for node_modules'));
  const lines = out.split('\n');
  assert.equal(
    lines.findIndex(l => l.includes('vendor-a')) < lines.findIndex(l => l.includes('node_modules')),
    true
  );
});

test('markdownlint: missing ignores anchor fails loudly', () => {
  assert.throws(() => renderMarkdownlintConfig('{"globs": []}', ['vendor-a']), /anchor/);
});

test('markdownlint: prose // comments mentioning .agents/skills are preserved', () => {
  const withProse = [
    '{',
    '  "ignores": [',
    '    // why we ignore .agents/skills at all: upstream text (ADR 0022)',
    '    "**/node_modules/**",',
    '  ],',
    '}',
  ].join('\n');
  // --fix idempotence: the comment survives a render, and the stray scan
  // does not flag it (a false positive would break --check forever).
  const out = renderMarkdownlintConfig(withProse, ['vendor-a']);
  assert.ok(out.includes('// why we ignore .agents/skills at all: upstream text (ADR 0022)'));
  assert.deepEqual(findStraySkillLines(withProse, MDLINT_BEGIN_MARKER, MDLINT_END_MARKER), []);
  assert.equal(renderMarkdownlintConfig(out, ['vendor-a']), out, 'idempotent with the comment');
});

test('findStraySkillLines: markers are configurable (markdownlint uses //)', () => {
  const md = [
    '"ignores": [',
    `  ${MDLINT_BEGIN_MARKER}`,
    '  "**/.agents/skills/vendor-a/**",',
    `  ${MDLINT_END_MARKER}`,
    '  "**/.agents/skills/stray/**",',
  ].join('\n');
  assert.deepEqual(findStraySkillLines(md, MDLINT_BEGIN_MARKER, MDLINT_END_MARKER), [
    {number: 5, line: '  "**/.agents/skills/stray/**",'},
  ]);
});

test('live repo: markdownlint ignores block matches the skill set', () => {
  const {thirdParty} = classifySkills(TOOL_ROOT);
  const current = fs.readFileSync(
    path.join(TOOL_ROOT, 'config', '.markdownlint-cli2.jsonc'),
    'utf8'
  );
  assert.equal(
    renderMarkdownlintConfig(current, thirdParty),
    current.replace(/\r\n/g, '\n'),
    'out of sync — run: pnpm format:fix'
  );
});
