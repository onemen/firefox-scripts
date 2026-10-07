// test/unit/tools/cleanupCiDownloads.test.mjs — the delete paths of the
// cleanup-ci-downloads job (ADR 0021), driven against fixtures only (P2-16,
// audit 2026-10-06).
//
// This step runs in the only E2E job holding `contents: write` and is the one
// place that deletes a release asset, a release and a tag. The irreversible
// surface is pinned here by guards the tests would catch breaking — a guard
// removed from the tool fails an assertion below instead of being absorbed by
// a forgiving mock:
//
//   - release absent → exit 0, no deletes (the steady state);
//   - BROWSER unset → exit 1, not a single gh call (the step fails loudly);
//   - the asset is matched by the resolver's EXACT expected name only, and
//     only with a pinned version — no version, no deletion (never guess);
//   - release + tag are deleted only once NO assets remain (another escape
//     in flight keeps the release alive);
//   - every call stays inside the `ci-downloads` namespace — a tag or release
//     outside it is never named.
//
// The gh calls are an injected, scripted recorder (tools/ci/cleanupCiDownloads
// exports the body for exactly this), so no test can reach a real repository
// or a real release.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

import {ciDownloadsAssetName} from '../../e2e/shared/browserResolver.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const toolUrl = pathToFileURL(path.join(REPO_ROOT, 'tools', 'ci', 'cleanupCiDownloads.mjs')).href;

const {cleanupCiDownloads} = await import(toolUrl);

const BROWSER = 'librewolf';
const VERSION = '155.0-1';
const OUR_ASSET = ciDownloadsAssetName(BROWSER, VERSION);
const OTHER_ASSET = ciDownloadsAssetName('waterfox', '6.7.1.1');

/** A gh-shaped 404, the way execFileSync surfaces it. */
function notFound() {
  return Object.assign(new Error('gh release view: Not Found (HTTP 404)'), {status: 404});
}

/**
 * Fixture-backed gh: every call is recorded, the next scripted response is
 * returned (object → JSON string, Error → thrown), and an unscripted call
 * throws so an unexpected sequence fails the test instead of guessing.
 *
 * @param {(object | string | Error)[]} responses
 */
function scriptedGh(responses) {
  const calls = [];
  let next = 0;
  const gh = args => {
    calls.push(args);
    if (next >= responses.length) {
      throw new Error(`unscripted gh call: gh ${args.join(' ')}`);
    }
    const response = responses[next++];
    if (response instanceof Error) throw response;
    return typeof response === 'string' ? response : JSON.stringify(response);
  };
  return {gh, calls};
}

const noop = () => {};

test('release absent → exit 0, and no delete is ever attempted', () => {
  const {gh, calls} = scriptedGh([notFound()]);
  const code = cleanupCiDownloads({browser: BROWSER, version: VERSION, gh, log: noop});
  assert.equal(code, 0);
  assert.deepEqual(calls, [['release', 'view', 'ci-downloads', '--json', 'assets']]);
});

test('BROWSER unset → exit 1 without a single gh call', () => {
  const {gh, calls} = scriptedGh([]);
  const code = cleanupCiDownloads({browser: '', version: VERSION, gh, log: noop});
  assert.equal(code, 1);
  assert.equal(calls.length, 0, 'nothing may be queried or deleted without a browser');
});

test('consumed asset deleted by exact name; release + tag follow only when empty', () => {
  const {gh, calls} = scriptedGh([{assets: [{name: OUR_ASSET}]}, '', {assets: []}, '']);
  const code = cleanupCiDownloads({browser: BROWSER, version: VERSION, gh, log: noop});
  assert.equal(code, 0);
  assert.deepEqual(calls, [
    ['release', 'view', 'ci-downloads', '--json', 'assets'],
    ['release', 'delete-asset', 'ci-downloads', OUR_ASSET, '--yes'],
    ['release', 'view', 'ci-downloads', '--json', 'assets'],
    ['release', 'delete', 'ci-downloads', '--yes', '--cleanup-tag'],
  ]);
});

test('assets remain after ours (another escape in flight) → release is kept', () => {
  const {gh, calls} = scriptedGh([
    {assets: [{name: OUR_ASSET}, {name: OTHER_ASSET}]},
    '',
    {assets: [{name: OTHER_ASSET}]},
  ]);
  const code = cleanupCiDownloads({browser: BROWSER, version: VERSION, gh, log: noop});
  assert.equal(code, 0);
  assert.deepEqual(calls[1], ['release', 'delete-asset', 'ci-downloads', OUR_ASSET, '--yes']);
  assert.equal(
    calls.some(args => args[0] === 'release' && args[1] === 'delete'),
    false,
    'the release must NOT be deleted while assets remain'
  );
});

test('no pinned version → the asset is never guessed at, release untouched', () => {
  const {gh, calls} = scriptedGh([{assets: [{name: OUR_ASSET}]}, {assets: [{name: OUR_ASSET}]}]);
  const code = cleanupCiDownloads({browser: BROWSER, version: '', gh, log: noop});
  assert.equal(code, 0);
  assert.equal(
    calls.some(args => args[1] === 'delete-asset' || args[1] === 'delete'),
    false,
    'without a version only the exact expected name may be deleted — which is not known'
  );
});

test('every gh call stays inside the ci-downloads namespace', () => {
  const scenarios = [
    scriptedGh([notFound()]),
    scriptedGh([{assets: [{name: OUR_ASSET}]}, '', {assets: []}, '']),
    scriptedGh([
      {assets: [{name: OUR_ASSET}, {name: OTHER_ASSET}]},
      '',
      {assets: [{name: OTHER_ASSET}]},
    ]),
  ];
  for (const {gh, calls} of scenarios) {
    cleanupCiDownloads({browser: BROWSER, version: VERSION, gh, log: noop});
    for (const args of calls) {
      assert.equal(args[0], 'release', `unexpected gh resource: gh ${args.join(' ')}`);
      assert.equal(
        args[2],
        'ci-downloads',
        `gh ${args.join(' ')} names a release/tag outside the ci-downloads namespace`
      );
    }
  }
});

test('first-read lookup failure → treated as “release absent”: exit 0, no deletes', () => {
  // Current contract: the INITIAL `gh release view` failure (404 in the
  // steady state) short-circuits to "nothing to clean". Deliberately
  // asymmetric with ciDownload's --clean, which rethrows non-404 — pinning
  // both here makes any future tightening an explicit, reviewed change.
  for (const failure of [
    notFound(),
    Object.assign(new Error('HTTP 500: server error'), {status: 500}),
  ]) {
    const {gh, calls} = scriptedGh([failure]);
    const code = cleanupCiDownloads({browser: BROWSER, version: VERSION, gh, log: noop});
    assert.equal(code, 0);
    assert.deepEqual(calls, [['release', 'view', 'ci-downloads', '--json', 'assets']]);
  }
});

test('a failure on the re-read AFTER a delete propagates (exit 1, not a silent pass)', () => {
  const {gh} = scriptedGh([
    {assets: [{name: OUR_ASSET}]},
    '',
    Object.assign(new Error('HTTP 500: server error'), {status: 500}),
  ]);
  assert.throws(
    () => cleanupCiDownloads({browser: BROWSER, version: VERSION, gh, log: noop}),
    /HTTP 500/
  );
});
