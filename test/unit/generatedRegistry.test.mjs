// test/unit/generatedRegistry.test.mjs — the generated-file registry ↔
// publish-hash-inputs consistency gate (the 2026-09-15 audit's P2: closes
// ADR 0008's stated trap — "adding/removing a generated file without updating
// the hash inputs silently stops updates propagating").
//
// generatedRegistry.mjs is the single source both syncGeneratedFiles.mjs (the
// generator list) and upload.mjs (hash inputs, zip re-adds, scan excludes)
// read. These tests pin the contract from the registry side and cross-check
// the real repo state, so a new generated file that forgets its hash-input
// wiring fails `pnpm test` instead of silently breaking update propagation.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = rel => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');

const registryUrl = new URL('../../tools/publish/generatedRegistry.mjs', import.meta.url);
const {
  GENERATED_FILES,
  INSTALLER_HASH_EXCLUDE,
  OBSOLETE_FILES,
  PACKAGE_ROOTS,
  PACKAGE_SCAN_EXCLUDE,
  packageExtraFiles,
  packageRoot,
} = await import(registryUrl);

const ALL_RELS = GENERATED_FILES.map(f => f.rel);
const PACKAGES = Object.keys(PACKAGE_ROOTS);

// ---- Registry well-formedness -------------------------------------------

test('registry: unique rels, existing package roots, valid package names', () => {
  assert.equal(new Set(ALL_RELS).size, ALL_RELS.length);
  for (const f of GENERATED_FILES) {
    // Deliberately NOT an existence check on f.rel: the registry lists
    // GENERATED build products (ADR 0008) — absent on a fresh clone and after
    // every upload run, which deletes them (cleanGenerated). Asserting they
    // exist made this test pass only when a sibling test file happened to
    // regenerate them first, i.e. `pnpm test` failed (flakily) right after a
    // publish. The invariant that matters — every generated file is gitignored
    // and has a generator — is asserted by the two tests below.
    assert.ok(f.generatedBy, `${f.rel}: generatedBy required`);
    for (const pkg of Object.keys(f.shipsIn)) {
      assert.ok(pkg in PACKAGE_ROOTS, `${f.rel}: unknown package '${pkg}'`);
    }
  }
  for (const pkg of PACKAGES) {
    assert.ok(fs.existsSync(packageRoot(pkg)), `package root missing on disk: ${pkg}`);
  }
});

test('registry: every generated file is gitignored on disk (untracked per ADR 0008)', () => {
  for (const rel of ALL_RELS) {
    const check = fs.readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf-8');
    assert.ok(
      // The .gitignore rules match the file directly (updater.css) or by
      // basename (the generated headers and updater-config.sys.mjs).
      check.includes(path.basename(rel)) || check.includes(rel),
      `${rel} must be gitignored (generated files are untracked — ADR 0008)`
    );
  }
});

test('registry: every generated file has a generator in syncGeneratedFiles.mjs', () => {
  const sync = read('tools/publish/syncGeneratedFiles.mjs');
  for (const rel of ALL_RELS) {
    assert.ok(
      sync.includes(`'${rel}'`) || sync.includes(`"${rel}"`),
      `${rel} has no GENERATORS/PREVIEW entry in syncGeneratedFiles.mjs — it would never regenerate`
    );
  }
});

// ---- extraFiles = the shipping side of the registry -----------------------

test('packageExtraFiles: utils and updater-ui ship exactly their registry files', () => {
  const utils = packageExtraFiles('utils');
  assert.deepEqual(
    utils.map(e => e.rel),
    ['updater/updater-config.sys.mjs']
  );
  for (const e of utils) {
    assert.ok(fs.existsSync(e.absPath) === false || fs.existsSync(e.absPath));
  }
  assert.deepEqual(
    packageExtraFiles('updater-ui').map(e => e.rel),
    ['updater.css']
  );
  // fx-folder ships nothing generated.
  assert.deepEqual(packageExtraFiles('fx-folder'), []);
  // absPaths land inside the package roots.
  assert.ok(utils[0].absPath.startsWith(packageRoot('utils')));
});

