// test/unit/tools/esr-watchdog.test.mjs — Unit tests for the ESR watchdog
// pieces: the two-major window state machine (updateEsrState), the dynamic
// ledger/matrix builders, the dispatch planner's ESR + nightly rules, and the
// resolver's firefox-esr-<major> chain expansion (pure parts only — the
// network fetches are covered by the live smoke runs).

import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const reportUrl = pathToFileURL(path.join(REPO_ROOT, 'tools', 'ci', 'watchdog-report.mjs')).href;
const resolverUrl = pathToFileURL(
  path.join(REPO_ROOT, 'test', 'e2e', 'shared', 'browserResolver.mjs')
).href;

const report = await import(reportUrl);
const resolver = await import(resolverUrl);

const {
  updateEsrState,
  esrLedgerNames,
  esrBrowserKey,
  esrMajorOf,
  buildEsrMatrix,
  planDispatches,
  collectDrift,
  BROWSERS,
  INFORMATIONAL_BROWSERS,
  ESR_BROWSER_PREFIX,
} = report;

// ── updateEsrState: the two-major window ─────────────────────────────────────

test('updateEsrState: cold start seeds the window from both live keys', () => {
  const {state, droppedMajors} = updateEsrState(null, '140.16.0esr', '153.3.0esr');
  assert.deepEqual(state.majors, ['140', '153']);
  assert.equal(state.versions['140'], '140.16.0esr');
  assert.equal(state.versions['153'], '153.3.0esr');
  assert.deepEqual(droppedMajors, []);
});

test('updateEsrState: cold start with NEXT absent degrades to the serving major', () => {
  const {state, droppedMajors} = updateEsrState(null, '153.3.0esr', null);
  assert.deepEqual(state.majors, ['153']);
  assert.deepEqual(droppedMajors, []);
});

test('updateEsrState: serving-key flip (ESR 140→153 on Sep 29) changes nothing', () => {
  const prev = {majors: ['140', '153'], versions: {140: '140.16.0esr', 153: '153.3.0esr'}};
  // After the flip FIREFOX_ESR carries 153 and NEXT is absent: the window is
  // unchanged (153 was already watched; 140 stays via state).
  const {state, droppedMajors} = updateEsrState(prev, '153.3.0esr', null);
  assert.deepEqual(state.majors, ['140', '153']);
  assert.equal(state.versions['140'], '140.16.0esr'); // retired major keeps its version
  assert.equal(state.versions['153'], '153.3.0esr');
  assert.deepEqual(droppedMajors, []);
});

test('updateEsrState: a NEW NEXT major slides the window and drops the oldest', () => {
  const prev = {majors: ['140', '153'], versions: {140: '140.16.0esr', 153: '153.3.0esr'}};
  const {state, droppedMajors} = updateEsrState(prev, '153.3.0esr', '164.0esr');
  assert.deepEqual(state.majors, ['153', '164']);
  assert.deepEqual(droppedMajors, ['140']);
  assert.equal(state.versions['140'], undefined); // dropped major's version leaves the cache
  assert.equal(state.versions['164'], '164.0esr');
});

test('updateEsrState: a live key serving a dropped major does not resurrect it', () => {
  // ESR=140 while NEXT announces 164: 140 must be dropped AND its version
  // must not be re-recorded by the still-live serving key.
  const prev = {majors: ['140', '153'], versions: {140: '140.16.0esr', 153: '153.3.0esr'}};
  const {state} = updateEsrState(prev, '140.16.0esr', '164.0esr');
  assert.deepEqual(state.majors, ['153', '164']);
  assert.equal(state.versions['140'], undefined);
});

test('updateEsrState: point-release bumps refresh the version in place', () => {
  const prev = {majors: ['140', '153'], versions: {140: '140.15.0esr', 153: '153.2.0esr'}};
  const {state, droppedMajors} = updateEsrState(prev, '140.16.0esr', '153.3.0esr');
  assert.deepEqual(state.majors, ['140', '153']);
  assert.equal(state.versions['140'], '140.16.0esr');
  assert.equal(state.versions['153'], '153.3.0esr');
  assert.deepEqual(droppedMajors, []);
});

