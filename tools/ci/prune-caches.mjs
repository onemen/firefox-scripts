#!/usr/bin/env node

// tools/ci/prune-caches.mjs — prune old GitHub Actions caches.
//
// GitHub keeps up to 10 versions per cache key and auto-evicts (LRU) only
// when the repo crosses the 10 GB total limit, so stale keys accumulate and
// burn the quota/bandwidth forever (e.g. a `firefox-dl-*` key per Firefox
// stable bump, a `node-cache-*` per lockfile change). This script keeps the
// newest N versions per cache-key FAMILY (see stem()) and deletes the rest.
//
// The grouping is family-aware because the setup-browser keys embed what they
// cache: `…-Windows-ca6cc4d5e2db5f9a` (the installer), its `-x` twin (the
// extracted dir) and the fork namespace's `-v<version>` entries all rotate per
// release while their key stem changes, so GitHub's per-key version cap never
// applies to them and a content-hash-only stem leaves them unpruned. Measure
// 2026-10-05: 10.7 GB against a 10 GB cap, with the portable-dir entries alone
// at ~2.6 GB across four releases.
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
import path from 'node:path';
import {pathToFileURL} from 'node:url';

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

/**
 * The cache-key family a key belongs to — the stem whose versions `--keep`
 * counts. GitHub's own "10 versions per key" only helps when the key itself
 * rotates; the setup-browser keys embed the content they cache, so every vendor
 * bump and every extracted-dir save looks like a brand-new key and nothing ever
 * groups. The family is the key minus everything that varies per entry:
 *
 * firefox-portable-Windows-ca6cc4d5e2db5f9a-x → firefox-portable-Windows
 * firefox-dl-Windows-ca6cc4d5e2db5f9a → firefox-dl-Windows
 * browser-dl-Windows-zen-portable-dir-v1.23b → browser-dl-Windows-zen-portable
 * esr-portable-Windows-8769a05370997233 → esr-portable-Windows
 * snap-firefox-8995 → snap-firefox browser-validated-37359307092 →
 * browser-validated url-watchdog-baseline-2026-10-05 → url-watchdog-baseline
 *
 * The suffixes are peeled in a loop because they stack (`…-dir-v1.23b`): one
 * pass would leave the inner marker behind and split the family in two. The
 * sticky version is anchored to a leading digit (`-v1.23b`, `-v157.0`) so the
 * peel cannot eat a plain word that merely starts with `v` (`-validated`). The
 * content hash takes a `-` OR a `:` separator, because the msys2 key spells it
 * `files:<64 hex>`. The trailing dash is dropped last so a hashed key and its
 * legacy unhashed predecessor (`firefox-portable-macOS`, saved before the
 * composite keyed on the URL) land in the same family.
 *
 * @param {string} key a GitHub Actions cache key
 * @returns {string} the family stem
 */
export function stem(key) {
  let s = key;
  for (let i = 0; i < 4; i++) {
    const next = s
      .replace(/-dir$/, '')
      .replace(/-x$/, '')
      .replace(/-v\d[^-]*$/, '')
      .replace(/[:-][0-9a-f]{16,}$/i, '')
      .replace(/-\d+$/, '');
    if (next === s) break;
    s = next;
  }
  return s.replace(/-+$/, '');
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
      `(${(totalSize / 1e6).toFixed(1)} MB), keeping ${KEEP} per family, ` +
      `${byStem.size} families`
  );
  for (const [s, group] of [...byStem.entries()].sort(
    (a, b) =>
      b[1].reduce((n, c) => n + c.size_in_bytes, 0) - a[1].reduce((n, c) => n + c.size_in_bytes, 0)
  )) {
    const size = group.reduce((n, c) => n + c.size_in_bytes, 0);
    console.log(
      `  family ${s}  ${String(group.length).padStart(3)} entr${group.length === 1 ? 'y' : 'ies'}  ${(
        size / 1e6
      ).toFixed(1)} MB`
    );
  }
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

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(err => {
    console.error(`✗ Error: ${err.message}`);
    process.exit(1);
  });
}
