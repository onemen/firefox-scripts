#!/usr/bin/env node
// tools/publish/stageFlow.mjs — ONE local command for the release-staging
// handoff (operator request, 2026-09-27): after the release PRs merge, run
//
//   pnpm release:stage
//
// and end up with everything the WDSI/AV handoff needs in one folder — no run-id
// hunting in the Actions tab, no six-command PowerShell block:
//
//   1. resolve the release commit (origin/main's tip, or --ref) and refuse to
//      stage it when the local checkout disagrees with origin;
//   2. reuse the existing successful build-and-upload staging run for that
//      commit, or dispatch a new one (publish=false — never publishes);
//   3. `gh run watch` it to completion (an interrupt is safe — re-running the
//      command resumes at step 2 because the run now exists);
//   4. download the full staged-<os> artifact of THIS machine's OS into
//      dist/release-stage-<short-commit>/ (readable name; the run id lives in
//      SUMMARY.md inside the folder, not in the folder name);
//   5. write SUMMARY.md there — the single evidence artifact: commit, run id +
//      Actions URL, per-file sha256/size, the WDSI portal link, a paste block
//      for the filing, and Next steps (filing is a human step by design);
//   6. best-effort VirusTotal status of the two binaries — hash LOOKUP first
//      (seconds, no upload), upload only when VT has never seen the bytes
//      (that "never seen" fact is itself the do-I-need-a-fresh-WDSI-filing
//      signal). Never throws on VT trouble: the summary says so.
//
// Windows is the WDSI/AV-relevant OS (the Microsoft ML flag is a Windows
// binary); mac/linux users get the same folder scheme from their OS's artifact
// via --os. Nothing here touches gh-pages, the latest release or hashes.json.

import {spawnSync} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {gitEnv} from './generateBuildDates.mjs';
import {scanVirusTotal, lookupVirusTotalHashes, vtApiKey} from '../scan-vt.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPO = 'onemen/firefox-scripts';
const STAGE_WORKFLOW = 'build-and-upload.yml';
const WDSI_PORTAL_URL = 'https://www.microsoft.com/en-us/wdsi';
const WDSI_PRODUCT_URL = 'https://www.microsoft.com/en-us/wdsi/filesubmission';
// GitHub reports the workflow NAME ("Build and upload"), not the yml file name.
const STAGE_WORKFLOW_RE = /build[-_ ]?and[-_ ]?upload/i;

/**
 * Artifact name per platform (mirrors build-and-upload.yml's
 * staged-<platform>).
 */
const STAGED_ARTIFACT = {win32: 'staged-win', darwin: 'staged-mac', linux: 'staged-linux'};

/**
 * Normalize the --os value to the artifact name (exported for tests).
 *
 * @param {string} osName process.platform-style value (win32/darwin/linux)
 * @returns {string} the staged-<platform> artifact name
 */
export function artifactForOs(osName) {
  const a = STAGED_ARTIFACT[osName];
  if (!a) {
    throw new Error(`unsupported --os '${osName}' (expected win32|darwin|linux)`);
  }
  return a;
}

/** Installer file name per platform (the summary's subject binaries). */
const INSTALLER_FILE = /** @type {Record<string, string>} */ ({
  win32: 'installer_win.exe',
  darwin: 'installer_mac',
  linux: 'installer_linux',
});
/** Helper file name per platform. */
const HELPER_FILE = /** @type {Record<string, string>} */ ({
  win32: 'helper_win.exe',
  darwin: 'helper_mac',
  linux: 'helper_linux',
});

/**
 * Parse the stage-flow CLI argv (exported for the unit tests; main() exits, so
 * tests import this directly).
 *
 * @param {string[]} argv
 * @returns {{ref: string; os: string; keepOld: boolean}}
 */
export function parseStageArgs(argv) {
  /** @type {{ref: string; os: string; keepOld: boolean}} */
  const o = {ref: '', os: process.platform, keepOld: false};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ref' && argv[i + 1]) o.ref = argv[++i];
    else if (a.startsWith('--ref=')) o.ref = a.slice('--ref='.length);
    else if (a === '--os' && argv[i + 1]) o.os = argv[++i];
    else if (a.startsWith('--os=')) o.os = a.slice('--os='.length);
    else if (a === '--keep-old') o.keepOld = true;
    else throw new Error(`unknown argument: ${a} (see the header of tools/publish/stageFlow.mjs)`);
  }
  o.ref = String(o.ref || '').trim();
  o.os = String(o.os || process.platform);
  return o;
}

