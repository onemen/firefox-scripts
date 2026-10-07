#!/usr/bin/env node

/**
 * tools/check-strncpy.mjs — forbid new `strncpy(`-family call sites in
 * installer/src.
 *
 * House convention is the bounded copy `snprintf(dst, sizeof(dst), "%s", src)`:
 * always NUL-terminates, never over-reads the source, and keeps the tree clean
 * for SAST scanners.
 *
 * Scope: `strncpy`, `strncat`, `strcpy` and the wide-char `wcsncpy`/`wcscpy`,
 * across `.c`, `.h` AND `.inl` — the umbrella header every file includes would
 * otherwise be unenforced, and `wcsncpy` was invisible to the old pattern. The
 * bounded counterparts stay `snprintf` (narrow) and `wmemcpy` + explicit
 * terminator or `swprintf` (wide): this repo uses no `*cpy_s` (Annex K is not
 * portable to every toolchain we build).
 *
 * Zero tolerance — no allowlist for first-party code. The scanner matches call
 * syntax across line breaks, so prose mentions are out of scope by
 * construction. The scan is recursive under installer/src (helper/ included)
 * but skips vendor/ — vendored third-party code (miniz) is pristine per
 * AGENTS.md.
 *
 * Exit code 0 = no call sites. Run via `pnpm lint` (lint:ncpy stage).
 */

import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_DIR = path.join(REPO_ROOT, 'installer', 'src');

// One literal regex (not a RegExp built from a list): the security lint
// forbids non-literal RegExp arguments, and the test suite — 'flags every
// forbidden family member' — is what keeps this alternation complete.
const CALL_RE = /\b(?:strncpy|strncat|strcpy|wcsncpy|wcscpy)\s*\(/g;
const C_LIKE = /\.(c|h|inl)$/;

function listCSources(dir) {
  const out = [];
  for (const e of fs
    .readdirSync(dir, {withFileTypes: true})
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      // Vendored third-party code (installer/src/vendor/miniz) is read-only:
      // not ours to gate or modify.
      if (e.name === 'vendor') continue;
      out.push(...listCSources(full));
    } else if (e.isFile() && C_LIKE.test(e.name)) {
      out.push(full);
    }
  }
  return out.sort();
}

/**
 * Find every line carrying a forbidden call in the given C sources. Matches
 * across line breaks (a `(` on the next line is still a call), and non-C paths
 * are ignored so callers cannot widen the scope by accident.
 */
export function findStrncpyCalls(files = listCSources(SCAN_DIR), root = REPO_ROOT) {
  const findings = [];
  for (const file of files.filter(f => C_LIKE.test(f))) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(CALL_RE)) {
      const allLines = text.split(/\r?\n/);
      const line = text.slice(0, m.index).split(/\r?\n/).length;
      findings.push({
        file: path.relative(root, file).replaceAll('\\', '/'),
        line,
        text: allLines[line - 1].trim(),
      });
    }
  }
  return findings;
}

function main() {
  const findings = findStrncpyCalls();
  if (findings.length > 0) {
    console.error(
      [
        `check-strncpy: ${findings.length} strncpy-family call site(s) found — use snprintf(dst, sizeof(dst), "%s", src) (wide: wmemcpy/swprintf) instead.`,
        ...findings.map(f => `  ${f.file}:${f.line}: ${f.text}`),
        'snprintf always NUL-terminates and never over-reads the source;',
        'see the 2026-09 strncpy-sweep PR for the conversion pattern.',
      ].join('\n')
    );
    process.exit(1);
  }
  console.log(
    'check-strncpy: no strncpy-family call sites in installer/src (.c/.h/.inl, 0 findings).'
  );
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main();
}
