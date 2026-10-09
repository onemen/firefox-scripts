#!/usr/bin/env node

/**
 * tools/check-yaml-frontmatter.mjs — parse the YAML a change actually touches.
 *
 * The failure shape: a `: ` inside a multi-line YAML plain scalar ends the
 * scalar and starts a new mapping key — the host reads no `description` at all
 * and the skill is never registered, silently. Nothing else in the toolchain
 * catches it: prettier's markdown-frontmatter path is lenient (`prettier
 * --check`on the buggy file exits 0) and`@eslint/markdown`'s `frontmatter:
 * 'yaml'`option does not validate.`.yml` _files_ are already covered (prettier
 * parses them and exits 2 on a syntax error) — what is ungated is YAML hiding
 * inside markdown frontmatter, and this repo keeps the metadata that makes its
 * own skills loadable there.
 *
 * Scope: only files the change touches, and within a markdown file only the
 * lines of its frontmatter block. A repo-wide scan would flag vendored text and
 * get disabled within a week (the ADR 0022 line is about _mutating_ gates; a
 * validating gate applies to everything, so `.agents/skills/` — vendored
 * included — is in scope here).
 *
 * Base resolution matches tools/check-md-list-markers.mjs: the merge base with
 * `main` (the review-time surface CI PR runs share), `BASE_SHA` overrides
 * everything, and no resolvable base fails loudly with exit 2 rather than
 * silently scanning nothing. `CHANGED_FILES` (newline-separated) bypasses git
 * entirely — the test and manual-run seam.
 *
 * One `git diff -U0` supplies both the changed-file list and the added-line
 * numbers, so the whole gate is a single git invocation plus N in-process
 * parses. Parsing is the cheap part; process startup and git are the budget.
 *
 * Exit codes: 0 = clean, 1 = a parse error, 2 = no resolvable diff base. Run
 * via `pnpm lint` (lint:yaml stage) and the pre-push hook.
 */

import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

import {load, YAMLException} from 'js-yaml';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Extensions whose whole file is YAML. */
const YAML_EXT_RE = /\.ya?ml$/;

/** Markdown-ish extensions that may carry a frontmatter block. */
const MARKDOWN_EXT_RE = /\.mdx?$/;

/** Pathspecs handed to the single `git diff -U0`. */
const PATHSPECS = ['*.md', '*.mdx', '*.yaml', '*.yml'];

/** Never scanned: build products, the git dir, installed dependencies. */
const EXCLUDED_SEGMENTS = ['node_modules', 'dist', '.git'];
// pnpm-lock.yaml is machine-generated multi-document YAML (a leading '---'
// plus a supply-chain metadata document); this gate is a frontmatter/changed-YAML
// parser, not a lockfile validator, and issue #413's colon rule does not apply
// to it. The lockfile's own integrity gate is `pnpm install --frozen-lockfile`,
// which fails the job when it is inconsistent with package.json.
const EXCLUDED_FILES = new Set(['pnpm-lock.yaml']);

/**
 * A markdown frontmatter block: the file's first line is exactly `---`, and the
 * closing `---` is a later line. Returns null when the file has no block.
 *
 * @param {string} text file content, already CRLF-normalized
 * @returns {{start: number; end: number; body: string} | null} `start` is the
 *   1-based line of the first body line, `end` the 1-based line of the closing
 *   fence, `body` the block's text
 */
export function frontmatterRange(text) {
  if (!/^---[ \t]*\n/.test(text)) return null;
  const lines = text.split('\n');
  const close = lines.indexOf('---', 1);
  if (close === -1) return null;
  return {start: 2, end: close, body: lines.slice(1, close).join('\n')};
}

/**
 * True when any added line falls inside `[start, end]`.
 *
 * @param {{start: number; end: number}} range
 * @param {Set<number> | undefined} added added line numbers (undefined = no
 *   line information, i.e. treat as changed)
 * @returns {boolean}
 */
export function rangeTouched(range, added) {
  if (!added) return true;
  for (let n = range.start; n <= range.end; n++) if (added.has(n)) return true;
  return false;
}

