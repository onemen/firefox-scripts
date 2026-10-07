#!/usr/bin/env node

/**
 * tools/check-skill-commands.mjs — validate command tokens and relative links
 * in AUTHORED SKILL.md files; vendored skills are out of scope (ADR 0022).
 *
 * Checked per authored SKILL.md:
 *
 * - `pnpm <script>` (and `pnpm run <script>`) must name a package.json script, or
 *   be a whitelisted pnpm builtin (`install`, `exec`, …). Bare `pnpm publish`
 *   is deliberately NOT whitelisted: the builtin would publish the package, not
 *   the release.
 * - `node <path>.mjs` must resolve from the repo root (flag tokens such as
 *   `--env-file-if-exists=.env` are skipped; globs are skipped — they are not
 *   files).
 * - `make <target>` must be a target of the Makefile it resolves against: `make
 *   -C <dir> <target>` uses that dir's Makefile, a bare `make <target>`
 *   resolves against `installer/Makefile` (there is no root Makefile).
 * - `[text](relative/target)` links must exist on disk — resolved against the
 *   SKILL.md's own directory first (skills link as `../../../docs/…`), then
 *   against the repo root. Absolute URLs, `#anchors` and `mailto:` are out of
 *   scope (no network in the lint chain).
 *
 * Commands are read from fenced code blocks and inline backtick spans only.
 * Exit code 0 = every token resolves. Wired as `pnpm lint:skill-cmds` in the
 * `pnpm lint` chain; `--dry-run` prints without failing.
 */

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {readSkillFrontmatter} from './check-skills.mjs';

const __filename = fileURLToPath(import.meta.url);
const SKILLS_DIR = '.agents/skills';

/**
 * pnpm subcommands that are not package.json scripts but are legitimate in
 * skill text. Everything else must be a script — `pnpm publish` (the builtin)
 * is intentionally absent, see the header.
 */
export const PNPM_BUILTINS = new Set([
  'install',
  'exec',
  'run',
  'dlx',
  'why',
  'list',
  'outdated',
  'add',
  'remove',
]);

/**
 * Extract code segments (fenced blocks and inline backtick spans) from a
 * markdown document, each with the 1-based line it starts on.
 *
 * @param {string} text markdown content (CRLF tolerated)
 * @returns {{line: number; code: string}[]} segments in document order
 */
export function extractCodeSegments(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const segments = [];
  let inFence = false;
  let fence = '';
  let fenceStart = 0;
  let buffer = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = /^(\s*)(`{3,})/.exec(line);
    if (fenceMatch) {
      if (!inFence) {
        inFence = true;
        fenceStart = i + 2; // 1-based line of the fence's FIRST CONTENT line
        fence = fenceMatch[2];
        buffer = [];
      } else if (fence.startsWith(fenceMatch[2])) {
        segments.push({line: fenceStart, code: buffer.join('\n')});
        inFence = false;
      }
      continue;
    }
    if (inFence) {
      buffer.push(line);
      continue;
    }
    for (const m of line.matchAll(/`([^`\n]+)`/g)) {
      segments.push({line: i + 1, code: m[1]});
    }
  }
  if (inFence) segments.push({line: fenceStart, code: buffer.join('\n')});
  return segments;
}

/**
 * Markdown text with every code segment blanked out (same newlines), so link
 * extraction never sees a fenced example of a link.
 *
 * @param {string} text markdown content
 * @returns {string} text with code segments replaced by blank lines
 */
function stripCode(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let inFence = false;
  let fence = '';
  let fenceStart = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = /^(\s*)(`{3,})/.exec(line);
    if (fenceMatch) {
      if (!inFence) {
        inFence = true;
        fence = fenceMatch[2];
        fenceStart = i;
      } else if (fence.startsWith(fenceMatch[2])) {
        for (let j = fenceStart; j <= i; j++) lines[j] = '';
        inFence = false;
      }
      continue;
    }
    if (inFence) {
      lines[i] = '';
      continue;
    }
    lines[i] = line.replace(/`[^`\n]+`/g, '');
  }
  return lines.join('\n');
}

/**
 * Validate the command tokens and links of one SKILL.md body.
 *
 * @param {string} text SKILL.md content
 * @param {{
 *   skillDir: string;
 *   repoRoot: string;
 *   scripts: Set<string>;
 *   makeTargets: Map<string, Set<string>>;
 * }} opts
 *   absolute skill dir (for link resolution), repo root, package.json script
 *   names, and Makefile targets keyed by directory ('' = repo root, 'installer'
 *   = installer/Makefile)
 * @returns {{line: number; message: string}[]} problems, empty when clean
 */