function gh(args, {capture = false} = {}) {
  const res = spawnSync('gh', args, {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024});
  if (res.error || res.status !== 0) {
    throw new Error(
      `gh ${args.join(' ')} failed — ${res.error?.message || (res.stderr || '').toString().trim()}`
    );
  }
  return capture ? res.stdout : undefined;
}

function git(args, {cwd = REPO_ROOT} = {}) {
  const res = spawnSync('git', args, {cwd, encoding: 'utf8', env: gitEnv()});
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed — ${(res.stderr || '').toString().trim()}`);
  }
  return (res.stdout || '').trim();
}

/**
 * The commit the release staging is FOR: the --ref value (SHA or branch name)
 * resolved to a full sha, default origin/main's tip after a fetch. Refuses when
 * the shared checkout is not on that same commit — the whole point of the local
 * folder is "the bytes built from the commit I have checked out".
 *
 * @param {string} ref the --ref value ('' = origin/main tip)
 * @returns {{sha: string; short: string; branch: string}}
 */
export function resolveReleaseCommit(ref) {
  git(['fetch', '--quiet']);
  const sha = git(['rev-parse', '--verify', `${ref || 'origin/main'}^{commit}`]);
  if (!ref) {
    // Default: the local checkout must BE origin/main's tip. A dirty or
    // switched checkout is fine — but a different commit is a mistake: the
    // summary's "Source" link and the operator's mental model would disagree.
    const head = git(['rev-parse', 'HEAD']);
    if (head !== sha) {
      throw new Error(
        `this checkout is at ${head.slice(0, 12)} but origin/main is at ${sha.slice(0, 12)} — ` +
          'pull main first (or pass --ref) so the local folder matches the staged bytes.'
      );
    }
  }
  const named = git(['name-rev', '--name-only', '--refs=refs/remotes/origin/*', sha]);
  // `name-rev` answers with the raw ref (remotes/origin/HEAD, remotes/origin/main);
  // strip to the plain branch name and skip symref aliases like origin/HEAD.
  const branch = named === 'undefined' ? '' : named.replace(/^remotes\/origin\//, '');
  return {sha, short: sha.slice(0, 7), branch: branch === 'HEAD' ? 'main' : branch};
}

/**
 * Newest successful build-and-upload run whose head commit is exactly `sha` —
 * '' when none exists (the caller dispatches one).
 *
 * @param {string} sha full commit sha
 * @returns {string} run id or ''
 */
export function findStagingRun(sha) {
  const raw = gh(
    [
      'run',
      'list',
      '-R',
      REPO,
      '--workflow',
      STAGE_WORKFLOW,
      '--status',
      'success',
      '--limit',
      '30',
      '--json',
      'databaseId,headSha,name',
    ],
    {capture: true}
  );
  const hit = JSON.parse(raw).find(
    r => STAGE_WORKFLOW_RE.test(String(r.name)) && String(r.headSha).toLowerCase() === sha
  );
  return hit ? String(hit.databaseId) : '';
}

/**
 * The run's id and status, freshly fetched (used both to verify a reused run
 * and to wait for a dispatched one). Status: queued|in_progress|completed.
 *
 * @param {string} run run id
 * @returns {{
 *   id: string;
 *   status: string;
 *   conclusion: string;
 *   headSha: string;
 *   url: string;
 * }}
 */
export function getRun(run) {
  const raw = gh(
    [
      'api',
      `repos/${REPO}/actions/runs/${run}`,
      '--jq',
      '{status: .status, conclusion: .conclusion, headSha: .head_sha}',
    ],
    {capture: true}
  );
  const info = JSON.parse(raw);
  return {
    id: String(run),
    status: String(info.status),
    conclusion: String(info.conclusion || ''),
    headSha: String(info.headSha || ''),
    url: `https://github.com/${REPO}/actions/runs/${run}`,
  };
}

