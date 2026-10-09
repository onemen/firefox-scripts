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
// The other chronic grower WAS pnpm/setup's `cache: true`: it keys the pnpm
// store `<prefix>-<lockfile hashes>-<run_id>-1-<uuid>` — a UNIQUE key per run,
// so GitHub's per-key version cap never fires there either and every job on
// every OS mints a fresh ~65 MB entry with byte-identical content. Measure
// 2026-10-08: 81 entries / 5.26 GB, all the same lockfile state; 2026-10-09:
// 65 entries / 4.18 GB, the bulk of the 10.79 GB that put the repo back over
// the cap — the cap-sitting that let the LRU eviction take the URL watchdog's
// state caches (#462). setup-repo now caches the store itself, on a stable
// lockfile+platform key (pinned by test/unit/tools/pnpmStoreCache.test.mjs), so
// the per-run shape is no longer minted; stem() still peels the legacy tail,
// because entries carrying it live until they expire and a revert would mint
// them again. The peel collapses them into one family per OS/arch that keeps a
// single newest entry.
//
// The keep count is NOT uniform: the release-keyed browser families (see
// keepFor()) keep ONE entry per layout, because a vendor bump mints a brand-new
// key and the superseded one can never be restored again — keeping three of
// them is three downloads no leg will ever ask for. Measure 2026-10-08: 130
// entries / 9.94 GB against the 10 GB cap, 2.44 GB of it superseded browser
// entries; sitting at the cap is what makes GitHub start evicting.
//
// Usage:
//   node tools/ci/prune-caches.mjs [--keep 3] [--dry-run]
//                                  [--prefix <regex>]...
//
//   --keep <n>    versions to keep per family for everything EXCEPT the
//                 release-keyed browser families, which always keep 1 per
//                 layout (default 3)
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
 * snap-firefox-8995 → snap-firefox browser-fork-validated-37359307092 →
 * browser-fork-validated
 * pnpm-cache-Linux-x64-<h>-<h>-<h>-37739280981-1-1f11f359-398b-…-5381 →
 * pnpm-cache-Linux-x64
 *
 * The watchdog's own two state families (`url-watchdog-baseline-*`,
 * `browser-validated-*`) are no longer produced: both files moved to the
 * durable `watchdog-state` branch (ADR 0046, #462). Any stragglers still
 * sitting in the cache are peeled by the same generic rules below and retired
 * by --keep.
 *
 * The suffixes are peeled in a loop because they stack (`…-dir-v1.23b`, and the
 * pnpm tail stacks a run id, a `-1` and a uuid under the hash combo): one pass
 * would leave the inner marker behind and split the family in two. The sticky
 * version is anchored to a leading digit (`-v1.23b`, `-v157.0`) so the peel
 * cannot eat a plain word that merely starts with `v` (`-validated`). The
 * content hash takes a `-` OR a `:` separator, because the msys2 key spells it
 * `files:<64 hex>`. The trailing dash is dropped last so a hashed key and its
 * legacy unhashed predecessor (`firefox-portable-macOS`, saved before the
 * composite keyed on the URL) land in the same family. The pnpm store family is
 * lowercased: pnpm/setup spelled the platform `Linux-x64`, the composite keys
 * it on `runner.arch` (`Linux-X64`), and two families that differ only in case
 * keep an entry each — so the legacy per-run entries would survive their own
 * successor forever.
 *
 * @param {string} key a GitHub Actions cache key
 * @returns {string} the family stem
 */
export function stem(key) {
  let s = key;
  // The hash-combo peel needs up to 5 passes (run tail → run id → 3 hashes);
  // 8 is headroom without being unbounded.
  for (let i = 0; i < 8; i++) {
    const next = s
      // pnpm/setup's per-run suffix: `-<run_id>-1-<uuid v4>`.
      .replace(/-\d+-1-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, '')
      .replace(/-dir$/, '')
      .replace(/-x$/, '')
      .replace(/-v\d[^-]*$/, '')
      .replace(/[:-][0-9a-f]{16,}$/i, '')
      .replace(/-\d+$/, '');
    if (next === s) break;
    s = next;
  }
  // The pnpm store family is case-folded so the legacy `Linux-x64` shape and the
  // composite's `Linux-X64` land in ONE family, where keep-one retires the
  // superseded entry. Nothing else is folded: a cache key's case is otherwise
  // part of its identity.
  if (/^pnpm-cache(?:-|$)/i.test(s)) s = s.toLowerCase();
  return s.replace(/-+$/, '');
}

// ── The current key scheme (ADR 0045) ─────────────────────────────────────
//
// `<name>-<type>-<os>-<hash>-<layout>`: one browser per name, so the release is
// the only varying half and a group is the key minus it. One entry per group is
// the whole useful set, and a vendor bump retires its predecessor — the parser
// below is what makes that automatic for the new keys, exactly as the legacy
// peel does for the old shapes.

/** The os tokens a key carries: the lowercased runner OS, plus `snap`. */
const KEY_OS = new Set(['windows', 'linux', 'macos', 'snap']);
/** The payload kinds: the downloaded installer, or the tree extracted from it. */
const KEY_TYPE = new Set(['dl', 'portable']);
/**
 * The layout of that payload: an installer (`plain`), or an extracted tree
 * (`dir`).
 */
const KEY_LAYOUT = new Set(['plain', 'dir']);
/**
 * The release half: a URL hash (16 hex), a sticky `v<version>`, or a snap
 * revision.
 */
const KEY_HASH_RE = /^(?:[0-9a-f]{16}|v[^-]+|\d+)$/;

/**
 * Split a cache key of the current scheme (ADR 0045), or null when the key is
 * not one — a legacy shape, or a cache this repo does not name this way (pnpm,
 * msys2, the watchdog's own records).
 *
 * Parsed right-to-left: `layout`, `os`, `type` come from closed sets, so the
 * remainder is the name even when it contains dashes (`firefox-dev`,
 * `esr-prev`).
 *
 * @param {string} key a GitHub Actions cache key
 * @returns {{
 *   name: string;
 *   type: string;
 *   os: string;
 *   hash: string;
 *   layout: string;
 * } | null}
 */
export function parseKey(key) {
  const parts = key.split('-');
  if (parts.length < 5) return null;
  const [layout, hash, os, type] = parts.slice(-4).reverse();
  if (!KEY_LAYOUT.has(layout) || !KEY_OS.has(os) || !KEY_TYPE.has(type)) return null;
  if (!KEY_HASH_RE.test(hash)) return null;
  const name = parts.slice(0, -4).join('-');
  return name ? {name, type, os, hash, layout} : null;
}

/**
 * The release-independent half of a group id, or null when the id is not a
 * group of the current scheme. Split out so keepFor() can price a group it did
 * not build — including the ids planDeletes() received from a caller.
 *
 * @param {string} group a group id from {@link groupOf}
 * @returns {{name: string; type: string; os: string; layout: string} | null}
 */
function parseGroup(group) {
  const parts = group.split('-');
  if (parts.length < 4) return null;
  const [layout, os, type] = parts.slice(-3).reverse();
  if (!KEY_LAYOUT.has(layout) || !KEY_OS.has(os) || !KEY_TYPE.has(type)) return null;
  const name = parts.slice(0, -3).join('-');
  return name ? {name, type, os, layout} : null;
}

/**
 * Families where superseded entries are worthless, so exactly one survives:
 *
 * - The release-keyed browser families: a bump mints a brand-new key (a new
 *   download URL hash, a new `-v<version>`, a new snap revision) and the
 *   superseded entry can never be restored again — GitHub's per-key version cap
 *   never fires on it either. One entry per layout is the whole useful set.
 * - `pnpm-cache-*`: the content is fully determined by the key's lockfile hashes,
 *   so entries sharing a peeled stem are byte-identical duplicates — only the
 *   newest is ever restored. Old lockfile states only served restore-keys
 *   warm-fill; a cold store after a bump costs one ~1 min re-download, not 5.26
 *   GB of eviction pressure.
 */
const KEEP_ONE =
  /^(firefox-dl|firefox-portable|browser-dl|esr-portable|snap-firefox|pnpm-cache)(?:-|$)/;

/** The ref whose copies every branch can restore (caches are ref-scoped). */
const MAIN = 'refs/heads/main';

/**
 * The layout half of a release-keyed group. A portable leg saves TWO entries
 * under one family — the installer and its extracted dir — and a single leg
 * restores BOTH (observed seconds apart in one run), so they must never compete
 * for the same keep slot: keep "1" there would delete the half the leg is about
 * to ask for.
 *
 * One marker per payload, not one per key spelling: the extracted dir is
 * written as `…-x` by the URL-keyed legs and as `…-dir` by the sticky fork
 * namespace, and both are the same payload. Spelling them apart would let a
 * family that ever carried both keep one entry each — the superseded spelling
 * would then survive its successor forever, exactly like the legacy pnpm shape
 * (see stem()).
 *
 * @param {string} key a GitHub Actions cache key
 * @returns {'plain' | 'dir'} which copy of the release this key is
 */
export function layout(key) {
  if (key.endsWith('-x') || /-dir(-|$)/.test(key)) return 'dir';
  return 'plain';
}

/**
 * The group a key's keep-slot is counted in. For a current-scheme key
 * (`<name>-<type>-<os>-<hash>-<layout>`) that is the key minus its release —
 * one group per browser payload, which is what makes a vendor bump retire its
 * predecessor. For a legacy key it stays the family + layout rule: the hashed
 * and unhashed predecessors of the same payload must land together, and the
 * installer must not compete with its own extracted dir.
 *
 * @param {string} key a GitHub Actions cache key
 * @returns {string} the group id
 */
export function groupOf(key) {
  const parsed = parseKey(key);
  if (parsed) return `${parsed.name}-${parsed.type}-${parsed.os}-${parsed.layout}`;
  const family = stem(key);
  return KEEP_ONE.test(family) ? `${family} :: ${layout(key)}` : family;
}

/**
 * Versions to keep for a group: one for the keep-one families (browser releases
 *
 * - pnpm store duplicates), the caller's `keep` for everything else — toolchain
 *   caches rotate on the lockfile/config hash and the watchdog/validated
 *   records are sub-kilobyte history the publish pre-flight reads (an evicted
 *   copy is indistinguishable from "never validated", so those keep whatever
 *   the operator asks for).
 *
 * @param {string} group a group id from {@link groupOf}
 * @param {number} keep the default count for non-release-keyed groups
 * @returns {number} how many entries of this group survive
 */
export function keepFor(group, keep) {
  // A current-scheme group is one browser payload: its entries differ only in
  // the release, and only the newest can ever be restored.
  if (parseGroup(group)) return 1;
  return KEEP_ONE.test(group.split(' :: ')[0]) ? 1 : keep;
}

/**
 * Which caches to delete. Inside a group: a `main`-branch copy outranks a
 * same-key copy saved on a PR branch (caches are ref-scoped — the main copy is
 * the only one every branch can restore, so dropping it to keep a PR-scoped
 * twin would cold-start every other branch), then newest first.
 *
 * @param {{key: string; created_at: string; ref?: string}[]} caches
 * @param {number} keep default count for the non-release-keyed groups
 * @returns {{
 *   key: string;
 *   created_at: string;
 *   ref?: string;
 *   size_in_bytes?: number;
 *   id?: number;
 * }[]}
 *   the same objects, selected for deletion
 */
export function planDeletes(caches, keep) {
  const byGroup = new Map();
  for (const c of caches) {
    const g = groupOf(c.key);
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(c);
  }
  const toDelete = [];
  for (const [g, group] of byGroup) {
    group.sort(
      (a, b) =>
        (b.ref === MAIN ? 1 : 0) - (a.ref === MAIN ? 1 : 0) ||
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );
    toDelete.push(...group.slice(keepFor(g, keep)));
  }
  return toDelete;
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

  const byGroup = new Map();
  for (const c of inScope) {
    const g = groupOf(c.key);
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(c);
  }

  const toDelete = planDeletes(inScope, KEEP);

  const totalSize = inScope.reduce((n, c) => n + c.size_in_bytes, 0);
  console.log(
    `repo ${repo}: ${caches.length} caches, ${inScope.length} in scope ` +
      `(${(totalSize / 1e6).toFixed(1)} MB), keeping ${KEEP} per family ` +
      `(1 per browser payload + keep-one family/layout: releases + pnpm store), ` +
      `${byGroup.size} groups`
  );
  for (const [s, group] of [...byGroup.entries()].sort(
    (a, b) =>
      b[1].reduce((n, c) => n + c.size_in_bytes, 0) - a[1].reduce((n, c) => n + c.size_in_bytes, 0)
  )) {
    const size = group.reduce((n, c) => n + c.size_in_bytes, 0);
    console.log(
      `  group ${s}  keeps ${String(keepFor(s, KEEP)).padStart(2)}  ` +
        `${String(group.length).padStart(3)} entr${group.length === 1 ? 'y' : 'ies'}  ${(
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
      // 404 = another prune (nightly tick, post-gate job, publish pre-flight)
      // deleted the same superseded entry first — that IS success.
      if (!res.ok && res.status !== 404)
        throw new Error(`delete ${c.key} failed: ${res.status} ${await res.text()}`);
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
