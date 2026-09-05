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
 * - (default) `--check` — exit 1 when the generated block is out of sync (used by
 *   the format scripts and CI).
 * - `--fix` — rewrite the block in place (`pnpm format:fix`).
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
  if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) {
    // No (valid) managed block — append one after the existing content.
    const base = current.replace(/\r\n/g, '\n').replace(/\n+$/, '');
    return [...(base ? [base, ''] : []), ...block, ''].join('\n');
  }
  return [...lines.slice(0, beginIdx), ...block, ...lines.slice(endIdx + 1)].join('\n');
}

async function main() {
  const fix = process.argv.includes('--fix');
  const {thirdParty, authored} = classifySkills(REPO_ROOT);
  const ignoreFile = path.join(REPO_ROOT, PRETTIERIGNORE_PATH);
  const current = fs.existsSync(ignoreFile) ? fs.readFileSync(ignoreFile, 'utf8') : '';
  const desired = renderPrettierignore(current, thirdParty, authored);

  if (desired === current.replace(/\r\n/g, '\n')) {
    console.log(
      `skill gates: .prettierignore in sync (${thirdParty.length} third-party, ${authored.length} authored)`
    );
    return;
  }
  if (!fix) {
    console.error('skill gates: config/.prettierignore is out of sync with .agents/skills/.');
    console.error('Run: pnpm format:fix   (or: node tools/sync-skill-gates.mjs --fix)');
    process.exitCode = 1;
    return;
  }
  fs.writeFileSync(ignoreFile, desired);
  console.log(
    `skill gates: .prettierignore regenerated (${thirdParty.length} third-party, ${authored.length} authored)`
  );
}

/* Executed directly → run; imported → the sync test uses the pure helpers. */
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch(err => {
    console.error(err);
    process.exitCode = 1;
  });
}
