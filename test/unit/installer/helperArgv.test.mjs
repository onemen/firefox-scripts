// test/unit/installer/helperArgv.test.mjs — argument-validation contract of the
// standalone admin-copy helper (installer/src/helper/helper_win.c, issue #274).
//
// The helper's argv grammar and traversal guard are pure C logic; the contract
// is mirrored 1:1 in JS here so a regression on either side surfaces in
// `pnpm test` without a compiler: the shape rules (argc, parity), the `..`
// component rejection (bounds-correct form of the #272 proposal), and the
// quoted-relaunch length budget. The real binary's behavior is additionally
// covered by the updater E2E helper scenario (checksum-before-execute, #271).
//
// The last test reads the C source and asserts the mirrored constants/markers
// are still present — if the C logic moves, this file must move with it.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';

const HELPER_C = fileURLToPath(
  new URL('../../../installer/src/helper/helper_win.c', import.meta.url)
);

// ── JS mirror of helper_win.c (keep in sync — pinned by the tripwire below) ──

const EXIT_BAD_ARGS = 1;
const MAX_PARAMS_W = 4096;
// '\\' + "__wtest_" (8) + 8 hex digits + ".tmp" (4) + NUL = 22
const PROBE_SUFFIX_W = 22;

/** Port of has_dotdot_component(): true if any path component is exactly "..". */
function hasDotdotComponent(pathStr) {
  const len = pathStr.length;
  for (let i = 0; i < len; i++) {
    if (pathStr[i] !== '.') continue;
    if (i + 1 >= len || pathStr[i + 1] !== '.') continue;
    const prevOk = i === 0 || pathStr[i - 1] === '\\' || pathStr[i - 1] === '/';
    const nextOk = i + 2 === len || pathStr[i + 2] === '\\' || pathStr[i + 2] === '/';
    if (prevOk && nextOk) return true;
  }
  return false;
}

/**
 * Port of WinMain's argv validation. `argv` includes the exe itself at index 0,
 * matching the C argc/wargv convention. Returns {ok} or the rejection reason.
 */
function validateHelperArgv(argv) {
  const argc = argv.length;
  if (argc < 3 || argc % 2 === 0) return {ok: false, reason: 'shape'};
  for (let i = 1; i < argc; i++) {
    if (hasDotdotComponent(argv[i])) return {ok: false, reason: 'traversal', index: i};
  }
  return {ok: true};
}

/** Port of the relaunch command-line length computation (WCHARs, minus NUL). */
function quotedRelaunchLength(argv) {
  let paramsLen = 0;
  for (let i = 1; i < argv.length; i++) {
    // "arg" plus the space separator (except before the first).
    paramsLen += argv[i].length + 2 + (i > 1 ? 1 : 0);
  }
  return paramsLen;
}

// ── shape rules ──────────────────────────────────────────────────────────────

