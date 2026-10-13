#!/usr/bin/env node

// Publishes the built docs site (docs-site/dist) to the root of the Pages
// branch, the same branch that serves the release artifacts the installer and
// the in-browser updater fetch (ADR 0003, ADR 0031, ADR 0046).
//
// The two writers are path-disjoint: publish (pages.yml) owns the artifact
// files, this script owns the site files (index.html, 404.html, _astro/,
// pagefind/, the page directories and their assets). The shared concurrency
// group `gh-pages-write` serializes the two workflows so they can never
// interleave read-head-then-commit cycles.
//
// Every push is a full replace of what this script owns, so a page that was
// deleted or renamed cannot survive as a stale file: the previous deploy's file
// list is committed alongside the site (DOCS_MANIFEST), and anything in it that
// the new build no longer produces is deleted in the same commit.
//
// Usage: node tools/docs/publishDocsSite.mjs [--dist docs-site/dist] [--dry-run]
// Env:   GITHUB_TOKEN_VAR, the repo-wide fixed token variable name the publish
//        tooling also reads (required; no local fallback, this always pushes).

import fs from 'node:fs';
import path from 'node:path';

import {REPO_OWNER, SELF_UPDATE_FILE, ZIP_PAGES_BRANCH, ZIP_PAGES_REPO} from '../publish/paths.js';
import {createOctokit, getGitHubToken} from '../publish/publishCommon.mjs';
import {readPagesFile, uploadFilesToPages} from '../publish/uploadToPages.mjs';
import {bold, dim, green, yellow} from '../publish/log.mjs';

/** The list of branch paths the docs deploy owns, committed with the site. */
const DOCS_MANIFEST = '.docs-site-files.json';

// Artifact paths owned by pages.yml (the owner list in the docs-deploy.yml
// header): the docs deploy must never write or delete them. A site build can
// never legitimately contain one, and a hand-edited manifest must not be able
// to smuggle one into the deletion list.
const RESERVED_PAGES_PATHS = new Set(['hashes.json', SELF_UPDATE_FILE, 'README.md']);
const isReservedPagesPath = name =>
  RESERVED_PAGES_PATHS.has(name) ||
  name.endsWith('.zip') ||
  name.endsWith('.exe') ||
  name.endsWith('.sha256');

function parseArgs(argv) {
  const args = {dist: 'docs-site/dist', dryRun: false};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dist') args.dist = argv[++i];
    else if (argv[i] === '--dry-run') args.dryRun = true;
  }
  return args;
}

/**
 * Every file under the built site, as branch-relative paths mapped to bytes.
 * Paths are POSIX-separated: the branch is a git tree, not a Windows path.
 *
 * @param {string} distDir
 * @returns {Map<string, Buffer>}
 */
function collectDist(distDir) {
  const files = new Map();
  if (!fs.existsSync(distDir)) {
    throw new Error(`No built site at ${distDir} — run \`pnpm docs:build\` first.`);
  }
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const rel = path.relative(distDir, full).split(path.sep).join('/');
        if (isReservedPagesPath(rel)) {
          throw new Error(`Refusing to publish reserved artifact path '${rel}' from ${distDir}.`);
        }
        files.set(rel, fs.readFileSync(full));
      }
    }
  };
  walk(distDir);
  return files;
}

/**
 * The docs-owned paths recorded by the previous deploy, or an empty list. A
 * corrupt or absent manifest is reported and treated as empty: it only costs a
 * stale-file sweep on the next deploy, never a broken site.
 *
 * @param {import('@octokit/rest').Octokit} octokit
 * @returns {Promise<string[]>}
 */
async function readPreviousDocsFiles(octokit) {
  const raw = await readPagesFile(octokit, DOCS_MANIFEST);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw.toString('utf8'));
    return Array.isArray(parsed?.files) ? parsed.files.filter(f => typeof f === 'string') : [];
  } catch (error) {
    console.log(
      yellow(
        `${DOCS_MANIFEST} on the Pages branch is unreadable (${error.message}) — ` +
          'treating it as empty.'
      )
    );
    return [];
  }
}

