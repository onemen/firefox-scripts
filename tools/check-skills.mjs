#!/usr/bin/env node

/**
 * tools/check-skills.mjs — validate SKILL.md frontmatter and run the vendored
 * skills' own tests: the weekly skills-watchdog parses frontmatter for drift
 * detection, but nothing gates on the metadata being well-formed, and the
 * vendored skills' tests never run.
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
 *   -path/-tree-sha`) and a parseable `github-repo` URL;
 * - every frontmatter key (top-level and `metadata.`) is on the known-key
 *   allow-list — a typo or an unreviewed upstream key fails the gate instead of
 *   passing silently;
 * - a skill that declares `license:` ships the license text (third-party:
 *   LICENSE/NOTICE/COPYING in its directory, with recorded exceptions for
 *   upstreams that ship none — injecting a file would break the pristine
 *   vendored tree ADR 0022 requires).
 *
 * Frontmatter is parsed with js-yaml (the same parse the `lint:yaml` gate
 * reports on, #413) — one parser, one classification (`metadata.github-repo` =
 * third-party). `tools/skills-watchdog.mjs` keeps its own line-based reader on
 * purpose: the watchdog's job is to _report_ drifted or unreadable metadata, so
 * it must survive a block that does not parse.
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

import {SKILLS_DIR} from './skills-watchdog.mjs';
import {parseFrontmatter} from './check-yaml-frontmatter.mjs';

const __filename = fileURLToPath(import.meta.url);

const GH_META_KEYS = ['github-repo', 'github-ref', 'github-path', 'github-tree-sha'];
const REPO_URL_RE =
  /^(?:(?:https?|ssh):\/\/(?:git@)?github\.com\/|git@github\.com:|github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/;

// Every frontmatter key in use, so a typo or an upstream key nobody has seen
// fails the gate instead of silently passing. Extend deliberately, in review.
const TOP_LEVEL_KEYS = new Set([
  'name',
  'description',
  'metadata',
  'license',
  'compatibility',
  'disable-model-invocation',
]);
const METADATA_KEYS = new Set([
  ...GH_META_KEYS,
  'argument-hint',
  'author',
  'hermes-category',
  'hermes-tags',
]);

// A third-party skill that declares `license:` must ship the license text
// (ADR 0022: "still MIT-attributed" needs a file to point at). Recorded
// exceptions are upstream gaps we do not paper over by injecting files into
// a pristine vendored tree — the file would diverge from the installed tree
// `gh skill update` manages.
const LICENSE_FILE_EXCEPTIONS = new Set(['lavish']);
const LICENSE_FILE_NAMES = [
  'LICENSE',
  'LICENSE.md',
  'LICENSE.txt',
  'NOTICE',
  'NOTICE.md',
  'COPYING',
];

/**
 * Read a SKILL.md's frontmatter with js-yaml (the same parse the `lint:yaml`
 * gate reports on) and normalize the two shapes every caller here needs: `name`
 * / `description` as trimmed strings or null, and `metadata` as a plain
 * key→value record.
 *
 * The frontmatter used to be read by a line scanner that could not tell a valid
 * block from a broken one — a `: ` inside a multi-line scalar ended the value
 * and the scanner still saw a `description` (#413). One parser now answers both
 * "is this valid?" and "what does it say?".
 *
 * @param {string} text SKILL.md content (CRLF tolerated)
 * @param {string} file the file's repo-relative label, for error messages
 * @returns {{
 *   present: boolean;
 *   name: string | null;
 *   description: string | null;
 *   metadata: Record<string, string>;
 *   topKeys: string[];
 *   error: string | null;
 * }}
 */