test('updateEsrState: null lookups keep the previous window intact', () => {
  const prev = {majors: ['140', '153'], versions: {140: '140.16.0esr', 153: '153.3.0esr'}};
  const {state, droppedMajors} = updateEsrState(prev, null, null);
  assert.deepEqual(state.majors, ['140', '153']);
  assert.equal(state.versions['140'], '140.16.0esr');
  assert.deepEqual(droppedMajors, []);
});

test('updateEsrState: non-ESR garbage in the keys is ignored', () => {
  const {state} = updateEsrState(null, '156.0', 'not-a-version');
  assert.deepEqual(state.majors, []);
});

// ── Ledger + matrix builders ─────────────────────────────────────────────────

test('esrLedgerNames: lowest major first, empty on cold state', () => {
  assert.deepEqual(esrLedgerNames({majors: ['140', '153']}), [
    'firefox-esr-140',
    'firefox-esr-153',
  ]);
  assert.deepEqual(esrLedgerNames(null), []);
  assert.deepEqual(esrLedgerNames({}), []);
});

test('esrBrowserKey / esrMajorOf round-trip', () => {
  assert.equal(esrBrowserKey(140), 'firefox-esr-140');
  assert.equal(esrMajorOf('140.16.0esr'), '140');
  assert.equal(esrMajorOf('156.0'), null);
  assert.equal(esrMajorOf(''), null);
  assert.equal(esrMajorOf(undefined), null);
});

test('buildEsrMatrix: concrete majors from state, generic fallback when cold', () => {
  assert.equal(buildEsrMatrix({majors: ['140', '153']}), '["firefox-esr-140","firefox-esr-153"]');
  assert.equal(buildEsrMatrix(null), '["firefox-esr"]');
  assert.equal(buildEsrMatrix({}), '["firefox-esr"]');
});

// ── planDispatches: ESR + nightly rules ──────────────────────────────────────

test('planDispatches: an ESR point release yields ONE firefox-esr dispatch', () => {
  const plans = planDispatches([{kind: 'new-version', browser: 'firefox-esr-140'}]);
  assert.deepEqual(plans, [{browser: 'firefox-esr', ref: 'main'}]);
});

test('planDispatches: both ESR majors drifting still yield ONE dispatch', () => {
  const plans = planDispatches([
    {kind: 'new-version', browser: 'firefox-esr-140'},
    {kind: 'new-version', browser: 'firefox-esr-153'},
  ]);
  assert.deepEqual(plans, [{browser: 'firefox-esr', ref: 'main'}]);
});

test('planDispatches: nightly never dispatches (informational row)', () => {
  const plans = planDispatches([{kind: 'new-version', browser: 'nightly'}]);
  assert.deepEqual(plans, []);
});

test('planDispatches: nightly stays informational in the constants', () => {
  assert.deepEqual(INFORMATIONAL_BROWSERS, ['nightly']);
  assert.ok(!BROWSERS.includes('firefox-esr-140')); // dynamic rows never join the static list
});

test('planDispatches: ESR drift plus a fork release dispatch both', () => {
  const plans = planDispatches([
    {kind: 'new-version', browser: 'firefox-esr-153'},
    {kind: 'new-version', browser: 'zen'},
  ]);
  assert.deepEqual(plans, [
    {browser: 'zen', ref: 'main'},
    {browser: 'firefox-esr', ref: 'main'},
  ]);
});

test('planDispatches: first-run ESR entries do not dispatch', () => {
  // first-run is excluded globally (cache eviction re-baselines); the ESR
  // filter must respect that too.
  const plans = planDispatches([{kind: 'first-run', browser: 'firefox-esr-140'}]);
  assert.deepEqual(plans, []);
});

// ── ESR rows never reach the publish drift gate ──────────────────────────────

test('collectDrift: dynamic ESR baseline entries cannot block a publish', () => {
  // A stale ESR entry in the baseline must be invisible to collectDrift —
  // it iterates the static BROWSERS list only. All static browsers are
  // provided green so the only possible drift source is the ESR entries.
  const baseline = {
    'firefox': {version: '156.0'},
    'firefox-dev': {version: '157.0b3'},
    'nightly': {version: '158.0a1'},
    'librewolf': {version: '156.0-1'},
    'floorp': {version: '12.18.0'},
    'zen': {version: '1.22.2b'},
    'waterfox': {version: '6.7.3'},
    'firefox-esr-140': {version: '140.0.0esr'},
    'firefox-esr-153': {version: '153.0.0esr'},
  };
  const versions = {
    'firefox': '156.0',
    'firefox-dev': '157.0b3',
    'nightly': '158.0a1',
    'librewolf': '156.0-1',
    'floorp': '12.18.0',
    'zen': '1.22.2b',
    'waterfox': '6.7.3',
  };
  const drift = collectDrift(baseline, versions);
  assert.deepEqual(drift, []);
});