const {dist, dryRun} = parseArgs(process.argv.slice(2));

// The docs site always lands on the PROD artifact branch; a dev-mode module
// import would otherwise aim it at a disposable dev-build-<id> branch.
if (ZIP_PAGES_BRANCH !== 'gh-pages') {
  throw new Error(
    `Refusing to publish docs to '${ZIP_PAGES_BRANCH}' — the docs site belongs on gh-pages.`
  );
}

const files = collectDist(dist);
const next = [...files.keys()].sort();

// A dry run is genuinely OFFLINE: no token, no branch read, no writes. It
// reports what the build produced; the deletion list can only be known from the
// live manifest, so the dry run says so rather than pretending to know.
if (dryRun) {
  console.log(
    bold(
      `Docs site: ${files.size} file${files.size === 1 ? '' : 's'} from ${dist} → ` +
        `${REPO_OWNER}/${ZIP_PAGES_REPO}@${ZIP_PAGES_BRANCH}`
    )
  );
  console.log(dim('Dry run — nothing committed.'));
  console.log(
    dim(
      'Removed paths are only known from the live branch manifest — the publish step ' +
        'reports and deletes them.'
    )
  );
  process.exit(0);
}

const token = getGitHubToken();
if (!token) {
  throw new Error('No GitHub token: set GITHUB_TOKEN_VAR (the repo-wide fixed variable name).');
}
const octokit = createOctokit(token);
const repo = {owner: REPO_OWNER, repo: ZIP_PAGES_REPO};

const previous = await readPreviousDocsFiles(octokit);
// Only ever delete paths this script wrote; reserved artifact paths are
// refused even when a hand-edited manifest lists them.
const deletePaths = previous
  .filter(p => {
    if (files.has(p)) return false;
    if (isReservedPagesPath(p)) {
      console.log(yellow(`  ! ${p}  reserved artifact path, not deleting`));
      return false;
    }
    return true;
  })
  .sort();

console.log(
  bold(
    `Docs site: ${files.size} file${files.size === 1 ? '' : 's'} from ${dist} → ` +
      `${REPO_OWNER}/${ZIP_PAGES_REPO}@${ZIP_PAGES_BRANCH}`
  )
);
for (const path of deletePaths) console.log(`  ${yellow('-')} ${path}  deleted`);

if (!previous.length) {
  // First docs deploy on this branch: make sure it really is the artifact
  // branch before writing a site into it (a fresh branch would otherwise be
  // created as an orphan holding only the site).
  try {
    const {data: probe} = await octokit.repos.getContent({...repo, path: 'hashes.json'});
    if (Array.isArray(probe) || probe.type !== 'file') throw new Error('hashes.json is not a file');
  } catch (error) {
    throw new Error(
      `The Pages branch has no hashes.json (${error.message}) — refusing to write the docs ` +
        'site into it. Publish the artifacts first.',
      {cause: error}
    );
  }
  console.log(dim('First docs deploy on this branch — hashes.json found, proceeding.'));
}

await uploadFilesToPages(
  octokit,
  {
    ...Object.fromEntries(files),
    // The manifest rides the same commit, so the next deploy always knows
    // exactly which paths this one owned.
    [DOCS_MANIFEST]: Buffer.from(
      `${JSON.stringify(
        {
          comment:
            'Paths owned by tools/docs/publishDocsSite.mjs (docs-deploy.yml). Anything ' +
            'listed here and absent from the next build is deleted. Do not hand-edit.',
          generatedAt: new Date().toISOString(),
          files: next,
        },
        null,
        2
      )}\n`,
      'utf8'
    ),
  },
  {
    deletePaths,
    message: `docs: publish site (${new Date().toISOString().slice(0, 10)})`,
  }
);

console.log(green('Docs site published.'));
