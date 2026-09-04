#!/usr/bin/env node

/**
 * gcc -fanalyzer over the installer sources — parallel runner + filter + cache.
 *
 * `make analyze` (part of `pnpm lint`) runs one gcc per source file in parallel
 * here instead of piping a single serial gcc through stdin. Each file is really
 * COMPILED (`-c`, object files in a temp dir): `-fsyntax-only` disables the
 * `-fanalyzer` pass entirely on modern gcc, so the old gate verified syntax
 * only while reporting itself as an analyzer.
 *
 * Results are cached in `installer/.analyzer-cache/` keyed by a hash of
 * everything that can change the outcome: the source file, the compiler flags,
 * the gcc version, and every transitively included header with its mtime (so a
 * re-generated `_config.h` / `resources.h` invalidates without content
 * sniffing). Only clean runs are cached — a run that reports findings or a gcc
 * failure never is, because gcc exits 0 even with analyzer warnings.
 *
 * Exit codes: 0 when no analyzer-class findings and every gcc exited 0; 1 on
 * analyzer findings or a gcc hard error (the old `gcc | node` pipe lost hard
 * errors and reported a false green); 2 when gcc cannot be run at all.
 */

import {spawn, spawnSync} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const INSTALLER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'installer');
const SRC_DIR = 'src';
const CACHE_DIR = path.join(INSTALLER_DIR, '.analyzer-cache');
const CACHE_VERSION = 1;

// Every top-level source in src/ — vendored miniz (src/vendor/) is excluded
// (read-only third-party code). Derived from the directory so a new file is
// analyzed without touching this list.
const SOURCES = fs
  .readdirSync(path.join(INSTALLER_DIR, SRC_DIR))
  .filter(f => f.endsWith('.c'))
  .sort();

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

/** All `#include "…"` files reachable from `file`, relative to src/. */
function localIncludes(file, seen = new Set()) {
  if (seen.has(file)) return seen;
  seen.add(file);
  const text = fs.readFileSync(path.join(INSTALLER_DIR, SRC_DIR, file), 'utf8');
  for (const m of text.matchAll(/^\s*#\s*include\s*"([^"]+)"/gm)) {
    const inc = path.normalize(m[1]);
    if (inc.endsWith('.h') && fs.existsSync(path.join(INSTALLER_DIR, SRC_DIR, inc))) {
      localIncludes(inc, seen);
    }
  }
  return seen;
}

/**
 * Cache key for one source: its bytes, the exact flags, the gcc version, and
 * the CONTENT of every transitively included local header. Content — not mtime
 * — because the Makefile regenerates _config.h / resources.h on every `make
 * analyze` run (touching them), while their content only changes when
 * installer.conf / installer/web actually change.
 */
function cacheKeyFor(file) {
  const hash = crypto.createHash('sha256');
  hash.update(CACHE_VERSION + '\n');
  for (const inc of localIncludes(file)) {
    hash.update(inc + '\n');
    hash.update(fs.readFileSync(path.join(INSTALLER_DIR, SRC_DIR, inc)));
  }
  hash.update(JSON.stringify(BASE_ARGS));
  hash.update(spawnSyncText('gcc', ['-dumpfullversion', '-dumpversion']));
  return hash.digest('hex');
}

function spawnSyncText(cmd, args) {
  const r = spawnSync(cmd, args, {encoding: 'utf8'});
  return r.status === 0 ? r.stdout : 'unknown';
}

/** Spawn one gcc; resolve (never reject) with {file, code, output}. */
function runGcc(file, objPath) {
  return new Promise(resolve => {
    const child = spawn('gcc', [...BASE_ARGS, path.join(SRC_DIR, file), `-o${objPath}`], {
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

function readCacheEntry(key) {
  try {
    const entry = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, `${key}.json`), 'utf8'));
    if (entry && entry.clean === true) return {findings: [], ...entry};
  } catch {
    /* miss */
  }
  return null;
}

function writeCacheEntry(key, entry) {
  fs.mkdirSync(CACHE_DIR, {recursive: true});
  fs.writeFileSync(path.join(CACHE_DIR, `${key}.json`), JSON.stringify(entry));
}

async function main() {
  // Object files share one temp dir (unique per run); cached files skip gcc.
  const OUT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'analyzer-'));

  try {
    const cache = new Map(SOURCES.map(f => [f, cacheKeyFor(f)]));
    const hits = new Map();
    const misses = [];
    for (const file of SOURCES) {
      const entry = readCacheEntry(cache.get(file));
      if (entry) hits.set(file, entry);
      else misses.push(file);
    }

    const results = await Promise.all(
      misses.map(file => runGcc(file, path.join(OUT_DIR, `${file}.o`)))
    );

    const unrunnable = results.find(r => r.code === null);
    if (unrunnable) {
      console.error('analyze-c failed: gcc could not be run.');
      console.error(unrunnable.output);
      process.exitCode = 2;
      return; // not exit(): the finally below must remove the temp dir
    }

    let total = 0;
    for (const {file, code, output} of results) {
      if (code !== 0) {
        // Hard compiler error (syntax error, bad flag, …) — always a failure,
        // analyzer findings or not.
        console.error(`✗ gcc failed on ${file} (exit ${code}):`);
        console.error(output || '(no output)');
        process.exitCode = 1;
        return; // not exit(): the finally below must remove the temp dir
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
      } else {
        // Cache only clean runs: gcc exits 0 even when it reports analyzer
        // warnings, so "exit 0" alone does not describe a re-runnable state.
        writeCacheEntry(cache.get(file), {clean: true, findings: []});
      }
    }

    for (const [file, entry] of hits) {
      total += entry.findings.length;
      if (entry.findings.length) {
        for (const f of entry.findings) console.error(`[${file}] (cached)\n${f}\n`);
      }
    }

    if (total) {
      console.error(`\n${total} analyzer finding(s) across ${SOURCES.length} files.`);
      process.exitCode = 1;
      return; // not exit(): the finally below must remove the temp dir
    }
    const cached = hits.size ? `, ${hits.size} cached` : '';
    console.log(
      `✓ gcc -fanalyzer: no memory-safety/UB findings (${SOURCES.length} files, compiled, parallel${cached})`
    );
  } finally {
    fs.rmSync(OUT_DIR, {recursive: true, force: true});
  }
}

main().catch(err => {
  console.error('analyze-c failed:', err);
  process.exit(2);
});
