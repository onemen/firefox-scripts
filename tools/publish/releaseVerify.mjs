#!/usr/bin/env node
// tools/publish/releaseVerify.mjs — re-derive the post-publish facts from GitHub.
//
// `pnpm release:verify` is step 7 of the release workflow: the runbook
// checklist can go stale, these checks cannot — every line is re-fetched from
// GitHub at run time.
// Each check prints PASS/FAIL; the script exits 1 when anything failed.
//
// Checks:
//   1. `latest` release carries the full asset set (2 zips + 4 installers;
//      extra assets are tolerated — e.g. the installer .sha256 sidecars — only
//      a MISSING expected asset fails)
//   2. gh-pages serves the machine surface: hashes.json, helper_win.exe, index.html
//   3. the `latest` tag points at main HEAD (or --sha <commit>)
//   4. an installer-<date> component release exists
//   5. published-binary AV verdicts are clean (delegates to
//      tools/check-published-av.mjs; VT_API_KEY-aware, best-effort there)
//
// Usage: pnpm release:verify [-- --sha <commit>]
//
// jq note: `gh --jq` runs gojq, whose regex dialect rejects `\d` (invalid
// escape sequence) — character classes like [0-9] must be used instead (#359,
// verified against gh's embedded gojq on 2026-09-28).

import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

const REPO = 'onemen/firefox-scripts';

/** The asset set every prod publish must leave on `latest` (ADR 0024 names). */
export const EXPECTED_RELEASE_ASSETS = [
  'utils.zip',
  'fx-folder.zip',
  'installer_win.exe',
  'installer_linux',
  'installer_linux_aarch64',
  'installer_mac',
];

/**
 * gh's embedded jq is gojq, whose regex dialect rejects `\d` — character
 * classes are the portable spelling (#359: the `\d` filter crashed the
 * component-release count with "invalid escape sequence"). Exported so the unit
 * tests can pin both the dialect and the match shape.
 */
export const INSTALLER_TAG_JQ_FILTER =
  '[.[] | select(.tag_name | test("^installer-[0-9]{4}-[0-9]{2}-[0-9]{2}$"))] | length';

/**
 * Pure: the exact argv for the published-binary AV check. check-published-av
 * requires --repo and --ref (a bare spawn prints usage and exits non-zero,
 * which read as an AV failure — #359); the ref is the one the gh-pages checks
 * verify.
 *
 * @param {string} repo
 * @param {string} [ref]
 * @returns {string[]}
 */
export function avCheckArgs(repo, ref = 'gh-pages') {
  return [
    '--env-file-if-exists=.env',
    'tools/check-published-av.mjs',
    '--repo',
    repo,
    '--ref',
    ref,
  ];
}

/**
 * Pure: a git blob SHA as the contents API's `.sha` returns it — 40 lowercase
 * hex. Used to VALIDATE the gh-pages file checks instead of JSON.parsing the
 * `--jq` output: gh prints a bare unquoted string there, which JSON.parse can
 * never accept (#359 — that was the real "fails in-script, works standalone"
 * bug; numbers parsed, strings never did).
 *
 * @param {string} s
 * @returns {boolean}
 */
export function isBlobSha(s) {
  return /^[0-9a-f]{40}$/.test(String(s).trim());
}

/**
 * Pure: diff the release's asset names against the expected set. Extra assets
 * are allowed (sidecars land with #325); missing ones are the failure.
 *
 * @param {string[]} actual
 * @returns {{missing: string[]}}
 */
export function evaluateAssets(actual) {
  const have = new Set(actual);
  return {missing: EXPECTED_RELEASE_ASSETS.filter(name => !have.has(name))};
}

/**
 * Pure: resolve a /git/ref/tags/<tag> response body to the commit it points at.
 * A lightweight tag points at the commit directly; an annotated tag wraps it.
 *
 * @param {{object: {type: string; sha: string} | null}} refBody
 * @returns {string | null}
 */
export function resolveTagCommit(refBody) {
  const obj = refBody?.object;
  if (!obj) return null;
  return obj.type === 'tag' ? `annotated:${obj.sha}` : obj.sha;
}

function fail(message) {
  console.error(`\u2717 release:verify: ${message}`);
  process.exit(1);
}