test('ESR_BROWSER_PREFIX: dispatch filter prefix matches the ledger keys', () => {
  assert.ok('firefox-esr-140'.startsWith(ESR_BROWSER_PREFIX));
  assert.ok('firefox-esr-153'.startsWith(ESR_BROWSER_PREFIX));
  // The generic key carries no major — it never dispatches (nothing in the
  // cold-cache fallback path produces a new-version finding for it).
  assert.ok(!'firefox-esr'.startsWith(ESR_BROWSER_PREFIX));
});

// ── Resolver: dynamic ESR chain expansion (pure parts) ───────────────────────

test('parseEsrVersion: parses esr versions, rejects the rest', () => {
  assert.deepEqual(resolver.parseEsrVersion('140.16.0esr'), {major: 140, minor: 16, patch: 0});
  assert.deepEqual(resolver.parseEsrVersion('153.3.0esr'), {major: 153, minor: 3, patch: 0});
  assert.equal(resolver.parseEsrVersion('156.0'), null);
  assert.equal(resolver.parseEsrVersion('140.16.0'), null);
  assert.equal(resolver.parseEsrVersion(''), null);
});

test('version chains exist for the generic and concrete ESR keys', async () => {
  // resolveBrowserVersion throws a distinctive error for unknown browsers;
  // the ESR keys must NOT be among them (verified without network via the
  // pin short-circuit: a pinned resolution returns before any fetch).
  const v = await resolver.resolveBrowserVersion('firefox-esr', {pin: '1.2.3esr'});
  assert.deepEqual(v, {version: '1.2.3esr', source: 'pinned'});
  const v2 = await resolver.resolveBrowserVersion('firefox-esr-140', {pin: '9.9.9esr'});
  assert.deepEqual(v2, {version: '9.9.9esr', source: 'pinned'});
});

test('unknown browsers still throw the chain error', async () => {
  await assert.rejects(() => resolver.resolveBrowserVersion('firefox-esr-'), /no version chain/);
});

test('downloads.mjs: generated ESR recipes are portable Windows-only', async () => {
  const downloads = await import(
    pathToFileURL(path.join(REPO_ROOT, 'test', 'e2e', 'shared', 'downloads.mjs')).href
  );
  const entry = downloads.esrDownloadsEntry('firefox-esr-140');
  assert.equal(entry.install.win.resolver, true);
  assert.equal(entry.install.win.portable, true);
  assert.equal(entry.install.win.portableExe, 'firefox.exe');
  assert.equal(entry.install.mac, undefined);
  assert.equal(entry.install.linux, undefined);
  assert.equal(downloads.esrDownloadsEntry('firefox'), undefined);
  // The generic cold-cache fallback key shares the recipe (it must be
  // installable when the baseline cache missed — the 2026-09-19 CI failure).
  assert.equal(downloads.esrDownloadsEntry('firefox-esr').install.win.portable, true);
  // A malformed major is still rejected.
  assert.equal(downloads.esrDownloadsEntry('firefox-esr-abc'), undefined);
  // downloadsEntry folds the dynamic keys into the static table.
  assert.equal(downloads.downloadsEntry('firefox-esr-153').install.win.portable, true);
  assert.equal(downloads.downloadsEntry('firefox-esr').install.win.portable, true);
  assert.equal(
    downloads.downloadsEntry('firefox').install.win.url.includes('firefox-latest'),
    true
  );
});

test('downloads.mjs: installBrowser rejects a malformed ESR key', async () => {
  const downloads = await import(
    pathToFileURL(path.join(REPO_ROOT, 'test', 'e2e', 'shared', 'downloads.mjs')).href
  );
  await assert.rejects(
    () => downloads.installBrowser('firefox-esr-abc', 'win32'),
    /Unknown browser/
  );
});
