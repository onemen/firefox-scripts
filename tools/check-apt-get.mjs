#!/usr/bin/env node

/**
 * tools/check-apt-get.mjs — forbid raw `sudo apt-get update/install` call sites
 * in .github/workflows, .github/actions and .github/scripts.
 *
 * Every apt fetch must route through .github/actions/bound-apt (timeout 120 s
 * on update, retries with backoff, acquire/dpkg-lock timeouts, skip when the
 * probe command exists) so a stalled archive mirror fails fast instead of
 * eating the whole job timeout (issue #461).
 *
 * Scope: shell command positions with optional wrappers — the start of a line
 * (in a `run:` block or `run:` inline), after `&&`, `;` or `|`, and behind a
 * `timeout 60` prefix; `sudo` and its flags are optional, and `apt install` (no
 * `-get`) is the same tool. Full-line comments and lines whose first non-space
 * character is `#` are never scanned, so prose mentions (issue text,
 * backtick-quoted examples, trailing `#` notes) stay out of scope.
 *
 * Exit code 0 = no raw call sites. Run via `pnpm lint` (lint:apt stage).
 */

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_DIRS = [
  path.join(REPO_ROOT, '.github', 'workflows'),
  path.join(REPO_ROOT, '.github', 'actions'),
  path.join(REPO_ROOT, '.github', 'scripts'),
];
const EXEMPT_DIR = path.join(REPO_ROOT, '.github', 'actions', 'bound-apt');

// A command position is the start of the line, or the token right after a
// shell separator. `run:` (inline YAML) is stripped first, so a one-line step
// is scanned like the body of a `run: |` block.
// Flags are `-` tokens only — a constrained character class, never `\S+`.
// Requiring the dash is what keeps a prose line like `… apt sources (…) so
// the update fails` from matching: `so` is not a flag, and the optional `-get`
// cannot swallow "sources". Written as literal regexes (no constructed
// patterns) so the security/detect-non-literal-regexp rule stays clean.
//
//   MOD   = an optional `timeout N` + optional flags, then a verb
//   CMD   = flags FIRST, then the verb      (apt-get -y install x)
//   CMD_T = verb FIRST, then trailing flags (apt-get install -y x)
//   ANY   = either order, from a command position
//
// The trailing `\b` anchors the verb so `installed`/`update-alternatives` miss.
// The apt verb with optional `-flag` tokens on either side of it:
//   apt-get -y install x   (flags before the verb)
//   apt-get install -y x   (flags after the verb)
const CMD = String.raw`apt(?:-get)?(?:\s+\s-[A-Za-z0-9][^\s]*)*\s+(?:update|install)(?:\s+\s-[A-Za-z0-9][^\s]*)*\b`;
// Optional `timeout N` and an optional wrapped privilege before the verb.
const WRAPPERS = String.raw`(?:timeout\s+\S+\s+)?(?:sudo\s+(?:-[A-Za-z0-9][^\s]*\s+)*)?`;

// Same shape as check-gate-coverage.mjs: the interpolation is our own escaped
// literal, never external input.
/* eslint-disable security/detect-non-literal-regexp */
const LINE_START_RE = new RegExp(String.raw`^\s*${WRAPPERS}${CMD}`);
const AFTER_SEPARATOR_RE = new RegExp(String.raw`(?:&&|\|\||;|\|)\s*${WRAPPERS}${CMD}`);
/* eslint-enable security/detect-non-literal-regexp */

const YAML_LIKE = /\.(yml|yaml)$/;
const EXCLUDED_DIR = ['node_modules', '.git'];

/** Recursively list files under the scan roots (missing roots are skipped). */
function listScanFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, {withFileTypes: true});
  } catch {
    return out;
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!EXCLUDED_DIR.includes(e.name)) out.push(...listScanFiles(full));
    } else if (e.isFile()) {
      out.push(full);
    }
  }
  return out;
}

/** The text to scan: drop a trailing `#` comment, and any inline `run:`. */
function commandText(line) {
  const withoutComment = line.replace(/\s+#.*$/, '');
  // The key must be a whole token: `unused: …` in a description must not be
  // read as `run:`.
  const runRe = /(?:^|\s)-?\s*\brun:\s*/;
  const runIdx = withoutComment.search(runRe);
  if (runIdx !== -1) {
    return withoutComment.slice(runIdx).replace(runRe, '');
  }
  return withoutComment;
}

/**
 * Find every raw `apt-get`/`apt` `update|install` command in the given YAML
 * files. Files under the bound-apt action are exempt (that is the wrapper
 * itself); non-YAML paths are ignored so callers cannot widen the scope.
 *
 * @param {string[]} [files] default: `.github/workflows`, `.github/actions` and
 *   `.github/scripts`
 * @param {string} [root] base for the reported paths
 */
export function findRawAptGetCalls(files = SCAN_DIRS.flatMap(listScanFiles), root = REPO_ROOT) {
  const findings = [];
  for (const file of files.filter(
    f => YAML_LIKE.test(f) && path.relative(EXEMPT_DIR, f).startsWith('..')
  )) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      const text = commandText(line);
      if (/^\s*#/.test(line)) return; // full-line comment
      if (LINE_START_RE.test(text) || AFTER_SEPARATOR_RE.test(text)) {
        findings.push({
          file: path.relative(root, file).replaceAll('\\', '/'),
          line: i + 1,
          text: line.trim(),
        });
      }
    });
  }
  return findings;
}

function main() {
  const findings = findRawAptGetCalls();
  if (findings.length > 0) {
    console.error(
      [
        `check-apt-get: ${findings.length} raw apt call site(s) found — route through .github/actions/bound-apt instead (issue #461).`,
        ...findings.map(f => `  ${f.file}:${f.line}: ${f.text}`),
      ].join('\n')
    );
    process.exit(1);
  }
  console.log('check-apt-get: no raw apt call sites in .github (0 findings).');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
