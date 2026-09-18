// test/unit/publish/publishScope.test.mjs — unit tests for the partial-publish
// scope (tools/publish/publishScope.mjs, issue #157 AV holdback: publish only
// the named artifact roles instead of freezing every delivery).
//
// publishScope.mjs is dependency-free (no paths.js/publishMode import chain),
// so nothing has to be pushed onto argv before importing it.

import {test} from 'node:test';
import assert from 'node:assert/strict';

const {
  INCLUDE_ROLES,
  devBranchStrandWarning,
  noBinaryScope,
  parseInclude,
  scopeFor,
  includeBanner,
} = await import('../../../tools/publish/publishScope.mjs');

test('parseInclude: the flag is required — no argv means a loud error, never a guess', () => {
  assert.throws(() => parseInclude(['--mode=prod', '--local']), /Missing --include=<roles>/);
  assert.throws(() => parseInclude([]), /Missing --include=<roles>/);
});

test('parseInclude: a single role', () => {
  assert.deepEqual([...parseInclude(['--mode=prod', '--include=installer'])], ['installer']);
});

test('parseInclude: comma list, repeats and whitespace are folded into one set', () => {
  const include = parseInclude(['--include=installer, helper', '--include=helper']);
  assert.deepEqual([...include].sort(), ['helper', 'installer']);
  assert.equal(include.size, 2);
});

test('parseInclude: every documented role is accepted', () => {
  for (const role of INCLUDE_ROLES) {
    assert.deepEqual([...parseInclude([`--include=${role}`])], [role]);
  }
});

test('parseInclude: --include=all expands to every role', () => {
  assert.deepEqual([...parseInclude(['--include=all'])].sort(), [...INCLUDE_ROLES].sort());
  // `all` mixed with explicit roles is the same full set.
  assert.deepEqual(
    [...parseInclude(['--include=all,installer'])].sort(),
    [...INCLUDE_ROLES].sort()
  );
});

test('parseInclude: an unknown role fails loud with the expected list', () => {
  assert.throws(() => parseInclude(['--include=binaries']), /Unknown --include role 'binaries'/);
  assert.throws(() => parseInclude(['--include=binaries']), /packages\|installer\|helper\|all/);
});

test('parseInclude: an empty value is rejected, never silently a full publish', () => {
  assert.throws(() => parseInclude(['--include=']), /--include= needs at least one role/);
  assert.throws(() => parseInclude(['--include=,']), /Unknown --include role ''/);
});

test('scopeFor: an empty set (the old implicit default) is not reachable via the parser', () => {
  // scopeFor keeps a default for unit callers, but parseInclude can never
  // produce it — the flag is required.
  assert.deepEqual(scopeFor(), {
    packages: false,
    installer: false,
    helper: false,
  });
});

test('scopeFor: each included role flips only its own flag', () => {
  assert.deepEqual(scopeFor(parseInclude(['--include=installer'])), {
    packages: false,
    installer: true,
    helper: false,
  });
  assert.deepEqual(scopeFor(parseInclude(['--include=packages'])), {
    packages: true,
    installer: false,
    helper: false,
  });
  assert.deepEqual(scopeFor(parseInclude(['--include=installer,helper'])), {
    packages: false,
    installer: true,
    helper: true,
  });
  assert.deepEqual(scopeFor(parseInclude(['--include=all'])), {
    packages: true,
    installer: true,
    helper: true,
  });
});

test('noBinaryScope: true only when both binary roles are left out', () => {
  assert.equal(noBinaryScope(scopeFor(parseInclude(['--include=packages']))), true);
  assert.equal(noBinaryScope(scopeFor(parseInclude(['--include=installer']))), false);
  assert.equal(noBinaryScope(scopeFor(parseInclude(['--include=helper']))), false);
  assert.equal(noBinaryScope(scopeFor(parseInclude(['--include=all']))), false);
});

test('includeBanner: a full publish prints nothing', () => {
  assert.equal(includeBanner(parseInclude(['--include=all'])), '');
});

test('includeBanner: names the included roles, the held-back ones and the frozen entries', () => {
  const banner = includeBanner(parseInclude(['--include=packages']), {
    mode: 'prod',
  });
  assert.match(banner, /PARTIAL PROD PUBLISH — publishing: packages/);
  assert.match(banner, /Held back \(not built, scanned or uploaded\): installer, helper/);
  assert.match(banner, /hashes\.json entries stay frozen/);
  assert.match(banner, /#157/);
});

test('includeBanner: --local explains the snapshot variant instead', () => {
  const banner = includeBanner(parseInclude(['--include=packages,installer']), {
    mode: 'dev',
    local: true,
  });
  assert.match(banner, /PARTIAL DEV PUBLISH — publishing: packages, installer/);
  assert.match(banner, /snapshot simply omits the held-back roles/);
  assert.doesNotMatch(banner, /#157/);
});

test('devBranchStrandWarning: silent when packages are included', () => {
  assert.equal(
    devBranchStrandWarning(parseInclude(['--include=packages,helper']), {
      branchExists: false,
    }),
    ''
  );
  assert.equal(devBranchStrandWarning(parseInclude(['--include=all'])), '');
});

test('devBranchStrandWarning: a NEW dev branch without packages is a hard warning', () => {
  const text = devBranchStrandWarning(parseInclude(['--include=installer,helper']), {
    branchExists: false,
  });
  assert.match(text, /WARNING/);
  assert.match(text, /CREATES its dev-build branch/);
  assert.match(text, /--include=all/);
});

test('devBranchStrandWarning: an existing dev branch stays consistent', () => {
  const text = devBranchStrandWarning(parseInclude(['--include=installer']), {
    branchExists: true,
  });
  assert.match(text, /NOTE/);
  assert.match(text, /keep serving/);
  assert.doesNotMatch(text, /WARNING/);
});

test('devBranchStrandWarning: unknown branch state downgrades to the generic note', () => {
  const text = devBranchStrandWarning(parseInclude(['--include=installer']), {
    branchExists: null,
  });
  assert.match(text, /NOTE/);
  assert.match(text, /CREATES the dev-build branch/);
  assert.doesNotMatch(text, /WARNING/);
});
