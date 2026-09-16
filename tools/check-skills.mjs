#!/usr/bin/env node

/**
 * tools/check-skills.mjs — validate SKILL.md frontmatter and run the vendored
 * skills' own tests (the 2026-09-15 audit's last unowned P2: the weekly
 * skills-watchdog parses frontmatter for drift detection, but nothing gates on
 * the metadata being well-formed, and the vendored skills' tests never run).
 *
 * ADR 0022 draws the line this tool stays behind: "gates that mutate apply to
 * things we author; gates that validate apply to everything." Nothing here
 * lints or formats skill text — it only validates structure and executes the
 * skills' own test files.
 *
 * Checks, per skill directory under `.agents/skills/`:
 *
 * - a SKILL.md exists (a directory without one is invisible to every other tool —
 *   flagged instead of silently skipped);
 * - the tree stays flat (ADR 0022, decision 4): every SKILL.md sits at
 *   `.agents/skills/<name>/SKILL.md` — a nested SKILL.md would betray a second
 *   discovery root. Vendored skills keep their internal folder layout
 *   (`scripts/`, `references/`, …) — the rule bounds the roots, not their
 *   contents;
 * - `name` and `description` are present and non-empty, and `name` matches the
 *   directory name;
 * - authored skills (no `metadata.github-repo`) carry no `metadata.github-*` keys
 *   at all — a partial block is the manually-copied-skill signature that ADR
 *   0022 retired;
 * - third-party skills carry all four gh-injected keys (`github-repo/-ref/
 *   -path/-tree-sha`) and a parseable `github-repo` URL.
 *
 * Frontmatter parsing is reused from tools/skills-watchdog.mjs — one parser,
 * one classification (`metadata.github-repo` = third-party).
 *
 * Finally, every `*.test.mjs` found inside a skill directory is executed with
 * `node --test` (vendored tests are the upstream project's own; today that is
 * `debugging-firefox/scripts/firefox-rdp.test.mjs`, a pure-Node suite). Skills
 * without test files contribute an informational count, not an error.
 *
 * Modes:
 *
 * - (default) check + run vendored tests; exit 1 on any error or test failure.
 * - `--skip-tests` — static validation only.
 *
 * Wired into `pnpm lint` (the checks job runs it on every PR).
 */

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

import {SKILLS_DIR, parseSkillFrontmatter} from './skills-watchdog.mjs';

const __filename = fileURLToPath(import.meta.url);

const GH_META_KEYS = ['github-repo', 'github-ref', 'github-path', 'github-tree-sha'];
const REPO_URL_RE =
  /^(?:(?:https?|ssh):\/\/(?:git@)?github\.com\/|git@github\.com:|github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/;

/**
 * Extract the frontmatter block (between the first two `---` lines), or null.
 *
 * @param {string} text SKILL.md content (CRLF tolerated)
 * @returns {string[] | null} the block's lines, without the fences
 */
function frontmatterLines(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines[0]?.trim() !== '---') return null;
  const end = lines.indexOf('---', 1);
  if (end === -1) return null;
  return lines.slice(1, end);
}

/**
 * True when `key` appears at the top level of the block with a non-empty value
 * — either inline (`key: value`) or as an indented continuation (`key:`
 * followed by deeper-indented lines). Tolerates both styles in use.
 *
 * @param {string[]} block frontmatter lines
 * @param {string} key
 */
function hasNonEmptyScalar(block, key) {
  const prefix = key + ':';
  for (let i = 0; i < block.length; i++) {
    const line = block[i];
    if (!line.startsWith(prefix)) continue;
    const rest = line.slice(prefix.length);
    if (rest.trim() !== '') return true;
    for (let j = i + 1; j < block.length; j++) {
      if (block[j].trim() === '') break;
      if (!/^\s/.test(block[j])) break; // next top-level key — value was empty
      if (block[j].trim() !== '') return true;
    }
    return false;
  }
  return false;
}

/**
 * SKILL.md paths below a skill directory, relative to it — a nested one would
 * mean a second skill-discovery root inside the tree (ADR 0022, decision 4).
 *
 * @param {string} dir absolute skill directory
 * @returns {string[]} e.g. `['agents/other/SKILL.md']`, empty when flat
 */
function findNestedSkillMds(dir) {
  const found = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const item of fs.readdirSync(current, {withFileTypes: true})) {
      const full = path.join(current, item.name);
      if (item.isDirectory()) stack.push(full);
      else if (item.name === 'SKILL.md' && path.dirname(full) !== dir) {
        found.push(path.relative(dir, full).replaceAll('\\', '/'));
      }
    }
  }
  return found.sort((a, b) => a.localeCompare(b));
}

/**
 * Statically validate every skill directory under `skillsDir`.
 *
 * @param {string} skillsDir absolute path to `.agents/skills/`
 * @returns {{file: string; message: string}[]} problems, empty when clean
 */
