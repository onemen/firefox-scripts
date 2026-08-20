#!/usr/bin/env node

/**
 * Filter gcc -fanalyzer output for real analyzer-class findings.
 *
 * `make analyze` pipes the compiler's stderr here. GCC emits a lot of harmless
 * -Wextra noise (missing initializers, unused parameters, etc.) on every build;
 * this script keeps only the diagnostics that indicate actual memory-safety/UB
 * classes and exits 1 if any are present:
 *
 * use-after-free / use-after-return / double-free / leak / NULL deref /
 * overflow / uninitialized use / buffer over-read or over-write
 *
 * Usage (from installer/): make analyze Exit code: 0 when no analyzer-class
 * issues, 1 when there are.
 */

import {createInterface} from 'node:readline';

const ANALYZER_RE =
  /(use-after-free|use-after-return|double-free|leak of|NULL dereference|'free' of|heap-use-after|over-read|over-write|buffer overflow|uninitialized|uninitialised|warning: .*too small|allocation size)/i;

async function main() {
  const rl = createInterface({input: process.stdin});
  const findings = [];
  let current = [];
  const flush = () => {
    if (current.length && current.some(l => ANALYZER_RE.test(l))) {
      findings.push(current.join('\n'));
    }
    current = [];
  };
  for await (const line of rl) {
    if (/^\s*$/.test(line)) {
      flush();
      continue;
    }
    current.push(line);
  }
  flush();

  if (findings.length) {
    console.error(`✗ gcc -fanalyzer found ${findings.length} potential issue(s):\n`);
    for (const f of findings) {
      console.error(f + '\n');
    }
    process.exit(1);
  }
  console.log('✓ gcc -fanalyzer: no memory-safety/UB findings');
}

main().catch(err => {
  console.error('analyze-c failed:', err);
  process.exit(2);
});
