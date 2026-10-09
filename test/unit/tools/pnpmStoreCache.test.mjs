// test/unit/tools/pnpmStoreCache.test.mjs — the pnpm-store cache contract for
// .github/actions/setup-repo.
//
// The store cache is the repo's single largest cache consumer, and the way it
// goes wrong is silent: a key with any run-varying half can never be restored,
// so GitHub's "10 versions per key" cap stops applying and every job mints a
// fresh duplicate. Measured 2026-10-09 (issue #462): 65 `pnpm-cache-*` entries
// / 4.18 GB of byte-identical content, the bulk of the 10.79 GB that put the
// repo over the 10 GB Actions-cache cap — and sitting at the cap is what lets
// GitHub's LRU eviction eat the URL watchdog's state caches, which then reads
// as "every browser is a new version".
//
// Nothing else checked this, so the properties below are pinned out of the
// composite's own text:
//
//   1. pnpm/setup's built-in `cache:` is OFF — it is the per-run key source
//      (`<prefix>-<hashes>-<run_id>-<attempt>-<uuid>`);
//   2. no pnpm cache key carries a run-varying context, with a detector that
//      is proven to fire on the shape that caused #462;
//   3. the store key is the lockfile content hash + platform, so a save whose
//      key already exists no-ops instead of minting a new entry;
//   4. the store is cached with the actions/cache restore/save SPLIT, and the
//      save is guarded (a real install + success + the default branch) so a
//      killed job or a PR ref cannot poison or pad the family;
//   5. the cached path is resolved from `pnpm store path`, not hardcoded per OS
//      (the path has an OS-specific prefix and a store-format version segment
//      that moves with pnpm's major).

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const ACTION = path.join(ROOT, '.github', 'actions', 'setup-repo', 'action.yml');

const raw = fs.readFileSync(ACTION, 'utf8').replace(/\r\n/g, '\n');

