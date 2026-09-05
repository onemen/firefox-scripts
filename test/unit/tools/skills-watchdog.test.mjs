// test/unit/tools/skills-watchdog.test.mjs — Unit tests for the pure helpers
// in tools/skills-watchdog.mjs (the GitHub API calls and issue writes hit the
// network — not unit-tested; see check-browser-downloads.test.mjs for the
// same split).

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const scriptUrl = pathToFileURL(path.join(REPO_ROOT, 'tools', 'skills-watchdog.mjs')).href;
const {
  collectDrift,
  folderTreeAt,
  ISSUE_TITLE,
  issueBody,
  loadInventory,
  parseSkillFrontmatter,
  refToCommit,
  shortRef,
  SKILLS_DIR,
  updateCommand,
} = await import(scriptUrl);

/** Write a skill folder with the given SKILL.md frontmatter into a temp root. */
function makeSkillsRoot(skills) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-wd-'));
  for (const [name, text] of Object.entries(skills)) {
    fs.mkdirSync(path.join(root, SKILLS_DIR, name), {recursive: true});
    fs.writeFileSync(path.join(root, SKILLS_DIR, name, 'SKILL.md'), text);
  }
  return root;
}

const GH_MD = [
  '---',
  'name: cavecrew',
  'description: When to delegate.',
  'metadata:',
  '    github-path: skills/cavecrew',
  '    github-ref: refs/tags/bin-v1.1.6',
  '    github-repo: https://github.com/JuliusBrussee/caveman',
  '    github-tree-sha: 58b9a0bdb00d97953bfc840cb4dc3b38faf03759',
  '---',
  '',
  'Body.',
].join('\n');

const AUTHORED_MD = [
  '---',
  'name: ai-review',
  'description: Review a PR.',
  '---',
  '',
  'Body.',
].join('\n');

test('parseSkillFrontmatter: extracts name and gh metadata block', () => {
  const {name, metadata} = parseSkillFrontmatter(GH_MD);
  assert.equal(name, 'cavecrew');
  assert.deepEqual(metadata, {
    'github-path': 'skills/cavecrew',
    'github-ref': 'refs/tags/bin-v1.1.6',
    'github-repo': 'https://github.com/JuliusBrussee/caveman',
    'github-tree-sha': '58b9a0bdb00d97953bfc840cb4dc3b38faf03759',
  });
});

test('parseSkillFrontmatter: tolerates CRLF and missing blocks', () => {
  assert.deepEqual(
    parseSkillFrontmatter(GH_MD.replace(/\n/g, '\r\n')).metadata['github-ref'],
    'refs/tags/bin-v1.1.6'
  );
  assert.deepEqual(parseSkillFrontmatter(AUTHORED_MD), {name: 'ai-review', metadata: {}});
  assert.deepEqual(parseSkillFrontmatter('no frontmatter at all'), {name: null, metadata: {}});
});

