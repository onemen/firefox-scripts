// tools/test/unit/pagesIndex.test.mjs — Tests for the generated Pages-site
// landing page (tools/publish/uploadToPages.mjs).
//
// uploadToPages.mjs imports paths.js, which calls requireMode() at import
// time, so the test pushes --mode=prod into process.argv before the dynamic
// import.

import {test} from 'node:test';
import assert from 'node:assert/strict';

process.argv.push('--mode=prod');

const {pagesIndex} = await import('../../../tools/publish/uploadToPages.mjs');

test('pagesIndex: renders the landing-page contract', () => {
  const html = pagesIndex().toString('utf-8');
  // Static index.html on purpose: the branch's .nojekyll disables Jekyll and
  // its README-as-index fallback. These are the links a visitor relies on.
  assert.match(html, /<title>firefox-scripts<\/title>/);
  assert.match(html, /Under active development/);
  assert.match(html, /<a href="fx-folder\.zip">/);
  assert.match(html, /<a href="utils\.zip">/);
  assert.match(html, /<a href="hashes\.json">/);
  assert.match(html, /releases\/latest/);
  assert.match(html, /docs\/DEVELOPING\.md/);
});

test('pagesIndex: deterministic so unchanged runs push no commit', () => {
  assert.deepEqual(pagesIndex().toString('utf-8'), pagesIndex().toString('utf-8'));
});
