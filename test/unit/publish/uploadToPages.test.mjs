// test/unit/publish/uploadToPages.test.mjs — unit tests for the Pages-branch
// push (tools/publish/uploadToPages.mjs): blob skipping, tree/commit assembly,
// and the orphan-creation contract (issue #261 / ADR 0031 — a missing branch is
// never seeded from the default branch; its root commit holds only the pushed
// files and has no parents).

import {test} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// uploadToPages.mjs pulls in paths.js → publishMode.mjs, which reads --mode
// from argv at load time, so the test pushes --mode=prod into process.argv
// before the dynamic import (same pattern as pagesIndex.test.mjs).
process.argv.push('--mode=prod');

const {uploadFilesToPages} = await import('../../../tools/publish/uploadToPages.mjs');

/** Independent git blob sha (the canonical git object hashing). */
const gitBlobSha = buf =>
  crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');

const BRANCH = 'gh-pages';
const OLD_HEAD = '1'.repeat(40);
const MERGED_TREE = '2'.repeat(40);
const FRESH_TREE = '3'.repeat(40);
const COMMIT = '4'.repeat(40);

/**
 * Minimal git-data stub covering exactly the endpoints uploadFilesToPages may
 * touch. `headSha: null` = the branch ref does not exist (getRef → 404). There
 * is deliberately NO `repos.get`: if the implementation ever went back to
 * seeding the branch from the default branch, the missing method would throw
 * and fail the test.
 */
function fakeOctokit({headSha = OLD_HEAD, tracked = {}} = {}) {
  const calls = [];
  const api = {
    git: {
      getRef: async ({ref}) => {
        calls.push(['getRef', ref]);
        if (!headSha) {
          const err = new Error('Reference does not exist');
          err.status = 404;
          throw err;
        }
        return {data: {object: {sha: headSha}}};
      },
      getTree: async ({tree_sha}) => {
        calls.push(['getTree', tree_sha]);
        return {
          data: {
            sha: tree_sha,
            tree: Object.entries(tracked).map(([path, sha]) => ({path, sha, type: 'blob'})),
          },
        };
      },
      createBlob: async ({content}) => {
        calls.push(['createBlob', content]);
        return {data: {sha: gitBlobSha(Buffer.from(content, 'base64'))}};
      },
      createTree: async ({base_tree, tree}) => {
        calls.push(['createTree', base_tree, tree]);
        return {data: {sha: base_tree ? MERGED_TREE : FRESH_TREE}};
      },
      createCommit: async ({message, tree, parents}) => {
        calls.push(['createCommit', message, tree, parents]);
        return {data: {sha: COMMIT}};
      },
      updateRef: async ({ref, sha, force}) => {
        calls.push(['updateRef', ref, sha, force]);
        return {data: {}};
      },
      createRef: async ({ref, sha}) => {
        calls.push(['createRef', ref, sha]);
        return {data: {}};
      },
    },
  };
  return {api, calls};
}

test('existing branch: only changed files upload; commit parents on the old head; ref force-updated', async t => {
  t.mock.method(console, 'log', () => {});
  const same = Buffer.from('unchanged-zip-bytes');
  const {api, calls} = fakeOctokit({
    // a real branch always carries the empty .nojekyll blob, so it is skipped
    tracked: {'.nojekyll': gitBlobSha(Buffer.alloc(0)), 'utils.zip': gitBlobSha(same)},
  });
  const uploaded = await uploadFilesToPages(
    api,
    {'utils.zip': same, 'hashes.json': Buffer.from('{"utils": {}}\n')},
    {message: 'chore: publish prod artifacts (2026-09-20)'}
  );

  assert.deepEqual(uploaded, ['hashes.json']);
  assert.equal(
    calls.filter(([name]) => name === 'createBlob').length,
    1,
    'the unchanged blob must never re-upload'
  );
  const tree = calls.find(([name]) => name === 'createTree');
  assert.equal(tree[1], OLD_HEAD, 'the merged tree bases on the branch head tree');
  const commit = calls.find(([name]) => name === 'createCommit');
  assert.equal(commit[1], 'chore: publish prod artifacts (2026-09-20)');
  assert.equal(commit[2], MERGED_TREE);
  assert.deepEqual(commit[3], [OLD_HEAD]);
  assert.deepEqual(
    calls.find(([name]) => name === 'updateRef'),
    ['updateRef', `heads/${BRANCH}`, COMMIT, true]
  );
  assert.equal(
    calls.some(([name]) => name === 'createRef'),
    false
  );
});

test('missing branch: TRUE ORPHAN — files-only tree, no parents, createRef (never seeded from main)', async t => {
  const logs = [];
  t.mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
  const {api, calls} = fakeOctokit({headSha: null});
  const uploaded = await uploadFilesToPages(api, {'hashes.json': Buffer.from('{}\n')});

  assert.deepEqual(uploaded, ['.nojekyll', 'hashes.json']);
  // The orphan path never touches the default branch: exactly one getRef (the
  // publish branch itself), no repos.get (absent from the stub — a
  // seed-from-main regression throws), no tree read of an inherited head.
  assert.equal(calls.filter(([name]) => name === 'getRef').length, 1);
  assert.equal(
    calls.some(([name]) => name === 'getTree'),
    false
  );
  const tree = calls.find(([name]) => name === 'createTree');
  assert.equal(tree[1], undefined, 'no base_tree — the tree holds only the pushed files');
  assert.deepEqual(
    tree[2].map(e => e.path).sort(),
    ['.nojekyll', 'hashes.json'],
    '.nojekyll always joins the fresh tree'
  );
  const commit = calls.find(([name]) => name === 'createCommit');
  assert.deepEqual(commit[3], [], 'an orphan root commit has no parents');
  assert.deepEqual(
    calls.find(([name]) => name === 'createRef'),
    ['createRef', `refs/heads/${BRANCH}`, COMMIT]
  );
  assert.equal(
    calls.some(([name]) => name === 'updateRef'),
    false
  );
  assert.ok(
    logs.some(line => /orphan artifact-only branch/.test(line)),
    'the run announces the orphan creation'
  );
});

test('idle run on an existing branch: no commit, no ref update', async t => {
  t.mock.method(console, 'log', () => {});
  const same = Buffer.from('same');
  const {api, calls} = fakeOctokit({
    tracked: {'.nojekyll': gitBlobSha(Buffer.alloc(0)), 'utils.zip': gitBlobSha(same)},
  });
  const uploaded = await uploadFilesToPages(api, {'utils.zip': same});

  assert.deepEqual(uploaded, []);
  assert.equal(
    calls.some(([name]) => name === 'createCommit'),
    false
  );
  assert.equal(
    calls.some(([name]) => name === 'updateRef'),
    false
  );
});

test('missing message argument falls back to the generic publish-files subject', async t => {
  t.mock.method(console, 'log', () => {});
  const {api, calls} = fakeOctokit();
  await uploadFilesToPages(api, {'hashes.json': Buffer.from('x\n')});
  const commit = calls.find(([name]) => name === 'createCommit');
  assert.match(commit[1], /^chore: publish files \(\d{4}-\d{2}-\d{2}\)$/);
});
