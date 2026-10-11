#!/usr/bin/env node

/**
 * tools/check-hygiene.mjs — forbid leftover references in tracked files.
 *
 * Three guards (issue #516, `lint:hygiene` stage):
 *
 * 1. The dot-local dir: code must never touch it (uncommitted local drafts;
 *    AGENTS.md). Any `.local/` occurrence in code-like files is a violation.
 *    Docs may explain the gitignore rule itself, so there only a concrete
 *    `.local/<path>` reference counts.
 * 2. Leftover markers: `batch #N` / `audit P..` tokens with digits in code are
 *    audit/batch provenance that should never have shipped. The digit-less
 *    placeholders issues use to describe this rule stay clean.
 * 3. Authored skills stay under SKILL_LINE_CAP lines. Third-party skills carry
 *    github-repo frontmatter and are exempt (byte-identical upstream, ADR
 *    0022).
 *
 * Comment hygiene in this file: the literal tokens are never written here —
 * fixtures in the test build them by concatenation, and the regexes below match
 * digits, so the `#N` / `P..` placeholders in prose stay clean. (This comment
 * itself avoids the dot-local-slash literal for the same reason.) The scan
 * covers git-tracked files only, so untracked drafts and build products are out
 * of scope by construction.
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
// LOCAL_REF_RE matches any dot-local-slash occurrence; LOCAL_CONCRETE_RE
// only a concrete path beneath it (what docs are gated on).
export const LOCAL_REF_RE = /\.local\//;
export const LOCAL_CONCRETE_RE = /\.local\/[\w.-]+/;
export const MARKER_RE = /\b(?:batch #\d+|audit P\d[\w.-]*)/;

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
    const re = isDocs ? LOCAL_CONCRETE_RE : LOCAL_REF_RE;
    for (let i = 0; i < file.lines.length; i++) {
      if (re.test(file.lines[i])) {
        violations.push(`${file.path}:${i + 1}: references the untracked dot-local dir`);
        break;
      }
    }
  }
  return violations;
}

/**
 * Leftover batch/audit marker violations in code-like files.
 *
 * @param {{path: string; lines: string[]}[]} files
 * @returns {string[]}
 */
export function findMarkers(files) {
  const violations = [];
  for (const file of files) {
    if (file.path.endsWith('.md')) continue;
    for (let i = 0; i < file.lines.length; i++) {
      if (MARKER_RE.test(file.lines[i])) {
        violations.push(`${file.path}:${i + 1}: leftover batch/audit marker`);
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

const violations = [...findLocalRefs(files), ...findMarkers(files)];

const skillFiles = tracked.filter(rel => /^.agents\/skills\/[^/]+\/SKILL\.md$/.test(rel));
violations.push(...overlongSkills(skillFiles.map(skillInfo)));

if (violations.length > 0) {
  for (const violation of violations) console.error(violation);
  process.exit(1);
}
console.log('check-hygiene: clean');
