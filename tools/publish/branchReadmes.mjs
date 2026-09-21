//
// Landing pages for the artifact-only publish branches (ADR 0031).
//
// - gh-pages (prod): the rendered repo README (pagesIndex in uploadToPages.mjs)
//   already points at the `latest` release — that behavior is unchanged.
// - dev-build-<id> (dev): a dedicated WARNING page. These branches hold
//   developer-test artifacts with dev-channel URLs baked in; a human landing
//   here must not mistake them for the supported release channel. The page
//   links the RAW file URLs (raw.githubusercontent.com) — GitHub's blob pages
//   save the rendered HTML when a visitor uses "save link as", which is
//   exactly the trap hit while testing the 2026-09-21 dev build (the
//   downloads came out as 160-390 KB of HTML instead of a 917 B zip).
//
// The dev index.html is generated here (not from the repo README) so the
// warning is impossible to miss and every link is a real, working download.
//

import {REPO_OWNER, ZIP_PAGES_REPO} from './paths.js';

/** Escape a string for interpolating into HTML text/attribute context. */
const esc = s =>
  String(s).replace(
    /[&<>"']/g,
    c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]
  );
/**
 * Percent-encode a dynamic path segment for URL context (branch name, file
 * name). Used for every generated URL so no input character can break out of
 * the link target or inject markup.
 */
const enc = encodeURIComponent;

/**
 * Build the dev-build-<id> branch README.md — GitHub renders it on the branch
 * listing page, which is where a human browsing the branch lands. The raw links
 * here are the ones that actually download (the listing's own file links are
 * blob pages that save as HTML).
 *
 * @param {object} opts
 * @param {string} opts.branch the dev branch name (e.g. dev-build-main-8fb95b1)
 * @param {string[]} opts.files the artifact file names published to the branch
 * @param {string} [opts.note] optional extra note (e.g. the --note RC label)
 * @returns {Buffer} the README.md payload
 */
export function devBranchReadme({branch, files, note}) {
  const rawBase = `https://raw.githubusercontent.com/${REPO_OWNER}/${ZIP_PAGES_REPO}/${enc(branch)}`;
  const lines = [
    `# ⚠️ Developer test build — '${esc(branch)}'`,
    '',
    '**These files are for developer testing only.** They are published from a disposable',
    'per-run branch; nothing here is a supported release.',
    '',
    '- A build installed from these artifacts pins its updater to **this dev channel** and',
    '  shows a “Test build” banner. Reinstall from a production build to go back to stable.',
    '- The branch disappears when cleaned up (`pnpm dev-clean`).',
    '- Windows SmartScreen will warn on the unsigned installer — “More info → Run anyway”',
    '  (see the release notes for the full flow).',
    '',
    '**For real use, download the',
    `[latest release](https://github.com/${REPO_OWNER}/${ZIP_PAGES_REPO}/releases/latest) instead.**`,
    '',
  ];
  if (note) lines.push(`> Note: ${esc(note)}`, '');
  lines.push('## Files (direct download)', '');
  for (const f of files) {
    if (f === 'index.html' || f === '.nojekyll' || f === 'README.md') continue;
    lines.push(`- [${esc(f)}](${rawBase}/${enc(f)})`);
  }
  lines.push(
    '',
    'Files are served from `raw.githubusercontent.com`; the updater fetches artifacts from',
    `\`cdn.jsdelivr.net/gh/${REPO_OWNER}/${ZIP_PAGES_REPO}@${esc(branch)}\`.`,
    ''
  );
  return Buffer.from(lines.join('\n'), 'utf-8');
}

/**
 * Build the gh-pages branch README.md — rendered on the branch listing page.
 * The artifact branch itself holds no human docs today; the README points the
 * visitor at the `latest` release (the supported download surface) instead of
 * letting them grab per-commit artifacts from the listing.
 *
 * @returns {Buffer} the README.md payload
 */
export function ghPagesReadme() {
  return Buffer.from(
    [
      `# ${ZIP_PAGES_REPO} — release artifacts`,
      '',
      'This branch holds the published packages (zips, hashes, binaries) served to the',
      'installer and the in-browser updater. **Do not download files from this listing** —',
      'per-commit artifacts are not a supported download surface.',
      '',
      `**Download the [latest release](https://github.com/${REPO_OWNER}/${ZIP_PAGES_REPO}/releases/latest)**`,
      '— it bundles the same packages with release notes and install instructions.',
      '',
      'The rendered page (index.html) mirrors the repository README.',
      '',
    ].join('\n'),
    'utf-8'
  );
}

/**
 * Build the dev-build-<id> branch landing page.
 *
 * @param {object} opts
 * @param {string} opts.branch the dev branch name (e.g. dev-build-main-8fb95b1)
 * @param {string[]} opts.files the artifact file names published to the branch
 * @param {string} [opts.note] optional extra note (e.g. the --note RC label)
 * @returns {Buffer} the index.html payload
 */
export function devIndexHtml({branch, files, note}) {
  const rawBase = `https://raw.githubusercontent.com/${REPO_OWNER}/${ZIP_PAGES_REPO}/${enc(branch)}`;
  const items = files
    .filter(f => f !== 'index.html' && f !== '.nojekyll' && f !== 'README.md')
    // Escape the WHOLE href (not just the filename): the branch name is
    // interpolated into rawBase and lands in an attribute context.
    .map(f => `      <li><a href="${rawBase}/${enc(f)}" download>${esc(f)}</a></li>`)
    .join('\n');
  const noteHtml = note ? `\n    <p><strong>Note:</strong> ${esc(note)}</p>` : '';
  return Buffer.from(
    [
      '<!doctype html>',
      '<html lang="en">',
      '  <head>',
      '    <meta charset="utf-8" />',
      '    <meta name="viewport" content="width=device-width, initial-scale=1" />',
      `    <title>${esc(branch)} — developer test build</title>`,
      '    <style>',
      '      body { font-family: system-ui, sans-serif; max-width: 720px; margin: 40px auto; padding: 0 24px; line-height: 1.5; }',
      '      .warning { background: #fff8c5; border: 1px solid #d4a72c; border-radius: 6px; padding: 12px 16px; }',
      '      code { background: #f6f8fa; padding: 2px 5px; border-radius: 4px; }',
      '      li { margin: 4px 0; }',
      '    </style>',
      '  </head>',
      '  <body>',
      '    <div class="warning">',
      '      <h1>⚠️ Developer test build — not for daily use</h1>',
      `      <p>These files are published from the disposable <code>${esc(branch)}</code> branch`,
      '      for <strong>developer testing only</strong>. They install a build whose updater',
      '      is pinned to this dev channel, show a “Test build” banner, and disappear when',
      '      the branch is cleaned up. For anything real, use the',
      `      <a href="https://github.com/${esc(REPO_OWNER)}/${esc(ZIP_PAGES_REPO)}/releases/latest">latest release</a>.`,
      '      Windows SmartScreen will warn on the unsigned installer — see the release notes',
      '      for the “More info → Run anyway” flow.</p>',
      noteHtml,
      '    </div>',
      '    <h2>Files (direct download)</h2>',
      '    <ul>',
      items,
      '    </ul>',
      `    <p>Files are served from <code>raw.githubusercontent.com</code>; the updater itself`,
      `      fetches artifacts from <code>cdn.jsdelivr.net/gh/${esc(REPO_OWNER)}/${esc(ZIP_PAGES_REPO)}@${esc(branch)}</code>.</p>`,
      '  </body>',
      '</html>',
      '',
    ].join('\n'),
    'utf-8'
  );
}