/**
 * One `git diff -U0 <base>...HEAD` parsed into "added new-file line numbers per
 * file". A modified line counts as added (git shows it as a `-`/`+` pair),
 * which is what a frontmatter edit looks like.
 *
 * @param {string} diff raw diff text
 * @returns {Map<string, Set<number>>}
 */
export function parseAddedLines(diff) {
  const out = new Map();
  let file = null;
  let added = null;
  let line = 0;
  const setFile = rel => {
    if (rel === null) {
      file = null;
      added = null;
      return;
    }
    file = rel;
    if (!out.has(rel)) out.set(rel, new Set());
    added = out.get(rel);
  };
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      setFile(null);
      continue;
    }
    if (raw.startsWith('+++ ')) {
      // `+++ b/<path>`; a deleted file's `/dev/null` is filtered by --diff-filter
      const target = unquotePath(raw.slice(4));
      setFile(target === '/dev/null' ? null : target.replace(/^[ab]\//, ''));
      continue;
    }
    if (raw.startsWith('@@ ')) {
      const m = /\+(\d+)/.exec(raw);
      line = m ? Number(m[1]) : 0;
      continue;
    }
    if (file === null) continue;
    if (raw.startsWith('+')) {
      added.add(line);
      line += 1;
    } else if (raw.startsWith(' ') || raw === '') {
      line += 1;
    }
    // '-', '\' and hunk metadata do not advance the new-file counter
  }
  return out;
}

/**
 * Undo git's path quoting (it wraps a path in `"` when it contains a space or a
 * quote and escapes those characters). The diff runs with
 * `core.quotepath=false`, so non-ASCII bytes are emitted literally and no octal
 * unescaping is needed.
 *
 * @param {string} p
 * @returns {string}
 */
function unquotePath(p) {
  return p.startsWith('"') ? p.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\') : p;
}

/**
 * Which changed files could carry YAML this gate cares about, relative to the
 * repo root.
 *
 * @param {Map<string, Set<number>>} addedByFile
 * @returns {{file: string; added: Set<number>}[]}
 */
export function yamlCandidates(addedByFile) {
  const out = [];
  for (const [rel, added] of addedByFile) {
    if (EXCLUDED_SEGMENTS.some(seg => rel.split('/').includes(seg))) continue;
    if (EXCLUDED_FILES.has(rel)) continue;
    if (YAML_EXT_RE.test(rel)) {
      out.push({file: rel, added});
      continue;
    }
    if (!MARKDOWN_EXT_RE.test(rel)) continue;
    const abs = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(abs)) continue; // deleted after staging
    const range = frontmatterRange(fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n'));
    if (range && rangeTouched(range, added)) out.push({file: rel, added, range});
  }
  return out;
}

/**
 * Parse a markdown file's frontmatter block with js-yaml. The shared entry
 * point for every consumer of skill metadata: this gate and
 * `tools/check-skills.mjs`, so "is this frontmatter valid?" and "what does it
 * say?" have one answer instead of a regex and a parser disagreeing.
 *
 * A parse error is returned, not thrown: the watchdog and check-skills both
 * need to _report_ malformed frontmatter, which is the case this exists for.
 *
 * @param {string} text file content, CRLF tolerated
 * @param {string} [file] the file's label, carried into an error finding
 * @returns {{
 *   present: boolean;
 *   range?: {start: number; end: number; body: string};
 *   data?: unknown;
 *   error?: {file: string; line: number; column: number; reason: string};
 * }}
 *   `present` false = no frontmatter block at all
 */
export function parseFrontmatter(text, file = '<frontmatter>') {
  const range = frontmatterRange(text.replace(/\r\n/g, '\n'));
  if (!range) return {present: false};
  try {
    return {present: true, range, data: load(range.body)};
  } catch (err) {
    return {present: true, range, error: yamlFinding(file, err, 1)};
  }
}

/**
 * A js-yaml exception as a 1-based finding. `lineOffset` is the file line of
 * the parsed text's first line, minus one: js-yaml's `mark.line` is 0-based.
 *
 * @param {string} file
 * @param {any} err
 * @param {number} lineOffset
 * @returns {{file: string; line: number; column: number; reason: string}}
 */
