#!/usr/bin/env node

/**
 * tools/sync-skill-gates.mjs — keep the lint/format gates in sync with the
 * third-party skills in `.agents/skills/` (ADR 0022).
 *
 * The third-party set is derived from each SKILL.md's `metadata.github-repo`
 * (the same `loadInventory()` source of truth the watchdog uses) and applied as
 * a generated block to `config/.prettierignore`. eslint's ignores are derived
 * directly at config-load (see `config/eslint.config.js`) — no static eslint
 * list exists.
 *
 * The `.prettierignore` policy is inverted for zero-touch vendor skills: a
 * managed block between BEGIN/END markers holds one glob ignoring every skill
 * directory, then one negated (un-ignore) line per authored skill, then one
 * comment line per third-party skill (provenance at a glance). (The literal
 * patterns live in config/.prettierignore — they cannot be spelled inside a
 * block comment: the glob's leading double-star-slash sequence is exactly what
 * terminates one.)
 *
 * Installing a new third-party skill needs no config edit at all; authoring a
 * new skill is the rare act, and `pnpm format:fix` regenerates the un-ignore
 * line for it (the authored skill must still be prettier-clean before push —
 * the format gate enforces that).
 *
 * Modes:
 *
 * - (default) `--check` — exit 1 when the generated block is out of sync, or when
 *   any skill-gating line sits outside the block (used by the format scripts
 *   and CI).
 * - `--fix` — rewrite the block in place and strip stray lines (`pnpm
 *   format:fix`).
 *
 * Fail-closed against the 4dd6640 regression class: a hand-written skill list
 * that survives beside the generated block silently re-gates vendor skills (and
 * breaks `gh skill update` detection) — so the block is the only place allowed
 * to gate the skills tree. `findStraySkillLines()` flags violators anywhere
 * else in the file; `--fix` strips them.
 *
 * Note: negated patterns (`!`) work in `.prettierignore` (verified against
 * prettier 3.9), so the inverted policy is safe.
 */

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {loadInventory} from './skills-watchdog.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const REPO_ROOT = path.resolve(__dirname, '..');

export const PRETTIERIGNORE_PATH = 'config/.prettierignore';
export const BEGIN_MARKER = '# BEGIN managed: third-party skills (generated — run pnpm format:fix)';
export const END_MARKER = '# END managed';

/**
 * The third-party/authored classification of `.agents/skills/`, from the
 * watchdog's loader (frontmatter `metadata.github-repo` = third-party).
 *
 * @param {string} root repo root
 * @returns {{thirdParty: string[]; authored: string[]}}
 */
export function classifySkills(root) {
  const thirdParty = loadInventory(root).map(i => i.skill);
  const skillsRoot = path.join(root, '.agents', 'skills');
  const authored = fs
    .readdirSync(skillsRoot, {withFileTypes: true})
    .filter(e => e.isDirectory() && fs.existsSync(path.join(skillsRoot, e.name, 'SKILL.md')))
    .map(e => e.name)
    .filter(name => !thirdParty.includes(name))
    .sort();
  return {thirdParty: thirdParty.sort(), authored};
}

/**
 * Compute the full desired `.prettierignore` content given the current file
 * text and the skill classification. Everything outside the managed block is
 * preserved byte-for-byte (modulo CRLF normalization).
 *
 * @param {string} current file content ('' for a fresh file)
 * @param {string[]} thirdParty
 * @param {string[]} authored
 * @returns {string}
 */
/**
 * A line that gates the skills tree. Inside the managed block these are
 * generated; anywhere else they are stale hand-written leftovers. Comments and
 * blank lines never count — prose may mention the policy freely.
 *
 * @param {string} line
 * @returns {boolean}
 */
function isSkillGateLine(line) {
  const t = line.trim();
  return t !== '' && !t.startsWith('#') && t.includes('.agents/skills');
}

/**
 * Unbalanced managed markers (orphan BEGIN or END, or duplicated pairs) — lines
 * the renderer treats as "no valid block" but that would survive a
 * regenerate-and-append. `--fix` must converge such a file in one run, so
 * orphaned marker lines are stripped before the fresh block is appended.
 *
 * @param {string[]} lines
 * @returns {boolean}
 */
function hasOrphanMarkers(lines) {
  const begins = lines.filter(l => l === BEGIN_MARKER).length;
  const ends = lines.filter(l => l === END_MARKER).length;
  const firstBegin = lines.indexOf(BEGIN_MARKER);
  const firstEnd = lines.indexOf(END_MARKER);
  return (
    begins !== 1 || ends !== 1 || firstBegin === -1 || firstEnd === -1 || firstEnd < firstBegin
  );
}

