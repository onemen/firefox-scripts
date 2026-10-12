'use strict';

// test/unit/docsSite/internalLinks.test.mjs
//
// Contract under test: every internal link in the docs content resolves
// correctly under the site's configured `base`.
//
// Why (issue #28, docs-site): the site is served from a subpath —
// `base: '/firefox-scripts'` in docs-site/astro.config.mjs — because the
// release artifacts live at the gh-pages branch root beside the site output.
// Astro does NOT rewrite root-absolute links found in Markdown/MDX content
// (upstream withastro/astro#5680): only links Starlight generates itself (the
// sidebar, prev/next, breadcrumbs) get the `base` prefix. So a hand-written
// `[Installation](/installation/)` renders as `/installation/` in the built
// HTML and 404s in production, while looking fine in `astro dev` if you only
// browse base-prefixed URLs. Every such link broke at once when the landing
// page was first built.
//
// The fix is relative links, which are base-agnostic — `../installation/` from
// the FAQ page resolves correctly whatever `base` is, and keeps working if the
// project path ever changes.
//
// These tests are the regression guard: they assert on the SOURCE, so they need
// neither node_modules nor a build, and they fail at review time.
//
// Two failure modes are guarded, and the second is the one that is easy to
// reintroduce by hand:
//   1. a root-absolute link, which loses `base` and 404s;
//   2. a relative link with the WRONG number of `../`, which resolves to a
//      page that does not exist (`faq/installation/` instead of
//      `installation/`). A hand edit that "looks relative" can be just as dead
//      as the original bug, so each relative link is resolved the way a browser
//      would and required to land on a real page.
//
// Deliberately NOT treated as internal links: `https:`/`http:`/`mailto:`
// targets, pure fragments (`#section`), and protocol-relative `//host/path`.
// `src="/firefox-scripts/..."` is checked separately, by the opposite rule —
// public/ assets are served from the site root and MUST be base-prefixed.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {join, posix} from 'node:path';

const DOCS_DIR = 'docs-site/src/content/docs';
const CONFIG = 'docs-site/astro.config.mjs';

/** Every .mdx page, as repo-relative POSIX paths, sorted for stable output. */
function mdxFiles(dir = DOCS_DIR, acc = []) {
  for (const entry of readdirSync(dir, {withFileTypes: true})) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) mdxFiles(full, acc);
    else if (entry.name.endsWith('.mdx')) acc.push(full.split('\\').join('/'));
  }
  return acc.sort();
}

/** The configured `base`, read from the single place it is declared. */
function configuredBase() {
  const src = readFileSync(CONFIG, 'utf8');
  const m = src.match(/^const base\s*=\s*["']([^"']+)["']/m);
  assert.ok(m, `could not find "const base = ..." in ${CONFIG}`);
  return m[1].replace(/\/$/, '');
}

/**
 * A page's own URL directory, relative to the site root: '' for the landing
 * page, 'faq/' for the FAQ page, 'how-it-works/config-js/' for a nested page.
 */
function ownDirOf(file) {
  const rel = posix.relative(DOCS_DIR, file);
  return rel === 'index.mdx' ? '' : rel.replace(/\.mdx$/, '/');
}

/** Route paths that exist, e.g. '', 'faq/', 'how-it-works/config-js/'. */
function knownPages() {
  return new Set(mdxFiles().map(f => ownDirOf(f)));
}

/** Line number of `index` within `src`, 1-based. */
const lineAt = (src, index) => src.slice(0, index).split('\n').length;

const EXTERNAL = /^(?:https?:|mailto:|tel:|\/\/|#)/;

/**
 * An MDX expression link, e.g. `{assetUrl('latest', ...)}` — not a literal
 * path.
 */
const isExpression = target => target.includes('{');

/**
 * Every link destination in a page, with its line number. Covers markdown
 * links, href="" attributes and frontmatter `link:` values.
 */
function linkTargets(src) {
  const found = [];
  const forms = [
    {re: /\]\(([^)\s]+)/g, kind: 'markdown link'},
    {re: /href="([^"]+)"/g, kind: 'href attribute'},
    {re: /^\s*link:\s*(\S+)/gm, kind: 'frontmatter link'},
  ];
  for (const {re, kind} of forms) {
    let m;
    while ((m = re.exec(src)) !== null)
      found.push({target: m[1], kind, line: lineAt(src, m.index)});
  }
  return found;
}

test('every docs page is discovered', () => {
  const files = mdxFiles();
  assert.ok(files.length >= 8, `expected the site's pages, found ${files.length}`);
  // The landing page is installation.mdx served via a / -> /installation/
  // redirect — there is intentionally no index.mdx copy.
  assert.ok(files.includes('docs-site/src/content/docs/installation.mdx'));
  assert.ok(
    !files.includes('docs-site/src/content/docs/index.mdx'),
    'index.mdx must not come back as a copy of the landing page'
  );
});

