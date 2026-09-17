// test/unit/publish/publishScope.test.mjs — unit tests for the partial-publish
// scope (tools/publish/publishScope.mjs, issue #157 AV holdback: hold back one
// artifact role instead of freezing every delivery).
//
// publishScope.mjs is dependency-free (no paths.js/publishMode import chain),
// so nothing has to be pushed onto argv before importing it.

import {test} from 'node:test';
import assert from 'node:assert/strict';

const {SKIP_ROLES, noBinaryScope, parseSkip, scopeFor, skipBanner} =
  await import('../../../tools/publish/publishScope.mjs');

test('parseSkip: no --skip= argument means a full publish', () => {
  assert.deepEqual([...parseSkip(['--mode=prod', '--local'])], []);
});

test('parseSkip: a single role', () => {
  assert.deepEqual([...parseSkip(['--mode=prod', '--skip=installer'])], ['installer']);
});

test('parseSkip: comma list, repeats and whitespace are folded into one set', () => {
  const skip = parseSkip(['--skip=installer, helper', '--skip=helper']);
  assert.deepEqual([...skip].sort(), ['helper', 'installer']);
  assert.equal(skip.size, 2);
});

test('parseSkip: every documented role is accepted', () => {
  for (const role of SKIP_ROLES) {
    assert.deepEqual([...parseSkip([`--skip=${role}`])], [role]);
  }
});

test('parseSkip: an unknown role fails loud with the expected list', () => {
  assert.throws(() => parseSkip(['--skip=binaries']), /Unknown --skip role 'binaries'/);
  assert.throws(() => parseSkip(['--skip=binaries']), /packages\|installer\|helper/);
});

test('parseSkip: an empty value is rejected, never silently a full publish', () => {
  assert.throws(() => parseSkip(['--skip=']), /--skip= needs at least one role/);
  assert.throws(() => parseSkip(['--skip=,']), /Unknown --skip role ''/);
});

test('scopeFor: nothing skipped → every role in scope', () => {
  assert.deepEqual(scopeFor(parseSkip([])), {packages: true, installer: true, helper: true});
});

test('scopeFor: each role flips only its own flag', () => {
  assert.deepEqual(scopeFor(parseSkip(['--skip=installer'])), {
    packages: true,
    installer: false,
    helper: true,
  });
  assert.deepEqual(scopeFor(parseSkip(['--skip=packages'])), {
    packages: false,
    installer: true,
    helper: true,
  });
  assert.deepEqual(scopeFor(parseSkip(['--skip=installer,helper'])), {
    packages: true,
    installer: false,
    helper: false,
  });
});

test('noBinaryScope: true only when both binary roles are held back', () => {
  assert.equal(noBinaryScope(scopeFor(parseSkip(['--skip=installer,helper']))), true);
  assert.equal(noBinaryScope(scopeFor(parseSkip(['--skip=installer']))), false);
  assert.equal(noBinaryScope(scopeFor(parseSkip(['--skip=packages']))), false);
  assert.equal(noBinaryScope(scopeFor(parseSkip([]))), false);
});

test('skipBanner: a full publish prints nothing', () => {
  assert.equal(skipBanner(parseSkip([])), '');
});

test('skipBanner: names the held-back roles and the frozen manifest entries', () => {
  const banner = skipBanner(parseSkip(['--skip=installer,helper']), {mode: 'prod'});
  assert.match(banner, /PARTIAL PROD PUBLISH — held back: installer, helper/);
  assert.match(banner, /hashes\.json entries stay frozen/);
  assert.match(banner, /#157/);
});

test('skipBanner: --local explains the snapshot variant instead', () => {
  const banner = skipBanner(parseSkip(['--skip=helper']), {mode: 'dev', local: true});
  assert.match(banner, /PARTIAL DEV PUBLISH — held back: helper/);
  assert.match(banner, /snapshot simply omits the held-back roles/);
  assert.doesNotMatch(banner, /#157/);
});