export function checkSkillsDir(skillsDir) {
  const errors = [];
  if (!fs.existsSync(skillsDir)) {
    return [{file: skillsDir, message: 'skills directory is missing'}];
  }
  for (const entry of fs
    .readdirSync(skillsDir, {withFileTypes: true})
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = `${SKILLS_DIR}/${entry.name}`;
    if (!entry.isDirectory()) {
      errors.push({
        file: rel,
        message: 'stray file in the skills root — the tree must stay flat (ADR 0022)',
      });
      continue;
    }
    const skillFile = path.join(skillsDir, entry.name, 'SKILL.md');
    if (!fs.existsSync(skillFile)) {
      errors.push({
        file: rel,
        message: 'SKILL.md is missing — the skill is invisible to every other tool',
      });
      continue;
    }
    for (const nestedSkillMd of findNestedSkillMds(path.join(skillsDir, entry.name))) {
      errors.push({
        file: `${rel}/${nestedSkillMd}`,
        message: 'nested SKILL.md — a second discovery root; skills stay flat (ADR 0022)',
      });
    }
    const text = fs.readFileSync(skillFile, 'utf8');
    const block = frontmatterLines(text);
    if (!block) {
      errors.push({file: `${rel}/SKILL.md`, message: 'no frontmatter block'});
      continue;
    }
    const {name, metadata} = parseSkillFrontmatter(text);
    if (!hasNonEmptyScalar(block, 'name') || !name) {
      errors.push({file: `${rel}/SKILL.md`, message: 'frontmatter has no non-empty name:'});
    } else if (name !== entry.name) {
      errors.push({
        file: `${rel}/SKILL.md`,
        message: `name "${name}" does not match directory name "${entry.name}"`,
      });
    }
    if (!hasNonEmptyScalar(block, 'description')) {
      errors.push({file: `${rel}/SKILL.md`, message: 'frontmatter has no non-empty description:'});
    }
    const ghKeys = Object.keys(metadata).filter(k => k.startsWith('github-'));
    if (metadata['github-repo']) {
      for (const key of GH_META_KEYS) {
        if (!metadata[key])
          errors.push({
            file: `${rel}/SKILL.md`,
            message: `third-party metadata.${key} is missing or empty`,
          });
      }
      if (metadata['github-repo'] && !REPO_URL_RE.test(metadata['github-repo'])) {
        errors.push({
          file: `${rel}/SKILL.md`,
          message: `metadata.github-repo is not a GitHub repo URL: ${metadata['github-repo']}`,
        });
      }
    } else if (ghKeys.length > 0) {
      errors.push({
        file: `${rel}/SKILL.md`,
        message: `partial gh metadata without github-repo (${ghKeys.join(', ')}) — the manually-copied-skill signature ADR 0022 retired; reinstall with \`gh skill install\``,
      });
    }
  }
  return errors;
}

/**
 * Find vendored test files (any `*.test.mjs` under each skill directory).
 *
 * @param {string} skillsDir absolute path to `.agents/skills/`
 * @returns {{skill: string; file: string}[]}
 */
export function findVendoredTests(skillsDir) {
  const found = [];
  if (!fs.existsSync(skillsDir)) return found;
  for (const entry of fs.readdirSync(skillsDir, {withFileTypes: true})) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(skillsDir, entry.name);
    const stack = [dir];
    while (stack.length > 0) {
      const current = stack.pop();
      for (const item of fs.readdirSync(current, {withFileTypes: true})) {
        const full = path.join(current, item.name);
        if (item.isDirectory()) stack.push(full);
        else if (item.name.endsWith('.test.mjs')) found.push({skill: entry.name, file: full});
      }
    }
  }
  return found.sort((a, b) => a.file.localeCompare(b.file));
}
/**
 * Run one vendored test file with `node --test`.
 *
 * @param {string} file absolute path to the test file
 * @returns {{ok: boolean; output: string}}
 */
export function runVendoredTest(file) {
  const res = spawnSync(process.execPath, ['--test', file], {encoding: 'utf8', timeout: 120_000});
  const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  return {ok: res.status === 0, output};
}

async function main() {
  const skipTests = process.argv.includes('--skip-tests');
  const repoRoot = path.resolve(path.dirname(__filename), '..');
  const skillsDir = path.join(repoRoot, SKILLS_DIR);

  const errors = checkSkillsDir(skillsDir);
  for (const {file, message} of errors) console.error(`✗ ${file}: ${message}`);

  if (skipTests) {
    if (errors.length > 0) process.exit(1);
    console.log('check-skills: frontmatter OK (vendored tests skipped)');
    return;
  }

  const tests = findVendoredTests(skillsDir);
  const failures = [];
  for (const {skill, file} of tests) {
    process.stdout.write(`check-skills: running vendored test ${path.relative(repoRoot, file)} … `);
    const {ok, output} = runVendoredTest(file);
    console.log(ok ? 'pass' : 'FAIL');
    if (!ok) failures.push({skill, file, output});
  }
  if (tests.length === 0) console.log('check-skills: no vendored tests found');
  for (const {file, output} of failures) {
    console.error(
      `✗ vendored test failed: ${path.relative(repoRoot, file)}\n${output.split('\n').slice(-30).join('\n')}`
    );
  }

  if (errors.length > 0 || failures.length > 0) {
    console.error(
      `check-skills: ${errors.length} frontmatter error(s), ${failures.length} vendored test failure(s)`
    );
    process.exit(1);
  }
  console.log(`check-skills: OK (${tests.length} vendored test file(s) run)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  await main();
}
