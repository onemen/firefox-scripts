// test/unit/publish/devReleaseRender.test.mjs — unit tests for the dev
// release page rendering + the --tag/--note flag contracts (devReleasePage.mjs
// + publishMode.mjs, ADR 0026).

import {test} from 'node:test';
import assert from 'node:assert/strict';

process.argv.push('--mode=dev');

const {renderDevRelease, createsDevRelease} =
  await import('../../../tools/publish/devReleasePage.mjs');

const BASE = {
  note: '',
  shortSha: '450468f',
  date: '2026-09-12',
  devBranch: 'dev-build-main-450468f',
};

test('plain dev publish: bare title, warning + provenance body', () => {
  const {title, body} = renderDevRelease(BASE);
  assert.equal(title, 'dev-build-main-450468f');
  assert.match(body, /⚠️ Test build/);
  assert.match(body, /never auto-updates/i);
  assert.match(body, /latest stable/);
  assert.match(body, /450468f/);
  assert.match(body, /2026-09-12/);
  assert.match(body, /tree\/dev-build-main-450468f/);
});

test('--note publish: title carries the label, body leads with it', () => {
  const {title, body} = renderDevRelease({...BASE, note: 'RC 1 for v1.0 — community validation'});
  assert.equal(title, 'dev-build-main-450468f — RC 1 for v1.0 — community validation');
  assert.ok(body.startsWith('RC 1 for v1.0 — community validation\n'));
  // Still a prerelease page: warning + provenance ride along.
  assert.match(body, /⚠️ Test build/);
  assert.match(body, /releases\/latest/);
});

test('only an announced (--tag) dev publish creates a release (branch-only default)', () => {
  assert.equal(createsDevRelease({tag: false}), false);
  assert.equal(createsDevRelease({tag: true}), true);
});

test('--note slugifies into the dev-build id; DEV_BUILD_ID env still wins', async () => {
  const {slugifyDevNote, devBuildId} = await import('../../../tools/publish/publishMode.mjs');
  assert.equal(slugifyDevNote('v1.0 RC — community'), 'v1.0-RC-community');
  assert.equal(slugifyDevNote('  spaced   out  '), 'spaced-out');
  assert.equal(
    devBuildId({branch: 'main', sha: '450468f', note: 'v1.0 RC'}),
    'dev'.slice(0, 0) || 'main-v1.0-RC-450468f'
  );
  assert.equal(devBuildId({branch: 'main', sha: '450468f', note: ''}), 'main-450468f');
  assert.equal(devBuildId({branch: 'feat/x', sha: 'abc1234', note: 'RC 1'}), 'feat-x-RC-1-abc1234');
  // The env override (republishing an existing branch) beats any note slug.
  assert.equal(
    devBuildId({branch: 'main', sha: '450468f', note: 'v1.0 RC', envId: 'main-450468f'}),
    'main-450468f'
  );
});
