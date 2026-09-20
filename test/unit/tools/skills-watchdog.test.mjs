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
  ageInDays,
  collectDrift,
  collectNewerTags,
  compareSemver,
  folderTreeAt,
  ISSUE_TITLE,
  issueBody,
  loadInventory,
  NEWER_TAG_COOLDOWN_DAYS,
  newestTagInSeries,
  parseSkillFrontmatter,
  parseTagSeries,
  refToCommit,
  shortRef,
  SKILLS_DIR,
  tagCommitDate,
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

// ── newer-tag scan ────────────────────────────────────────────────────────

test('parseTagSeries: namespaced prefixes stay in their own lane', () => {
  assert.deepEqual(parseTagSeries('bin-v1.1.6'), {
    prefix: 'bin-v',
    version: '1.1.6',
    tagName: 'bin-v1.1.6',
  });
  assert.deepEqual(parseTagSeries('lavish-axi-v0.1.64'), {
    prefix: 'lavish-axi-v',
    version: '0.1.64',
    tagName: 'lavish-axi-v0.1.64',
  });
  assert.deepEqual(parseTagSeries('v1.2.3'), {prefix: 'v', version: '1.2.3', tagName: 'v1.2.3'});
  assert.equal(parseTagSeries('release-1.2'), null);
});

test('compareSemver: dotted numeric ordering, missing components are 0', () => {
  assert.equal(compareSemver('0.1.74', '0.1.64'), 1);
  assert.equal(compareSemver('1.2.3', '1.2.3'), 0);
  assert.equal(compareSemver('1.2', '1.1.9'), 1);
  assert.equal(compareSemver('2.7.0', '1.1.6'), 1);
});

test('newestTagInSeries: never crosses namespaces', () => {
  const tags = ['v2.7.0', 'v2.6.0', 'bin-v1.1.7', 'bin-v1.1.6', 'bin-v1.1.5'];
  assert.equal(newestTagInSeries(tags, 'bin-v'), 'bin-v1.1.7');
  assert.equal(newestTagInSeries(tags, 'v'), 'v2.7.0');
  assert.equal(newestTagInSeries(tags, 'lavish-axi-v'), null);
});

/**
 * Fake API for the newer-tag scan: paginated tags list + tag→commit→date chain.
 * `annotated` maps a tag name to a tagger date (annotated tag object); tags
 * without an entry resolve as lightweight.
 */
function tagApi({
  tags = [],
  commitDates = {},
  annotated = {},
  failTags = false,
  failCommit = false,
}) {
  const fetchJson = async pathname => {
    if (pathname.startsWith('/repos/o/r/tags?')) {
      if (failTags) throw statusErr(500, 'tags boom');
      const page = Number(new URLSearchParams(pathname.split('?')[1]).get('page') || 1);
      return tags.slice((page - 1) * 100, page * 100).map(name => ({name}));
    }
    if (pathname.startsWith('/repos/o/r/git/ref/tags/')) {
      const name = decodeURIComponent(pathname.split('/').pop());
      const isAnnotated = name in annotated;
      return {
        object: {
          type: isAnnotated ? 'tag' : 'commit',
          sha: isAnnotated ? `t-${name}` : `c-${name}`,
        },
      };
    }
    if (pathname.startsWith('/repos/o/r/git/tags/')) {
      const name = pathname.split('/').pop().replace(/^t-/, '');
      return {object: {sha: `c-${name}`}, tagger: {date: annotated[name]}};
    }
    if (pathname.startsWith('/repos/o/r/commits/')) {
      const sha = pathname.split('/').pop();
      if (failCommit) throw statusErr(500, 'commit boom');
      return {commit: {committer: {date: commitDates[sha]}}};
    }
    throw new Error(`unexpected path: ${pathname}`);
  };
  return fetchJson;
}

const NOW = new Date('2026-09-19T00:00:00Z');

test('collectNewerTags: tag past the cooldown → actionable newer-tag finding', async () => {
  const api = tagApi({
    tags: ['bin-v1.1.7', 'bin-v1.1.6', 'v2.7.0'],
    commitDates: {'c-bin-v1.1.7': '2026-09-07T00:00:00Z'}, // 12 days before NOW
  });
  const {findings, infos} = await collectNewerTags([ITEM], api, {now: NOW});
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'newer-tag');
  assert.equal(findings[0].fromTag, 'bin-v1.1.6');
  assert.equal(findings[0].toTag, 'bin-v1.1.7');
  assert.equal(findings[0].ageDays, 12);
  assert.deepEqual(infos, []);
});

