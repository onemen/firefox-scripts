#!/usr/bin/env node

/**
 * tools/check-docs-mdx.mjs flags editor residue that would ship to a reader
 * (docs site, #28).
 *
 * The failure shape: a docs page renders a TODO, a stray note to the next
 * author, or an HTML comment nobody can see. MDX gives no mechanical warning:
 * `{/* … *}/` and `<!-- … -->` both vanish from the rendered page, so the
 * marker is invisible exactly where it does damage: nobody can see it in the
 * preview, and the reader does not need to. The gate exists because the docs
 * pages are reviewed by reading the _rendered_ site, and rendered output is the
 * one place a residue marker is guaranteed not to appear.
 *
 * Scope: every `.mdx` under `docs-site/src/content/docs/`, repo-wide: not the
 * changed-lines scope of `tools/check-md-list-markers.mjs`. That gate scans all
 * repository prose, where a repo-wide pass would drown in pre-existing text;
 * this set is ten self-authored pages whose current content is clean, so the
 * strong form is affordable and catches a marker that was introduced in an
 * earlier commit and merely travelled along since. `dist/` and `node_modules/`
 * are never walked.
 *
 * Two findings, both scanned outside code and outside annotations:
 *
 * - `html-comment`: `<!--` anywhere. MDX has no HTML comments; the correct form
 *   is a JSX expression comment, and an HTML one is at best dead weight.
 * - `marker`: a bare `TODO` / `FIXME` / `XXX` / `HACK` (or `@todo`) in prose.
 *   Case-sensitive on purpose: a lowercase "todo" in an FAQ sentence is
 *   English, not residue, and a gate that cries wolf over prose gets switched
 *   off.
 *
 * Deliberately NOT findings:
 *
 * - fenced code blocks and inline code spans: a page that documents an HTML
 *   comment or a `TODO` token shows it in backticks, and quoting the mistake is
 *   not making it;
 * - `{/* … *}` annotations, these are the sanctioned review channel: the
 *   maintainer marks up a page with `{/* TODO: … *}/`, and MDX strips them, so
 *   they never reach a reader. They are the marker _moving to the source_
 *   rather than leaking into the prose. Remove the annotation when the fix
 *   lands.
 *
 * Exit code 0 = clean, 1 = findings, 2 = the content directory is missing (the
 * gate fails loudly rather than scanning nothing). Run via `pnpm lint`
 * (lint:mdx stage).
 */

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The docs content collection, relative to the repo root. */
export const CONTENT_DIR = 'docs-site/src/content/docs';

/** Never walked: build output and dependencies are not sources. */
const SKIPPED_DIRS = new Set(['node_modules', 'dist', '.astro']);

/** An HTML comment opener. MDX has no HTML comments; `<!--` is always residue. */
export const HTML_COMMENT_RE = /<!--/g;

/** A residue marker in prose. Case-sensitive, as documented above. */
export const MARKER_RE = /(?:\b(?:TODO|FIXME|XXX|HACK)\b|@todo\b)/g;

/** A JSX annotation comment (the sanctioned review channel), never a finding. */
const ANNOTATION_RE = /\{\/\*[\s\S]*?\*\//g;

/** An inline code span. */
const CODE_SPAN_RE = /`[^`\n]*`/g;

/** A fenced code block delimiter. */
const FENCE_RE = /^\s*(?:```|~~~)/;

/**
 * Replace a matched region with spaces, keeping its newlines so every following
 * offset, and therefore every line number, stays valid.
 *
 * @param {string} text
 * @returns {string}
 */
function blank(text) {
  return text.replace(/[^\n]/g, ' ');
}

/**
 * Blank the regions where a marker is not prose: fenced blocks first (whole
 * lines), then JSX annotations and inline code spans.
 *
 * Order matters. The inline-code-span pattern reads the backticks of a fence
 * delimiter as an empty code span, so masking spans first would erase the very
 * delimiters that establish the fence state, and every line inside the block
 * would then be scanned as prose. The delimiter lines themselves are left
 * intact: they are what the state machine reads.
 *
 * @param {string} text raw file contents; CRLF is normalized by the caller
 * @returns {string} same length and line structure, non-prose blanked out
 */
