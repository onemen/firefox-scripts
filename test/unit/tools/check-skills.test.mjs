// test/unit/tools/check-skills.test.mjs — unit tests for the skills checker
// (tools/check-skills.mjs). The real `.agents/skills/` tree is validated by
// `pnpm test:skills` / the lint gate itself; these tests pin the frontmatter
// rules with fixture directories.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const scriptUrl = pathToFileURL(path.join(REPO_ROOT, 'tools', 'check-skills.mjs')).href;
const {checkSkillsDir, findVendoredTests, agentsSkillsTable, checkAgentsTableDrift} = await import(
  scriptUrl
);

function makeSkillsDir(skills) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));
  const skillsDir = path.join(root, 'skills');
  for (const [name, files] of Object.entries(skills)) {
    for (const [rel, content] of Object.entries(files)) {
      const p = path.join(skillsDir, name, rel);
      fs.mkdirSync(path.dirname(p), {recursive: true});
      fs.writeFileSync(p, content);
    }
  }
  return skillsDir;
}

function authored(name) {
  return {
    'SKILL.md': `---
name: ${name}
description: Authored test skill.
---

Body.
`,
  };
}

function thirdParty(name) {
  return {
    'SKILL.md': `---
name: ${name}
description: Third-party test skill.
license: MIT
metadata:
    github-path: skills/${name}
    github-ref: refs/tags/v1.0.0
    github-repo: https://github.com/acme/${name}
    github-tree-sha: 0123456789abcdef0123456789abcdef01234567
---

Body.
`,
  };
}