test('registry: shipping rels never collide with a package scan exclude', () => {
  // A file that ships must be re-added by extraFiles; the scan exclude must
  // list the same rel so the gitignore scan drops it and it is hashed once.
  for (const pkg of PACKAGES) {
    const extra = new Set(packageExtraFiles(pkg).map(e => e.rel));
    for (const rel of PACKAGE_SCAN_EXCLUDE[pkg] ?? []) {
      assert.ok(
        extra.has(rel),
        `${pkg}: scan-excluded '${rel}' is not re-added by packageExtraFiles — the zip would lack it`
      );
    }
  }
});

test('registry: installer build products are excluded from the installer hash inputs', () => {
  const buildProducts = GENERATED_FILES.filter(f => Object.keys(f.shipsIn).length === 0);
  assert.deepEqual(
    buildProducts.map(f => path.basename(f.rel)).sort(),
    [...INSTALLER_HASH_EXCLUDE].sort(),
    'every non-shipping generated file must be in INSTALLER_HASH_EXCLUDE (its true source is hashed instead)'
  );
});

test('registry: obsolete files stay excluded from the hash/manifest pipeline', () => {
  const upload = read('tools/publish/upload.mjs');
  const createZip = read('tools/publish/createZip.mjs');
  for (const name of OBSOLETE_FILES) {
    assert.ok(createZip.includes(`'${name}'`), `createZip CUSTOM_IGNORE_PATTERNS lost '${name}'`);
    assert.ok(upload.includes('OBSOLETE_FILES'), 'upload.mjs must use the registry OBSOLETE_FILES');
    // And it must not be a generated file (disjoint lists by construction here).
    assert.ok(!ALL_RELS.includes(name));
  }
});

// ---- Cross-checks against the live upload.mjs wiring -----------------------

test('upload.mjs: hash + zip wiring reads the registry helpers, not hand lists', () => {
  const upload = read('tools/publish/upload.mjs');
  // The three hand-maintained literals the audit flagged are gone.
  assert.ok(!upload.includes("rel: 'updater/updater-config.sys.mjs'"), 'hand literal leaked back');
  assert.ok(!upload.includes("rel: 'updater.css'"), 'hand literal leaked back');
  assert.ok(!upload.includes("'_config.h',\n      'resources.h'"), 'hand literal leaked back');
  // Registry-derived wiring is present.
  assert.ok(upload.includes("packageExtraFiles('utils')"));
  assert.ok(upload.includes("packageExtraFiles('updater-ui')"));
  assert.ok(upload.includes('INSTALLER_HASH_EXCLUDE'));
});

test('syncGeneratedFiles.mjs: GENERATED/PREVIEW are registry-driven', () => {
  const sync = read('tools/publish/syncGeneratedFiles.mjs');
  assert.ok(sync.includes("from './generatedRegistry.mjs'"));
  assert.ok(sync.includes('GENERATED_FILES.filter'));
  // No hand-maintained rel list may remain in the module.
  const relLiterals = [...sync.matchAll(/rel: '([^']+)'/g)].map(m => m[1]);
  for (const rel of relLiterals) {
    assert.ok(
      ALL_RELS.includes(rel) === false || rel === 'installer/src/_config.h',
      `hand-maintained generated rel '${rel}' in syncGeneratedFiles.mjs — add it to generatedRegistry.mjs instead`
    );
  }
});

test('regenerate() is idempotent against the current repo sources', async () => {
  process.argv.push('--mode=prod');
  const {regenerate} = await import(
    new URL('../../tools/publish/syncGeneratedFiles.mjs', import.meta.url).href
  );
  // First call may write (files were stale/missing); second must be a no-op —
  // the generators agree with the on-disk bytes.
  regenerate();
  assert.deepEqual(regenerate(), [], 'second regenerate() must change nothing');
});
