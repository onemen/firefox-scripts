#!/usr/bin/env node

/**
 * Opt-in git hooks installer: `node tools/install-githooks.mjs` (or `pnpm
 * hooks:install`).
 *
 * Sets core.hooksPath to githooks/ — currently one pre-push gate that runs the
 * CI-equivalent checks (lint, format, test) so a red CI run is predictable. The
 * repo deliberately has no other hooks (ADR 0008 removed generation hooks;
 * generated files are built on demand by the Makefile / publish tooling).
 *
 * Self-heals a stale core.hooksPath pointing at a missing directory (observed
 * in the wild) by replacing it, and refuses to silently stomp a live config.
 */

import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOKS_DIR_REL = 'githooks';
const HOOKS_DIR = path.join(ROOT, HOOKS_DIR_REL);

function git(...args) {
  return execFileSync('git', args, {cwd: ROOT, encoding: 'utf8'}).trim();
}

const current = (() => {
  try {
    return git('config', '--get', 'core.hooksPath') || '';
  } catch {
    return '';
  }
})();

if (current === HOOKS_DIR_REL) {
  console.log(`✓ core.hooksPath already '${HOOKS_DIR_REL}' — nothing to do.`);
  process.exit(0);
}

if (current) {
  const abs = path.isAbsolute(current) ? current : path.join(ROOT, current);
  if (path.resolve(abs) === HOOKS_DIR) {
    // Same directory written in a different form (./githooks, trailing slash,
    // absolute path) — equivalent configuration, normalize to the bare form.
    console.log(`! core.hooksPath is '${current}' — same directory; normalizing.`);
  } else {
    const stale = !fs.existsSync(abs);
    console.log(
      `! core.hooksPath is '${current}' (${stale ? 'stale — directory does not exist' : 'in use'})`
    );
    if (!stale) {
      console.error(
        `Refusing to overwrite a live hooksPath. Inspect it, then unset manually:\n` +
          `  git config --unset core.hooksPath`
      );
      process.exit(1);
    }
    console.log(`  replacing stale value with '${HOOKS_DIR_REL}'.`);
  }
}

// Validate + chmod BEFORE flipping the config: a missing hook or a failed
// chmod must never leave git pointed at hooks that cannot run.
const prePush = path.join(HOOKS_DIR, 'pre-push');
if (!fs.existsSync(prePush)) {
  console.error(`✗ ${HOOKS_DIR_REL}/pre-push not found — core.hooksPath left unchanged.`);
  process.exit(1);
}

// Git for Windows runs hooks through bash, which ignores the executable bit;
// on POSIX it is required, so set it there (no-op on Windows where chmod is
// unreliable through MSYS).
const isWindows = process.platform === 'win32';
if (!isWindows) {
  fs.chmodSync(prePush, 0o755);
}

git('config', 'core.hooksPath', HOOKS_DIR_REL);
console.log(`✓ core.hooksPath set to '${HOOKS_DIR_REL}'.`);
console.log(
  `✓ pre-push gate installed: pnpm lint && pnpm format && pnpm test` +
    (isWindows ? '' : ' (chmod +x applied)') +
    `\n  bypass: git push --no-verify | uninstall: git config --unset core.hooksPath`
);