/**
 * Lines outside the managed block that gate `.agents/skills` — stale
 * hand-written entries (e.g. a static list that predated the block surviving
 * beside it) silently re-gate vendor skills, so `--check` fails on them and
 * `--fix` strips them.
 *
 * @param {string} current file content
 * @returns {{number: number; line: string}[]} 1-based line numbers + text
 */
export function findStraySkillLines(current) {
  const lines = current.replace(/\r\n/g, '\n').split('\n');
  const beginIdx = lines.indexOf(BEGIN_MARKER);
  const endIdx = lines.indexOf(END_MARKER);
  const hasBlock = beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx;
  const inBlock = i => hasBlock && i >= beginIdx && i <= endIdx;
  return lines
    .map((line, i) => ({number: i + 1, line}))
    .filter(({line}, i) => !inBlock(i) && isSkillGateLine(line));
}

/**
 * Compute the full desired `.prettierignore` content given the current file
 * text and the skill classification. Everything outside the managed block is
 * preserved byte-for-byte (modulo CRLF normalization) — except stray
 * skill-gating lines, which are dropped so `--fix` fully heals the file.
 *
 * @param {string} current file content ('' for a fresh file)
 * @param {string[]} thirdParty
 * @param {string[]} authored
 * @returns {string}
 */
export function renderPrettierignore(current, thirdParty, authored) {
  const block = [
    BEGIN_MARKER,
    '**/.agents/skills/*',
    ...authored.map(name => `!**/.agents/skills/${name}`),
    ...thirdParty.map(name => `# third-party (gh metadata): ${name}`),
    END_MARKER,
  ];
  const lines = current.replace(/\r\n/g, '\n').split('\n');
  const beginIdx = lines.indexOf(BEGIN_MARKER);
  const endIdx = lines.indexOf(END_MARKER);
  const hasBlock =
    beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx && !hasOrphanMarkers(lines);
  const inBlock = i => hasBlock && i >= beginIdx && i <= endIdx;
  // Stray gate lines AND orphaned markers (unbalanced/duplicated pairs) are
  // dropped, so one --fix run always converges to exactly one valid block.
  const kept = lines.filter(
    (line, i) =>
      inBlock(i) || (!isSkillGateLine(line) && line !== BEGIN_MARKER && line !== END_MARKER)
  );
  if (!hasBlock) {
    // No (valid) managed block — append one after the surviving content.
    const base = kept.join('\n').replace(/\n+$/, '');
    return [...(base ? [base, ''] : []), ...block, ''].join('\n');
  }
  const kBegin = kept.indexOf(BEGIN_MARKER);
  const kEnd = kept.indexOf(END_MARKER);
  return [...kept.slice(0, kBegin), ...block, ...kept.slice(kEnd + 1)].join('\n');
}

async function main() {
  const fix = process.argv.includes('--fix');
  const {thirdParty, authored} = classifySkills(REPO_ROOT);
  const ignoreFile = path.join(REPO_ROOT, PRETTIERIGNORE_PATH);
  const current = fs.existsSync(ignoreFile) ? fs.readFileSync(ignoreFile, 'utf8') : '';
  const stray = findStraySkillLines(current);
  const desired = renderPrettierignore(current, thirdParty, authored);

  if (desired === current.replace(/\r\n/g, '\n')) {
    console.log(
      `skill gates: .prettierignore in sync (${thirdParty.length} third-party, ${authored.length} authored)`
    );
    return;
  }
  if (!fix) {
    if (stray.length > 0) {
      console.error(
        `skill gates: ${PRETTIERIGNORE_PATH} gates .agents/skills outside the managed block (stale hand-written list?):`
      );
      for (const {number, line} of stray) console.error(`  line ${number}: ${line}`);
    } else {
      console.error('skill gates: config/.prettierignore is out of sync with .agents/skills/.');
    }
    console.error(
      'The managed block exclusively gates .agents/skills. Run: pnpm format:fix   (or: node tools/sync-skill-gates.mjs --fix)'
    );
    process.exitCode = 1;
    return;
  }
  fs.writeFileSync(ignoreFile, desired);
  const strayNote = stray.length > 0 ? `, stripped ${stray.length} stray line(s)` : '';
  console.log(
    `skill gates: .prettierignore regenerated (${thirdParty.length} third-party, ${authored.length} authored${strayNote})`
  );
}

/* Executed directly → run; imported → the sync test uses the pure helpers. */
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch(err => {
    console.error(err);
    process.exitCode = 1;
  });
}
