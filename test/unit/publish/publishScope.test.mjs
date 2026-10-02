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
  devTabOnlyWarning,
  noBinaryScope,
  packageInScope,
  pagesCommitMessage,
  parseInclude,
  scopeFor,
  scopeLabel,
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
  assert.throws(
    () => parseInclude(['--include=binaries']),
    /packages\|updater-ui\|installer\|helper\|all/
  );
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
    updaterUi: false,
    installer: false,
    helper: false,
  });
});

test('scopeFor: each included role flips only its own flag', () => {
  assert.deepEqual(scopeFor(parseInclude(['--include=installer'])), {
    packages: false,
    updaterUi: false,
    installer: true,
    helper: false,
  });
  assert.deepEqual(scopeFor(parseInclude(['--include=packages'])), {
    packages: true,
    updaterUi: false,
    installer: false,
    helper: false,
  });
  assert.deepEqual(scopeFor(parseInclude(['--include=updater-ui'])), {
    packages: false,
    updaterUi: true,
    installer: false,
    helper: false,
  });
  assert.deepEqual(scopeFor(parseInclude(['--include=installer,helper'])), {
    packages: false,
    updaterUi: false,
    installer: true,
    helper: true,
  });
  assert.deepEqual(scopeFor(parseInclude(['--include=all'])), {
    packages: true,
    updaterUi: true,
    installer: true,
    helper: true,
  });
});

test('packageInScope: packages covers all three zips, updater-ui only the tab', () => {
  const full = scopeFor(parseInclude(['--include=packages']));
  for (const name of ['utils', 'fx-folder', 'updater-ui']) {
    assert.equal(packageInScope(full, name), true, `packages must cover ${name}`);
  }

  // The tab-only role (issue #383): utils/fx-folder stay frozen, so they must
  // read as out of scope or a "tab hotfix" would re-upload them too.
  const tabOnly = scopeFor(parseInclude(['--include=updater-ui']));
  assert.equal(packageInScope(tabOnly, 'updater-ui'), true);
  assert.equal(packageInScope(tabOnly, 'utils'), false);
  assert.equal(packageInScope(tabOnly, 'fx-folder'), false);

  // A binary-only run stages no zips at all.
  const binaries = scopeFor(parseInclude(['--include=installer,helper']));
  for (const name of ['utils', 'fx-folder', 'updater-ui']) {
    assert.equal(packageInScope(binaries, name), false, `${name} must be out of scope`);
  }
});

test('devTabOnlyWarning: silent unless the tab is published without `packages`', () => {
  assert.equal(devTabOnlyWarning(parseInclude(['--include=packages'])), '');
  assert.equal(devTabOnlyWarning(parseInclude(['--include=packages,updater-ui'])), '');
  assert.equal(devTabOnlyWarning(parseInclude(['--include=all'])), '');
  // A binary role alongside the tab does NOT make the branch complete — the zips
  // are still missing — so the warning must stay.
  assert.match(
    devTabOnlyWarning(parseInclude(['--include=updater-ui,installer']), {branchExists: false}),
    /WARNING/
  );
});

test('devTabOnlyWarning: a NEW dev branch carrying only the tab is a hard warning', () => {
  const text = devTabOnlyWarning(parseInclude(['--include=updater-ui']), {branchExists: false});
  assert.match(text, /WARNING/);
  assert.match(text, /CREATES its dev-build branch/);
  // The zips the installer needs are exactly what is missing.
  assert.match(text, /utils\.zip \/ fx-folder\.zip/);
  assert.match(text, /--include=packages/);
});

test('devTabOnlyWarning: an existing dev branch keeps its zips serving', () => {
  const text = devTabOnlyWarning(parseInclude(['--include=updater-ui']), {branchExists: true});
  assert.match(text, /NOTE/);
  assert.match(text, /only the tab moves/);
  assert.doesNotMatch(text, /WARNING/);
});

test('devBranchStrandWarning: the tab role counts as a package role', () => {
  // A branch that carries the tab is not the "no zips at all" strand shape.
  assert.equal(
    devBranchStrandWarning(parseInclude(['--include=updater-ui']), {branchExists: false}),
    ''
  );
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

test('includeBanner: a packages run does not claim the tab is held back (it ships with it)', () => {
  const banner = includeBanner(parseInclude(['--include=packages,installer']), {mode: 'prod'});
  assert.doesNotMatch(banner, /updater-ui/);
});

test('includeBanner: a tab-only run names the packages role as held back', () => {
  const banner = includeBanner(parseInclude(['--include=updater-ui']), {mode: 'prod'});
  assert.match(banner, /publishing: updater-ui/);
  assert.match(banner, /Held back \(not built, scanned or uploaded\): packages, installer, helper/);
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

test('scopeLabel: a full publish stays "artifacts" (the historical wording)', () => {
  assert.equal(scopeLabel(parseInclude(['--include=all'])), 'artifacts');
});

test('scopeLabel: a partial publish names exactly its roles, in role order', () => {
  assert.equal(scopeLabel(parseInclude(['--include=packages'])), 'packages');
  assert.equal(scopeLabel(parseInclude(['--include=installer,helper'])), 'installer+helper');
  // role order is normalized: helper,installer ships as installer+helper
  assert.equal(scopeLabel(parseInclude(['--include=helper,installer'])), 'installer+helper');
});

test('pagesCommitMessage: full prod — the historical shape', () => {
  assert.equal(
    pagesCommitMessage({
      mode: 'prod',
      include: parseInclude(['--include=all']),
      date: '2026-09-20',
    }),
    'chore: publish prod artifacts (2026-09-20)'
  );
});

test('pagesCommitMessage: partial scope and the pushed platform join the subject', () => {
  // call-site reality: the platform list comes from the binaries actually
  // pushed (builtInstallers/builtHelpers), so a packages-only run — which
  // ships only platform-independent zips + manifest — names no platform.
  assert.equal(
    pagesCommitMessage({
      mode: 'prod',
      include: parseInclude(['--include=packages']),
      platforms: [],
      date: '2026-09-20',
    }),
    'chore: publish prod packages (2026-09-20)'
  );
  assert.equal(
    pagesCommitMessage({
      mode: 'prod',
      include: parseInclude(['--include=installer,helper']),
      platforms: ['linux'],
      date: '2026-09-20',
    }),
    'chore: publish prod installer+helper (linux, 2026-09-20)'
  );
});

test('pagesCommitMessage: dev carries the disposable branch id, prod never does', () => {
  assert.equal(
    pagesCommitMessage({
      mode: 'dev',
      include: parseInclude(['--include=all']),
      platforms: [],
      devBranch: 'dev-build-main-abc1',
      date: '2026-09-20',
    }),
    'chore: publish dev artifacts (dev-build-main-abc1, 2026-09-20)'
  );
  assert.equal(
    pagesCommitMessage({
      mode: 'prod',
      include: parseInclude(['--include=all']),
      platforms: [],
      devBranch: 'gh-pages',
      date: '2026-09-20',
    }),
    'chore: publish prod artifacts (2026-09-20)'
  );
});
