#!/usr/bin/env node

/**
 * gcc -fanalyzer over the installer sources — parallel runner + filter.
 *
 * `make analyze` (part of `pnpm lint`) runs one gcc per source file in parallel
 * here instead of piping a single serial gcc through stdin. Each file is really
 * COMPILED (`-c`, object files in a temp dir): `-fsyntax-only` disables the
 * `-fanalyzer` pass entirely on modern gcc, so the old gate verified syntax
 * only while reporting itself as an analyzer. The per-file stderr is filtered
 * for analyzer-class diagnostics; everything else (the usual -Wextra noise:
 * missing initializers, unused parameters, …) is dropped. Kept classes:
 *
 * use-after-free / use-after-return / double-free / leak / NULL deref /
 * overflow / uninitialized use / buffer over-read or over-write
 *
 * Exit codes: 0 when no analyzer-class findings and every gcc exited 0; 1 on
 * analyzer findings or a gcc hard error (the old `gcc | node` pipe lost hard
 * errors and reported a false green); 2 when gcc cannot be run at all.
 */

import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
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

const OUT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'analyzer-'));

const BASE_ARGS = [
  '-fanalyzer',
  '-Wall',
  '-Wextra',
  `-I${SRC_DIR}`,
  '-DMINIZ_NO_DEFLATE_APIS',
  '-DMINIZ_NO_ZLIB_APIS',
  '-c',
];

const ANALYZER_RE =
  /warning:.*(Wanalyzer|leak of|dereference of|over-read|over-write|buffer overflow|uninitialized|uninitialised|allocation size)/i;

/** A line that opens a gcc warning diagnostic. */
const WARNING_RE = /^src[/\\].*warning: /;

/**
 * Keep diagnostic blocks that OPEN with an analyzer-class warning. Only the
 * first line of a gcc diagnostic is reliably tagged — merged blocks (several
 * warnings without a separating blank line) must be split, otherwise a plain
 * -Wextra warning can inherit an analyzer verdict from a neighbour. Non-gcc
 * lines (source excerpts, event traces, headers' notes) are dropped outright:
 * the events path printed for a finding reproduces the source, and gcc exits
 * non-zero on its own when a hard error occurs.
 */
function analyzerFindings(output) {
  const findings = [];
  for (const line of output.split(/\r?\n/)) {
    if (!WARNING_RE.test(line)) continue;
    if (ANALYZER_RE.test(line)) findings.push(line);
  }
  return findings;
}

function runGcc(file) {
  return new Promise(resolve => {
    const obj = path.join(OUT_DIR, `${file}.o`);
    const child = spawn('gcc', [...BASE_ARGS, path.join(SRC_DIR, file), `-o${obj}`], {
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
  console.log(
    `✓ gcc -fanalyzer: no memory-safety/UB findings (${SOURCES.length} files, compiled, parallel)`
  );
}

main()
  .catch(err => {
    console.error('analyze-c failed:', err);
    process.exitCode = 2;
  })
  .finally(() => {
    fs.rmSync(OUT_DIR, {recursive: true, force: true});
  });
