// test/unit/installer/prodIdentityEmbed.test.mjs — the prod installer must NOT
// embed the release identity string. CFG_DEV_BRANCH is dev/local-only (its sole
// consumer, the "test build" banner, early-returns unless isLocal||isDev), and
// the string is HEAD-derived: embedded in prod it re-rolled the PE bytes on
// EVERY main commit — a core-only commit invalidated the WDSI hash submission
// with no installer-scoped change (2026-09-26 Phase 2R: installer drifted
// 1bf69bba→960628f8 on 7 ASCII bytes of embedded commit hash + 3 checksum
// bytes, while the helper — which omits _config.h — stayed byte-identical).
//
// Contract being pinned (ADR 0036 amendment, 2026-09-26):
//   prod build  → CFG_DEV_BRANCH "" (bytes depend only on installer-scoped
//                 inputs, the same set the build epoch derives from);
//   dev/local   → "dev-build-<id>" (the banner needs it).
//
// Source-level wiring checks in the makefileGeneratorFlags.test.mjs style: the
// generator itself is module-scope-bound to the real argv/env, so the test
// reads the exact expression that bakes the value.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const SYNC_PATH = path.join(REPO_ROOT, 'tools', 'publish', 'syncGeneratedFiles.mjs');
const PLATFORM_H = path.join(REPO_ROOT, 'installer', 'src', 'platform.h');

// LF-normalize at read (text files are LF in the repo; a working-tree copy can
// linger as CRLF — AGENTS.md → Conventions).
const syncSrc = fs.readFileSync(SYNC_PATH, 'utf-8').replace(/\r\n/g, '\n');
const platformSrc = fs.readFileSync(PLATFORM_H, 'utf-8').replace(/\r\n/g, '\n');

test('identity embed: the generator gates CFG_DEV_BRANCH on dev/local', () => {
  // The exact bake line must derive from the MODE/LOCAL guard, never from the
  // raw DEV_BRANCH constant.
  assert.match(
    syncSrc,
    /const devBranchValue = MODE === 'dev' \|\| LOCAL \? DEV_BRANCH : '';/,
    'syncGeneratedFiles.mjs must gate the identity value on MODE===dev || LOCAL'
  );
  assert.match(
    syncSrc,
    /#define CFG_DEV_BRANCH "\$\{devBranchValue\}"/,
    'the _config.h template must emit the gated value, not DEV_BRANCH directly'
  );
  // And no other line may bake the raw constant into the C header.
  const bakeLines = syncSrc.split('\n').filter(l => l.includes('CFG_DEV_BRANCH'));
  for (const line of bakeLines) {
    assert.ok(
      !/`\$\{DEV_BRANCH\}`/.test(line),
      `a CFG_DEV_BRANCH line still embeds the raw HEAD-derived constant: ${line.trim()}`
    );
  }
});

test('identity embed: prod output carries an empty CFG_DEV_BRANCH', () => {
  // End-to-end through the real generator: prod (MODE=prod, LOCAL=false) must
  // produce `#define CFG_DEV_BRANCH ""` regardless of HEAD. The generator
  // functions are module-scope-bound to live argv/env, so drive the check
  // through a fresh node subprocess with the publish env cleared.
  const {execFileSync} = require('node:child_process');
  const probe = `
    import {createRequire} from 'node:module';
    const require = createRequire(import.meta.url);
    import {configHeader} from ${JSON.stringify(pathToFileURL(SYNC_PATH).href)};
    const src = configHeader(require('node:fs').readFileSync(${JSON.stringify(
      path.join(REPO_ROOT, 'config', 'installer.conf')
    )}, 'utf-8'));
    const line = src.split('\\n').find(l => l.includes('CFG_DEV_BRANCH'));
    console.log(line);
  `;
  const tmp = path.join(REPO_ROOT, 'dist', 'fxs-identity-probe.mjs');
  fs.mkdirSync(path.dirname(tmp), {recursive: true});
  fs.writeFileSync(tmp, probe);
  try {
    const out = execFileSync(
      process.execPath,
      [tmp],
      // No --mode/--local argv and no DEV_BUILD_ID env: the prod default.
      {env: {...process.env, DEV_BUILD_ID: ''}, encoding: 'utf-8'}
    ).trim();
    assert.equal(
      out,
      '#define CFG_DEV_BRANCH ""',
      'a prod-mode generated header must embed an empty identity string'
    );
  } finally {
    fs.rmSync(tmp, {force: true});
  }
});

test('identity embed: dev and local outputs keep the banner string', () => {
  const {execFileSync} = require('node:child_process');
  const cases = [
    {argv: ['--mode=dev'], label: 'dev'},
    {argv: ['--local'], label: 'local'},
  ];
  for (const {argv, label} of cases) {
    const probe = `
      import {createRequire} from 'node:module';
    const require = createRequire(import.meta.url);
    import {configHeader} from ${JSON.stringify(pathToFileURL(SYNC_PATH).href)};
      const src = configHeader(require('node:fs').readFileSync(${JSON.stringify(
        path.join(REPO_ROOT, 'config', 'installer.conf')
      )}, 'utf-8'));
      console.log(src.split('\\n').find(l => l.includes('CFG_DEV_BRANCH')));
    `;
    const tmp = path.join(REPO_ROOT, 'dist', 'fxs-identity-probe.mjs');
    fs.writeFileSync(tmp, probe);
    try {
      const out = execFileSync(process.execPath, [tmp, ...argv], {encoding: 'utf-8'}).trim();
      assert.match(
        out,
        /^#define CFG_DEV_BRANCH "dev-build-/,
        `a ${label} build must keep its banner identity string`
      );
    } finally {
      fs.rmSync(tmp, {force: true});
    }
  }
});

test('identity embed: the C header documents the empty-in-prod contract', () => {
  assert.match(
    platformSrc,
    /INSTALLER_DEV_BRANCH ""/,
    'platform.h must keep the empty fallback for the prod build'
  );
  assert.match(
    platformSrc,
    /BY DESIGN[\s\S]*?re-roll the PE[\s\S]*?bytes/,
    'platform.h must document WHY the string is empty in prod (the 2026-09-26 finding)'
  );
});