test('collectNewerTags: tag inside the cooldown → info only, never a finding', async () => {
  const api = tagApi({
    tags: ['bin-v1.1.7', 'bin-v1.1.6'],
    commitDates: {'c-bin-v1.1.7': '2026-09-17T00:00:00Z'}, // 2 days before NOW
  });
  const {findings, infos} = await collectNewerTags([ITEM], api, {now: NOW});
  assert.deepEqual(findings, []);
  assert.equal(infos.length, 1);
  assert.equal(infos[0].toTag, 'bin-v1.1.7');
  assert.equal(infos[0].ageDays, 2);
});

test('collectNewerTags: no newer tag in the series → silent', async () => {
  const api = tagApi({tags: ['bin-v1.1.6', 'v2.7.0', 'v2.6.0']});
  const {findings, infos} = await collectNewerTags([ITEM], api, {now: NOW});
  assert.deepEqual(findings, []);
  assert.deepEqual(infos, []);
});

test('collectNewerTags: rolling refs and unparseable series are skipped', async () => {
  const rolling = await collectNewerTags(
    [{...ITEM, ref: 'refs/heads/main'}],
    tagApi({tags: ['v9.9.9']}),
    {now: NOW}
  );
  assert.deepEqual(rolling.findings, []);

  const noV = await collectNewerTags(
    [{...ITEM, ref: 'refs/tags/release-1.2'}],
    tagApi({tags: ['release-2.0']}),
    {now: NOW}
  );
  assert.deepEqual(noV.findings, []);
});

test('collectNewerTags: paginates the tags list past page 1', async () => {
  // 150 filler tags from another namespace own page 1 entirely; the pinned
  // series only appears on page 2.
  const filler = Array.from({length: 150}, (_, i) => `other-v${String(i).padStart(3, '0')}`);
  const api = tagApi({
    tags: [...filler, 'bin-v1.1.7', 'bin-v1.1.6'],
    commitDates: {'c-bin-v1.1.7': '2026-08-25T00:00:00Z'}, // 25 days before NOW
  });
  const {findings} = await collectNewerTags([ITEM], api, {now: NOW});
  assert.equal(findings.length, 1);
  assert.equal(findings[0].toTag, 'bin-v1.1.7');
  assert.equal(findings[0].ageDays, 25);
});

test('collectNewerTags: equal and lower versions are never reported', async () => {
  const equal = await collectNewerTags(
    [{...ITEM, ref: 'refs/tags/v1.2'}],
    tagApi({tags: ['v1.2.0', 'v1.2'], commitDates: {'c-v1.2.0': '2026-08-01T00:00:00Z'}}),
    {now: NOW}
  );
  assert.deepEqual(equal.findings, []);

  const lower = await collectNewerTags(
    [ITEM],
    tagApi({
      tags: ['bin-v1.1.5', 'bin-v1.1.6'],
      commitDates: {'c-bin-v1.1.5': '2026-08-01T00:00:00Z'},
    }),
    {now: NOW}
  );
  assert.deepEqual(lower.findings, []);
});

test('collectNewerTags: annotated tagger date drives the cooldown, not the commit date', async () => {
  // Tag published today pointing at an old commit: the publication date keeps
  // it in cooldown even though the commit is 30 days old.
  const freshTag = await collectNewerTags(
    [ITEM],
    tagApi({
      tags: ['bin-v1.1.7', 'bin-v1.1.6'],
      annotated: {'bin-v1.1.7': '2026-09-18T00:00:00Z'},
      commitDates: {'c-bin-v1.1.7': '2026-08-20T00:00:00Z'},
    }),
    {now: NOW}
  );
  assert.deepEqual(freshTag.findings, []);
  assert.equal(freshTag.infos[0].ageDays, 1);

  // Inverse: an old annotated tag on a fresh commit is actionable.
  const oldTag = await collectNewerTags(
    [ITEM],
    tagApi({
      tags: ['bin-v1.1.7', 'bin-v1.1.6'],
      annotated: {'bin-v1.1.7': '2026-08-15T00:00:00Z'},
      commitDates: {'c-bin-v1.1.7': '2026-09-18T00:00:00Z'},
    }),
    {now: NOW}
  );
  assert.equal(oldTag.findings.length, 1);
  assert.equal(oldTag.findings[0].ageDays, 35);
});

