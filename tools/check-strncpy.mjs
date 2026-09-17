#!/usr/bin/env node

/**
 * tools/check-strncpy.mjs — forbid new `strncpy(` call sites in installer/src.
 *
 * House convention is the bounded copy `snprintf(dst, sizeof(dst), "%s", src)`:
 * always NUL-terminates, never over-reads the source, and keeps the tree clean
 * for SAST scanners (the semgrep rule behind bot PRs #163/#229 kept firing on
 * the idiom one site at a time). The 2026-09 sweep converted all 57 call sites;
 * this gate is what stops a refactor or a new platform variant from quietly
 * reintroducing the idiom (the way #214 re-seeded a fourth copy of it).
 *
 * Zero tolerance — no allowlist for first-party code. The two `strncpy`
 * mentions that remain in the tree are gcc -fanalyzer workaround comments
 * explaining a deliberate non-use; the scanner matches call syntax across line
 * breaks, so prose is out of scope by construction. The scan is recursive under
 * installer/src (helper/ included) but skips vendor/ — vendored third-party
 * code (miniz) is pristine and read-only per AGENTS.md, so it is not ours to
 * gate.
 *
 * Exit code 0 = no call sites. Run via `pnpm lint` (lint:ncpy stage).
 */

import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_DIR = path.join(REPO_ROOT, 'installer', 'src');

const CALL_RE = /\bstrncpy\s*\(/g;

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
    } else if (e.isFile() && /\.c$/.test(e.name)) {
      out.push(full);
    }
  }
  return out.sort();
}

/**
 * Find every line carrying a `strncpy(` call in the given C sources. Matches
 * across line breaks (a `(` on the next line is still a call), and non-.c paths
 * are ignored so callers cannot widen the scope by accident.
 */
export function findStrncpyCalls(files = listCSources(SCAN_DIR), root = REPO_ROOT) {
  const findings = [];
  for (const file of files.filter(f => /\.c$/.test(f))) {
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
        `check-strncpy: ${findings.length} strncpy call site(s) found — use snprintf(dst, sizeof(dst), "%s", src) instead.`,
        ...findings.map(f => `  ${f.file}:${f.line}: ${f.text}`),
        'snprintf always NUL-terminates and never over-reads the source;',
        'see the 2026-09 strncpy-sweep PR for the conversion pattern.',
      ].join('\n')
    );
    process.exit(1);
  }
  console.log('check-strncpy: no strncpy call sites in installer/src (0 findings).');
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main();
}
