#!/usr/bin/env node

/**
 * tools/check-md-list-markers.mjs — flag a markdown list marker that lost its
 * line break.
 *
 * The failure shape: a bullet fuses into the previous line, so a list rule
 * silently becomes part of the preceding item and is unreadable as a rule.
 * Nothing catches it mechanically: markdownlint accepts a mid-line hyphen,
 * prettier reflows the paragraph happily, and check:decisions only parses the
 * ADR files' status lines — a prose-reading AI reviewer is the wrong instrument
 * for a diff-shape defect.
 *
 * Scope: markdown files the change touches, ADDED/CHANGED lines only (git diff
 * against the merge base). A repo-wide scan would flag pre-existing prose and
 * get disabled within a week. Base resolution: the merge base with `main` — the
 * review-time surface, which CI PR runs share (ci.yml checks out full history).
 * A push to `main` compares against itself and passes: the gate is a PR-time
 * tripwire. `BASE_SHA` overrides everything (tests, manual runs); with no
 * resolvable base the gate fails loudly instead of scanning nothing. Excluded
 * from scanning entirely: the third-party skills under `.agents/skills/` —
 * vendored text stays pristine (ADR 0022), and their fences deliberately quote
 * the buggy string as the incident's working example.
 *
 * The detector is /[.:)]\s+-[A-Z]/ — a list marker appearing mid-line after a
 * sentence end — with two documented blind spots, both deliberate (the gate is
 * a tripwire for the common edit accident, not a markdown parser):
 *
 * - `-One` (no space before the marker) is not matched — the space-bearing form
 *   is what a prettier reflow leaves behind;
 * - a fused marker after a comma/word boundary (`…record, -and`) is not matched —
 *   flagging those drowns the signal in legitimate mid-line enumerations.
 *   Matches inside inline code spans (`…`) and fenced blocks are ignored:
 *   quoting the buggy string is not making the mistake. Em-dashes and minus
 *   signs are not `-`, so they never trigger the pattern.
 *
 * Exit code 0 = clean. Run via `pnpm lint` (lint:md-markers stage).
 */

import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The fused-marker pattern: sentence end, whitespace, `-`, capital letter. */
export const FUSED_MARKER_RE = /[.:)]\s+-[A-Z]/;

/**
 * Vendored third-party skills are pristine and outside every text gate (ADR
 * 0022).
 */
const EXCLUDED_SEGMENTS = ['node_modules', 'dist', '.git'];
/**
 * The vendored-skills subtree, matched as a path prefix (segments never contain
 * '/').
 */
const EXCLUDED_PREFIX = '.agents/skills/';

/**
 * Which markdown files the current change touches, relative to the repo root.
 *
 * Merge-base diff against `main` (see the scope note above). `BASE_SHA`
 * overrides everything (tests, manual runs). A file with no resolvable base is
 * treated as fully changed (worst case).
 *
 * @param {string[]} _argv extra CLI args (unused; reserved)
 * @param {{cwd?: string; baseSha?: string; runGit?: typeof execFileSync}} [io]
 *   test seams
 * @returns {string[]}
 */
export function changedMarkdownFiles(_argv = process.argv.slice(2), io = {}) {
  if (process.env.CHANGED_FILES) {
    return process.env.CHANGED_FILES.split('\n').filter(f => /\.md$/.test(f));
  }
  const base = io.baseSha ?? process.env.BASE_SHA ?? resolveBaseSha(io.cwd ?? REPO_ROOT);
  const runGit = io.runGit ?? execFileSync;
  const diff = runGit(
    'git',
    ['-C', io.cwd ?? REPO_ROOT, 'diff', '--name-only', '--diff-filter=ACMR', `${base}...HEAD`],
    {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024}
  );
  return diff
    .split('\n')
    .map(f => f.trim())
    .filter(f => f !== '' && f.endsWith('.md'));
}

/**
 * The diff base for the current checkout: `BASE_SHA` when set, else the merge
 * base with `main`, else `HEAD~1` when no main ref exists (shallow/partial
 * checkouts). Returns null when none resolve — the caller decides whether that
 * is fatal.
 *
 * @param {string} cwd
 * @returns {string | null}
 */