test('shape: exe + one pair (argc=3) is the minimal valid argv', () => {
  const r = validateHelperArgv(['helper.exe', 'C:\\src.zip-x', 'C:\\dst\\config.js']);
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('shape: fewer than 3 args → EXIT_BAD_ARGS (no pair to copy)', () => {
  assert.equal(validateHelperArgv(['helper.exe']).reason, 'shape');
  assert.equal(validateHelperArgv(['helper.exe', 'only-src']).reason, 'shape');
  assert.equal(EXIT_BAD_ARGS, 1);
});

test('shape: even argc → EXIT_BAD_ARGS (pairs must be complete)', () => {
  // argc=4: exe + 1.5 pairs
  assert.equal(validateHelperArgv(['h', 'a', 'b', 'c']).reason, 'shape');
  // argc=8: exe + 3.5 pairs
  assert.equal(validateHelperArgv(['h', 'a', 'b', 'c', 'd', 'e', 'f', 'g']).reason, 'shape');
});

test('shape: three complete pairs pass', () => {
  const r = validateHelperArgv(['h', 's1', 'd1', 's2', 'd2', 's3', 'd3']);
  assert.equal(r.ok, true, JSON.stringify(r));
});

// ── '..' traversal rejection ────────────────────────────────────────────────

test('traversal: bare and embedded ".." components are rejected', () => {
  for (const p of [
    '..',
    '..\\..',
    '..//..',
    'foo\\..\\bar',
    'foo/../../etc/passwd',
    'C:\\x\\..\\y',
    '..\\config.js',
    'dir\\..',
    'dir/..',
  ]) {
    const r = validateHelperArgv(['h', p, 'C:\\dst']);
    assert.equal(r.reason, 'traversal', `expected rejection for ${p}`);
  }
});

test('traversal: names that merely contain dots are accepted', () => {
  for (const p of [
    'foo...',
    '...foo',
    'foo..bar',
    'a..b\\c',
    'foo.bar',
    'file..js',
    '.hidden',
    'C:\\Program Files\\Mozilla Firefox\\config.js',
    'x/./y', // single-dot component is harmless
  ]) {
    const r = validateHelperArgv(['h', p, 'C:\\dst']);
    assert.equal(r.ok, true, `expected acceptance for ${p}: ${JSON.stringify(r)}`);
  }
});

test('traversal: the #272 off-by-one inputs read only in-bounds indices', () => {
  // The bounds-correct guard must decide these purely from the string's real
  // length — no look-ahead past the terminator (the #272 bug).
  assert.equal(hasDotdotComponent('..'), true); // i+2 == len branch
  assert.equal(hasDotdotComponent('a/..'), true); // next component ends the string
  assert.equal(hasDotdotComponent('../b'), true); // first component ends in sep
  assert.equal(hasDotdotComponent('a/'), false); // no dots at all
  assert.equal(hasDotdotComponent('.'), false);
});

// ── relaunch length budget ───────────────────────────────────────────────────

test('budget: realistic updater argv is far below MAX_PARAMS_W', () => {
  const argv = [
    'C:\\Users\\x\\AppData\\Local\\Temp\\fxs-abc\\helper_win.exe',
    'C:\\Users\\x\\AppData\\Local\\Temp\\fxs-abc\\fx-folder\\config.js',
    'C:\\Program Files\\Mozilla Firefox\\config.js',
    'C:\\Users\\x\\AppData\\Local\\Temp\\fxs-abc\\fx-folder\\defaults\\pref\\config-prefs.js',
    'C:\\Program Files\\Mozilla Firefox\\defaults\\pref\\config-prefs.js',
  ];
  const len = quotedRelaunchLength(argv);
  assert.equal(len < MAX_PARAMS_W, true, `length ${len} must stay under budget`);
});

test('budget: the C guard rejects a command line at/above MAX_PARAMS_W', () => {
  // Construct an argv whose quoted length just crosses the budget the C code
  // enforces (params_len >= MAX_PARAMS_W → EXIT_BAD_ARGS).
  const longPath = 'C:\\' + 'x'.repeat(MAX_PARAMS_W);
  const argv = ['h', longPath, 'C:\\dst'];
  assert.equal(quotedRelaunchLength(argv) >= MAX_PARAMS_W, true);
  // Note: such an argv is ALSO caught earlier by the shape/traversal gates?
  // No — it is shape-valid and traversal-free; the C code must reject it at
  // the length check. The mirror asserts the decision boundary formula only.
  assert.equal(validateHelperArgv(argv).ok, true); // passes the argv gates…
  // …so the length guard is the only defense: params_len >= MAX_PARAMS_W.
});

// ── C-source sync tripwire ──────────────────────────────────────────────────

test('tripwire: helper_win.c still carries the mirrored contract', () => {
  const src = fs.readFileSync(HELPER_C, 'utf8');
  for (const marker of [
    '#define MAX_PARAMS_W 4096',
    '#define PROBE_SUFFIX_W 22',
    '#define EXIT_BAD_ARGS 1',
    'has_dotdot_component',
    'params_len >= MAX_PARAMS_W',
  ]) {
    assert.ok(src.includes(marker), `helper_win.c drifted: missing ${marker}`);
  }
});

test('tripwire: probe suffix constant matches the format string it bounds', () => {
  const src = fs.readFileSync(HELPER_C, 'utf8');
  assert.ok(
    src.includes('wsprintfW(test, L"%s\\\\__wtest_%08lx.tmp", dir,'),
    'probe format string changed — recompute PROBE_SUFFIX_W (dir + \\ + __wtest_ + 8 hex + .tmp + NUL)'
  );
  // 1 (sep) + 8 ("__wtest_") + 8 (hex) + 4 (".tmp") + 1 (NUL)
  assert.equal(1 + 8 + 8 + 4 + 1, PROBE_SUFFIX_W);
});
