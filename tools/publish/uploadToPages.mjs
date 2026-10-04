#!/usr/bin/env node

// Uploads files (installer package zips, helper binaries, the hash manifest)
// to the GitHub Pages branch of the firefox-scripts repo, where the installer
// UI and the in-browser updater fetch them from (ZIP_PAGES_URL / HASHES_URL /
// HELPER_BASE_URL in config/installer.conf).
//
// GitHub Pages sends `Access-Control-Allow-Origin: *`, so the installer tab
// can fetch these files cross-origin — unlike release-asset CDNs, which do
// not send CORS headers.
//
// A missing branch is created as a TRUE ORPHAN on first run: a single root
// commit holding exactly the pushed files — never seeded from the default
// branch (the 2026-08-22 seed-from-main accident dragged the whole source tree
// and history onto the branch; ADR 0031).  Uploads go through the git-data API
// so existing files are replaced atomically and unchanged files are skipped.
//
// The prod branch also carries the docs site at its root (index.html,
// 404.html, _astro/, pagefind/ — ADR 0038); those paths are written by
// .github/workflows/docs-deploy.yml, never from here. This module owns only
// the artifact paths, which is what keeps the two writers disjoint.

import crypto from 'crypto';
import {REPO_OWNER, ZIP_PAGES_REPO, ZIP_PAGES_BRANCH} from './paths.js';
import {bold, dim, green, yellow} from './log.mjs';

function gitBlobSha(buf) {
  return crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
}

/**
 * Resolve the Pages branch head, or `null` when the branch does not exist yet.
 * The caller turns `null` into an orphan root commit built from the pushed
 * files — the branch is NEVER seeded from the default branch (issue #261, ADR
 * 0031).
 */
async function pagesBranchHead(octokit) {
  const repo = {owner: REPO_OWNER, repo: ZIP_PAGES_REPO};
  try {
    const {data: ref} = await octokit.git.getRef({...repo, ref: `heads/${ZIP_PAGES_BRANCH}`});
    return ref.object.sha;
  } catch (error) {
    if (error.status !== 404) {
      throw new Error(`Failed to read ${ZIP_PAGES_BRANCH} ref: ${error.message}`, {cause: error});
    }
  }

  console.log(
    yellow(
      `Branch '${ZIP_PAGES_BRANCH}' not found — the first push creates it as an ` +
        'orphan artifact-only branch (ADR 0031)'
    )
  );
  return null;
}

/**
 * Read one file from the Pages branch head (issue #341: the self-update payload
 * is MERGED across pages.yml's sequential OS jobs — each job reads the branch's
 * current self-update.json, merges its own platform URLs over it, and rewrites
 * the file, so the final job's commit carries every platform). Returns null
 * when the branch or the file is missing, and rethrows real errors — callers
 * downgrade to under-merge, never to a wrong payload.
 *
 * @param {import('@octokit/rest').Octokit} octokit authenticated client
 * @param {string} path file path on the branch (e.g. 'self-update.json')
 * @returns {Promise<Buffer | null>} file bytes, or null when absent
 */
export async function readPagesFile(octokit, path) {
  const headSha = await pagesBranchHead(octokit);
  if (!headSha) return null;
  const {data} = await octokit.repos.getContent({
    owner: REPO_OWNER,
    repo: ZIP_PAGES_REPO,
    path,
    ref: headSha,
  });
  if (Array.isArray(data) || data.type !== 'file') return null;
  return Buffer.from(data.content, 'base64');
}

/**
 * Does the target branch already exist? `null` when the probe itself fails
 * (network, permissions) — callers downgrade their message instead of
 * asserting. Mode-aware through the module constants: prod probes gh-pages, dev
 * probes this run's dev-build-<id> branch.
 */
export async function branchExistsOnPages(octokit) {
  try {
    await octokit.git.getRef({
      owner: REPO_OWNER,
      repo: ZIP_PAGES_REPO,
      ref: `heads/${ZIP_PAGES_BRANCH}`,
    });
    return true;
  } catch (e) {
    if (e?.status === 404) return false;
    return null;
  }
}

/**
 * Push a set of named files to the Pages branch. `files` maps the target path
 * on the branch (e.g. 'helper_win.exe', 'hashes.json') to a Buffer with the
 * file content. Callers pass only the files that changed, so a stale dist/ copy
 * can never overwrite a live artifact on Pages.
 *
 * `deletePaths` removes branch paths in the SAME commit (ADR 0038: the docs
 * deploy owns a full replace of its own files, so a page that no longer exists
 * must not survive). A path that is not on the branch is skipped, so passing
 * the full previous list every run is safe.
 *
 * Returns the list of uploaded file names (empty when everything is current).
 */