function resolveBaseSha(cwd) {
  if (process.env.BASE_SHA) return process.env.BASE_SHA;
  for (const ref of ['main']) {
    try {
      const out = execFileSync('git', ['-C', cwd, 'merge-base', ref, 'HEAD'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (out) return out;
    } catch {
      // ref unknown / no merge base — try the next
    }
  }
  try {
    return execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD~1'], {encoding: 'utf8'}).trim();
  } catch {
    return null;
  }
}

/**
 * Findings for one file: ADDED/CHANGED lines whose fused-marker match sits
 * outside inline code spans and fenced blocks.
 *
 * @param {string} file absolute path to a markdown file
 * @param {string[]} lines the file's raw lines (LF or CRLF both fine)
 * @param {{baseSha?: string; runGit?: typeof execFileSync}} [opts] seams
 *   (tests): baseSha pins the diff base, runGit replaces the git invocation
 * @returns {{line: number; text: string; snippet: string}[]}
 */
export function findFusedMarkers(file, lines, opts = {}) {
  const rel = path.relative(REPO_ROOT, file).replaceAll('\\', '/');
  if (rel.startsWith(EXCLUDED_PREFIX)) return [];
  if (EXCLUDED_SEGMENTS.some(seg => rel.split('/').includes(seg))) return [];

  const baseSha = opts.baseSha ?? process.env.BASE_SHA;
  const changed = new Set();
  if (baseSha) {
    const runGit = opts.runGit ?? execFileSync;
    const diff = runGit('git', ['-C', REPO_ROOT, 'diff', '-U0', baseSha, '--', rel], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    collectAddedLines(diff, changed);
  } else {
    // No resolvable base: treat every line as changed (worst case — the gate
    // must stay able to run).
    for (let i = 1; i <= lines.length; i++) changed.add(i);
  }

  const findings = [];
  // Fence state must be computed from the WHOLE file: an added line inside an
  // existing (unchanged) fenced block sits after an opening fence the diff
  // never shows, and scanning it as prose would flag quoted text.
  let inFence = false;
  for (let n = 1; n <= lines.length; n++) {
    const text = lines[n - 1] ?? '';
    if (/^\s*(```|~~~)/.test(text)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !changed.has(n)) continue;
    const snippet = fusedSnippet(stripCodeSpans(text));
    if (snippet) findings.push({line: n, text: text.trim(), snippet});
  }
  return findings;
}

/**
 * The one-line `git diff -U0` hunk parser: adds the new-file line numbers of
 * every `+` line. Context and `-` lines never touch the set.
 *
 * @param {string} diff
 * @param {Set<number>} into the set to add to
 */
export function collectAddedLines(diff, into) {
  let line = 0;
  for (const raw of diff.split('\n')) {
    // Hunk header `@@ -l,c +l,c @@`: the new-file start is the first digits
    // after a '+' (the '-' segment never contains one). Parsed without a
    // quantified group so the SAST unsafe-regex rule stays quiet.
    if (raw.startsWith('@@ ')) {
      const m = /\+(\d+)/.exec(raw);
      if (m) line = Number(m[1]);
      continue;
    }
    if (line === 0) continue; // still before the first hunk (headers)
    if (raw.startsWith('+')) {
      into.add(line);
      line += 1;
    } else if (raw.startsWith('-') || raw.startsWith('\\')) {
      // old-file line / "\ No newline" — does not advance the new-file counter
    } else if (raw.startsWith(' ') || raw === '') {
      line += 1;
    } else {
      line += 1;
    }
  }
}

/** Remove inline code spans so their content can never match the detector. */
export function stripCodeSpans(text) {
  return text.replace(/`[^`]*`/g, m => ' '.repeat(m.length));
}

/**
 * The fused-marker snippet of a line, or null. The backtick-stripped text is
 * matched, but the snippet is carved from the ORIGINAL line so the reported
 * context still reads naturally.
 *
 * @param {string} original
 * @returns {string | null}
 */
export function fusedSnippet(original) {
  const stripped = stripCodeSpans(original);
  const m = FUSED_MARKER_RE.exec(stripped);
  if (!m) return null;
  const start = Math.max(0, m.index - 20);
  const end = Math.min(original.length, m.index + m[0].length + 20);
  return (start > 0 ? '…' : '') + original.slice(start, end) + (end < original.length ? '…' : '');
}

function main() {
  // Resolve the base ONCE and share it: findFusedMarkers must never fall back
  // to "every line changed" for a file the file-level pass did resolve — that
  // would degenerate into the repo-wide scan the issue rules out.
  const base = process.env.BASE_SHA ?? resolveBaseSha(REPO_ROOT);
  if (!base) {
    console.error(
      'check-md-list-markers: could not resolve a diff base (no BASE_SHA, no merge base ' +
        'with main, no HEAD~1) — set BASE_SHA to run the gate.'
    );
    process.exit(2);
  }
  const files = changedMarkdownFiles(process.argv.slice(2), {baseSha: base});
  if (files.length === 0) {
    console.log('check-md-list-markers: no changed markdown files (0 files scanned).');
    return;
  }
  const findings = [];
  for (const rel of files) {
    const abs = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(abs)) continue; // deleted after staging — nothing to scan
    findings.push(
      ...findFusedMarkers(abs, fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n').split('\n'), {
        baseSha: base,
      }).map(f => ({file: rel, ...f}))
    );
  }
  if (findings.length > 0) {
    console.error(
      [
        `check-md-list-markers: ${findings.length} fused list marker(s) — a bullet lost its line break.`,
        ...findings.map(f => `  ${f.file}:${f.line}: ${f.snippet}`),
        'Restore the line break before the "- " list marker (see issue #307).',
      ].join('\n')
    );
    process.exit(1);
  }
  console.log(`check-md-list-markers: clean (${files.length} changed markdown file(s) scanned).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