test('loadInventory: third-party only, authored skills excluded', () => {
  const root = makeSkillsRoot({
    'cavecrew': GH_MD,
    'ai-review': AUTHORED_MD,
  });
  try {
    // A directory without SKILL.md must also be skipped.
    fs.mkdirSync(path.join(root, SKILLS_DIR, 'no-skill-md-dir'), {recursive: true});
    const inv = loadInventory(root);
    assert.deepEqual(
      inv.map(i => i.skill),
      ['cavecrew']
    );
    assert.equal(inv[0].repo, 'JuliusBrussee/caveman');
    assert.equal(inv[0].ref, 'refs/tags/bin-v1.1.6');
    assert.equal(inv[0].skillPath, 'skills/cavecrew');
    assert.equal(inv[0].treeSha, '58b9a0bdb00d97953bfc840cb4dc3b38faf03759');
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('shortRef: strips the refs/ prefix for the ref API', () => {
  assert.equal(shortRef('refs/tags/bin-v1.1.6'), 'tags/bin-v1.1.6');
  assert.equal(shortRef('refs/heads/main'), 'heads/main');
});

/**
 * Fake API implementing the resolution chain the tool uses: `/git/ref/<ref>` →
 * (peel tag) → `/git/trees/<sha>` walks. Trees are keyed by sha; the fake tree
 * store maps sha → entries.
 */
function fakeApi({tagObject = null, refTarget, trees = {}, aheadBy = 0, refMissing = false}) {
  const calls = [];
  const fetchJson = async pathname => {
    calls.push(pathname);
    if (pathname.startsWith('/repos/o/r/compare/')) {
      return {ahead_by: aheadBy, behind_by: 0};
    }
    if (pathname.startsWith('/repos/o/r/git/ref/')) {
      if (refMissing) throw statusErr(404, 'Not Found');
      return {object: {type: tagObject ? 'tag' : 'commit', sha: refTarget}};
    }
    if (pathname.startsWith('/repos/o/r/git/tags/')) {
      return {object: {sha: tagObject}};
    }
    if (pathname === '/repos/o/r/git/trees/HEAD') {
      return {sha: 'head-root', tree: trees['head-root'] || []};
    }
    if (pathname.startsWith('/repos/o/r/git/trees/')) {
      const sha = pathname.split('/').pop();
      if (!(sha in trees)) throw statusErr(422, 'Invalid object requested');
      return {sha, tree: trees[sha]};
    }
    throw new Error(`unexpected path: ${pathname}`);
  };
  fetchJson.calls = calls;
  return fetchJson;
}

function statusErr(status, message) {
  return Object.assign(new Error(message), {status});
}

const ITEM = {
  skill: 'cavecrew',
  dir: `${SKILLS_DIR}/cavecrew`,
  repo: 'o/r',
  ref: 'refs/tags/bin-v1.1.6',
  skillPath: 'skills/cavecrew',
  treeSha: 'sha-local-folder',
};

/** Standard fake repo: root → skills → cavecrew, on both ref and HEAD. */
function standardFake({
  refFolderSha,
  headFolderSha,
  aheadBy = 0,
  refMissing = false,
  peel = false,
}) {
  return fakeApi({
    refTarget: 'commit-at-ref',
    tagObject: peel ? 'commit-at-ref' : null,
    aheadBy,
    refMissing,
    trees: {
      'commit-at-ref': [{path: 'skills', type: 'tree', sha: 'ref-skills'}],
      'ref-skills': [{path: 'cavecrew', type: 'tree', sha: refFolderSha}],
      'head-root': [
        {path: 'skills', type: 'tree', sha: 'head-skills'},
        {path: 'README.md', type: 'blob', sha: 'x'},
      ],
      'head-skills': [{path: 'cavecrew', type: 'tree', sha: headFolderSha}],
    },
  });
}

test('refToCommit: resolves through the ref API and peels annotated tags', async () => {
  assert.equal(await refToCommit(fakeApi({refTarget: 'c1'}), 'o/r', 'refs/tags/v1'), 'c1');
  assert.equal(
    await refToCommit(fakeApi({refTarget: 'tag1', tagObject: 'c2'}), 'o/r', 'refs/tags/v1'),
    'c2'
  );
});

test('folderTreeAt: walks every segment of the skill folder path', async () => {
  const api = standardFake({refFolderSha: 'folder-sha', headFolderSha: 'folder-sha'});
  assert.equal(await folderTreeAt(api, 'o/r', 'commit-at-ref', 'skills/cavecrew'), 'folder-sha');
  // missing folder → null
  assert.equal(await folderTreeAt(api, 'o/r', 'commit-at-ref', 'skills/nope'), null);
});

test('collectDrift: rolling tag moved → content-drift', async () => {
  const api = standardFake({
    refFolderSha: 'sha-upstream',
    headFolderSha: 'sha-upstream',
    aheadBy: 3,
  });
  const findings = await collectDrift([ITEM], api);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'content-drift');
  assert.equal(findings[0].upstreamTreeSha, 'sha-upstream');
  assert.equal(findings[0].aheadBy, 3);
});

test('collectDrift: static tag unchanged but skill changed on HEAD → ref-behind', async () => {
  const api = standardFake({
    refFolderSha: 'sha-local-folder',
    headFolderSha: 'sha-head-folder',
    aheadBy: 9,
  });
  const findings = await collectDrift([ITEM], api);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'ref-behind');
  assert.equal(findings[0].aheadBy, 9);
  assert.equal(findings[0].upstreamTreeSha, 'sha-head-folder');
});

test('collectDrift: static tag unchanged, folder same on HEAD → no finding', async () => {
  const api = standardFake({
    refFolderSha: 'sha-local-folder',
    headFolderSha: 'sha-local-folder',
    aheadBy: 5,
  });
  assert.deepEqual(await collectDrift([ITEM], api), []);
});

test('collectDrift: everything current (annotated tag) → no finding', async () => {
  const api = standardFake({
    refFolderSha: 'sha-local-folder',
    headFolderSha: 'sha-local-folder',
    peel: true,
  });
  assert.deepEqual(await collectDrift([ITEM], api), []);
});

test('collectDrift: missing ref → ref-missing; other error → check-failed', async () => {
  const missing = await collectDrift(
    [ITEM],
    standardFake({refMissing: true, refFolderSha: 'x', headFolderSha: 'x'})
  );
  assert.equal(missing[0].kind, 'ref-missing');

  const boom = async () => {
    throw new Error('socket hung up');
  };
  const failed = await collectDrift([ITEM], boom);
  assert.equal(failed[0].kind, 'check-failed');
  assert.match(failed[0].reason, /socket hung up/);
});

test('updateCommand: gh update for drift, forced reinstall for a stale static tag', () => {
  assert.equal(
    updateCommand({kind: 'content-drift', skill: 'cavecrew', repo: 'o/r'}),
    'gh skill update cavecrew --all'
  );
  assert.equal(
    updateCommand({kind: 'ref-behind', skill: 'cavecrew', repo: 'o/r'}),
    'gh skill install o/r cavecrew --dir .agents/skills --force'
  );
});

test('issueBody: carries the update command per skill and the injection warning', async () => {
  const api = standardFake({
    refFolderSha: 'sha-upstream',
    headFolderSha: 'sha-upstream',
    aheadBy: 2,
  });
  const body = issueBody(await collectDrift([ITEM], api), 'run-123');
  assert.match(body, /### cavecrew — content drift/);
  assert.match(body, /gh skill update cavecrew --all/);
  assert.match(body, /prompt-injection surface/);
  assert.match(body, /Watchdog run: run-123/);
});

test('issueBody: empty findings render without sections', () => {
  assert.doesNotThrow(() => issueBody([]));
});

test('ISSUE_TITLE: stable dedup key', () => {
  assert.equal(ISSUE_TITLE, '[skills-watchdog] third-party skill drift');
});
