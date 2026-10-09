#!/usr/bin/env node

/**
 * tools/check-apt-get.mjs — forbid raw `sudo apt-get update/install` call sites
 * in .github/workflows and .github/actions.
 *
 * Every apt fetch must route through .github/actions/bound-apt (timeout 120 s
 * on update, retries with backoff, acquire/dpkg-lock timeouts, skip when the
 * probe command exists) so a stalled archive mirror fails fast instead of
 * eating the whole job timeout (issue #461).
 *
 * Scope: lines where `sudo apt-get update|install` starts a shell command
 * (leading whitespace only) across the YAML files under .github, excluding the
 * bound-apt action itself. Prose mentions (comments, backtick-quoted) are out
 * of scope by construction — they never start a command.
 *
 * Exit code 0 = no raw call sites. Run via `pnpm lint` (lint:apt stage).
 */

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_DIR = path.join(REPO_ROOT, '.github');
const EXEMPT_DIR = path.join(SCAN_DIR, 'actions', 'bound-apt');

const RAW_CALL_RE = /^\s*sudo\s+apt-get\s+(update|install)\b/;
const YAML_LIKE = /\.(yml|yaml)$/;

function listYaml(dir) {
  const out = [];
  for (const e of fs
    .readdirSync(dir, {withFileTypes: true})
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...listYaml(full));
    } else if (e.isFile() && YAML_LIKE.test(e.name)) {
      out.push(full);
    }
  }
  return out.sort();
}

/**
 * Find every raw `sudo apt-get update|install` command line in the given YAML
 * files. Files under the bound-apt action are exempt (that is the wrapper
 * itself); non-YAML paths are ignored so callers cannot widen the scope.
 */
export function findRawAptGetCalls(files = listYaml(SCAN_DIR), root = REPO_ROOT) {
  const findings = [];
  for (const file of files.filter(
    f => YAML_LIKE.test(f) && path.relative(EXEMPT_DIR, f).startsWith('..')
  )) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((text, i) => {
      if (RAW_CALL_RE.test(text)) {
        findings.push({
          file: path.relative(root, file).replaceAll('\\', '/'),
          line: i + 1,
          text: text.trim(),
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
        `check-apt-get: ${findings.length} raw sudo apt-get call site(s) found — route through .github/actions/bound-apt instead (issue #461).`,
        ...findings.map(f => `  ${f.file}:${f.line}: ${f.text}`),
      ].join('\n')
    );
    process.exit(1);
  }
  console.log('check-apt-get: no raw sudo apt-get call sites in .github (0 findings).');
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main();
}