export async function uploadFilesToPages(
  octokit,
  files,
  {
    message = `chore: publish files (${new Date().toISOString().slice(0, 10)})`,
    deletePaths = [],
  } = {}
) {
  const repo = {owner: REPO_OWNER, repo: ZIP_PAGES_REPO};
  // An empty .nojekyll disables the legacy Jekyll build for the Pages branch:
  // files are served raw and every push deploys immediately, without the
  // flaky Jekyll build (which was erroring on this repo and left new pushes
  // undeployed).  Content-addressed (fixed empty blob), so it creates a
  // commit only the first time and is skipped on every later push.
  const entries = Object.entries({'.nojekyll': Buffer.alloc(0), ...files}).filter(
    ([, buf]) => buf != null && buf.length >= 0
  );
  const deletions = deletePaths.filter(p => typeof p === 'string' && p.length > 0);
  if (entries.length === 0 && deletions.length === 0) {
    return [];
  }

  console.log(
    bold(
      `Publishing to ${REPO_OWNER}/${ZIP_PAGES_REPO}@${ZIP_PAGES_BRANCH} ` +
        `(${entries.length} file${entries.length === 1 ? '' : 's'}` +
        `${deletions.length ? `, ${deletions.length} deletion(s)` : ''}):`
    )
  );
  const headSha = await pagesBranchHead(octokit);

  // A missing branch compares against an empty tree: every pushed file is
  // new, nothing can be "unchanged".
  let baseTreeSha = null;
  const existingEntries = new Map();
  if (headSha) {
    const {data: tree} = await octokit.git.getTree({
      ...repo,
      tree_sha: headSha,
      recursive: 1,
    });
    baseTreeSha = tree.sha;
    for (const e of tree.tree.filter(e => e.type === 'blob')) {
      existingEntries.set(e.path, e.sha);
    }
  }

  const updatedEntries = [];
  const uploaded = [];
  for (const [name, buf] of entries) {
    const sha = gitBlobSha(buf);
    if (existingEntries.get(name) === sha) {
      console.log(dim(`  - ${name}  unchanged`));
      continue;
    }
    const {data: blob} = await octokit.git.createBlob({
      ...repo,
      content: buf.toString('base64'),
      encoding: 'base64',
    });
    updatedEntries.push({path: name, mode: '100644', type: 'blob', sha: blob.sha});
    uploaded.push(name);
    console.log(`  ${green('+')} ${name}  ${buf.length} bytes`);
  }

  // Deletions: a null sha removes the path from the tree (git-data API). Only
  // paths actually present on the branch are removed, so the caller can pass its
  // whole previous file list every run.
  const deleted = [];
  for (const path of deletions) {
    if (!existingEntries.has(path)) continue;
    if (entries.some(([name]) => name === path)) {
      throw new Error(`Path listed for deletion is also being written: ${path}`);
    }
    updatedEntries.push({path, mode: '100644', type: 'blob', sha: null});
    deleted.push(path);
    console.log(`  ${yellow('-')} ${path}  deleted`);
  }

  if (updatedEntries.length === 0) {
    console.log(dim('  No changes — nothing to commit'));
    return uploaded;
  }

  // A missing branch becomes a TRUE ORPHAN: the tree holds only the pushed
  // files (no base_tree) and the commit has no parents.  `.nojekyll` is always
  // in `entries`, so a fresh branch always has at least one entry and the
  // early return above is unreachable for it.
  const {data: newTree} = await octokit.git.createTree(
    headSha ?
      {...repo, base_tree: baseTreeSha, tree: updatedEntries}
    : {...repo, tree: updatedEntries}
  );
  const {data: commit} = await octokit.git.createCommit({
    ...repo,
    message,
    tree: newTree.sha,
    parents: headSha ? [headSha] : [],
  });
  if (headSha) {
    await octokit.git.updateRef({
      ...repo,
      ref: `heads/${ZIP_PAGES_BRANCH}`,
      sha: commit.sha,
      force: true,
    });
  } else {
    await octokit.git.createRef({
      ...repo,
      ref: `refs/heads/${ZIP_PAGES_BRANCH}`,
      sha: commit.sha,
    });
  }
  console.log(
    green(
      `✓ ${REPO_OWNER}/${ZIP_PAGES_REPO}@${ZIP_PAGES_BRANCH} updated: ${commit.sha.slice(0, 7)}`
    )
  );
  return uploaded;
}
