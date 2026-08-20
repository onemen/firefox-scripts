// clang-format runner for the installer C sources.
//
// Prettier/ESLint don't support C, so the installer's .c/.h files are
// formatted with clang-format (style: installer/.clang-format, mirroring the
// codebase's 4-space/K&R conventions).  This script is the cross-platform
// glue: it discovers the sources, spawns the npm-provided clang-format binary
// once for the whole batch, and reports failures with a nonzero exit.
//
// Usage:
//   node tools/format-c.mjs --check   # dry run; exit 1 if any file needs formatting
//   node tools/format-c.mjs --write   # format files in place
//
// Excluded on purpose:
//   installer/src/vendor/**  - vendored third-party code (miniz)
//   installer/src/resources.h, _config.h - generated at build time

import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {readdirSync, statSync} from 'node:fs';
import {resolve, join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';

const require = createRequire(import.meta.url);
const srcRoot = resolve(fileURLToPath(new URL('..', import.meta.url)), 'installer/src');
const stylePath = resolve(fileURLToPath(new URL('..', import.meta.url)), 'installer/.clang-format');

const EXCLUDES = new Set(['vendor', 'resources.h', '_config.h']);

function collectC(path, out) {
  for (const entry of readdirSync(path)) {
    if (EXCLUDES.has(entry)) continue;
    const full = join(path, entry);
    if (statSync(full).isDirectory()) {
      collectC(full, out);
    } else if (/\.(c|h)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const files = collectC(srcRoot, []);
if (files.length === 0) {
  console.error('format-c: no C sources found under installer/src');
  process.exit(1);
}

const mode = process.argv.includes('--write') ? 'write' : 'check';
const args = ['--style=file:' + stylePath];
if (mode === 'write') {
  args.push('-i');
} else {
  args.push('-n', '--Werror'); // -n/-dry-run: report only
}
args.push(...files.map(f => relative(process.cwd(), f)));

const bin = require('clang-format').getNativeBinary();
const child = spawn(bin, args, {stdio: 'inherit'});
child.on('error', err => {
  console.error(`format-c: failed to spawn ${bin}: ${err.message}`);
  process.exit(1);
});
child.on('exit', code => {
  if (mode === 'check' && code !== 0) {
    console.error('format-c: run `npm run format:c` to fix the above files');
  }
  process.exit(code ?? 1);
});
