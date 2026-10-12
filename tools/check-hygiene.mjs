#!/usr/bin/env node

/**
 * tools/check-hygiene.mjs — forbid leftover references in tracked files.
 *
 * Five guards (issue #516, `lint:hygiene` stage). The shapes are general on
 * purpose: marker numbers and local-draft names are arbitrary, so the patterns
 * match families, never quoted specimens.
 *
 * 1. The dot-local dir: code must never touch it (uncommitted local drafts;
 *    AGENTS.md). A bare dot-local-slash occurrence in code-like files is a
 *    violation, as is a quoted dot-local name in any separator shape — property
 *    access like `element.localName` is unquoted code and stays clean, as do
 *    system paths stay clean (the XDG store dir — judged absolute from the path
 *    or string start, so dot-led and bare relative paths still flag). Docs may
 *    explain the gitignore rule itself, so there only a concrete dot-local path
 *    reference counts.
 * 2. Leftover markers: batch / audit / section tokens carrying an ID in code are
 *    review provenance that should never have shipped. The digit-less
 *    placeholders issues use to describe this rule stay clean.
 * 3. Uncommitted-conversation references: code cites docs, code, issues or PRs —
 *    never a transcript from a machine chat (share links and chat phrasing).
 * 4. Authored skills stay under SKILL_LINE_CAP lines. Third-party skills carry
 *    github-repo frontmatter and are exempt (byte-identical upstream, ADR
 *    0022).
 * 5. New prose and comments never use the em dash character (commas, parentheses,
 *    or periods instead). Only added lines are judged, so the existing
 *    occurrences are grandfathered; string literals, fenced code blocks, and
 *    inline code spans are not prose and stay out of scope.
 *
 * Comment hygiene in this file: the literal tokens are never written here —
 * fixtures in the test build them by concatenation, prose uses placeholders
 * without digits, and separator classes are bracketed so no literal shape
 * occurs. (The one exception the file cannot avoid is none: this comment itself
 * carries no literal.) Upstream license text (core/LICENSE) is excluded from
 * the marker scan — it is not ours to reword. The scan covers git-tracked files
 * only, so untracked drafts and build products are out of scope by
 * construction.
 *
 * Exit code 0 = clean. Run via `pnpm lint` (lint:hygiene stage).
 */

import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Authored skills longer than this fail the gate. */
export const SKILL_LINE_CAP = 500;