/**
 * Best-effort VT status for the summary — hash lookup first, upload only when
 * VT has never seen the bytes. Returns null-shaped entries on VT trouble; the
 * caller renders them as an honest "unknown" row. Exported for tests.
 *
 * @param {{file: string; sha256: string; size: number}[]} files
 * @returns {Promise<
 *   {
 *     sha256: string;
 *     verdict: string;
 *     stats: Record<string, number>;
 *     flags: string[];
 *     note?: string;
 *   }[]
 * >}
 */
export async function vtStatus(files) {
  if (!vtApiKey()) {
    return files.map(f => ({
      sha256: f.sha256,
      verdict: 'unknown',
      stats: {},
      flags: [],
      note: 'VT_API_KEY not set — set it in .env for an automatic AV status',
    }));
  }
  const hashes = files.map(f => f.sha256);
  const known = await lookupVirusTotalHashes(hashes);
  const out = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const k = known[i];
    if (k && k.verdict !== 'unknown') {
      out.push({
        sha256: f.sha256,
        verdict: k.verdict,
        stats: k.stats,
        flags: k.flags || [],
        uploaded: false,
      });
      continue;
    }
    // VT has never seen the bytes (or the lookup was inconclusive): the only
    // way to a verdict is a real upload — which is also the filing signal.
    const scanned = await scanVirusTotal([f.file]);
    const r = scanned.results[0];
    if (!r || r.error) {
      out.push({
        sha256: f.sha256,
        verdict: 'unknown',
        stats: {},
        flags: [],
        note: r?.error || 'VirusTotal scan failed',
      });
      continue;
    }
    out.push({sha256: f.sha256, verdict: r.verdict, stats: r.stats, flags: r.flags || []});
  }
  return out;
}

/**
 * Render SUMMARY.md (pure — exported for the unit tests so the format is
 * pinned). `wdsi` carries the operator-filled filing facts when present
 * (existing summary re-read at start).
 *
 * @param {{
 *   commit: {sha: string; short: string; branch: string};
 *   run: {id: string; url: string; conclusion: string};
 *   osName: string;
 *   artifact: string;
 *   files: {rel: string; size: number; sha256: string}[];
 *   binaries: {installer: string; helper: string};
 *   vt: {
 *     sha256: string;
 *     verdict: string;
 *     stats: Record<string, number>;
 *     flags: string[];
 *     note?: string;
 *   }[];
 *   savedAt: string;
 *   wdsi?: {submissionId: string; filedAt: string; verdict: string};
 * }} p
 * @returns {string}
 */
export function renderSummary(p) {
  const eng = rel => {
    const f = p.files.find(x => x.rel === rel);
    const e = f && p.vt.find(v => v.sha256 === f.sha256);
    if (!e || e.verdict === 'unknown') {
      return `unknown — ${e?.note || 'no VT data'}`;
    }
    const total = Object.entries(e.stats || {}).reduce((n, [, c]) => n + Number(c || 0), 0);
    const who = e.flags.length ? ` · flagged by ${e.flags.join(', ')}` : '';
    const microsoft =
      e.flags.includes('Microsoft') ? 'flagged → WDSI filing required' : 'not flagged';
    return `${e.verdict.toUpperCase()} · ${e.stats?.malicious ?? 0}/${total} engines${who} · Microsoft: ${microsoft}`;
  };
  const fileRow = rel => {
    const f = p.files.find(x => x.rel === rel);
    if (!f) return '';
    return `| \`${rel}\` | ${f.size.toLocaleString('en-US')} | \`${f.sha256}\` |`;
  };
  const b = p.binaries;
  return `# Release staging — ${p.commit.short}

| | |
|---|---|
| Commit | \`${p.commit.sha}\` (\`${p.commit.short}\`${p.commit.branch ? `, ${p.commit.branch}` : ''}) |
| CI run | ${p.run.id} · \`${STAGE_WORKFLOW}\` (publish=false) · ${p.run.conclusion || 'running'} — ${p.run.url} |
| Built for | ${p.osName} · artifact \`${p.artifact}\` |
| Saved locally | ${p.savedAt} by \`pnpm release:stage\` |
| WDSI | portal: ${WDSI_PORTAL_URL} · product submission: ${WDSI_PRODUCT_URL} |

## Binaries — the WDSI-relevant files

| File | Size | SHA-256 |
|---|---|---|
${[b.installer, b.helper].map(fileRow).filter(Boolean).join('\n')}

**AV status (VirusTotal, queried locally):**

- \`${b.installer}\`: ${eng(b.installer)}
- \`${b.helper}\`: ${eng(b.helper)}

Local engine double-check: \`pnpm scan:av ${b.installer} ${b.helper}\`

## Packages (context only — never filed)

| File | Size | SHA-256 |
|---|---|---|
${[
  p.files.find(f => f.rel.endsWith('utils.zip'))?.rel,
  p.files.find(f => f.rel.endsWith('updater-ui.zip'))?.rel,
]
  .filter(Boolean)
  .map(fileRow)
  .filter(Boolean)
  .join('\n')}

## WDSI paste block

    File:     ${path.posix.basename(b.installer)}
    SHA-256:  ${p.files.find(f => f.rel === b.installer)?.sha256}
    Size:     ${p.files.find(f => f.rel === b.installer)?.size.toLocaleString('en-US')} bytes
    Build:    ${REPO} @ ${p.commit.short} — CI run ${p.run.id} (publish=false)
    Source:   https://github.com/${REPO}/tree/${p.commit.sha}

## WDSI submission

${p.wdsi?.submissionId ? `- Submission id: \`${p.wdsi.submissionId}\` (filed ${p.wdsi.filedAt}) — verdict: ${p.wdsi.verdict}` : '- not filed yet — see Next steps'}

