// Unit tests for tools/publish/branchReadmes.mjs — the dev-build-<id> landing
// page. Pure string checks; no network. The contract this pins (after the
// 2026-09-21 dev test): the page must warn that the artifacts are developer
// test builds, link the latest release for real use, and link every artifact
// via RAW urls — never GitHub blob pages, which save as HTML when a visitor
// uses "save link as" (160-390 KB of markup instead of a 917 B zip).

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// branchReadmes.mjs imports paths.js -> publishMode.mjs, which requires a mode.
process.argv.push('--mode=dev');

const {devBranchReadme, devIndexHtml, ghPagesReadme} = await import(
  pathToFileURL(
    path.join(
      fileURLToPath(new URL('.', import.meta.url)),
      '../../../tools/publish/branchReadmes.mjs'
    )
  )
);

const FILES = [
  '.nojekyll',
  'fx-folder.zip',
  'hashes.json',
  'helper_win.exe',
  'helper_win.exe.sha256',
  'index.html',
  'installer_win.exe',
  'updater-ui.zip',
  'utils.zip',
];

test('dev index: warns the artifacts are developer-test-only', () => {
  const html = devIndexHtml({branch: 'dev-build-main-abc1234', files: FILES}).toString();
  assert.match(html, /Developer test build/);
  assert.match(html, /developer testing only/);
  assert.match(html, /dev-build-main-abc1234/);
});

test('dev index: points real use at the latest release', () => {
  const html = devIndexHtml({branch: 'dev-build-main-abc1234', files: FILES}).toString();
  assert.match(html, /releases\/latest/);
});

test('dev index: every artifact link is a raw.githubusercontent URL, never a blob page', () => {
  const html = devIndexHtml({branch: 'dev-build-main-abc1234', files: FILES}).toString();
  assert.ok(!html.includes('/blob/'), 'blob links leak HTML on save-link-as');
  for (const f of FILES) {
    if (f === 'index.html' || f === '.nojekyll') continue;
    // Percent-encoded filename (encodeURIComponent) inside the raw URL,
    // followed by the download attribute.
    assert.ok(
      html.includes(
        `raw.githubusercontent.com/onemen/firefox-scripts/dev-build-main-abc1234/${encodeURIComponent(f)}" download`
      ),
      `missing raw download link for ${f}`
    );
  }
});

test('dev index: renders the optional --note label', () => {
  const html = devIndexHtml({
    branch: 'dev-build-main-abc1234',
    files: FILES,
    note: 'RC rehearsal build',
  }).toString();
  assert.match(html, /RC rehearsal build/);
});

test('dev index: escapes HTML-significant characters in inputs', () => {
  const html = devIndexHtml({
    branch: 'dev-build-<script>',
    files: ['x<b>.zip'],
    note: 'a"&b',
  }).toString();
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('a"&b'), 'raw ampersand/quote must be escaped');
});

test('dev README: warns, links every artifact via raw URL, renders the note', () => {
  const md = devBranchReadme({
    branch: 'dev-build-main-abc1234',
    files: FILES,
    note: 'RC rehearsal build',
  }).toString();
  assert.match(md, /developer testing only/i);
  assert.match(md, /dev-build-main-abc1234/);
  assert.match(md, /releases\/latest/);
  assert.match(md, /RC rehearsal build/);
  for (const f of FILES) {
    if (f === 'index.html' || f === '.nojekyll' || f === 'README.md') continue;
    assert.ok(
      md.includes(`raw.githubusercontent.com/onemen/firefox-scripts/dev-build-main-abc1234/${f}`)
    );
  }
  assert.ok(!md.includes('/blob/'), 'README links must be raw, never blob pages');
});

test('dev README: escapes HTML-significant characters in inputs', () => {
  const md = devBranchReadme({
    branch: 'dev-build-<script>',
    files: ['x<b>.zip'],
    note: 'a"&b',
  }).toString();
  assert.ok(!md.includes('<script>'));
  assert.ok(!md.includes('a"&b'), 'raw ampersand/quote must be escaped');
});

test('gh-pages README: points the visitor at the latest release, never at the listing', () => {
  const md = ghPagesReadme().toString();
  assert.match(md, /releases\/latest/);
  assert.match(md, /Do not download files from this listing/);
});
