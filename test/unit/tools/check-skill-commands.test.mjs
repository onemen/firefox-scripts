// Pins the command and link validator (tools/check-skill-commands.mjs) in both
// of its scopes: the authored SKILL.md files and the command-bearing docs. The
// proof fixtures are a bare `pnpm publish` (no such script in this repo), a
// stale `lint:*` stage in a doc, and a link whose target does not exist.
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  PNPM_BUILTINS,
  checkMarkdownFile,
  checkAllSkills,
  checkDocs,
  collectRepoDeps,
  collectDocFiles,
  extractCodeSegments,
} from '../../../tools/check-skill-commands.mjs';

const tempRoots = [];
after(() => {
  for (const root of tempRoots) fs.rmSync(root, {recursive: true, force: true});
});

function makeRepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-cmds-'));
  tempRoots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), {recursive: true});
    fs.writeFileSync(full, content);
  }
  return root;
}

const ROOT_SCRIPTS = new Set([
  'snapshot:dev',
  'snapshot:prod',
  'lint',
  'review:local',
  'publish:all',
]);

const DEPS = {
  scripts: ROOT_SCRIPTS,
  scriptsByDir: new Map([
    ['', ROOT_SCRIPTS],
    ['docs-site', new Set(['dev', 'build', 'downloads'])],
  ]),
  makeTargets: new Map([
    ['', new Set(['help'])],
    ['installer', new Set(['dist_win', 'dist_linux', 'analyze'])],
  ]),
};

function check(root, text, fileRel = '.agents/skills/alpha') {
  return checkMarkdownFile(text, {
    fileDir: path.join(root, fileRel),
    repoRoot: root,
    ...DEPS,
  });
}

// ── pnpm tokens ─────────────────────────────────────────────────────────────

test('`pnpm publish -- …` is flagged (no bare publish script)', () => {
  const root = makeRepo({});
  const errors = check(root, '```bash\npnpm publish --include=all\n```\n');
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.match(errors[0].message, /pnpm publish.*does not resolve/);
});

test('a known script, `pnpm run <script>` and a builtin all pass', () => {
  const root = makeRepo({});
  const ok = [
    'pnpm snapshot:dev',
    'pnpm run lint',
    'pnpm install --frozen-lockfile',
    'pnpm review:local -- --dry-run',
  ].join('\n');
  assert.deepEqual(check(root, ok), []);
});

test('pnpm builtins are allow-listed but publish is deliberately not among them', () => {
  assert.ok(PNPM_BUILTINS.has('install'));
  assert.ok(!PNPM_BUILTINS.has('publish'));
});

test('prose is not scanned — only fenced blocks and inline backtick spans', () => {
  const root = makeRepo({});
  const text = [
    'Run pnpm publish whenever you like — this prose line is not a command.',
    'The real one is `pnpm bogus-script`.',
    '',
    '```bash',
    'pnpm another-bogus',
    '```',
  ].join('\n');
  const errors = check(root, text);
  assert.equal(errors.length, 2, JSON.stringify(errors));
  assert.deepEqual(
    errors.map(e => e.line),
    [2, 5]
  );
});

// ── node tokens ─────────────────────────────────────────────────────────────

test('node resolves existing files from the repo root and flags missing ones', () => {
  const root = makeRepo({'tools/publish/release.mjs': 'export {};\n'});
  const text =
    '```bash\nnode tools/publish/release.mjs --mode=dev\nnode tools/does-not-exist.mjs\n```\n';
  const errors = check(root, text);
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.match(errors[0].message, /tools\/does-not-exist\.mjs/);
});

test('node flags, -e scripts and globs are skipped', () => {
  const root = makeRepo({});
  const text = [
    '```bash',
    'node --env-file-if-exists=.env tools/whatever.mjs',
    'node --input-type=module -e "console.log(1)"',
    'node --test "test/unit/**/*.test.mjs"',
    '```',
  ].join('\n');
  const errors = check(root, text);
  // The first resolves only if the file exists — it does not, so exactly one
  // error (flag/-e produce none; the glob is skipped).
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.match(errors[0].message, /tools\/whatever\.mjs/);
});

// ── make targets ────────────────────────────────────────────────────────────

test('make targets resolve against the named or the installer Makefile', () => {
  const root = makeRepo({});
  const text = '```bash\nmake dist_win\nmake -C installer analyze\nmake frobnicate\n```\n';
  const errors = check(root, text);
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.match(errors[0].message, /make frobnicate.*no such target/);
});

test('alternation targets are checked piecewise', () => {
  const root = makeRepo({});
  const errors = check(root, '```bash\nmake dist_win|dist_linux\nmake dist_win|nope\n```\n');
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.match(errors[0].message, /nope/);
});

// ── links ───────────────────────────────────────────────────────────────────

test('a link to a missing target is flagged (docs/agents/issue-tracker.md)', () => {
  const root = makeRepo({});
  const errors = check(root, 'See [the tracker](docs/agents/issue-tracker.md) for details.\n');
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.match(errors[0].message, /link target does not exist: docs\/agents\/issue-tracker\.md/);
});

test('skill-relative and root-relative links that exist pass; URLs and anchors are skipped', () => {
  const root = makeRepo({
    'docs/decisions/index.md': '# decisions\n',
    '.agents/skills/alpha/references/notes.md': '# notes\n',
  });
  const text = [
    'See [decisions](../../../docs/decisions/index.md) and [notes](references/notes.md),',
    'plus [root form](docs/decisions/index.md), [web](https://example.com/x),',
    '[mail](mailto:a@b.c) and [section](#top).',
    '',
    '```md',
    '[not a real link](nope/missing.md)',
    '```',
  ].join('\n');
  assert.deepEqual(check(root, text), []);
});