function yamlFinding(file, err, lineOffset) {
  return {
    file,
    line: (err?.mark?.line ?? 0) + lineOffset + 1,
    column: (err?.mark?.column ?? 0) + 1,
    reason: err instanceof YAMLException ? (err.reason ?? err.message) : String(err),
  };
}

/**
 * Parse one candidate's YAML. Returns null when clean, otherwise a finding with
 * 1-based file line/column.
 *
 * @param {{
 *   file: string;
 *   range?: {start: number; end: number; body: string};
 * }} candidate
 * @returns {{
 *   file: string;
 *   line: number;
 *   column: number;
 *   reason: string;
 * } | null}
 */
export function parseCandidate(candidate) {
  let text;
  // js-yaml's mark is 0-based within the text it parsed; the block's first
  // body line is file line 2 (line 1 is the opening fence).
  let lineOffset;
  if (candidate.range) {
    text = candidate.range.body;
    lineOffset = 1;
  } else {
    const abs = path.join(REPO_ROOT, candidate.file);
    if (!fs.existsSync(abs)) return null;
    text = fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');
    lineOffset = 0;
  }
  try {
    load(text);
    return null;
  } catch (err) {
    return yamlFinding(candidate.file, err, lineOffset);
  }
}

/**
 * The diff base for the current checkout: `BASE_SHA` when set, else the merge
 * base with `main`, else `HEAD~1` (shallow/partial checkouts). Null when none
 * resolve — the caller decides whether that is fatal.
 *
 * @param {string} cwd
 * @returns {string | null}
 */
function resolveBaseSha(cwd) {
  if (process.env.BASE_SHA) return process.env.BASE_SHA;
  try {
    const out = execFileSync('git', ['-C', cwd, 'merge-base', 'main', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (out) return out;
  } catch {
    // no merge base — fall through
  }
  try {
    return execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD~1'], {encoding: 'utf8'}).trim();
  } catch {
    return null;
  }
}

/**
 * The changed-file map: `CHANGED_FILES` (newline-separated, no line numbers) or
 * the diff against the base.
 *
 * @param {string} cwd
 * @param {string} base
 * @param {typeof execFileSync} [runGit]
 * @returns {Map<string, Set<number>>}
 */
export function changedYamlMap(cwd, base, runGit = execFileSync) {
  if (process.env.CHANGED_FILES) {
    const map = new Map();
    // No line numbers from this seam: undefined means "treat the whole file as
    // changed", which is what a plain file list can honestly claim.
    for (const f of process.env.CHANGED_FILES.split('\n')
      .map(s => s.trim())
      .filter(Boolean)) {
      if (YAML_EXT_RE.test(f) || MARKDOWN_EXT_RE.test(f)) map.set(f, undefined);
    }
    return map;
  }
  const diff = runGit(
    'git',
    [
      '-C',
      cwd,
      '-c',
      'core.quotepath=false',
      'diff',
      '-U0',
      '--diff-filter=ACMR',
      `${base}...HEAD`,
      '--',
      ...PATHSPECS,
    ],
    {encoding: 'utf8', maxBuffer: 32 * 1024 * 1024}
  );
  return parseAddedLines(diff);
}

function main() {
  const base = resolveBaseSha(REPO_ROOT);
  if (!base) {
    console.error(
      'check-yaml-frontmatter: could not resolve a diff base (no BASE_SHA, no merge base with ' +
        'main, no HEAD~1) — set BASE_SHA to run the gate.'
    );
    process.exit(2);
  }
  const candidates = yamlCandidates(changedYamlMap(REPO_ROOT, base));
  if (candidates.length === 0) {
    console.log('check-yaml-frontmatter: no changed YAML (0 files scanned).');
    return;
  }
  const findings = candidates.map(parseCandidate).filter(f => f !== null);
  if (findings.length > 0) {
    console.error(
      [
        `check-yaml-frontmatter: ${findings.length} YAML syntax error(s) in the change.`,
        ...findings.map(f => `  ${f.file}:${f.line}:${f.column}: ${f.reason}`),
        'A ": " inside a multi-line plain scalar ends the scalar and starts a new key — quote the',
        'value or drop the colon (see issue #413).',
      ].join('\n')
    );
    process.exit(1);
  }
  console.log(`check-yaml-frontmatter: clean (${candidates.length} changed YAML file(s) parsed).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
