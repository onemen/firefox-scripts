#!/usr/bin/env node

// tools/ci/prune-caches.mjs — prune old GitHub Actions caches.
//
// GitHub keeps up to 10 versions per cache key and auto-evicts (LRU) only
// when the repo crosses the 10 GB total limit, so stale keys accumulate and
// burn the quota/bandwidth forever (e.g. a `firefox-dl-*` key per Firefox
// stable bump, a `node-cache-*` per lockfile change). This script keeps the
// newest N versions per cache-key "stem" (the key without its trailing
// content hash) and deletes the rest.
//
// Usage:
//   node tools/ci/prune-caches.mjs [--keep 3] [--dry-run]
//                                  [--prefix <regex>]...
//
//   --keep <n>    versions to keep per stem (default 3)
//   --dry-run     list what would be deleted without deleting
//   --prefix <re> only touch keys matching this regex (repeatable); default
//                 is every key. Example: --prefix '^firefox-dl-'
//
// Token: reads GITHUB_TOKEN_VAR (repo convention), falling back to GH_TOKEN.
// Needs `actions: write` scope. Repo comes from GITHUB_REPOSITORY (CI) or the
// origin remote.

import {execSync} from 'node:child_process';

const argv = process.argv.slice(2);
const KEEP = Number(argv.find(a => a.startsWith('--keep='))?.split('=')[1] ?? 3);
const DRY_RUN = argv.includes('--dry-run');
// Accept both `--prefix <re>` and `--prefix=<re>`. The pattern is the user's
// own CLI filter — intentionally arbitrary, so disable the ReDoS lint.
/* eslint-disable security/detect-non-literal-regexp */
const PREFIXES = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--prefix=')) PREFIXES.push(new RegExp(a.slice('--prefix='.length)));
  else if (a === '--prefix' && argv[i + 1]) PREFIXES.push(new RegExp(argv[++i]));
}
/* eslint-enable security/detect-non-literal-regexp */

function repoSlug() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  const url = execSync('git config --get remote.origin.url', {encoding: 'utf-8'}).trim();
  const m = url.match(/(?:github\.com[/:]|git@github\.com:)([^/]+)\/([^/.]+)/);
  if (!m) throw new Error(`cannot derive repo from origin URL: ${url}`);
  return `${m[1]}/${m[2]}`;
}

function token() {
  const t = process.env.GITHUB_TOKEN_VAR || process.env.GH_TOKEN;
  if (!t) {
    throw new Error('No token: set GITHUB_TOKEN_VAR (or GH_TOKEN) with `actions: write` scope.');
  }
  return t;
}

/** Strip a trailing content hash so versions of the same key group together. */
function stem(key) {
  return key.replace(/[0-9a-f]{8,}$/i, '');
}

async function main() {
  const repo = repoSlug();
  const auth = `Bearer ${token()}`;
  const api = 'https://api.github.com';

  const caches = [];
  for (let page = 1; ; page++) {
    const res = await fetch(`${api}/repos/${repo}/actions/caches?per_page=100&page=${page}`, {
      headers: {'authorization': auth, 'x-github-api-version': '2022-11-28'},
    });
    if (!res.ok) throw new Error(`list caches failed: ${res.status} ${await res.text()}`);
    const body = await res.json();
    caches.push(...(body.actions_caches ?? []));
    if (body.actions_caches.length === 0 || page >= (body.total_count ?? 0) / 100 + 1) break;
    if (body.actions_caches.length < 100) break;
  }

  const inScope =
    PREFIXES.length === 0 ? caches : caches.filter(c => PREFIXES.some(re => re.test(c.key)));

  const byStem = new Map();
  for (const c of inScope) {
    const s = stem(c.key);
    if (!byStem.has(s)) byStem.set(s, []);
    byStem.get(s).push(c);
  }

  const toDelete = [];
  for (const [, group] of byStem) {
    group.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    for (const c of group.slice(KEEP)) toDelete.push(c);
  }

  const totalSize = inScope.reduce((n, c) => n + c.size_in_bytes, 0);
  console.log(
    `repo ${repo}: ${caches.length} caches, ${inScope.length} in scope ` +
      `(${(totalSize / 1e6).toFixed(1)} MB), keeping ${KEEP} per stem`
  );
  for (const c of toDelete) {
    console.log(
      `  delete ${DRY_RUN ? '[dry-run] ' : ''}${c.key}  ` +
        `(${(c.size_in_bytes / 1e6).toFixed(1)} MB, ${c.created_at})`
    );
    if (!DRY_RUN) {
      const res = await fetch(`${api}/repos/${repo}/actions/caches/${c.id}`, {
        method: 'DELETE',
        headers: {'authorization': auth, 'x-github-api-version': '2022-11-28'},
      });
      if (!res.ok) throw new Error(`delete ${c.key} failed: ${res.status} ${await res.text()}`);
    }
  }
  console.log(DRY_RUN ? `would delete ${toDelete.length}` : `deleted ${toDelete.length}`);
}

main().catch(err => {
  console.error(`✗ Error: ${err.message}`);
  process.exit(1);
});
