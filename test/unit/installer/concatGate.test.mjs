// test/unit/installer/concatGate.test.mjs — Issue #225 concat-gate contract.
//
// The installer's web UI ships as ONE concatenated script.js (embed.mjs
// concatenates the web/script/ IIFE fragments; the fragments cannot be parsed
// individually). The gates therefore run against the BUILT artifact
// (installer/src/script.built.js) instead of the fragments:
//
//   - embed.mjs regenerates the artifact on every run (every build/publish),
//   - config/eslint.config.js lints it with the full repo config,
//   - prettier formats it (it is NOT in .prettierignore),
//   - this test pins the contract so a refactor cannot silently drop the
//     wiring (the artifact going stale, ignored, or uncovered again).
//
// embed.mjs runs main() at import (same constraint as embed.test.mjs), so it
// is spawned, never imported. Pure Node + the repo's own tools; no compiler.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const ARTIFACT = path.join(REPO_ROOT, 'installer', 'src', 'script.built.js');
const EMBED = path.join(REPO_ROOT, 'installer', 'embed.mjs');

/** Run embed.mjs (writes resources.h + the artifact); assert success. */
function buildArtifact() {
  const r = spawnSync(process.execPath, [EMBED, '--stdout'], {
    encoding: 'utf-8',
  });
  assert.equal(r.status, 0, `embed.mjs failed: ${r.stderr}`);
}

/**
 * The concat, rebuilt from the fragment files in SCRIPT_PARTS order — the same
 * transformation buildScriptJs performs (trailing-ws trim per part, '\n' join).
 * Asserting the artifact byte-equals this pins that the gated bytes are exactly
 * the served bytes.
 */
function expectedConcat() {
  const src = fs.readFileSync(EMBED, 'utf8');
  const m = /const SCRIPT_PARTS = \[([\s\S]*?)\];/.exec(src);
  assert.ok(m, 'embed.mjs defines SCRIPT_PARTS');
  const parts = [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
  assert.ok(parts.length >= 5, 'SCRIPT_PARTS lists the fragments');
  return (
    parts
      .map(p =>
        fs
          .readFileSync(path.join(REPO_ROOT, 'installer', 'web', 'script', p), 'utf-8')
          .replace(/[\s\uFEFF\xA0]+$/u, '')
      )
      .join('\n') + '\n'
  );
}

/** The repo's eslint/prettier entry points, run on the artifact. */
function runTool(cmd, args) {
  return spawnSync('npx', [cmd, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    shell: process.platform === 'win32',
  });
}

test('concat-gate: embed.mjs persists the artifact next to resources.h', () => {
  fs.rmSync(ARTIFACT, {force: true});
  buildArtifact();
  assert.ok(fs.existsSync(ARTIFACT), 'script.built.js written by embed.mjs');
});

test('concat-gate: artifact bytes == the served concatenation', () => {
  buildArtifact();
  assert.equal(fs.readFileSync(ARTIFACT, 'utf8'), expectedConcat());
});

test('concat-gate: eslint covers the artifact (fragments stay excluded)', () => {
  const cfg = fs.readFileSync(path.join(REPO_ROOT, 'config', 'eslint.config.js'), 'utf8');
  assert.match(
    cfg,
    /files:\s*\['installer\/src\/script\.built\.js'\]/,
    'eslint override block targets the artifact'
  );
  assert.match(cfg, /'installer\/web\/script\/'/, 'fragments remain excluded');
});

test('concat-gate: prettier does not ignore the artifact', () => {
  const ig = fs.readFileSync(path.join(REPO_ROOT, 'config', '.prettierignore'), 'utf8');
  for (const line of ig.split('\n')) {
    const rule = line.trim();
    if (!rule || rule.startsWith('#') || rule.startsWith('!')) continue;
    const covers =
      rule === 'installer/src/script.built.js' ||
      rule === 'installer/src/*.js' ||
      rule === 'installer/src/**' ||
      rule === '**/installer/src/**';
    assert.ok(!covers, `.prettierignore must not exclude the artifact (found: ${rule})`);
  }
});

test('concat-gate: artifact is eslint-clean under the repo config', () => {
  const r = runTool('eslint', [
    '--config',
    './config/eslint.config.js',
    'installer/src/script.built.js',
  ]);
  assert.equal(r.status, 0, `eslint findings on the built concat:\n${r.stdout}${r.stderr}`);
});

test('concat-gate: artifact is prettier-clean under the repo config', () => {
  const r = runTool('prettier', ['--check', 'installer/src/script.built.js']);
  assert.equal(r.status, 0, `prettier findings on the built concat:\n${r.stdout}${r.stderr}`);
});
