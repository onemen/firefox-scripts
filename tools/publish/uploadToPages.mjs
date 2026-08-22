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
 * hashes.json, so without this the site root would be a 404. Plain static
 * index.html on purpose — the branch inherits .nojekyll from the default
 * branch, so Jekyll (and its README-as-index fallback) is disabled. The
 * branch's own README.md stays for people browsing the repo. Content-addressed
 * like every other pushed file: unchanged content is skipped, so idle runs
 * create no commit for it.
 */
export function pagesIndex() {
  const repoUrl = `https://github.com/${REPO_OWNER}/${ZIP_PAGES_REPO}`;
  const li = (href, label, note = '') =>
    `    <li><a href="${href}">${label}</a>${note ? ` — ${note}` : ''}</li>`;
  return Buffer.from(
    [
      '<!doctype html>',
      '<html lang="en">',
      '  <head>',
      '    <meta charset="utf-8" />',
      '    <meta name="viewport" content="width=device-width, initial-scale=1" />',
      '    <title>firefox-scripts</title>',
      '  </head>',
      '  <body>',
      '    <h1>firefox-scripts</h1>',
      '    <p>Helper scripts that let Firefox-family browsers run legacy (non-WebExtension) extensions.</p>',
      '    <p><strong>🚧 Under active development</strong> — expect breaking changes.</p>',
      '    <h2>Downloads</h2>',
      '    <p>Installers for Windows, Linux and macOS are attached to the',
      `      <a href="${repoUrl}/releases/latest">latest release</a>.</p>`,
      '    <p>Packages fetched by the installer UI (also on this site):</p>',
      '    <ul>',
      li('fx-folder.zip', 'fx-folder.zip', 'browser config package'),
      li('utils.zip', 'utils.zip', 'chrome scripts + updater'),
      li('hashes.json', 'hashes.json', 'integrity manifest'),
      '    </ul>',
      '    <h2>Documentation</h2>',
      '    <ul>',
      li(`${repoUrl}/blob/main/docs/DEVELOPING.md`, 'Development guide'),
      li(`${repoUrl}/blob/main/docs/auto-updater.md`, 'Auto-updater design'),
      li(`${repoUrl}/blob/main/CONTRIBUTING.md`, 'Contributing'),
      '    </ul>',
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
