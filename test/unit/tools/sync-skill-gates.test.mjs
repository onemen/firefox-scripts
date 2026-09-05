// test/unit/tools/sync-skill-gates.test.mjs — Unit tests for the pure helpers
// in tools/sync-skill-gates.mjs (block rendering + live-repo sync), plus the
// gate contract: eslint derives its ignores from the same frontmatter, so the
// .prettierignore managed block is the only static list to keep honest.

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
  BEGIN_MARKER,
  END_MARKER,
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
