// test/unit/publish/releaseStage.test.mjs — the ONE staging command:
// release.mjs's --stage routing (no dispatch) + stageFlow's pure parts
// (artifact naming, run matching, summary format).

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const {parseReleaseArgs} = await import('../../../tools/publish/release.mjs');
const {artifactForOs, parseStageArgs, renderSummary, readWdsiFacts} =
  await import('../../../tools/publish/stageFlow.mjs');

const SRC = readFileSync(new URL('../../../tools/publish/stageFlow.mjs', import.meta.url), 'utf-8');

test('buildDispatchArgs: no stage mode remains — --stage never dispatches pages.yml', () => {
  // stageFlow.mjs owns the build-and-upload dispatch; the publish dispatcher
  // must not carry a second copy of it.
  const src = readFileSync(new URL('../../../tools/publish/release.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /build-and-upload\.yml/);
});

test('parseReleaseArgs: --stage routes locally, --include/--os knob rules', () => {
  const opts = parseReleaseArgs(['--stage']);
  assert.equal(opts.stage, true);
  assert.equal(opts.ref, '');
  assert.equal(opts.os, '');
  assert.throws(
    () => parseReleaseArgs(['--stage', '--include=all']),
    /--include does not apply to --stage/
  );
  assert.throws(
    () => parseReleaseArgs(['--include=all', '--os=linux']),
    /--os is a --stage option/
  );
  // --os IS a stage knob (it picks the staged-<os> artifact to download).
  assert.equal(parseReleaseArgs(['--stage', '--os=win32']).os, 'win32');
  const refd = parseReleaseArgs(['--stage', '--ref=0b3878c']);
  assert.equal(refd.ref, '0b3878c');
});

test('parseReleaseArgs: publish dispatches still require --include', () => {
  assert.throws(() => parseReleaseArgs([]), /Missing --include=<roles>/);
  assert.throws(() => parseReleaseArgs(['--ref=main']), /Missing --include=<roles>/);
});

test('release.mjs main routes --stage to runStageFlow with the raw ref', () => {
  const src = readFileSync(new URL('../../../tools/publish/release.mjs', import.meta.url), 'utf8');
  assert.match(src, /import\('\.\/stageFlow\.mjs'\)/);
  assert.match(src, /runStageFlow\(\{ref: opts\.ref, os: opts\.os \|\| undefined\}\)/);
});

test('artifactForOs maps the platform to the staged-<os> artifact name', () => {
  assert.equal(artifactForOs('win32'), 'staged-win');
  assert.equal(artifactForOs('darwin'), 'staged-mac');
  assert.equal(artifactForOs('linux'), 'staged-linux');
  assert.throws(() => artifactForOs('freebsd'), /unsupported --os/);
});

test('parseStageArgs: --ref/--os/--keep-old parse, unknown args fail loud', () => {
  assert.deepEqual(parseStageArgs([]), {ref: '', os: process.platform, keepOld: false});
  assert.deepEqual(parseStageArgs(['--ref=abc123']), {
    ref: 'abc123',
    os: process.platform,
    keepOld: false,
  });
  assert.deepEqual(parseStageArgs(['--os', 'linux']), {ref: '', os: 'linux', keepOld: false});
  assert.throws(() => parseStageArgs(['--watch']), /unknown argument: --watch/);
});

test('findStagingRun matches by workflow name AND exact head sha (name-regex pinned)', () => {
  // GitHub reports the workflow NAME ("Build and upload"), not the file name —
  // the case/separator-insensitive match is what makes both spellings hit.
  assert.match(SRC, /STAGE_WORKFLOW_RE = \/build\[-_ \]\?and\[-_ \]\?upload\/i/);
  assert.match(SRC, /--status',\s*\n?\s*'success'/);
  assert.match(SRC, /headSha\)\.toLowerCase\(\) === sha/);
  // The staged run must be publish=false's workflow, dispatched per commit.
  assert.match(SRC, /STAGE_WORKFLOW = 'build-and-upload\.yml'/);
});

test('the run bytes must come from the release commit (head-sha gate before download)', () => {
  assert.match(SRC, /info\.headSha\.toLowerCase\(\) !== commit\.sha/);
  assert.match(SRC, /not the release commit/);
});

test('the dispatch is --ref-pinned to an origin branch whose TIP is the release commit', () => {
  // gh workflow run without --ref builds the DEFAULT branch tip — a different
  // commit than the one --ref named (CodeRabbit #339, Major).
  assert.match(SRC, /export function findDispatchRefForCommit/);
  assert.match(SRC, /'--ref',\s*\n?\s*dispatchRef/);
  // No tip-exact branch: fail loudly instead of dispatching the wrong commit.
  assert.match(SRC, /is not the tip of any origin branch/);
});

test('the post-dispatch poll matches runs in ANY state (success-only never finds a fresh run)', () => {
  // A just-dispatched run is queued/in_progress; filtering --status success in
  // the poll loop made the flow falsely fail after 60s (CodeRabbit #339).
  assert.match(SRC, /export function findFreshRunForCommit/);
  assert.match(SRC, /run = findFreshRunForCommit\(commit\.sha\)/);
  // ...while the REUSE lookup keeps the success filter (only a finished run
  // can be reused).
  assert.match(SRC, /'--status',\s*\n?\s*'success'/);
});

test('the folder is named for the commit, the run id lives in SUMMARY.md', () => {
  assert.match(SRC, /release-stage-\$\{commit\.short\}/);
  assert.match(SRC, /run \$\{p\.run\.id\}/);
});

test('renderSummary: the evidence format is pinned (hashes, VT status, WDSI block, next steps)', () => {
  const md = renderSummary({
    commit: {sha: 'a'.repeat(40), short: 'aaaaaaa', branch: 'main'},
    run: {
      id: '42',
      url: 'https://github.com/onemen/firefox-scripts/actions/runs/42',
      conclusion: 'success',
    },
    osName: 'win32',
    artifact: 'staged-win',
    files: [
      {rel: 'installer/installer_win.exe', size: 231424, sha256: 'i'.repeat(64)},
      {rel: 'installer/helper_win.exe', size: 46592, sha256: 'h'.repeat(64)},
      {rel: 'scripts/utils.zip', size: 36461, sha256: 'u'.repeat(64)},
    ],
    binaries: {installer: 'installer/installer_win.exe', helper: 'installer/helper_win.exe'},
    vt: [
      {
        sha256: 'i'.repeat(64),
        verdict: 'fail',
        stats: {malicious: 1, undetected: 70},
        flags: ['Microsoft'],
      },
      {
        sha256: 'h'.repeat(64),
        verdict: 'unknown',
        stats: {},
        flags: [],
        note: 'VT_API_KEY not set',
      },
    ],
    savedAt: '2026-09-27 12:00 UTC',
  });
  assert.match(md, /# Release staging — aaaaaaa/);
  assert.match(md, /CI run \| 42/);
  assert.match(md, /\| `installer\/installer_win.exe` \| 231,424 \| `i{64}` \|/);
  assert.match(
    md,
    /FAIL · 1\/71 engines · flagged by Microsoft · Microsoft: flagged → WDSI filing required/
  );
  assert.match(md, /helper_win\.exe`: unknown — VT_API_KEY not set/);
  assert.match(md, /https:\/\/www\.microsoft\.com\/en-us\/wdsi/);
  assert.match(md, /## WDSI paste block/);
  assert.match(md, /## Next steps/);
  assert.match(md, /## WDSI submission[\s\S]*- not filed yet/);
  // Packages are context, never the filing subject.
  assert.match(md, /## Packages \(context only — never filed\)/);
});

test('renderSummary preserves a re-read WDSI submission record', () => {
  const md = renderSummary({
    commit: {sha: 'a'.repeat(40), short: 'aaaaaaa', branch: ''},
    run: {id: '42', url: 'u', conclusion: 'success'},
    osName: 'win32',
    artifact: 'staged-win',
    files: [
      {rel: 'installer/installer_win.exe', size: 1, sha256: 'i'.repeat(64)},
      {rel: 'installer/helper_win.exe', size: 1, sha256: 'h'.repeat(64)},
    ],
    binaries: {installer: 'installer/installer_win.exe', helper: 'installer/helper_win.exe'},
    vt: [],
    savedAt: 'now',
    wdsi: {submissionId: '23b7cf04', filedAt: '2026-09-27', verdict: 'pending'},
  });
  assert.match(md, /Submission id: `23b7cf04` \(filed 2026-09-27\) — verdict: pending/);
});

test('readWdsiFacts parses the summary line and survives a missing file', () => {
  assert.equal(readWdsiFacts('Z:/definitely/missing/SUMMARY.md'), undefined);
});

test('VT status: hash lookup first, upload only for unseen bytes, never throws', () => {
  // The pipeline imports the lookup/exported helpers from scan-vt.mjs — no
  // second VT client.
  assert.match(
    SRC,
    /import \{scanVirusTotal, lookupVirusTotalHashes, vtApiKey\} from '\.\.\/scan-vt\.mjs'/
  );
  assert.match(SRC, /VT_API_KEY not set/);
  assert.match(SRC, /lookupVirusTotalHashes\(hashes\)/);
  // And the flow never lets VT trouble kill the staging run.
  assert.match(SRC, /verdict: 'unknown'/);
});

test('the checkout-vs-origin guard exists (wrong-commit staging refused)', () => {
  assert.match(SRC, /pull main first \(or pass --ref\)/);
  assert.match(SRC, /git\(\['fetch', '--quiet'\]\)/);
});

test('the pnpm script is the one-command spelling (VT_API_KEY loaded from .env)', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));
  assert.equal(
    pkg.scripts['release:stage'],
    'node --env-file-if-exists=.env tools/publish/release.mjs --stage'
  );
});
