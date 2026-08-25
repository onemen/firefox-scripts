// test/unit/publish/pagesIndex.test.mjs — Tests for the generated Pages-site
// landing page (tools/publish/uploadToPages.mjs).
//
// uploadToPages.mjs imports paths.js, which calls requireMode() at import
// time, so the test pushes --mode=prod into process.argv before the dynamic
// import.

import {test} from 'node:test';
import assert from 'node:assert/strict';

process.argv.push('--mode=prod');

const {pagesIndex} = await import('../../../tools/publish/uploadToPages.mjs');

const renderedReadme =
  '<article class="markdown-body"><h1>firefox-scripts</h1><p>Helper scripts.</p></article>';
const okOctokit = {
  request: async (_route, opts) => {
    if (opts.headers.accept === 'application/vnd.github.html+json') return {data: renderedReadme};
    throw new Error('unexpected raw fetch');
  },
};

test('pagesIndex: serves the GitHub-rendered README as the site index', async () => {
  const html = (await pagesIndex(okOctokit)).toString('utf-8');
  assert.match(html, /<title>firefox-scripts<\/title>/);
  assert.match(html, /github-markdown-css/);
  assert.ok(html.includes(renderedReadme), 'rendered README body is embedded');
});

test('pagesIndex: falls back to escaped plain text when HTML rendering fails', async () => {
  const flakyOctokit = {
    request: async (_route, opts) => {
      if (opts.headers.accept !== 'application/vnd.github.raw+json') throw new Error('boom');
      return {data: '# readme <with> & markup'};
    },
  };
  const html = (await pagesIndex(flakyOctokit)).toString('utf-8');
  assert.match(html, /<pre># readme &lt;with&gt; &amp; markup<\/pre>/);
});

test('pagesIndex: both fetches failing is a hard error', async () => {
  await assert.rejects(
    () =>
      pagesIndex({
        request: async () => {
          throw new Error('down');
        },
      }),
    /README/
  );
});
