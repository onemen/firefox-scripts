'use strict';

// test/unit/docsSite/mdxResidue.test.mjs
//
// Contract under test: no docs page carries editor residue that would render
// to a reader — an HTML comment, or a bare TODO/FIXME/XXX/HACK marker in prose.
//
// Why (issue #28, docs-site): the pages are reviewed by reading the RENDERED
// site, and residue is invisible exactly where it does damage. `{/* … *}` and
// `<!-- … -->` both vanish from the rendered page, so a note-to-self left in the
// prose is something nobody can see in review — and the reader does not need to
// see either. tools/check-docs-mdx.mjs is the gate; these tests are its
// regression guard, and they also pin the two blind spots it must keep, since a
// gate that cries wolf over legitimate prose gets switched off.
//
// Pinned as NOT findings, deliberately:
//   - `{/* TODO: … *}` annotations — the sanctioned review channel. The marker
//     moved into the source instead of leaking into the text a reader sees;
//     MDX strips it at build time. This is what the maintainer uses to leave
//     review notes, so flagging it would break the review workflow itself.
//   - a marker inside backticks or a fenced block — a page documenting the token
//     quotes it; quoting the mistake is not making it.
//
// The masking must also preserve LINE NUMBERS: a blanked region is replaced by
// spaces, so a marker three lines below a fenced block still reports its real
// line. Test 5 pins that.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CONTENT_DIR, collectMdxFiles, findFindings} from '../../../tools/check-docs-mdx.mjs';

/** Built here so the expectations below read as pages, not escapes. */
const NL = String.fromCharCode(10);

/** The finding kinds a line of prose can produce. */
const kinds = text => findFindings(text).map(f => f.kind);

test('a bare TODO in prose is a finding', () => {
  assert.deepEqual(kinds('Some prose.\n\nTODO: rewrite this paragraph.\n'), ['marker']);
});

test('the marker line number is the line it sits on', () => {
  const findings = findFindings('line one\nline two\nFIXME: broken link\n');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 3);
  assert.equal(findings[0].kind, 'marker');
});

test('an HTML comment is a finding', () => {
  assert.deepEqual(kinds('text\n<!-- drop this sentence -->\n'), ['html-comment']);
});

test('every residue marker word is covered', () => {
  for (const marker of ['TODO', 'FIXME', 'XXX', 'HACK', '@todo']) {
    assert.deepEqual(kinds(`prose ${marker} more prose\n`), ['marker'], `${marker} not detected`);
  }
});

test('a JSX annotation is the sanctioned channel, never a finding', () => {
  assert.deepEqual(kinds('{/* TODO: ask the maintainer about this step */}\n\nReal prose.\n'), []);
  // …including the multi-line form, which is how a longer review note is written.
  assert.deepEqual(kinds('{/* TODO\n   two lines of note\n*/}\nprose\n'), []);
});

test('a marker inside code is documentation, not residue', () => {
  assert.deepEqual(
    kinds(
      'Use the `TODO` keyword here:' + NL + NL + '```js' + NL + '// TODO: sample' + NL + '```' + NL
    ),
    []
  );
  assert.deepEqual(kinds('Write `<!-- comment -->` to hide a line.\n'), []);
});

test('prose that MENTIONS the token is a finding — backtick it instead', () => {
  // The gate cannot tell "left behind" from "deliberately writing about the token",
  // so it flags both and the documented escape is backticks (the error message says so).
  assert.deepEqual(kinds('Use the TODO keyword here.\n'), ['marker']);
  assert.deepEqual(kinds('Use the `TODO` keyword here.\n'), []);
});

test('masking does not shift the line numbers of later findings', () => {
  const page = [
    'intro', // 1
    '', // 2
    '```js', // 3
    '// TODO: quoted sample', // 4  <- inside the fence, not a finding
    '```', // 5
    '', // 6
    'prose with `inline code` span', // 7
    '', // 8
    '{/* TODO: annotation */}', // 9
    '', // 10
    'TODO: a real leftover', // 11
  ].join('\n');
  const findings = findFindings(page);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 11);
});

test('lowercase "todo" in prose is English, not residue', () => {
  assert.deepEqual(kinds('Add the item to your todo list first.\n'), []);
});

test('CRLF sources are handled', () => {
  const findings = findFindings('prose\r\nTODO: windows line endings\r\nmore\r\n');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 2);
});

test('a marker inside a JSX attribute is still visible prose', () => {
  assert.deepEqual(kinds('<Aside title="TODO: rename this">\n  body\n</Aside>\n'), ['marker']);
});

test('collectMdxFiles finds nested pages and skips build output', () => {
  const root = mkdtempSync(join(tmpdir(), 'check-docs-mdx-'));
  try {
    mkdirSync(join(root, 'how-it-works'));
    mkdirSync(join(root, 'dist'));
    mkdirSync(join(root, 'node_modules'));
    writeFileSync(join(root, 'index.mdx'), '---\ntitle: a\n---\n');
    writeFileSync(join(root, 'how-it-works', 'config-js.mdx'), '---\ntitle: b\n---\n');
    writeFileSync(join(root, 'notes.md'), 'not a page\n');
    writeFileSync(join(root, 'dist', 'stale.mdx'), 'built output\n');
    writeFileSync(join(root, 'node_modules', 'vendored.mdx'), 'dependency\n');
    const found = collectMdxFiles(root).map(f => f.split('\\').join('/'));
    assert.equal(found.length, 2, found.join(','));
    assert.ok(found.some(f => f.endsWith('/index.mdx')));
    assert.ok(found.some(f => f.endsWith('/how-it-works/config-js.mdx')));
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('the live docs pages are clean', () => {
  const repoRoot = join(import.meta.dirname, '..', '..', '..');
  const dir = join(repoRoot, CONTENT_DIR);
  const pages = collectMdxFiles(dir);
  // Nine pages: the landing page is installation.mdx (via redirect), not a
  // separate index.mdx — see internalLinks.test.mjs.
  assert.ok(pages.length >= 9, `expected the full page set, found ${pages.length}`);
  const findings = pages.flatMap(file =>
    findFindings(readFileSync(file, 'utf8')).map(f => ({
      file: file.split('\\').join('/'),
      ...f,
    }))
  );
  assert.deepEqual(findings, []);
});

test('pnpm lint and pnpm lint:all both run the stage', () => {
  const pkg = JSON.parse(
    readFileSync(join(import.meta.dirname, '..', '..', '..', 'package.json'), 'utf8')
  );
  assert.match(pkg.scripts['lint:mdx'], /check-docs-mdx\.mjs/);
  assert.ok(pkg.scripts.lint.includes('lint:mdx'), 'lint must compose lint:mdx');
  assert.ok(pkg.scripts['lint:all'].includes('lint:mdx'), 'lint:all must run lint:mdx');
});