function gh(args) {
  const res = spawnSync('gh', args, {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024});
  if (res.error || res.status !== 0) {
    // Throw, don't exit: the per-check try/catch blocks turn this into a
    // per-check FAIL line so one broken check never hides the others.
    throw new Error(
      `gh ${args.join(' ')} failed — ${res.error?.message || (res.stderr || '').trim()}`
    );
  }
  return res.stdout;
}

function ghJson(args) {
  return JSON.parse(gh(args));
}

/**
 * Print one check line; returns the boolean so callers can fold it into allOk.
 *
 * @param {string} name
 * @param {boolean} ok
 * @param {string} [detail]
 * @returns {boolean}
 */
function report(name, ok, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

export function main(argv = process.argv.slice(2)) {
  let sha = '';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--sha' && argv[i + 1]) sha = argv[++i];
    else fail(`unknown argument: ${argv[i]}`);
  }

  let allOk = true;
  /** Fold one check's boolean into the result. */
  const check = (name, ok, detail) => {
    allOk = report(name, ok, detail) && allOk;
  };

  // 1. latest release asset set.
  try {
    const release = ghJson(['api', `repos/${REPO}/releases/tags/latest`]);
    const assets = (release.assets ?? []).map(a => a.name);
    const {missing} = evaluateAssets(assets);
    check(
      'latest release asset set',
      missing.length === 0,
      missing.length === 0 ? `${assets.length} assets` : `missing: ${missing.join(', ')}`
    );
  } catch {
    check('latest release asset set', false, 'no `latest` release');
  }

  // 2. gh-pages machine surface. NOTE: no JSON.parse here — `--jq '.sha'`
  // emits a bare unquoted string and ghJson would throw on it (#359 root
  // cause). The output is validated as a blob SHA instead, and a gh failure
  // names its cause instead of a bare FAIL.
  for (const file of ['hashes.json', 'helper_win.exe', 'index.html']) {
    let ok;
    let detail = '';
    try {
      const out = gh(['api', `repos/${REPO}/contents/${file}?ref=gh-pages`, '--jq', '.sha']);
      ok = isBlobSha(out);
      if (!ok) detail = `unexpected .sha output: ${out.trim().slice(0, 60)}`;
    } catch (e) {
      ok = false;
      detail = String(e.message)
        .replace(/^gh api failed — /, '')
        .slice(0, 160);
    }
    check(`gh-pages: ${file}`, ok, ok ? undefined : detail);
  }

  // 3. latest tag → main HEAD (or --sha).
  try {
    const refBody = ghJson(['api', `repos/${REPO}/git/ref/tags/latest`]);
    const tagSha = resolveTagCommit(refBody);
    let expected = sha;
    if (!expected) {
      expected = ghJson(['api', `repos/${REPO}/commits/main`]).sha;
    }
    // Annotated tags need one dereference round-trip; do it only when needed.
    let actual = tagSha;
    if (actual?.startsWith('annotated:')) {
      actual = ghJson(['api', `repos/${REPO}/git/tags/${actual.slice('annotated:'.length)}`]).object
        .sha;
    }
    check(
      '`latest` tag points at the released commit',
      actual === expected,
      `${actual} vs ${expected}`
    );
  } catch (e) {
    check('`latest` tag points at the released commit', false, String(e.message));
  }

  // 4. an installer-<date> component release exists ([0-9] classes — gh's
  // gojq rejects \d, #359).
  try {
    const count = ghJson([
      'api',
      `repos/${REPO}/releases?per_page=100`,
      '--jq',
      INSTALLER_TAG_JQ_FILTER,
    ]);
    check('installer-<date> component release', count > 0, `${count} found`);
  } catch (e) {
    check('installer-<date> component release', false, String(e.message));
  }

  // 5. published-binary AV verdicts (the existing lookup-only tool), spawned
  // with its required arguments (avCheckArgs — #359).
  const av = spawnSync(process.execPath, avCheckArgs(REPO), {encoding: 'utf8'});
  const avOk = av.status === 0;
  if (!avOk && av.stderr) console.error(av.stderr.trim());
  check(
    'published-binary AV verdicts',
    avOk,
    avOk ? 'check-published-av clean' : 'see output above'
  );

  console.log(allOk ? '\nrelease:verify: all checks green' : '\nrelease:verify: FAILURES above');
  process.exitCode = allOk ? 0 : 1;
}

// Direct invocation only (imported by the unit tests for the pure helpers).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
