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
 *    system-anchored paths (the XDG store dir). Docs may explain the gitignore
 *    rule itself, so there only a concrete dot-local path reference counts.
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
 * A dot-local occurrence anchored at a system path (tilde, slash, dollar,
 * backslash, drive colon) is XDG/absolute — not a repo draft. Repo-relative
 * drafts are bare or quote-led.
 *
 * @param {string} line
 * @param {number} index index of the `.local` occurrence
 * @returns {boolean}
 */
export function isSystemAnchored(line, index) {
  return index > 0 && /[/~$\\:]/.test(line[index - 1]);
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
        hit = LOCAL_CONCRETE_RE.test(line);
      } else {
        for (const match of line.matchAll(/\.local(?=[/\\])/g)) {
          if (!isSystemAnchored(line, match.index)) {
            hit = true;
            break;
          }
        }
        if (!hit) {
          for (const match of line.matchAll(/['"`][^'"`\n]*\.local(?=[./\\])/g)) {
            const at = match.index + match[0].lastIndexOf('.local');
            if (!isSystemAnchored(line, at)) {
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

function skillInfo(rel) {
  const text = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
  const match = /^---\n([\s\S]*?)\n---/.exec(text);
  return {
    path: rel,
    frontmatter: match ? match[1] : '',
    lines: text.replace(/\r\n/g, '\n').split('\n').length,
  };
}

// Only this tool's own fixtures exemption: none — the tool and its test
// never carry the literals (see the header), so no self-exclusion is needed.

const tracked = readTrackedFiles();
const codeFiles = tracked.filter(
  rel => CODE_EXTS.has(path.extname(rel)) && !rel.startsWith('node_modules/')
);
const docsFiles = tracked.filter(rel => rel.endsWith('.md'));
const files = [...codeFiles, ...docsFiles].map(rel => ({path: rel, lines: readLines(rel)}));

const violations = [...findLocalRefs(files), ...findMarkers(files), ...findChatRefs(files)];

const skillFiles = tracked.filter(rel => /^.agents\/skills\/[^/]+\/SKILL\.md$/.test(rel));
violations.push(...overlongSkills(skillFiles.map(skillInfo)));

if (violations.length > 0) {
  for (const violation of violations) console.error(violation);
  process.exit(1);
}
console.log('check-hygiene: clean');