export function checkSkillFile(text, opts) {
  const {skillDir, repoRoot, scripts, makeTargets} = opts;
  const errors = [];

  for (const {line, code} of extractCodeSegments(text)) {
    for (const m of code.matchAll(/(?:^|[\s(`])pnpm (?:run )?([A-Za-z][\w:.|-]*)/g)) {
      const token = m[1];
      const names = token.split('|');
      const bad = names.filter(n => !scripts.has(n) && !PNPM_BUILTINS.has(n));
      if (bad.length > 0) {
        errors.push({
          line: line + code.slice(0, m.index).split('\n').length - 1,
          message: `\`pnpm ${bad[0]}\` does not resolve: no "${bad[0]}" script in package.json and not a known pnpm builtin`,
        });
      }
    }

    // node/make are token-walked rather than regex-matched: one-liners that
    // cover `node --flag … x.mjs` and `make -C dir target` nest quantifiers,
    // which eslint's security/detect-unsafe-regex rejects — and for these two
    // shapes a walk over the line's tokens is clearer anyway.
    const codeLines = code.split('\n');
    for (let li = 0; li < codeLines.length; li++) {
      const lineNo = line + li;
      const tokens = codeLines[li].split(/\s+/).filter(Boolean);
      for (let t = 0; t < tokens.length; t++) {
        const bare = tokens[t].replace(/^[^A-Za-z0-9]+/, '');
        if (bare === 'node') {
          let u = t + 1;
          while (u < tokens.length && tokens[u].startsWith('-')) u += 1;
          const target = tokens[u] ?? '';
          if (
            target.endsWith('.mjs') &&
            !target.includes('*') &&
            !fs.existsSync(path.resolve(repoRoot, target))
          ) {
            errors.push({
              line: lineNo,
              message: `\`node ${target}\` does not resolve: ${target} not found from the repo root`,
            });
          }
        } else if (bare === 'make') {
          let u = t + 1;
          let dir = 'installer'; // no root Makefile; skills build the installer
          if (tokens[u] === '-C') {
            dir = tokens[u + 1] ?? '';
            u += 2;
          }
          const targetTok = (tokens[u] ?? '').replace(/[^A-Za-z0-9_|-].*$/, '');
          if (!targetTok) continue;
          const targets = makeTargets.get(dir);
          if (!targets) {
            errors.push({
              line: lineNo,
              message: `\`make ${targetTok}\`: no Makefile at ${dir || '.'} (known: ${[...makeTargets.keys()].join(', ')})`,
            });
            continue;
          }
          const bad = targetTok.split('|').filter(n => !targets.has(n));
          if (bad.length > 0) {
            errors.push({
              line: lineNo,
              message: `\`make ${bad[0]}\` does not resolve: no such target in ${dir || '.'}/Makefile`,
            });
          }
        }
      }
    }
  }

  const prose = stripCode(text);
  const proseLines = prose.split('\n');
  for (let i = 0; i < proseLines.length; i++) {
    for (const m of proseLines[i].matchAll(/\]\(<?([^)>\s]+)>?[^)]*\)/g)) {
      const target = m[1];
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // URL schemes: http:, mailto:, chrome: …
      if (target.startsWith('#')) continue;
      const clean = target.split('#')[0];
      if (!clean) continue;
      const candidates = [
        path.resolve(skillDir, clean), // skills link `../../../docs/…`
        path.resolve(repoRoot, clean), // root-relative shorthand
      ];
      if (!candidates.some(c => fs.existsSync(c))) {
        errors.push({
          line: i + 1,
          message: `link target does not exist: ${target}`,
        });
      }
    }
  }
  return errors;
}

/**
 * Load the repo-wide inputs the per-skill check needs: package.json script
 * names and the Makefile target sets (root Makefile if it ever appears, plus
 * installer/Makefile — the build skills actually invoke).
 *
 * @param {string} repoRoot repo root
 * @returns {{scripts: Set<string>; makeTargets: Map<string, Set<string>>}}
 */
export function collectRepoDeps(repoRoot) {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const scripts = new Set(Object.keys(pkg.scripts ?? {}));
  const makeTargets = new Map();
  const makefiles = [
    ['', path.join(repoRoot, 'Makefile')],
    ['installer', path.join(repoRoot, 'installer', 'Makefile')],
  ];
  for (const [dir, file] of makefiles) {
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    const targets = new Set();
    for (const m of text.matchAll(/^([A-Za-z][\w-]*)\s*:(?!=)/gm)) targets.add(m[1]);
    for (const m of text.matchAll(/^\.PHONY\s*:\s*(.*)$/gm)) {
      for (const name of m[1].split(/\s+/)) if (name) targets.add(name);
    }
    makeTargets.set(dir, targets);
  }
  return {scripts, makeTargets};
}

/**
 * Check every authored skill under `.agents/skills/` (third-party skills are
 * out of scope — ADR 0022 keeps them pristine and host-dependent).
 *
 * @param {string} repoRoot repo root
 * @returns {{file: string; line: number; message: string}[]} problems
 */
export function checkAllSkills(repoRoot) {
  const skillsRoot = path.join(repoRoot, SKILLS_DIR);
  const errors = [];
  if (!fs.existsSync(skillsRoot)) {
    return [{file: SKILLS_DIR, line: 0, message: 'skills directory is missing'}];
  }
  const {scripts, makeTargets} = collectRepoDeps(repoRoot);
  for (const entry of fs
    .readdirSync(skillsRoot, {withFileTypes: true})
    .sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const file = path.join(skillsRoot, entry.name, 'SKILL.md');
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    const fm = readSkillFrontmatter(text, `${SKILLS_DIR}/${entry.name}/SKILL.md`);
    if (fm.metadata['github-repo']) continue; // third-party: pristine, host-dependent
    const rel = `${SKILLS_DIR}/${entry.name}/SKILL.md`;
    for (const problem of checkSkillFile(text, {
      skillDir: path.join(skillsRoot, entry.name),
      repoRoot,
      scripts,
      makeTargets,
    })) {
      errors.push({file: rel, ...problem});
    }
  }
  return errors;
}

function main() {
  const dryRun = process.argv.includes('--dry-run');
  const repoRoot = path.resolve(path.dirname(__filename), '..');
  const errors = checkAllSkills(repoRoot);
  for (const {file, line, message} of errors) {
    console.error(`✗ ${file}:${line}: ${message}`);
  }
  if (errors.length > 0) {
    if (dryRun) {
      console.log(`check-skill-commands: ${errors.length} problem(s) (dry run, not failing)`);
      return;
    }
    console.error(
      `check-skill-commands: ${errors.length} unresolved command/link(s) in authored SKILL.md files`
    );
    process.exit(1);
  }
  console.log('check-skill-commands: all pnpm/node/make tokens and links resolve.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main();
}
