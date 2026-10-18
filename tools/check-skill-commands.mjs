#!/usr/bin/env node

/**
 * tools/check-skill-commands.mjs: validate command tokens and relative links in
 * the tracked markdown that tells people what to run. The filename is
 * historical, the checker grew a second scope:
 *
 * - the AUTHORED SKILL.md files (vendored skills are out of scope, ADR 0022);
 * - the command-bearing docs: every `.md` under `docs/` and `docs-site/`, plus
 *   `README.md`, `CONTRIBUTING.md` and `AGENTS.md`.
 *
 * Checked per file:
 *
 * - `pnpm <script>` (and `pnpm run <script>`) must name a package.json script, a
 *   whitelisted pnpm builtin (`install`, `exec`, ...), or a family wildcard
 *   whose prefix matches at least one script (`publish:*`, `test:e2e:*`). Bare
 *   `pnpm publish` is deliberately NOT whitelisted: the builtin would publish
 *   the package, not the release. `pnpm --dir <dir> <script>` resolves against
 *   that directory's own package.json (the nested docs-site project has its own
 *   scripts). A name resolves against the union of the repo and nested project
 *   scripts, because a nested README legitimately mixes both.
 * - `node <path>.mjs` must resolve from the repo root (flag tokens such as
 *   `--env-file-if-exists=.env` are skipped; globs are skipped, they are not
 *   files).
 * - `make <target>` must be a target of the Makefile it resolves against: `make
 *   -C <dir> <target>` uses that dir's Makefile, a bare `make <target>`
 *   resolves against `installer/Makefile` (there is no root Makefile).
 * - `[text](relative/target)` links must exist on disk, resolved against the
 *   file's own directory first (skills link as `../../../docs/...`), then
 *   against the repo root. Absolute URLs, `#anchors` and `mailto:` are out of
 *   scope (no network in the lint chain).
 *
 * Commands are read from fenced code blocks and inline backtick spans only, so
 * prose that merely mentions a command is not a finding. Exit code 0 = every
 * token resolves. Wired as `pnpm lint:skill-cmds` in the `pnpm lint` chain;
 * `--dry-run` prints without failing.
 */

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {readSkillFrontmatter} from './check-skills.mjs';

const __filename = fileURLToPath(import.meta.url);
const SKILLS_DIR = '.agents/skills';

/** Root markdown that carries commands, checked alongside the docs trees. */
export const ROOT_DOC_FILES = ['README.md', 'CONTRIBUTING.md', 'AGENTS.md'];

/** A filesystem tree inside a docs scope that is never source. */
const SKIP_DIRS = new Set(['node_modules', 'dist', '.astro']);

/**
 * Nested pnpm projects whose `pnpm --dir` targets resolve against their own
 * package.json.
 */