// Literal regexes (the security lint forbids non-literal RegExp arguments).
// LOCAL_REF_RE matches any dot-local-slash occurrence; QUOTED_LOCAL_RE a
// quoted dot-local name in any separator shape (slash, backslash, dot) —
// unquoted property access stays clean. LOCAL_CONCRETE_RE is the docs rule:
// only a concrete path beneath the dir counts there.
export const LOCAL_REF_RE = /\.local[/\\]/;
export const QUOTED_LOCAL_RE = /['"`][^'"`\n]*\.local(?=[./\\])/;

/**
 * Whether a bare occurrence sits in a system path. Tilde, dollar and drive
 * colon always anchor; a slash anchors except for dot-led relative paths (`./`,
 * `../`) — those are repo-relative, not system roots. Anything else before the
 * dot (a bare name like `foo`) is a repo draft too.
 *
 * @param {string} line
 * @param {number} index index of the `.local` occurrence
 * @returns {boolean}
 */
export function isSystemAnchored(line, index) {
  if (index === 0) return false;
  const prev = line[index - 1];
  if (prev === '/' || prev === '\\') {
    return line[index - 2] !== '.';
  }
  return /[~$:]/.test(prev);
}

/**
 * Whether a quoted string literal holds a system path, judged from inside the
 * string: rooted at `/`, `\`, `~`, `$` or a drive letter it is absolute (the
 * XDG store dir); anything else — bare names, dot-led paths — is a
 * repo-relative draft. Only the first character decides, so absolute paths
 * containing spaces stay safe.
 *
 * @param {string} line
 * @param {number} quoteIndex index of the opening quote
 * @returns {boolean}
 */
function isQuotedSystemPath(line, quoteIndex) {
  let i = quoteIndex + 1;
  while (line[i] === ' ' || line[i] === '\t') i++;
  const head = line[i];
  if (head === '/' || head === '\\' || head === '~' || head === '$') return true;
  return /[A-Za-z]/.test(head) && line[i + 1] === ':';
}
export const LOCAL_CONCRETE_RE = /\.local\/[\w.-]+/;
export const MARKER_RE =
  /\b(?:batch #\d+|audit P\d[\w.-]*|[Ss]ection\s+(?:[A-Za-z]\b|[A-Za-z]*\d[\w.-]*))/;
export const CHAT_RE =
  /(?:chatgpt\.com|claude\.ai|chat\.openai\.com|gemini\.google\.com)\/|AI[ -]chat|chat[ -]transcript/i;

// Code-like extensions under the strict rules. Docs (.md) get the concrete
// path rule only — prose about the gitignore rule itself is legitimate.
// The em dash, matched by escape so this file never carries the literal: the
// test builds it the same way, and added-lines-only judging keeps this very// description clean.
export const EM_DASH_RE = /\u2014/;
const MD_FENCE_RE = /^(`{3,}|~{3,})/;
const MD_INLINE_CODE_RE = /`[^`\n]*`/g;
const QUOTED_SPAN_RE = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g;

const CODE_EXTS = new Set(['.js', '.mjs', '.c', '.h', '.yml', '.sh', '.ps1']);

/**
 * Dot-local violations: every code-like file carrying the ref, plus every docs
 * file carrying a concrete dot-local path.
 *
 * @param {{path: string; lines: string[]}[]} files
 * @returns {string[]}
 */
export function findLocalRefs(files) {
  const violations = [];
  for (const file of files) {
    const isDocs = file.path.endsWith('.md');
    for (let i = 0; i < file.lines.length; i++) {
      const line = file.lines[i];
      let hit = false;
      if (isDocs) {
        // Concrete dot-local paths count in docs — but the system-path
        // distinction applies here too: an XDG location is not a repo draft.
        for (const match of line.matchAll(/\.local\/[\w.-]+/g)) {
          if (!isSystemAnchored(line, match.index)) {
            hit = true;
            break;
          }
        }
      } else {
        for (const match of line.matchAll(/\.local(?=[/\\])/g)) {
          if (!isSystemAnchored(line, match.index)) {
            hit = true;
            break;
          }
        }
        if (!hit) {
          for (const match of line.matchAll(/['"`][^'"`\n]*\.local(?=[./\\])/g)) {
            if (!isQuotedSystemPath(line, match.index)) {
              hit = true;
              break;
            }
          }
        }
      }
      if (hit) {
        violations.push(`${file.path}:${i + 1}: references the untracked dot-local dir`);
        break;
      }
    }
  }
  return violations;
}

/**
 * Leftover batch/audit/section marker violations in code-like files. Upstream
 * license text is excluded — its section numbering is not ours to reword
 * (AGENTS.md provenance rule).
 *
 * @param {{path: string; lines: string[]}[]} files
 * @returns {string[]}
 */
export function findMarkers(files) {
  const violations = [];
  for (const file of files) {
    if (file.path.endsWith('.md')) continue;
    if (/(^|\/)LICENSE$/.test(file.path)) continue;
    for (let i = 0; i < file.lines.length; i++) {
      if (MARKER_RE.test(file.lines[i])) {
        violations.push(`${file.path}:${i + 1}: leftover batch/audit/section marker`);
      }
    }
  }
  return violations;
}

/**
 * Uncommitted-conversation references in code-like files: share links and chat
 * phrasing. Cites belong to docs, code, issues or PRs.
 *
 * @param {{path: string; lines: string[]}[]} files
 * @returns {string[]}
 */
export function findChatRefs(files) {
  const violations = [];
  for (const file of files) {
    if (file.path.endsWith('.md')) continue;
    for (let i = 0; i < file.lines.length; i++) {
      if (CHAT_RE.test(file.lines[i])) {
        violations.push(`${file.path}:${i + 1}: uncommitted-conversation reference`);
      }
    }
  }
  return violations;
}

/**
 * Whether an added line in a code file reads as a comment. Line-local on
 * purpose: quoted spans are stripped first (escape-aware), so a dash inside a
 * string literal never counts. Block-comment interiors without a marker are
 * missed; the repo's marker-led JSDoc and docblock style keeps that gap small.
 *
 * @param {string} line one added line
 * @returns {boolean}
 */
export function isCommentLine(line) {
  const stripped = line.replace(QUOTED_SPAN_RE, "''");
  const trimmed = stripped.trimStart();
  return (
    trimmed.startsWith('//') ||
    trimmed.startsWith('#') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('<!--') ||
    stripped.includes('//') ||
    stripped.includes('/*') ||
    stripped.includes('*/')
  );
}

/**
 * New em dashes in prose and comments. Markdown files are prose except fenced
 * code blocks and inline code spans; code files judge comment lines only, so
 * string literals (including user-facing UI text) stay out of scope.
 *
 * @param {{path: string; lines: string[]; added: Set<number>}[]} files
 * @returns {string[]}
 */
export function findEmDashes(files) {
  const violations = [];
  for (const file of files) {
    const ext = path.extname(file.path).toLowerCase();
    const prose = ext === '.md';
    if (!prose && !CODE_EXTS.has(ext)) continue;
    let inFence = false;
    for (let i = 0; i < file.lines.length; i++) {
      const no = i + 1;
      const raw = file.lines[i];
      const fence = prose && MD_FENCE_RE.test(raw.trimStart());
      if (!file.added.has(no)) {
        if (fence) inFence = !inFence;
        continue;
      }
      if (prose) {
        if (fence) {
          inFence = !inFence;
          continue;
        }
        if (inFence) continue;
        if (EM_DASH_RE.test(raw.replace(MD_INLINE_CODE_RE, '``'))) {
          violations.push(
            `${file.path}:${no}: new prose uses an em dash (use a comma, parens, or a period)`
          );
        }
      } else if (isCommentLine(raw) && EM_DASH_RE.test(raw.replace(QUOTED_SPAN_RE, "''"))) {
        violations.push(
          `${file.path}:${no}: new comment uses an em dash (use a comma, parens, or a period)`
        );
      }
    }
  }
  return violations;
}

/**
 * New-file start line of a `--unified=0` hunk header. Manual parsing rather
 * than a regex: the nested-quantifier shape trips
 * security/detect-unsafe-regex.
 *
 * @param {string} line hunk header line
 * @returns {number} the new-file start line, or 0 when unparseable
 */
export function parseHunkStart(line) {
  const plus = line.indexOf('+', 3);
  if (plus === -1) return 0;
  let end = plus + 1;
  while (end < line.length && line[end] >= '0' && line[end] <= '9') end += 1;
  if (end === plus + 1) return 0;
  return Number(line.slice(plus + 1, end));
}

/**
 * Added (new-file) line numbers per path from `--unified=0` diff text. Pure;
 * git stays in collectAddedLines so tests never shell out.
 *
 * @param {string} diffText raw unified diff with zero context lines
 * @returns {Map<string, Set<number>>} repo-relative path to added 1-based lines
 */
export function parseAddedLines(diffText) {
  const added = new Map();
  let file = null;
  let no = 0;
  for (const line of diffText.split('\n')) {
    if (line.startsWith('+++ ')) {
      const match = /^\+\+\+ b\/(.+)$/.exec(line);
      file = match ? match[1] : null;
    } else if (line.startsWith('@@ ')) {
      no = parseHunkStart(line);
    } else if (file !== null && line.startsWith('+')) {
      if (!added.has(file)) added.set(file, new Set());
      added.get(file).add(no);
      no += 1;
    }
  }
  return added;
}

function runGit(args) {
  return execFileSync('git', args, {cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 8 << 20});
}

function safeMergeBase(base) {
  try {
    const out = runGit(['merge-base', 'HEAD', base]).trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * Added-line sets for the em-dash guard: the working tree against HEAD (the
 * local and pre-push input) plus the PR range off the merge base when one
 * resolves (the CI input on a clean checkout), plus every line of covered
 * untracked files (all of it is new). Throws when git cannot answer, so main()
 * can stand this guard down loudly while the other guards still run.
 *
 * @param {{base?: string}} [opts]
 * @returns {Map<string, Set<number>>}
 */
export function collectAddedLines({base} = {}) {
  const added = new Map();
  const merge = other => {
    for (const [file, lines] of other) {
      if (!added.has(file)) added.set(file, new Set());
      for (const no of lines) added.get(file).add(no);
    }
  };
  merge(parseAddedLines(runGit(['diff', 'HEAD', '--unified=0', '--no-color', '--'])));
  const ref = base || process.env.GITHUB_BASE_REF || 'origin/main';
  const mergeBase = safeMergeBase(ref);
  if (mergeBase) {
    merge(
      parseAddedLines(runGit(['diff', '--unified=0', '--no-color', `${mergeBase}...HEAD`, '--']))
    );
  } else {
    merge(parseAddedLines(runGit(['diff', '--unified=0', '--no-color', ref, 'HEAD', '--'])));
  }
  const others = runGit(['ls-files', '--others', '--exclude-standard'])
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);
  for (const rel of others) {
    const ext = path.extname(rel).toLowerCase();
    if (ext !== '.md' && !CODE_EXTS.has(ext)) continue;
    const abs = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    const count = fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n').split('\n').length;
    if (!added.has(rel)) added.set(rel, new Set());
    for (let no = 1; no <= count; no++) added.get(rel).add(no);
  }
  return added;
}

/**
 * Authored skills over the line cap. Third-party skills (github-repo in
 * frontmatter) are exempt.
 *
 * @param {{path: string; frontmatter: string; lines: number}[]} skills
 * @returns {string[]}
 */
export function overlongSkills(skills) {
  return skills
    .filter(skill => !/github-repo:/.test(skill.frontmatter) && skill.lines > SKILL_LINE_CAP)
    .map(skill => `${skill.path}: ${skill.lines} lines over the ${SKILL_LINE_CAP}-line cap`);
}

function readTrackedFiles() {
  const out = execFileSync('git', ['ls-files'], {encoding: 'utf8', cwd: REPO_ROOT});
  return out
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
}

function readLines(rel) {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8').replace(/\r\n/g, '\n').split('\n');
}

export function skillInfo(rel) {
  // Normalize CRLF at read (repo rule): a lingering CRLF working-tree copy
  // would otherwise break the frontmatter match and misclassify a vendored
  // skill as authored.
  const text = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---/.exec(text);
  return {
    path: rel,
    frontmatter: match ? match[1] : '',
    lines: text.split('\n').length,
  };
}

// Only this tool's own fixtures exemption: none — the tool and its test
// never carry the literals (see the header), so no self-exclusion is needed.

// Argv-guarded like the other check-* tools: importing this module (the unit
// test does) must not run a full-tree scan, let alone process.exit from
// inside a test worker when the tree happens to be dirty.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const tracked = readTrackedFiles();
  const codeFiles = tracked.filter(
    rel => CODE_EXTS.has(path.extname(rel)) && !rel.startsWith('node_modules/')
  );
  const docsFiles = tracked.filter(rel => rel.endsWith('.md'));
  // git ls-files still lists files deleted from the working tree before the
  // deletion is staged — readFileSync would throw ENOENT and block the normal
  // delete-then-validate flow, so lint only what is actually on disk.
  const present = rel => fs.existsSync(path.join(REPO_ROOT, rel));
  const files = [...codeFiles, ...docsFiles]
    .filter(present)
    .map(rel => ({path: rel, lines: readLines(rel)}));

  const violations = [...findLocalRefs(files), ...findMarkers(files), ...findChatRefs(files)];

  // Guard 5 judges added lines only, so the grandfathered tree stays clean.
  // When git cannot answer, only this guard stands down (loudly); the rest
  // still run.
  try {
    const added = collectAddedLines();
    const fresh = [...added.keys()]
      .filter(rel => {
        const ext = path.extname(rel).toLowerCase();
        return (ext === '.md' || CODE_EXTS.has(ext)) && present(rel);
      })
      .map(rel => ({path: rel, lines: readLines(rel), added: added.get(rel)}));
    violations.push(...findEmDashes(fresh));
  } catch (err) {
    console.log(`check-hygiene: em-dash guard skipped (${String(err.message).split('\n')[0]})`);
  }

  const skillFiles = tracked.filter(
    rel => /^.agents\/skills\/[^/]+\/SKILL\.md$/.test(rel) && present(rel)
  );
  violations.push(...overlongSkills(skillFiles.map(skillInfo)));

  if (violations.length > 0) {
    for (const violation of violations) console.error(violation);
    process.exit(1);
  }
  console.log('check-hygiene: clean');
}