/** Drop whole-line YAML/shell comments so prose can never satisfy a check. */
function stripComments(text) {
  return text
    .split('\n')
    .filter(line => !/^[ \t]*#/.test(line))
    .join('\n');
}

/** One block per composite step (` -` at the steps indentation). */
function stepBlocks(text) {
  return stripComments(text)
    .split(/^ {4}- /m)
    .slice(1);
}

/** The `key:` / `restore-keys:` expressions of every pnpm store cache step. */
function pnpmCacheKeys(text) {
  const keys = [];
  for (const block of stepBlocks(text)) {
    if (!/pnpm-cache-/.test(block)) continue;
    for (const line of block.split('\n')) {
      const m = line.match(/^\s*(restore-keys|key):\s*(.+?)\s*$/);
      if (m && /pnpm-cache-/.test(m[2])) keys.push({field: m[1], value: m[2]});
    }
  }
  return keys;
}

/**
 * A run-varying context anywhere in a key makes the entry unrestorable on any
 * later run and defeats GitHub's per-key version cap — the #462 regression.
 */
function runVaryingKeyViolations(keys) {
  return keys.filter(k => /\$\{\{[^}]*\b(?:run_id|run_attempt|run_number|uuid)\b/i.test(k.value));
}

const steps = stepBlocks(raw);
const keys = pnpmCacheKeys(raw);

test('the pnpm/setup step leaves its per-run store cache off', () => {
  const block = steps.find(b => /uses:\s*pnpm\/setup@/.test(b));
  assert.ok(block, 'setup-repo must install pnpm through pnpm/setup');
  assert.match(block, /^\s*cache:\s*false\s*$/m, 'pnpm/setup cache: must be false');
  assert.doesNotMatch(
    block,
    /^\s*cache:\s*true\s*$/m,
    'cache: true re-introduces the per-run store key'
  );
});

test('no pnpm store cache key carries a run-varying half', () => {
  assert.ok(keys.length >= 2, `expected a restore key and a save key, found ${keys.length}`);
  assert.deepEqual(runVaryingKeyViolations(keys), []);
});

test('the run-varying detector fires on the shape that caused #462', () => {
  // The mistake is made in the SOURCE expression, which is all the detector can
  // see: a literal legacy key varies by run id without naming one, so it is
  // (correctly) not flagged, while a run-scoped expression is.
  const literalLegacy =
    'pnpm-cache-Linux-x64-2fb24468351ea046bd9d0a57c23be5fd23e78f50a36bfdb56f46901df1ea7ef9' +
    '-37739280981-1-1f11f359-398b-4756-b7a7-183ba9805381';
  assert.deepEqual(runVaryingKeyViolations([{field: 'key', value: literalLegacy}]), []);
  assert.equal(
    runVaryingKeyViolations([
      {
        field: 'key',
        value: "pnpm-cache-Linux-x64-${{ github.run_id }}-${{ hashFiles('pnpm-lock.yaml') }}",
      },
    ]).length,
    1
  );
  assert.equal(
    runVaryingKeyViolations([
      {field: 'key', value: 'pnpm-cache-Linux-x64-${{ github.run_attempt }}'},
    ]).length,
    1
  );
  assert.deepEqual(
    runVaryingKeyViolations([
      {field: 'key', value: "pnpm-cache-Linux-X64-${{ hashFiles('pnpm-lock.yaml') }}"},
    ]),
    []
  );
});

test('the store key is the lockfile hash, with a prefix that can warm-fill', () => {
  assert.ok(
    keys.some(k => k.field === 'key' && /hashFiles\('pnpm-lock\.yaml'\)/.test(k.value)),
    'the pnpm store key must be derived from the lockfile content hash'
  );
  assert.ok(
    keys.some(k => k.field === 'restore-keys'),
    'a restore-keys prefix is what warm-fills a lockfile change'
  );
});

test('the store is cached with the restore/save split, save guarded', () => {
  const restore = steps.find(
    b => /uses:\s*actions\/cache\/restore@/.test(b) && /pnpm-cache-/.test(b)
  );
  const save = steps.find(b => /uses:\s*actions\/cache\/save@/.test(b) && /pnpm-cache-/.test(b));
  assert.ok(restore, 'the store needs an actions/cache/restore step');
  assert.ok(save, 'the store needs an actions/cache/save step');
  assert.match(save, /if:[^\n]*success\(\)/, 'a failed install must not mint an entry');
  assert.match(
    save,
    /if:[^\n]*inputs\.install == 'true'/,
    'a caller that installs in a later step must not save an unpopulated store'
  );
  assert.match(
    save,
    /if:[^\n]*refs\/heads\/main/,
    'a PR-ref copy is quota waste nothing but that PR can restore'
  );
  // Plain actions/cache (restore+save in one step) would save from a step that
  // never installed — the split exists so the save follows a real install.
  for (const block of steps) {
    if (/uses:\s*actions\/cache@/.test(block)) {
      assert.doesNotMatch(
        block,
        /pnpm-cache-/,
        'the pnpm store must not use plain actions/cache (use the restore/save split)'
      );
    }
  }
});
test('the cached path is resolved from pnpm, not spelled per platform', () => {
  assert.match(
    stripComments(raw),
    /pnpm store path/,
    'the store dir must come from `pnpm store path`'
  );
  // `shell: bash` aborts on a non-zero exit anyway, but the step should not
  // lean on that default for its only error path, and the non-empty guard
  // cannot tell "pnpm failed" from "pnpm printed nothing".
  assert.match(
    stripComments(raw),
    /DIR=\$\(pnpm store path --silent\)[^\n]*\|\|/,
    "the store path step must check pnpm's exit status explicitly"
  );
  for (const block of steps) {
    if (!/pnpm-cache-/.test(block)) continue;
    const pathLine = block.match(/^\s*path:\s*(.+?)\s*$/m);
    assert.ok(pathLine, 'every pnpm store cache step needs a path:');
    assert.match(
      pathLine[1],
      /steps\.pnpm-store\.outputs\.dir/,
      'every cache step must use the resolved store dir'
    );
  }
  assert.doesNotMatch(
    stripComments(raw),
    /(?:LOCALAPPDATA|Library\/pnpm|\.local\/share\/pnpm)/,
    'a hardcoded per-OS store path rots with pnpm store-format versions'
  );
});