test('collectNewerTags: unknown tag age is reported honestly, not silenced', async () => {
  const api = tagApi({tags: ['bin-v1.1.7', 'bin-v1.1.6'], commitDates: {}});
  const {findings} = await collectNewerTags([ITEM], api, {now: NOW});
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'newer-tag');
  assert.equal(findings[0].ageDays, null);
});

test('collectNewerTags: API failure → check-failed with the scan attribution', async () => {
  const failed = await collectNewerTags([ITEM], tagApi({failTags: true}), {now: NOW});
  assert.equal(failed.findings[0].kind, 'check-failed');
  assert.match(failed.findings[0].reason, /^newer-tag scan: /);
});

test('tagCommitDate + ageInDays: annotated tagger date first, commit date as fallback', async () => {
  // Annotated WITH tagger date → the publication date, no commit fetch.
  const annotated = async pathname => {
    if (pathname === '/repos/o/r/git/ref/tags/annotated') {
      return {object: {type: 'tag', sha: 'tag-obj'}};
    }
    if (pathname === '/repos/o/r/git/tags/tag-obj') {
      return {object: {sha: 'real-commit'}, tagger: {date: '2026-09-14T00:00:00Z'}};
    }
    throw new Error(`unexpected path: ${pathname}`);
  };
  assert.equal(await tagCommitDate(annotated, 'o/r', 'annotated'), '2026-09-14T00:00:00Z');

  // Annotated WITHOUT tagger date → peels to the commit's committer date.
  const noTagger = async pathname => {
    if (pathname === '/repos/o/r/git/ref/tags/no-tagger') {
      return {object: {type: 'tag', sha: 'tag-obj'}};
    }
    if (pathname === '/repos/o/r/git/tags/tag-obj') return {object: {sha: 'real-commit'}};
    if (pathname === '/repos/o/r/commits/real-commit') {
      return {commit: {committer: {date: '2026-09-12T00:00:00Z'}}};
    }
    throw new Error(`unexpected path: ${pathname}`);
  };
  assert.equal(await tagCommitDate(noTagger, 'o/r', 'no-tagger'), '2026-09-12T00:00:00Z');

  // Lightweight → straight to the commit's committer date.
  const lightweight = async pathname => {
    if (pathname === '/repos/o/r/git/ref/tags/light') {
      return {object: {type: 'commit', sha: 'real-commit'}};
    }
    if (pathname === '/repos/o/r/commits/real-commit') {
      return {commit: {committer: {date: '2026-09-12T00:00:00Z'}}};
    }
    throw new Error(`unexpected path: ${pathname}`);
  };
  assert.equal(await tagCommitDate(lightweight, 'o/r', 'light'), '2026-09-12T00:00:00Z');

  assert.equal(ageInDays('2026-09-12T00:00:00Z', NOW), 7);
  assert.equal(ageInDays('not a date', NOW), null);
  assert.equal(NEWER_TAG_COOLDOWN_DAYS, 7);
});

test('updateCommand: newer-tag re-resolves latest via forced reinstall', () => {
  assert.equal(
    updateCommand({kind: 'newer-tag', skill: 'cavecrew', repo: 'o/r'}),
    'gh skill install o/r cavecrew --dir .agents/skills --force'
  );
});

test('issueBody: newer-tag section carries the tag, the cooldown phrasing and the command', () => {
  const body = issueBody([
    {
      kind: 'newer-tag',
      skill: 'cavecrew',
      repo: 'o/r',
      ref: 'refs/tags/bin-v1.1.6',
      fromTag: 'bin-v1.1.6',
      toTag: 'bin-v1.1.7',
      ageDays: 12,
    },
  ]);
  assert.match(body, /### cavecrew — newer upstream release `bin-v1.1.7`/);
  assert.match(body, /12 day\(s\) old — past the 7-day cooldown/);
  assert.match(body, /gh skill install o\/r cavecrew --dir \.agents\/skills --force/);
});

test('ISSUE_TITLE: stable dedup key', () => {
  assert.equal(ISSUE_TITLE, '[skills-watchdog] third-party skill drift');
});
