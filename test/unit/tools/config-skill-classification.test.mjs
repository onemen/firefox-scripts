// Pins the ADR 0022 fail-CLOSED skill classification in
// config/eslint.config.js: when the watchdog cannot load, the classification
// falls back to a local frontmatter scan and vendored skills stay ignored
// (never `[]`).
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const CONFIG_URL = new URL('../../../config/eslint.config.js', import.meta.url).href;
const {classifyThirdPartySkills, scanThirdPartySkillDirs} = await import(CONFIG_URL);

const tempRoots = [];
after(() => {
  for (const root of tempRoots) fs.rmSync(root, {recursive: true, force: true});
});

function makeRepo(skills) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eslint-skill-'));
  tempRoots.push(root);
  for (const [name, content] of Object.entries(skills)) {
    const dir = path.join(root, '.agents', 'skills', name);
    fs.mkdirSync(dir, {recursive: true});
    fs.writeFileSync(path.join(dir, 'SKILL.md'), content);
  }
  return root;
}

const vendored = `---
name: vendored-one
description: Third-party skill.
metadata:
    github-repo: https://github.com/acme/vendored-one
    github-ref: refs/tags/v1.0.0
    github-path: skills/vendored-one
    github-tree-sha: 0123456789abcdef0123456789abcdef01234567
---

Body.
`;

const authored = `---
name: authored-one
description: Authored skill.
---

Body mentioning github-repo: in prose must not classify it as vendored.
`;

test('watchdog import failure falls back to the local scan (fail closed)', async () => {
  const root = makeRepo({'vendored-one': vendored, 'authored-one': authored});
  const rejects = () => Promise.reject(new Error('simulated partial checkout'));
  const ignores = await classifyThirdPartySkills(root, rejects);
  assert.deepEqual(ignores, ['**/.agents/skills/vendored-one']);
});

test('a healthy watchdog loader is the primary classification', async () => {
  const root = makeRepo({'vendored-one': vendored, 'authored-one': authored});
  const healthy = async () => ({
    loadInventory: r => {
      assert.equal(r, root);
      return [{skill: 'vendored-one'}];
    },
  });
  const ignores = await classifyThirdPartySkills(root, healthy);
  assert.deepEqual(ignores, ['**/.agents/skills/vendored-one']);
});

test('the local scan reads the frontmatter block only, not the prose body', () => {
  const root = makeRepo({'authored-one': authored, 'vendored-one': vendored});
  const ignores = scanThirdPartySkillDirs(root);
  assert.deepEqual(ignores, ['**/.agents/skills/vendored-one']);
});

test('the local scan tolerates CRLF and a missing skills tree', () => {
  const root = makeRepo({'vendored-one': vendored.replaceAll('\n', '\r\n')});
  assert.deepEqual(scanThirdPartySkillDirs(root), ['**/.agents/skills/vendored-one']);
  const empty = makeRepo({});
  assert.deepEqual(scanThirdPartySkillDirs(empty), []);
  assert.deepEqual(scanThirdPartySkillDirs(path.join(empty, 'absent')), []);
});
