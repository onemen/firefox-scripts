#!/usr/bin/env node
// tools/publish/releaseVerify.mjs — re-derive the post-publish facts from GitHub.
//
// `pnpm release:verify` is step 7 of the release workflow (see
// docs/release-workflow.plan.local.md): the runbook checklist can go stale,
// these checks cannot — every line is re-fetched from GitHub at run time.
// Each check prints PASS/FAIL; the script exits 1 when anything failed.
//
// Checks:
//   1. `latest` release carries the full asset set (2 zips + 4 installers;
//      extra assets are tolerated — e.g. the installer .sha256 sidecars once
//      #325 lands — only a MISSING expected asset fails)
//   2. gh-pages serves the machine surface: hashes.json, helper_win.exe, index.html
//   3. the `latest` tag points at main HEAD (or --sha <commit>)
//   4. an installer-<date> component release exists
//   5. published-binary AV verdicts are clean (delegates to
//      tools/check-published-av.mjs; VT_API_KEY-aware, best-effort there)
//
// Usage: pnpm release:verify [-- --sha <commit>]

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

  // 2. gh-pages machine surface.
  for (const file of ['hashes.json', 'helper_win.exe', 'index.html']) {
    let ok;
    try {
      ghJson(['api', `repos/${REPO}/contents/${file}?ref=gh-pages`, '--jq', '.sha']);
      ok = true;
    } catch {
      ok = false;
    }
    check(`gh-pages: ${file}`, ok);
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

  // 4. an installer-<date> component release exists.
  try {
    const count = ghJson([
      'api',
      `repos/${REPO}/releases?per_page=100`,
      '--jq',
      '[.[] | select(.tag_name | test("^installer-\\d{4}-\\d{2}-\\d{2}$"))] | length',
    ]);
    check('installer-<date> component release', count > 0, `${count} found`);
  } catch (e) {
    check('installer-<date> component release', false, String(e.message));
  }

  // 5. published-binary AV verdicts (the existing lookup-only tool).
  const av = spawnSync(
    process.execPath,
    ['--env-file-if-exists=.env', 'tools/check-published-av.mjs'],
    {encoding: 'utf8'}
  );
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
