// test/unit/tools/nightlyBuildId.test.mjs — the pure half of
// tools/ci/nightly-buildid.mjs.
//
// The scheduled core-smoke leg keys its "already validated" cache marker on the
// build ID this produces. That makes a WRONG id the worst possible failure: a
// stable-but-wrong id caches a skip over a build that was never validated (the
// leg silently stops running), and a per-run-varying id defeats the cache so
// the leg runs every night. Both are invisible without a test, and neither can
// be caught by looking at the workflow YAML.
//
// The HTTP round trip is not unit-tested (one HEAD request against Mozilla is
// the same cost as the run it gates); the PARSING is, because that is the part
// that rots: the header format is an HTTP date, and the mapping to a compact
// sortable id is where a month name or a padding mistake would hide.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';

import {parseBuildId, isDirectInvocation} from '../../../tools/ci/nightly-buildid.mjs';

test('a Nightly tarball Last-Modified header becomes a compact build id', () => {
  assert.equal(parseBuildId('Wed, 26 Aug 2026 11:15:31 GMT'), '20260826-1115');
});

test('the id is zero-padded so it sorts chronologically as a string', () => {
  // Lexicographic ordering is what makes the Actions-cache key usable, and it
  // only works if every field is fixed width: '2026-8-6' would sort wrong.
  const early = parseBuildId('Thu, 01 Jan 2026 00:00:00 GMT');
  const late = parseBuildId('Tue, 09 Feb 2026 00:00:00 GMT');
  assert.equal(early, '20260101-0000');
  assert.equal(late, '20260209-0000');
  assert.ok(early < late, 'January sorts before February');
});

test('every month name maps to its two-digit number', () => {
  // A missing month entry would throw for that build only — a once-a-year
  // failure nobody sees until it ships.
  const months = [
    ['Jan', '01'],
    ['Feb', '02'],
    ['Mar', '03'],
    ['Apr', '04'],
    ['May', '05'],
    ['Jun', '06'],
    ['Jul', '07'],
    ['Aug', '08'],
    ['Sep', '09'],
    ['Oct', '10'],
    ['Nov', '11'],
    ['Dec', '12'],
  ];
  for (const [name, num] of months) {
    assert.equal(parseBuildId(`Wed, 26 ${name} 2026 11:15:31 GMT`), `2026${num}26-1115`, name);
  }
});

test('seconds are dropped but the minute is kept', () => {
  // Minute precision is deliberate: two builds inside the same minute would
  // share an id and one leg would be skipped, which is the failure mode above.
  assert.equal(parseBuildId('Wed, 26 Aug 2026 11:15:00 GMT'), '20260826-1115');
  assert.notEqual(
    parseBuildId('Wed, 26 Aug 2026 11:15:31 GMT'),
    parseBuildId('Wed, 26 Aug 2026 11:16:31 GMT')
  );
});

test('a missing header throws instead of yielding a fallback id', () => {
  // The whole point: a bad id must FAIL the workflow step, never produce a
  // value that would cache a skip over an unvalidated build.
  assert.throws(() => parseBuildId(null), /no last-modified header/);
  assert.throws(() => parseBuildId(''), /no last-modified header/);
});

test('an unparseable header throws rather than guessing', () => {
  for (const bad of [
    'not a date',
    '2026-08-26T11:15:31Z', // ISO 8601, not an HTTP date
    'Wed, 26 Foo 2026 11:15:31 GMT', // unknown month
    'Wed, 26 Aug 2026 11:15:31 +0200', // non-GMT offset
  ]) {
    assert.throws(() => parseBuildId(bad), Error, bad);
  }
});

// ── The entrypoint guard ────────────────────────────────────────────────────
//
// These two tests exist because of a bug this file could not have caught: the
// guard compared `import.meta.url` against a hand-built `file:///` + argv[1].
// On Linux/macOS argv[1] already starts with `/`, so that produced four
// slashes against three and the comparison was ALWAYS false. The scheduled job
// runs on ubuntu-latest, so the script printed nothing, exited 0, and the empty
// id became the constant cache key `core-smoke-` — the leg ran once and then
// skipped itself forever. A Windows developer running it locally saw a correct
// match (drive letter, no leading slash) and a green run.

test('isDirectInvocation agrees with pathToFileURL for both path shapes', () => {
  // Both sides go through pathToFileURL, so this holds on any host: it pins
  // that the guard DELEGATES to the platform converter rather than doing its
  // own string arithmetic. It cannot by itself prove the POSIX branch — the
  // next test does that.
  const posix = '/home/runner/work/firefox-scripts/tools/ci/nightly-buildid.mjs';
  const windows = 'C:\\code\\repo\\tools\\ci\\nightly-buildid.mjs';
  for (const p of [posix, windows]) {
    assert.equal(isDirectInvocation(p, pathToFileURL(p).href), true, p);
  }
});

test('the POSIX branch is proven on ANY host via the injected converter', () => {
  // THE test for the original bug. `posixToFileURL` reproduces what Node does
  // on Linux/macOS (`file://` + an absolute path, three slashes) regardless of
  // the machine running the suite — so the ubuntu-latest shape is exercised
  // from a Windows checkout, with no runner and no merge required.
  const posixToFileURL = p => ({href: `file://${p}`});
  const argv1 = '/home/runner/work/firefox-scripts/tools/ci/nightly-buildid.mjs';
  assert.equal(
    isDirectInvocation(argv1, `file://${argv1}`, posixToFileURL),
    true,
    'a POSIX entry path must match its own import.meta.url'
  );
  // And it must not match a different module, i.e. the injected converter is
  // genuinely driving the comparison rather than the test always passing.
  assert.equal(isDirectInvocation(argv1, 'file:///somewhere/else.mjs', posixToFileURL), false);
  // The four-slash form — what the shipped bug produced — must NOT match.
  assert.equal(isDirectInvocation(argv1, `file:///${argv1}`, posixToFileURL), false);
});

test('a naive file:/// concatenation is wrong for a POSIX path — the original bug', () => {
  // Pure string facts, identical on every platform, pinning WHY the guard has
  // to go through pathToFileURL: the entry path already starts with `/`, so
  // prepending `file:///` yields four slashes against `import.meta.url`'s three.
  const argv1 = '/home/runner/work/firefox-scripts/tools/ci/nightly-buildid.mjs';
  assert.equal(
    `file:///${argv1}`,
    'file:////home/runner/work/firefox-scripts/tools/ci/nightly-buildid.mjs'
  );
  assert.notEqual(`file:///${argv1}`, `file://${argv1}`);
});

test('isDirectInvocation is false when the module was imported, not run', () => {
  const posix = '/home/runner/work/firefox-scripts/tools/ci/nightly-buildid.mjs';
  // A different module's URL — this file was imported, it is not the entry point.
  assert.equal(isDirectInvocation(posix, 'file:///other/place.mjs'), false);
  // No argv[1] at all (embedded, or a bare `node -e`).
  assert.equal(isDirectInvocation(undefined, pathToFileURL(posix).href), false);
  assert.equal(isDirectInvocation('', pathToFileURL(posix).href), false);
});

test('isDirectInvocation survives a converter that throws', () => {
  const boom = () => {
    throw new TypeError('not a path');
  };
  const posix = '/home/runner/work/firefox-scripts/tools/ci/nightly-buildid.mjs';
  assert.equal(isDirectInvocation(posix, `file://${posix}`, boom), false);
});