export function readSkillFrontmatter(text, file) {
  const parsed = parseFrontmatter(text, file);
  if (!parsed.present)
    return {
      present: false,
      name: null,
      description: null,
      metadata: {},
      topKeys: [],
      error: null,
    };
  if (parsed.error) {
    return {
      present: true,
      name: null,
      description: null,
      metadata: {},
      topKeys: [],
      error: `${parsed.error.reason} (frontmatter line ${parsed.error.line}:${parsed.error.column})`,
    };
  }
  const data = /** @type {Record<string, any>} */ (
    parsed.data && typeof parsed.data === 'object' ? parsed.data : {}
  );
  const scalar = value => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);
  const meta = data.metadata && typeof data.metadata === 'object' ? data.metadata : {};
  return {
    present: true,
    name: scalar(data.name),
    description: scalar(data.description),
    metadata: Object.fromEntries(
      Object.entries(meta).map(([k, v]) => [k, v === null || v === undefined ? '' : String(v)])
    ),
    topKeys: Object.keys(data),
    error: null,
  };
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
    const fm = readSkillFrontmatter(text, `${rel}/SKILL.md`);
    if (!fm.present) {
      errors.push({file: `${rel}/SKILL.md`, message: 'no frontmatter block'});
      continue;
    }
    const {name, description, metadata, topKeys, error} = fm;
    if (error !== null) {
      errors.push({file: `${rel}/SKILL.md`, message: `frontmatter is not valid YAML: ${error}`});
      continue;
    }
    for (const key of topKeys) {
      if (!TOP_LEVEL_KEYS.has(key)) {
        errors.push({
          file: `${rel}/SKILL.md`,
          message: `frontmatter has unknown key "${key}" — extend TOP_LEVEL_KEYS in tools/check-skills.mjs if it is intentional`,
        });
      }
    }
    for (const key of Object.keys(metadata)) {
      if (!METADATA_KEYS.has(key)) {
        errors.push({
          file: `${rel}/SKILL.md`,
          message: `metadata.${key} is unknown — extend METADATA_KEYS in tools/check-skills.mjs if it is intentional`,
        });
      }
    }
    if (topKeys.includes('license') && metadata['github-repo']) {
      const skillDirAbs = path.join(skillsDir, entry.name);
      const hasLicenseFile = LICENSE_FILE_NAMES.some(f => fs.existsSync(path.join(skillDirAbs, f)));
      if (!hasLicenseFile && !LICENSE_FILE_EXCEPTIONS.has(entry.name)) {
        errors.push({
          file: `${rel}/SKILL.md`,
          message:
            'declares license: but ships no LICENSE/NOTICE/COPYING file — ship the text or record the upstream gap in LICENSE_FILE_EXCEPTIONS',
        });
      }
    }
    if (!name) {
      errors.push({file: `${rel}/SKILL.md`, message: 'frontmatter has no non-empty name:'});
    } else if (name !== entry.name) {
      errors.push({
        file: `${rel}/SKILL.md`,
        message: `name "${name}" does not match directory name "${entry.name}"`,
      });
    }
    if (!description) {
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
 * Rows of the AGENTS.md Skills table — the `## Skills` section's rows whose
 * first cell is a backticked skill name. Used by the drift check below to keep
 * the table honest against the on-disk inventory.
 *
 * @param {string} agentsMd AGENTS.md content (CRLF tolerated)
 * @returns {{name: string; skillClass: string | null}[]} table rows in order
 */
export function agentsSkillsTable(agentsMd) {
  const section = agentsMd
    .replace(/\r\n/g, '\n')
    .split(/^## /m)
    .find(part => part.startsWith('Skills'));
  if (!section) return [];
  const rows = [];
  for (const line of section.split('\n')) {
    const match = /^\|\s*`([a-z0-9-]+)`\s*\|\s*([^|]*)\|/.exec(line);
    if (match) rows.push({name: match[1], skillClass: match[2].trim() || null});
  }
  return rows;
}

/**
 * Cross-check the AGENTS.md Skills table against the on-disk skill inventory:
 * every skill directory needs a table row, every row needs a directory, and the
 * row's class must match the frontmatter classification (`metadata.github-repo`
 * present = third-party, per the skills watchdog).
 *
 * @param {string} skillsDir absolute path to `.agents/skills/`
 * @param {string} agentsMd AGENTS.md content
 * @returns {{file: string; message: string}[]} problems, empty when in sync
 */
export function checkAgentsTableDrift(skillsDir, agentsMd) {
  const errors = [];
  const rows = new Map(agentsSkillsTable(agentsMd).map(row => [row.name, row.skillClass]));
  const onDisk = fs
    .readdirSync(skillsDir, {withFileTypes: true})
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort((a, b) => a.localeCompare(b));
  for (const name of onDisk) {
    if (!rows.has(name)) {
      errors.push({
        file: 'AGENTS.md',
        message: `skill \`${name}\` exists on disk but has no Skills-table row`,
      });
      continue;
    }
    const text = fs.readFileSync(path.join(skillsDir, name, 'SKILL.md'), 'utf8');
    const {metadata} = readSkillFrontmatter(text, `${SKILLS_DIR}/${name}/SKILL.md`);
    const actual = metadata['github-repo'] ? 'third-party' : 'authored';
    if (rows.get(name) !== actual) {
      errors.push({
        file: 'AGENTS.md',
        message: `skill \`${name}\` is ${actual} (frontmatter) but the Skills table says "${rows.get(name)}"`,
      });
    }
  }
  for (const name of rows.keys()) {
    if (!onDisk.includes(name)) {
      errors.push({
        file: 'AGENTS.md',
        message: `Skills-table row \`${name}\` has no directory under ${SKILLS_DIR} (stale row)`,
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
  const agentsMdPath = path.join(repoRoot, 'AGENTS.md');
  if (fs.existsSync(agentsMdPath) && fs.existsSync(skillsDir)) {
    errors.push(...checkAgentsTableDrift(skillsDir, fs.readFileSync(agentsMdPath, 'utf8')));
  } else {
    errors.push({
      file: 'AGENTS.md',
      message: 'AGENTS.md or .agents/skills/ is missing — the Skills table cannot be cross-checked',
    });
  }
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
