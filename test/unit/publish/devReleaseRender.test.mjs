// test/unit/publish/devReleaseRender.test.mjs — unit tests for the dev
// release page rendering (devReleasePage.mjs, ADR 0026's --note RC flag).

import {test} from 'node:test';
import assert from 'node:assert/strict';

process.argv.push('--mode=dev');

const {renderDevRelease} = await import('../../../tools/publish/devReleasePage.mjs');

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
