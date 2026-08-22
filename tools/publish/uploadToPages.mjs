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
// The branch is created (orphaned from the repo's default branch) on first
// run if it does not exist.  Uploads go through the git-data API so existing
// files are replaced atomically and unchanged files are skipped.

import crypto from 'crypto';
import {REPO_OWNER, ZIP_PAGES_REPO, ZIP_PAGES_BRANCH} from './paths.js';
import {bold, dim, green, yellow} from './log.mjs';

function gitBlobSha(buf) {
  return crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
}

/**
 * Landing page for the Pages site: the branch carries only binary artifacts and
 * hashes.json, so without this the site root would be a 404.
 *
 * The site serves the repository's own README.md, rendered by GitHub (the same
 * HTML the repo page shows) — fetched fresh on every publish and wrapped in a
 * minimal shell, so the landing page can never drift from the README. Static
 * HTML on purpose: the branch ships .nojekyll because the legacy Jekyll build
 * errored on this repo and left pushes undeployed. Content-addressed like every
 * other pushed file: unchanged content is skipped, so idle runs create no
 * commit for it.
 *
 * @returns {Promise<Buffer>} index.html, or a plain-text fallback when the
 *   README cannot be fetched (the site must never 404).
 */
export async function pagesIndex(octokit) {
  const repoUrl = `https://github.com/${REPO_OWNER}/${ZIP_PAGES_REPO}`;
  let body;
  try {
    const {data} = await octokit.request('GET /repos/{owner}/{repo}/readme', {
      owner: REPO_OWNER,
      repo: ZIP_PAGES_REPO,
      headers: {accept: 'application/vnd.github.html+json'},
      mediaType: {format: 'html'},
    });
    body = String(data);
  } catch (error) {
    console.log(yellow(`README fetch failed (${error.message}) — falling back to plain text.`));
    try {
      const {data} = await octokit.request('GET /repos/{owner}/{repo}/readme', {
        owner: REPO_OWNER,
        repo: ZIP_PAGES_REPO,
        headers: {accept: 'application/vnd.github.raw+json'},
      });
      body = `<pre>${String(data).replace(/[&<>]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;'})[c])}</pre>`;
    } catch (fallbackError) {
      throw new Error(`Failed to fetch the README for the Pages index: ${fallbackError.message}`, {
        cause: fallbackError,
      });
    }
  }
  return Buffer.from(
    [
      '<!doctype html>',
      '<html lang="en">',
      '  <head>',
      '    <meta charset="utf-8" />',
      '    <meta name="viewport" content="width=device-width, initial-scale=1" />',
      '    <title>firefox-scripts</title>',
      '    <link',
      '      rel="stylesheet"',
      '      href="https://cdn.jsdelivr.net/npm/github-markdown-css@5/github-markdown.min.css"',
      '    />',
      '    <style>',
      '      body { display: flex; justify-content: center; }',
      '      .markdown-body { max-width: 980px; padding: 16px 24px; }',
      '    </style>',
      '  </head>',
      '  <body class="markdown-body">',
      `    <!-- Rendered from ${repoUrl}#readme -->`,
      body,
      '  </body>',
      '</html>',
      '',
    ].join('\n'),
    'utf-8'
  );
}

/**
 * Ensure the Pages branch ref exists, creating it from the default branch if
 * needed.
 */
async function ensureBranch(octokit) {
  const repo = {owner: REPO_OWNER, repo: ZIP_PAGES_REPO};
  try {
    const {data: ref} = await octokit.git.getRef({...repo, ref: `heads/${ZIP_PAGES_BRANCH}`});
    return ref.object.sha;
  } catch (error) {
    if (error.status !== 404) {
      throw new Error(`Failed to read gh-pages ref: ${error.message}`, {cause: error});
    }
  }

  // Branch does not exist yet — start it from the default branch tip.
  console.log(
    yellow(`Branch '${ZIP_PAGES_BRANCH}' not found — creating from the default branch...`)
  );
  const {data: repoInfo} = await octokit.repos.get(repo);
  const {data: defaultRef} = await octokit.git.getRef({
    ...repo,
    ref: `heads/${repoInfo.default_branch}`,
  });
  const {data: created} = await octokit.git.createRef({
    ...repo,
    ref: `refs/heads/${ZIP_PAGES_BRANCH}`,
    sha: defaultRef.object.sha,
  });
  console.log(green(`✓ Created '${ZIP_PAGES_BRANCH}' at ${created.object.sha.slice(0, 7)}`));
  return created.object.sha;
}

/**
 * Push a set of named files to the Pages branch. `files` maps the target path
 * on the branch (e.g. 'helper_win.exe', 'hashes.json') to a Buffer with the
 * file content. Callers pass only the files that changed, so a stale dist/ copy
 * can never overwrite a live artifact on Pages.
 *
 * Returns the list of uploaded file names (empty when everything is current).
 */
export async function uploadFilesToPages(
  octokit,
  files,
  {message = `chore: publish files (${new Date().toISOString().slice(0, 10)})`} = {}
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
  if (entries.length === 0) {
    return [];
  }

  console.log(
    bold(
      `Publishing to ${REPO_OWNER}/${ZIP_PAGES_REPO}@${ZIP_PAGES_BRANCH} (${entries.length} file${entries.length === 1 ? '' : 's'}):`
    )
  );
  const headSha = await ensureBranch(octokit);

  const {data: tree} = await octokit.git.getTree({
    ...repo,
    tree_sha: headSha,
    recursive: 1,
  });
  const existingEntries = new Map(
    tree.tree.filter(e => e.type === 'blob').map(e => [e.path, e.sha])
  );

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

  if (updatedEntries.length === 0) {
    console.log(dim('  No changes — nothing to commit'));
    return uploaded;
  }

  const {data: newTree} = await octokit.git.createTree({
    ...repo,
    base_tree: tree.sha,
    tree: updatedEntries,
  });
  const {data: commit} = await octokit.git.createCommit({
    ...repo,
    message,
    tree: newTree.sha,
    parents: [headSha],
  });
  await octokit.git.updateRef({
    ...repo,
    ref: `heads/${ZIP_PAGES_BRANCH}`,
    sha: commit.sha,
    force: true,
  });
  console.log(
    green(
      `✓ ${REPO_OWNER}/${ZIP_PAGES_REPO}@${ZIP_PAGES_BRANCH} updated: ${commit.sha.slice(0, 7)}`
    )
  );
  return uploaded;
}