## Next steps

1. File the WDSI submission (${WDSI_PRODUCT_URL}) with the paste block above — the operator does this manually, by design.
2. Paste the submission id + verdict into this file (the \`## WDSI submission\` section) so the folder stays the single evidence artifact.
3. Run the installer test against a disposable profile; watch the install path end-to-end.
4. After the real publish, confirm Microsoft clears the exact hash above before calling the release done.
`;
}

/**
 * Read the operator-maintained WDSI facts back from an existing SUMMARY.md
 * (re-staging refreshes everything else but must not lose the filing record).
 *
 * @param {string} file path to an existing SUMMARY.md
 * @returns {{submissionId: string; filedAt: string; verdict: string} | undefined}
 */
export function readWdsiFacts(file) {
  try {
    const t = fs.readFileSync(file, 'utf-8');
    const m = /- Submission id: `([^`]+)` \(filed ([^)]+)\) — verdict: (.+)/.exec(t);
    if (!m) return undefined;
    return {submissionId: m[1], filedAt: m[2], verdict: m[3].trim()};
  } catch {
    return undefined;
  }
}

/**
 * The whole pipeline. Exported for the unit tests; main() wraps it with exit
 * codes. Throws on every gate failure; VT trouble never throws.
 *
 * @param {{ref?: string; os?: string}} [argvOpts]
 * @returns {Promise<{
 *   dir: string;
 *   summary: string;
 *   run: {id: string; url: string};
 *   reused: boolean;
 *   short: string;
 * }>}
 */
export async function runStageFlow(argvOpts = {}) {
  const ref = String(argvOpts.ref || '').trim();
  const osName = argvOpts.os || process.platform;
  const artifact = artifactForOs(osName);

  // 1. The release commit.
  const commit = resolveReleaseCommit(ref);
  const dir = path.join(REPO_ROOT, 'dist', `release-stage-${commit.short}`);
  console.log(`release commit: ${commit.short}${commit.branch ? ` (${commit.branch})` : ''}`);
  console.log(`folder: dist/release-stage-${commit.short}/`);

  // 2. Reuse-or-dispatch.
  let run = findStagingRun(commit.sha);
  const reused = Boolean(run);
  if (run) {
    console.log(`existing staging run for ${commit.short}: ${run} — reusing (nothing dispatched)`);
  } else {
    console.log(
      'no successful staging run for this commit yet — dispatching build-and-upload.yml (publish=false)…'
    );
    const mode = 'prod';
    const ghArgs = [
      'workflow',
      'run',
      STAGE_WORKFLOW,
      '-R',
      REPO,
      '-f',
      `mode=${mode}`,
      '-f',
      'publish=false',
      '-f',
      'include=all',
    ];
    gh(ghArgs);
    console.log('dispatched — finding the run…');
    // The dispatch API is async; poll until the run exists (a few seconds).
    run = '';
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 2000));
      run = findStagingRun(commit.sha);
      if (run) break;
    }
    if (!run) {
      throw new Error(
        'dispatched but no run appeared within 60s — check the Actions tab and re-run this command'
      );
    }
  }

  // 3. Wait for completion (a reused completed run falls through instantly).
  let info = getRun(run);
  if (info.status !== 'completed') {
    console.log(`waiting for ${info.url} …`);
    spawnSync('gh', ['run', 'watch', run, '-R', REPO, '--exit-status'], {stdio: 'inherit'});
    info = getRun(run);
  }
  if (info.conclusion !== 'success') {
    throw new Error(
      `run ${run} finished with '${info.conclusion || info.status}' — fix CI first, then re-run this command`
    );
  }
  // The bytes must come from the release commit — a --ref SHA that resolved to
  // a containing branch whose TIP moved would otherwise stage different bytes.
  if (info.headSha.toLowerCase() !== commit.sha) {
    throw new Error(
      `run ${run} built ${info.headSha.slice(0, 12)}, not the release commit ${commit.short} — ` +
        'dispatch a fresh staging run for the exact commit (re-run this command).'
    );
  }

  // 4. Download the full artifact into the commit-named folder.
  const dst = path.join(dir, 'artifact');
  fs.rmSync(dst, {recursive: true, force: true});
  fs.mkdirSync(dst, {recursive: true});
  gh(['run', 'download', run, '-R', REPO, '-n', artifact, '-D', dst]);
  console.log(`downloaded ${artifact} → dist/release-stage-${commit.short}/artifact/`);

  // 5. Hash everything, write SUMMARY.md.
  const walk = d =>
    fs
      .readdirSync(d, {withFileTypes: true})
      .flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const files = walk(dst)
    .map(p => {
      const data = fs.readFileSync(p);
      return {
        rel: path.relative(dst, p).split(path.sep).join('/'),
        size: data.length,
        sha256: crypto.createHash('sha256').update(data).digest('hex'),
      };
    })
    .sort((a, b2) => a.rel.localeCompare(b2.rel));
  const installer = files.find(f => path.posix.basename(f.rel) === INSTALLER_FILE[osName]);
  const helper = files.find(f => path.posix.basename(f.rel) === HELPER_FILE[osName]);
  if (!installer || !helper) {
    throw new Error(
      `the artifact lacks ${INSTALLER_FILE[osName]} or ${HELPER_FILE[osName]} — is ${run} really a publish=false staging run?`
    );
  }

  const binaries = {installer: installer.rel, helper: helper.rel};
  console.log('VirusTotal status (hash lookup first, upload only for unseen bytes)…');
  const vt = await vtStatus(
    [installer, helper].map(f => ({
      file: path.join(dst, f.rel.split('/').join(path.sep)),
      sha256: f.sha256,
      size: f.size,
    }))
  );
  const summary = renderSummary({
    commit,
    run: {id: run, url: info.url, conclusion: 'success'},
    osName,
    artifact,
    files,
    binaries,
    vt,
    savedAt: new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
    wdsi: readWdsiFacts(path.join(dir, 'SUMMARY.md')),
  });
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, 'SUMMARY.md'), summary);

  // 6. The 3-line console tail — a pointer, not a data dump (the summary is
  //    the single source of truth; the console only says where and what next).
  console.log(`✓ staged → dist/release-stage-${commit.short}/   (run ${run}, success)`);
  console.log('  everything (hashes, VT/Microsoft status, WDSI block): SUMMARY.md in that folder');
  console.log('  next: file WDSI, then paste the submission id into SUMMARY.md');
  return {dir, summary, run: {id: run, url: info.url}, reused, short: commit.short};
}

export function main(argv = process.argv.slice(2)) {
  const opts = parseStageArgs(argv);
  runStageFlow({ref: opts.ref, os: opts.os})
    .then(() => {})
    .catch(e => {
      console.error(`✗ release:stage — ${e.message}`);
      process.exitCode = 1;
    });
}

// Direct invocation only.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