test('no root-absolute internal links in docs content', () => {
  const offenders = [];
  for (const file of mdxFiles()) {
    const src = readFileSync(file, 'utf8');
    for (const {target, kind, line} of linkTargets(src)) {
      if (!target.startsWith('/') || target.startsWith('//')) continue; // not site-absolute
      if (target.startsWith(`${configuredBase()}/`)) continue; // a public asset, checked below
      offenders.push(
        `${file}:${line}  ${kind} -> ${target}\n` +
          `    Astro does not add base to content links (withastro/astro#5680),\n` +
          `    so this resolves to ${target} on the live site and 404s. Use a relative link.`
      );
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `root-absolute internal link(s) that will 404 under base:\n\n  ${offenders.join('\n  ')}`
  );
});

test('every internal link resolves to a page that exists', () => {
  // The subtle half of the contract: a relative link is only correct if it
  // climbs exactly the right number of levels. Resolve each one the way a
  // browser would — against the linking page's own URL — then require the
  // result to land on a real page inside the site.
  const base = configuredBase();
  const pages = knownPages();
  const offenders = [];

  for (const file of mdxFiles()) {
    const src = readFileSync(file, 'utf8');
    const ownDir = ownDirOf(file);

    for (const {target, kind, line} of linkTargets(src)) {
      if (EXTERNAL.test(target) || target.startsWith('/') || isExpression(target)) continue;

      const pathOnly = target.split('#')[0].split('?')[0];
      if (!pathOnly) continue; // fragment-only link

      // A browser resolves a relative link against the page's FULL url, base
      // included — the FAQ page sits at `${base}/faq/`, not at `/faq/`.
      const absolute = posix.resolve('/', `${base}/${ownDir}`, pathOnly);
      if (absolute !== base && !absolute.startsWith(`${base}/`)) {
        // Climbed above the site root — the link cannot be right.
        offenders.push(
          `${file}:${line}  ${kind} -> "${target}"\n` +
            `    resolves to ${absolute}, which is OUTSIDE the site (${base}/…). Too many "../".`
        );
        continue;
      }
      const inSite = absolute === base ? '' : absolute.slice(base.length + 1);
      const route = inSite === '' ? '' : `${inSite.replace(/\/$/, '')}/`;

      // A page route is only ever built as <route>/index.html, so the link
      // must carry the trailing slash: "../config-js" is a 404, "../config-js/"
      // resolves. GitHub Pages does not redirect the slashless form for us.
      if (!pathOnly.endsWith('/')) {
        offenders.push(
          `${file}:${line}  ${kind} -> "${target}"\n` +
            `    the built route is /${route} — a link to a page needs the trailing slash.`
        );
        continue;
      }

      if (!pages.has(route)) {
        offenders.push(
          `${file}:${line}  ${kind} -> "${target}"\n` +
            `    climbs from /${ownDir} to ${absolute}, i.e. /${route} — no such page.\n` +
            `    From this page a link to a root-level page needs ` +
            `"${'../'.repeat(ownDir.split('/').filter(Boolean).length)}".`
        );
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `internal link(s) that do not resolve to a real page:\n\n  ${offenders.join('\n  ')}`
  );
});

test('no markdown link with an expression destination', () => {
  // MDX does not parse `[text]({expression})` — there is no link there to
  // parse, so the raw text `[text]({expression})` is rendered literally and
  // the page shows unclickable markup. Use a JSX anchor instead:
  // `<a href={expression}><code>text</code></a>`.
  // (Seen on the /download packages table, which builds its URLs from the
  // fetched manifest at build time.)
  const offenders = [];
  for (const file of mdxFiles()) {
    const src = readFileSync(file, 'utf8');
    const re = /\]\(\s*\{/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      offenders.push(
        `${file}:${lineAt(src, m.index)}  markdown link with an expression destination\n` +
          `    renders as literal text. Use <a href={...}> instead.`
      );
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `markdown link(s) whose destination is a JSX expression:\n\n  ${offenders.join('\n  ')}`
  );
});

test('public asset references carry the base prefix', () => {
  // The counterpart invariant: images live in public/ and are addressed from
  // the site root, so they need `base` spelled out. An unprefixed src fails in
  // production while working in dev — the same failure mode, opposite fix.
  const base = configuredBase();
  const offenders = [];
  for (const file of mdxFiles()) {
    const src = readFileSync(file, 'utf8');
    const re = /<img[^>]*\ssrc="([^"]+)"/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const target = m[1];
      if (EXTERNAL.test(target)) continue;
      if (!target.startsWith(`${base}/`)) {
        offenders.push(
          `${file}:${lineAt(src, m.index)}  <img src="${target}"> must start with "${base}/"`
        );
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `public asset src without the base prefix:\n  ${offenders.join('\n  ')}`
  );
});