test('accepts the authored and third-party shapes in use', () => {
  const dir = makeSkillsDir({alpha: authored('alpha'), beta: thirdParty('beta')});
  try {
    assert.deepEqual(checkSkillsDir(dir), []);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('missing SKILL.md is flagged, not skipped', () => {
  const dir = makeSkillsDir({alpha: {'README.md': 'no skill here'}});
  try {
    const errors = checkSkillsDir(dir);
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /SKILL\.md is missing/);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('missing frontmatter block is flagged', () => {
  const dir = makeSkillsDir({alpha: {'SKILL.md': '# just prose\n'}});
  try {
    const errors = checkSkillsDir(dir);
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /no frontmatter block/);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('name is required and must match the directory', () => {
  const dir = makeSkillsDir({
    alpha: {'SKILL.md': '---\nname: omega\ndescription: d\n---\n\nBody.\n'},
  });
  try {
    const errors = checkSkillsDir(dir);
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /does not match directory name/);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('empty description is flagged', () => {
  const dir = makeSkillsDir({
    alpha: {'SKILL.md': '---\nname: alpha\ndescription:\n---\n\nBody.\n'},
  });
  try {
    const errors = checkSkillsDir(dir);
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /no non-empty description/);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('folded description block counts as non-empty', () => {
  const dir = makeSkillsDir({
    alpha: {
      'SKILL.md':
        '---\nname: alpha\ndescription:\n  A folded multi-line description\n  that keeps going.\n---\n\nBody.\n',
    },
  });
  try {
    assert.deepEqual(checkSkillsDir(dir), []);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('third-party metadata missing a gh key is flagged', () => {
  const files = thirdParty('alpha');
  files['SKILL.md'] = files['SKILL.md'].replace(/ {4}github-path: .*\n/, '');
  const dir = makeSkillsDir({alpha: files});
  try {
    const errors = checkSkillsDir(dir);
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /metadata\.github-path is missing/);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('unparseable github-repo URL is flagged', () => {
  const files = thirdParty('alpha');
  files['SKILL.md'] = files['SKILL.md'].replace(
    'https://github.com/acme/alpha',
    'gitlab:acme/alpha'
  );
  const dir = makeSkillsDir({alpha: files});
  try {
    const errors = checkSkillsDir(dir);
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /not a GitHub repo URL/);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('near-miss github hostnames are rejected, not just non-GitHub schemes', () => {
  for (const host of [
    'https://notgithub.com/acme/alpha',
    'https://github.com.evil.io/acme/alpha',
  ]) {
    const files = thirdParty('alpha');
    files['SKILL.md'] = files['SKILL.md'].replace('https://github.com/acme/alpha', host);
    const dir = makeSkillsDir({alpha: files});
    try {
      const errors = checkSkillsDir(dir);
      assert.equal(errors.length, 1);
      assert.match(errors[0].message, /not a GitHub repo URL/);
    } finally {
      fs.rmSync(dir, {recursive: true, force: true});
    }
  }
});

test('partial gh metadata without github-repo is the retired hand-copy signature', () => {
  const dir = makeSkillsDir({
    alpha: {
      'SKILL.md':
        '---\nname: alpha\ndescription: d\nmetadata:\n    github-tree-sha: 0123456789abcdef0123456789abcdef01234567\n---\n\nBody.\n',
    },
  });
  try {
    const errors = checkSkillsDir(dir);
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /partial gh metadata/);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('nested SKILL.md means a second discovery root', () => {
  const dir = makeSkillsDir({
    alpha: {
      'SKILL.md': '---\nname: alpha\ndescription: d\n---\n\nBody.\n',
      'agents/nested/SKILL.md': '---\nname: nested\ndescription: d\n---\n',
    },
  });
  try {
    const errors = checkSkillsDir(dir);
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /nested SKILL\.md/);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('internal subdirectories (scripts/, references/) are allowed', () => {
  const dir = makeSkillsDir({
    alpha: {
      'SKILL.md': '---\nname: alpha\ndescription: d\n---\n\nBody.\n',
      'scripts/helper.mjs': 'export const x = 1;\n',
      'references/deep/notes.md': '# notes\n',
    },
  });
  try {
    assert.deepEqual(checkSkillsDir(dir), []);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('stray file in the skills root is flagged', () => {
  const dir = makeSkillsDir({alpha: authored('alpha')});
  fs.writeFileSync(path.join(dir, 'README.md'), 'stray\n');
  try {
    const errors = checkSkillsDir(dir);
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /stray file/);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

// ── AGENTS.md Skills-table drift ─────────────────────────────────────────────

function agentsMdWith(rows) {
  const body = rows
    .map(([name, cls]) => `| \`${name}\` | ${cls} | Load when ${name}. |`)
    .join('\n');
  return `# Repository Guidelines

## Skills

| Skill | Class | Load when |
| ----- | ----- | --------- |
${body}

## Commands

Run tests.
`;
}

test('agentsSkillsTable: rows with class, non-row lines and other sections ignored', () => {
  const md = agentsMdWith([
    ['alpha', 'authored'],
    ['beta', 'third-party'],
  ]);
  assert.deepEqual(agentsSkillsTable(md), [
    {name: 'alpha', skillClass: 'authored'},
    {name: 'beta', skillClass: 'third-party'},
  ]);
  // No Skills section at all → no rows.
  assert.deepEqual(agentsSkillsTable('# Guide\n\nNo table here.\n'), []);
});

test('agentsSkillsTable: CRLF input normalizes', () => {
  const md = agentsMdWith([['alpha', 'authored']]).replaceAll('\n', '\r\n');
  assert.deepEqual(agentsSkillsTable(md), [{name: 'alpha', skillClass: 'authored'}]);
});

test('checkAgentsTableDrift: table in sync passes', () => {
  const dir = makeSkillsDir({
    alpha: authored('alpha'),
    beta: thirdParty('beta'),
  });
  try {
    assert.deepEqual(
      checkAgentsTableDrift(
        dir,
        agentsMdWith([
          ['alpha', 'authored'],
          ['beta', 'third-party'],
        ])
      ),
      []
    );
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('checkAgentsTableDrift: skill on disk without a row is flagged', () => {
  const dir = makeSkillsDir({alpha: authored('alpha')});
  try {
    const errors = checkAgentsTableDrift(dir, agentsMdWith([]));
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /`alpha` exists on disk but has no Skills-table row/);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('checkAgentsTableDrift: stale row without a directory is flagged', () => {
  const dir = makeSkillsDir({alpha: authored('alpha')});
  try {
    const errors = checkAgentsTableDrift(
      dir,
      agentsMdWith([
        ['alpha', 'authored'],
        ['ghost', 'authored'],
      ])
    );
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /`ghost` has no directory/);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('checkAgentsTableDrift: wrong class is flagged', () => {
  const dir = makeSkillsDir({alpha: authored('alpha')});
  try {
    const errors = checkAgentsTableDrift(dir, agentsMdWith([['alpha', 'third-party']]));
    assert.equal(errors.length, 1);
    assert.match(
      errors[0].message,
      /`alpha` is authored .* but the Skills table says "third-party"/
    );
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('missing skills directory is flagged', () => {
  const missing = path.join(
    os.tmpdir(),
    'skills-absent-' + process.pid + '-' + Math.random().toString(36).slice(2)
  );
  try {
    const errors = checkSkillsDir(missing);
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /skills directory is missing/);
  } finally {
    fs.rmSync(missing, {recursive: true, force: true});
  }
});

test('findVendoredTests finds test files recursively per skill', () => {
  const dir = makeSkillsDir({
    alpha: {
      'SKILL.md': '---\nname: alpha\ndescription: d\n---\n',
      'scripts/deep/one.test.mjs': 'import test from "node:test";\ntest("one", () => {});\n',
      'references/notes.md': '# notes\n',
    },
    beta: {'SKILL.md': '---\nname: beta\ndescription: d\n---\n'},
  });
  try {
    const found = findVendoredTests(dir);
    assert.equal(found.length, 1);
    assert.equal(found[0].skill, 'alpha');
    assert.match(found[0].file.replaceAll(/[/\\]/g, '/'), /scripts\/deep\/one\.test\.mjs$/);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