export function maskNonProse(text) {
  let inFence = false;
  const withoutFences = text
    .split('\n')
    .map(line => {
      if (FENCE_RE.test(line)) {
        inFence = !inFence;
        return line;
      }
      return inFence ? blank(line) : line;
    })
    .join('\n');
  return withoutFences.replace(ANNOTATION_RE, blank).replace(CODE_SPAN_RE, blank);
}

/**
 * Findings for one page: HTML comments and residue markers in rendered prose.
 *
 * @param {string} text the page's contents (CRLF tolerated)
 * @returns {{line: number; kind: string; snippet: string}[]}
 */
export function findFindings(text) {
  const original = text.replace(/\r\n/g, '\n').split('\n');
  const lines = maskNonProse(original.join('\n')).split('\n');
  const findings = [];
  for (const [index, masked] of lines.entries()) {
    for (const [kind, re] of /** @type {[string, RegExp][]} */ ([
      ['html-comment', HTML_COMMENT_RE],
      ['marker', MARKER_RE],
    ])) {
      re.lastIndex = 0;
      let match;
      while ((match = re.exec(masked)) !== null) {
        findings.push({
          line: index + 1,
          kind,
          snippet: snippetAround(original[index] ?? '', match.index, match[0].length),
        });
      }
    }
  }
  return findings;
}

/**
 * The offending text with a little context on each side, elided at the edges.
 *
 * @param {string} line the ORIGINAL line (the masked one is full of spaces)
 * @param {number} at match index within the line
 * @param {number} length match length
 * @returns {string}
 */
export function snippetAround(line, at, length) {
  const start = Math.max(0, at - 20);
  const end = Math.min(line.length, at + length + 20);
  return (start > 0 ? '…' : '') + line.slice(start, end) + (end < line.length ? '…' : '');
}

/**
 * Every `.mdx` page under the content collection, recursively, sorted.
 *
 * @param {string} [dir] absolute path to the content directory
 * @returns {string[]} absolute paths
 */
export function collectMdxFiles(dir = path.join(REPO_ROOT, CONTENT_DIR)) {
  const found = [];
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) found.push(...collectMdxFiles(abs));
    } else if (entry.name.endsWith('.mdx')) {
      found.push(abs);
    }
  }
  return found.sort();
}

function main() {
  const contentDir = path.join(REPO_ROOT, CONTENT_DIR);
  if (!fs.existsSync(contentDir)) {
    console.error(
      `check-docs-mdx: ${CONTENT_DIR} does not exist — the docs pages moved or the site was ` +
        'removed. Update CONTENT_DIR in tools/check-docs-mdx.mjs rather than deleting the gate.'
    );
    process.exit(2);
  }
  const files = collectMdxFiles(contentDir);
  const findings = [];
  for (const abs of files) {
    const rel = path.relative(REPO_ROOT, abs).replaceAll('\\', '/');
    for (const finding of findFindings(fs.readFileSync(abs, 'utf8'))) {
      findings.push({file: rel, ...finding});
    }
  }
  if (findings.length > 0) {
    console.error(
      [
        `check-docs-mdx: ${findings.length} editor residue marker(s) in the docs pages — these`,
        'render as text a reader can see, or are dead weight MDX strips anyway:',
        ...findings.map(f => `  ${f.file}:${f.line}: [${f.kind}] ${f.snippet}`),
        'Fix the prose, or move the note into a `{/* … *}` annotation (stripped at build time),',
        'or wrap it in backticks when the page is documenting the token itself.',
      ].join('\n')
    );
    process.exit(1);
  }
  console.log(`check-docs-mdx: clean (${files.length} docs page(s) scanned).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
