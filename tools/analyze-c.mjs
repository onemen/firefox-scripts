#!/usr/bin/env node

/**
 * gcc -fanalyzer over the installer sources — parallel runner + filter.
 *
 * `make analyze` (part of `pnpm lint`) runs one gcc per source file in parallel
 * here instead of piping a single serial gcc through stdin. The per-file stderr
 * is filtered for analyzer-class diagnostics; everything else (the usual
 * -Wextra noise: missing initializers, unused parameters, …) is dropped. Kept
 * classes:
 *
 * use-after-free / use-after-return / double-free / leak / NULL deref /
 * overflow / uninitialized use / buffer over-read or over-write
 *
 * Exit codes: 0 when no analyzer-class findings and every gcc exited 0; 1 on
 * analyzer findings or a gcc hard error (the old `gcc | node` pipe lost hard
 * errors and reported a false green); 2 when gcc cannot be run at all.
 */

import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const INSTALLER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'installer');
const SRC_DIR = 'src';

// Mirrors the file list the Makefile analyzed before this script took over
// the orchestration. Vendored miniz is excluded (read-only third-party code).
const SOURCES = [
  'main.c',
  'detect_browser.c',
  'http_server.c',
  'file_utils.c',
  'admin_copy.c',
  'self_update.c',
];

const BASE_ARGS = [
  '-fanalyzer',
  '-Wall',
  '-Wextra',
  `-I${SRC_DIR}`,
  '-DMINIZ_NO_DEFLATE_APIS',
  '-DMINIZ_NO_ZLIB_APIS',
  '-fsyntax-only',
];

const ANALYZER_RE =
  /(use-after-free|use-after-return|double-free|leak of|NULL dereference|'free' of|heap-use-after|over-read|over-write|buffer overflow|uninitialized|uninitialised|warning: .*too small|allocation size)/i;

/** Spawn one gcc; resolve (never reject) with {file, code, output}. */
function runGcc(file) {
  return new Promise(resolve => {
    const child = spawn('gcc', [...BASE_ARGS, path.join(SRC_DIR, file)], {
      cwd: INSTALLER_DIR,
    });
    let output = '';
    child.stderr.on('data', chunk => {
      output += chunk;
    });
    child.on('error', err => {
      resolve({file, code: null, output: String(err)});
    });
    child.on('close', code => {
      resolve({file, code, output});
    });
  });
}

/** Keep only blank-line-separated diagnostic blocks that match ANALYZER_RE. */
function analyzerFindings(output) {
  const findings = [];
  let current = [];
  const flush = () => {
    if (current.length && current.some(line => ANALYZER_RE.test(line))) {
      findings.push(current.join('\n'));
    }
    current = [];
  };
  for (const line of output.split(/\r?\n/)) {
    if (/^\s*$/.test(line)) {
      flush();
      continue;
    }
    current.push(line);
  }
  flush();
  return findings;
}

async function main() {
  const results = await Promise.all(SOURCES.map(runGcc));

  const unrunnable = results.find(r => r.code === null);
  if (unrunnable) {
    console.error('analyze-c failed: gcc could not be run.');
    console.error(unrunnable.output);
    process.exit(2);
  }

  let total = 0;
  for (const {file, code, output} of results) {
    if (code !== 0) {
      // Hard compiler error (syntax error, bad flag, …) — always a failure,
      // analyzer findings or not.
      console.error(`✗ gcc failed on ${file} (exit ${code}):`);
      console.error(output || '(no output)');
      process.exit(1);
    }
    const findings = analyzerFindings(output);
    if (findings.length) {
      if (total === 0) {
        console.error('✗ gcc -fanalyzer found potential issue(s):\n');
      }
      for (const f of findings) {
        console.error(`[${file}]\n${f}\n`);
      }
      total += findings.length;
    }
  }

  if (total) {
    console.error(`\n${total} analyzer finding(s) across ${SOURCES.length} files.`);
    process.exit(1);
  }
  console.log(`✓ gcc -fanalyzer: no memory-safety/UB findings (${SOURCES.length} files, parallel)`);
}

main().catch(err => {
  console.error('analyze-c failed:', err);
  process.exit(2);
});
