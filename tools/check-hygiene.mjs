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
