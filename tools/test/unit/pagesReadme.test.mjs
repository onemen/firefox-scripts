// tools/test/unit/pagesReadme.test.mjs — Tests for the generated Pages-site
// README (tools/publish/uploadToPages.mjs).
//
// uploadToPages.mjs imports paths.js, which calls requireMode() at import
// time, so the test pushes --mode=prod into process.argv before the dynamic
// import.

import {test} from 'node:test';
import assert from 'node:assert/strict';

process.argv.push('--mode=prod');

const {pagesReadme} = await import('../../../tools/publish/uploadToPages.mjs');

test('pagesReadme: renders the landing-page contract', () => {
  const md = pagesReadme().toString('utf-8');
  // Jekyll renders README.md as the site index; these are the lines a
  // visitor (and the repo owner) rely on.
  assert.match(md, /^# firefox-scripts$/m);
  assert.match(md, /Under active development/);
  assert.match(md, /\[`utils\.zip`\]\(utils\.zip\)/);
  assert.match(md, /\[`fx-folder\.zip`\]\(fx-folder\.zip\)/);
  assert.match(md, /\[`hashes\.json`\]\(hashes\.json\)/);
  assert.match(md, /releases\/latest/);
});

test('pagesReadme: deterministic so unchanged runs push no commit', () => {
  assert.deepEqual(pagesReadme().toString('utf-8'), pagesReadme().toString('utf-8'));
});