const NESTED_PROJECT_DIRS = ['docs-site'];

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
  'audit',
  'store',
  'version',
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
 * Resolve one `pnpm [--dir <dir>] <token>` occurrence. A name resolves when it
 * is a whitelisted pnpm builtin, a known script (the union of the repo and the
 * nested projects, or just that `--dir`'s set), or a `prefix:*` family with at
 * least one matching script.
 *
 * @param {string} token the token after `pnpm`, alternation-aware (`a|b`)
 * @param {string} dir the `--dir` target ('' when the command names no dir)
 * @param {{scripts: Set<string>; scriptsByDir: Map<string, Set<string>>}} deps
 * @returns {string | null} the first unresolved name, or null when all resolve
 */
export function unresolvedPnpmToken(token, dir, deps) {
  const candidates = dir ? (deps.scriptsByDir.get(dir) ?? new Set()) : deps.scripts;
  for (const name of token.split('|')) {
    if (!name) continue;
    if (PNPM_BUILTINS.has(name) || candidates.has(name)) continue;
    if (name.endsWith('*') && [...candidates].some(s => s.startsWith(name.slice(0, -1)))) {
      continue;
    }
    return name;
  }
  return null;
}

/**
 * Validate the command tokens and links of one markdown file (a SKILL.md or a
 * command-bearing doc).
 *
 * @param {string} text markdown content
 * @param {{
 *   fileDir: string;
 *   repoRoot: string;
 *   scripts: Set<string>;
 *   scriptsByDir: Map<string, Set<string>>;
 *   makeTargets: Map<string, Set<string>>;
 * }} opts
 *   absolute directory of the file (for link resolution), repo root, the union of
 *   every known script name, script names per directory for `pnpm --dir`, and
 *   Makefile targets keyed by directory ('' = repo root, 'installer' =
 *   installer/Makefile)
 * @returns {{line: number; message: string}[]} problems, empty when clean
 */
export function checkMarkdownFile(text, opts) {
  const {fileDir, repoRoot, scripts, scriptsByDir, makeTargets} = opts;
  const errors = [];

  for (const {line, code} of extractCodeSegments(text)) {
    // Every command is token-walked rather than regex-matched: one-liners that
    // cover `pnpm --dir <dir> <script>`, `node --flag ... x.mjs` and
    // `make -C <dir> <target>` nest quantifiers, which eslint's
    // security/detect-unsafe-regex rejects, and a walk over the line's tokens
    // reads more clearly for these shapes anyway.
    const codeLines = code.split('\n');
    for (let li = 0; li < codeLines.length; li++) {
      const lineNo = line + li;
      const tokens = codeLines[li].split(/\s+/).filter(Boolean);
      for (let t = 0; t < tokens.length; t++) {
        const bare = tokens[t].replace(/^[^A-Za-z0-9]+/, '');
        if (bare === 'pnpm') {
          let u = t + 1;
          let dir = '';
          while (u < tokens.length) {
            const arg = tokens[u].replace(/^[^A-Za-z0-9_-]+/, '');
            if (arg === 'run') {
              u += 1;
              continue;
            }
            if (arg === '--dir') {
              dir = (tokens[u + 1] ?? '').replace(/[^A-Za-z0-9_./-].*$/, '');
              u += 2;
              continue;
            }
            if (arg.startsWith('--dir=')) {
              dir = arg.slice('--dir='.length);
              u += 1;
              continue;
            }
            break;
          }
          const raw = tokens[u] ?? '';
          if (raw.startsWith('-')) continue; // a pnpm flag (`pnpm -r`), not a script
          const token = raw.replace(/[^A-Za-z0-9_|:*-].*$/, '');
          if (!token) continue;
          const bad = unresolvedPnpmToken(token, dir, {scripts, scriptsByDir});
          if (bad) {
            errors.push({
              line: lineNo,
              message: `\`pnpm ${dir ? `--dir ${dir} ` : ''}${bad}\` does not resolve: no "${bad}" script in the ${dir || 'root'} package.json and not a known pnpm builtin`,
            });
          }
        } else if (bare === 'node') {
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
      // The ADR template links `./NNNN-slug.md`: the target names the record an
      // author is about to create, so there is nothing on disk to resolve.
      if (clean.includes('NNNN')) continue;
      const candidates = [
        path.resolve(fileDir, clean), // a dot-relative link from the file's own dir
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
 * Load the repo-wide inputs the checks need: script names (per directory, plus
 * their union) and the Makefile target sets (root Makefile if it ever appears,
 * plus installer/Makefile, which the build skills and docs invoke).
 *
 * @param {string} repoRoot repo root
 * @returns {{
 *   scripts: Set<string>;
 *   scriptsByDir: Map<string, Set<string>>;
 *   makeTargets: Map<string, Set<string>>;
 * }}
 */
export function collectRepoDeps(repoRoot) {
  const scriptsByDir = new Map();
  for (const dir of ['', ...NESTED_PROJECT_DIRS]) {
    const file = path.join(repoRoot, dir, 'package.json');
    if (!fs.existsSync(file)) continue;
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
    scriptsByDir.set(dir, new Set(Object.keys(pkg.scripts ?? {})));
  }
  const scripts = new Set();
  for (const names of scriptsByDir.values()) for (const name of names) scripts.add(name);
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
  return {scripts, scriptsByDir, makeTargets};
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
  const {scripts, scriptsByDir, makeTargets} = collectRepoDeps(repoRoot);
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
    for (const problem of checkMarkdownFile(text, {
      fileDir: path.join(skillsRoot, entry.name),
      repoRoot,
      scripts,
      scriptsByDir,
      makeTargets,
    })) {
      errors.push({file: rel, ...problem});
    }
  }
  return errors;
}

/**
 * Markdown that carries commands: every `.md` under `docs/` and `docs-site/`,
 * plus the root pages. `.mdx` pages stay out: the docs build (`astro check`) is
 * the gate that understands MDX.
 *
 * @param {string} repoRoot repo root
 * @returns {string[]} repo-relative POSIX paths, deterministic order
 */
export function collectDocFiles(repoRoot) {
  const files = [];
  for (const rel of ROOT_DOC_FILES) {
    if (fs.existsSync(path.join(repoRoot, rel))) files.push(rel);
  }
  const walk = dir => {
    for (const entry of fs
      .readdirSync(dir, {withFileTypes: true})
      .sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.md')) {
        files.push(path.relative(repoRoot, full).replaceAll('\\', '/'));
      }
    }
  };
  for (const dir of ['docs', ...NESTED_PROJECT_DIRS]) {
    const full = path.join(repoRoot, dir);
    if (fs.existsSync(full)) walk(full);
  }
  return files;
}

/**
 * Check every command-bearing doc.
 *
 * @param {string} repoRoot repo root
 * @returns {{file: string; line: number; message: string}[]} problems
 */
export function checkDocs(repoRoot) {
  const {scripts, scriptsByDir, makeTargets} = collectRepoDeps(repoRoot);
  const errors = [];
  for (const rel of collectDocFiles(repoRoot)) {
    const text = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    for (const problem of checkMarkdownFile(text, {
      fileDir: path.dirname(path.join(repoRoot, rel)),
      repoRoot,
      scripts,
      scriptsByDir,
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
  const errors = [...checkAllSkills(repoRoot), ...checkDocs(repoRoot)];
  for (const {file, line, message} of errors) {
    console.error(`✗ ${file}:${line}: ${message}`);
  }
  if (errors.length > 0) {
    if (dryRun) {
      console.log(`check-skill-commands: ${errors.length} problem(s) (dry run, not failing)`);
      return;
    }
    console.error(
      `check-skill-commands: ${errors.length} unresolved command/link(s) in the skill and doc markdown`
    );
    process.exit(1);
  }
  console.log('check-skill-commands: all pnpm/node/make tokens and links resolve.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main();
}