test('link examples inside code fences are not treated as links', () => {
  const root = makeRepo({});
  const text = '```md\n[example](does/not/exist.md)\n```\n';
  assert.deepEqual(check(root, text), []);
});

// ── extractors + integration ────────────────────────────────────────────────

test('extractCodeSegments finds fences with their start line and inline spans', () => {
  const text = ['prose `one` here', '', '```bash', 'pnpm two', '```', 'end `three`'].join('\n');
  const segments = extractCodeSegments(text);
  assert.deepEqual(
    segments.map(s => [s.line, s.code]),
    [
      [1, 'one'],
      [4, 'pnpm two'],
      [6, 'three'],
    ]
  );
});

test('checkAllSkills skips third-party skills (ADR 0022) and checks authored ones', () => {
  const root = makeRepo({
    'package.json': JSON.stringify({scripts: {lint: 'x'}}),
    'installer/Makefile': 'dist_win:\n\techo\n',
    '.agents/skills/vendored/SKILL.md':
      '---\nname: vendored\ndescription: d\nmetadata:\n' +
      '    github-repo: https://github.com/acme/v\n---\n\n```bash\npnpm not-a-script\n```\n',
    '.agents/skills/authored/SKILL.md':
      '---\nname: authored\ndescription: d\n---\n\n```bash\npnpm also-not-a-script\n```\n',
  });
  const errors = checkAllSkills(root);
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.match(errors[0].file, /\.agents\/skills\/authored\/SKILL\.md/);
  assert.match(errors[0].message, /also-not-a-script/);
});

test('collectRepoDeps reads package.json scripts and Makefile targets incl. .PHONY', () => {
  const root = makeRepo({
    'package.json': JSON.stringify({scripts: {lint: 'x'}}),
    'installer/Makefile': '.PHONY: dist_win analyze\n\ndist_win:\n\techo\n',
  });
  const {scripts, makeTargets} = collectRepoDeps(root);
  assert.ok(scripts.has('lint'));
  assert.deepEqual([...makeTargets.get('installer')].sort(), ['analyze', 'dist_win']);
  assert.ok(!makeTargets.has(''), 'no root Makefile → no root entry');
});

// ── pnpm families, nested projects, builtins ────────────────────────────────

test('a family wildcard resolves when its prefix matches a script', () => {
  const root = makeRepo({});
  assert.deepEqual(
    check(root, '```bash\npnpm snapshot:*\npnpm publish:all|snapshot:dev\n```\n'),
    []
  );
  const errors = check(root, '```bash\npnpm nope:*\n```\n');
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.match(errors[0].message, /nope:\*/);
});

test("pnpm --dir resolves against that directory's own scripts", () => {
  const root = makeRepo({});
  assert.deepEqual(
    check(root, '```bash\npnpm --dir docs-site build\npnpm --dir=docs-site dev\n```\n'),
    []
  );
  const errors = check(root, '```bash\npnpm --dir docs-site lint\n```\n');
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.match(errors[0].message, /--dir docs-site lint/);
});

test('the builtins the docs legitimately use are whitelisted', () => {
  const root = makeRepo({});
  const text = '```bash\npnpm audit --audit-level=high\npnpm store path\npnpm version patch\n```\n';
  assert.deepEqual(check(root, text), []);
  assert.ok(PNPM_BUILTINS.has('audit') && PNPM_BUILTINS.has('store'));
});

test('an ADR template placeholder link is skipped, a real missing link is not', () => {
  const root = makeRepo({});
  assert.deepEqual(check(root, 'See [next](./NNNN-slug.md).\n'), []);
  const errors = check(root, 'See [gone](./0009-gone.md).\n');
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.match(errors[0].message, /0009-gone\.md/);
});

// ── docs scope ──────────────────────────────────────────────────────────────

test('collectDocFiles covers the root pages, docs/ and the nested project', () => {
  const root = makeRepo({
    'README.md': '# r\n',
    'CONTRIBUTING.md': '# c\n',
    'AGENTS.md': '# a\n',
    'docs/DEVELOPING.md': '# d\n',
    'docs/decisions/0001-x.md': '# x\n',
    'docs-site/README.md': '# site\n',
    'docs-site/node_modules/pkg/readme.md': '# dependency\n',
    'docs-site/dist/page.md': '# build output\n',
    'docs-site/src/content/docs/page.mdx': "# mdx is the docs build's\n",
  });
  assert.deepEqual(collectDocFiles(root).sort(), [
    'AGENTS.md',
    'CONTRIBUTING.md',
    'README.md',
    'docs-site/README.md',
    'docs/DEVELOPING.md',
    'docs/decisions/0001-x.md',
  ]);
});

test('checkDocs flags a stale command in a doc and names the file', () => {
  const root = makeRepo({
    'package.json': JSON.stringify({scripts: {lint: 'x'}}),
    'installer/Makefile': 'dist_win:\n\techo\n',
    'docs/GUIDE.md': 'Run `pnpm lint`, never `pnpm lint:gone`.\n',
    'docs-site/package.json': JSON.stringify({scripts: {build: 'astro build'}}),
    'docs-site/README.md': 'Run `pnpm build` here, `pnpm lint` from the root.\n',
  });
  const errors = checkDocs(root);
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.equal(errors[0].file, 'docs/GUIDE.md');
  assert.match(errors[0].message, /lint:gone/);
});
