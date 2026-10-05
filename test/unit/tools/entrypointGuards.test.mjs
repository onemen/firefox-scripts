// test/unit/tools/entrypointGuards.test.mjs — repo invariant: no script may
// build a file URL for its own entry path by hand.
//
// WHY this exists. tools/ci/nightly-buildid.mjs guarded its entry point by
// comparing `import.meta.url` against a hand-built URL: the literal `file:`,
// then three slashes, then the interpolated `process.argv[1]` with backslashes
// normalised to forward ones.
//
// A runner's `process.argv[1]` is already absolute, and on Linux/macOS it
// starts with `/`. Prepending three slashes therefore yields FOUR against
// `import.meta.url`'s three, so the comparison was ALWAYS false on the
// ubuntu-latest job that runs the schedule. The script printed nothing, exited
// 0, and left the build ID empty — which turned the workflow's cache key into
// the constant `core-smoke-`, so after the first green run every night was a
// cache hit and the smoke matrix skipped itself. The scheduled leg was dead
// and reported green.
//
// Windows hid it completely: there `argv[1]` begins with a drive letter, so the
// same expression happens to be correct. A local run on the maintainer's
// machine proved nothing.
//
// The correct forms, none of which this test may flag:
//   - `new URL(`file://${argv[1]}`)`  — TWO slashes; the path supplies the third
//   - `pathToFileURL(argv[1]).href`
//   - `path.resolve(argv[1]) === fileURLToPath(import.meta.url)` (path compare)
//   - `path.basename(argv[1]) === 'x.mjs'`
//
// The pattern below is written with escaped slashes, and the strings under
// test are ASSEMBLED AT RUNTIME, so this file never contains the sequence it
// forbids — otherwise it would be its own first finding, and the invariant
// would be unsatisfiable.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** The broken prefix, assembled so it is not written literally in this file. */
const THREE_SLASHES = 'file:' + '/'.repeat(3);
/** The correct prefix. */
const TWO_SLASHES = 'file:' + '/'.repeat(2);

/**
 * A hand-built file URL for an ENTRY PATH: three slashes followed by an
 * interpolated or concatenated path.
 *
 * The optional closing quote matters: in the concatenation spelling the string
 * is closed before the `+`, so the character right after the slashes is a
 * quote, not `+`. A stricter pattern quietly misses that half of the bug.
 *
 * `\s*` deliberately spans newlines. The pattern is matched against the WHOLE
 * source, not line by line, so an operator-LEADING continuation (`'file:///'`
 * then newline then `+ argv[1]`) is caught too — a per-line matcher cannot see
 * across the break, which is how three real spellings slipped through the first
 * version of this invariant.
 *
 * The slashes must be followed by an ENTRY-PATH expression. A bare `$` would
 * flag any interpolation after a file:/// prefix — including unrelated sandbox
 * stubs (an nsIFileIO.newFileURI fake building a spec from `file.path`, the
 * #416 sweep test), which never guard an entry point. So the arms require
 * either the argv spine (directly, or with a method tail like the original
 * bug's backslash-normalising `.replace()`), or a BARE identifier — a plausible
 * `const p = process.argv[1]` alias. A member expression (`x.path`) is a
 * fixture/URI-builder operand, not an entry path, and is left alone.
 */
const BROKEN =
  /file:\/\/\/['"`]?\s*(?:\$\{[^}]*process\.argv\[1\][^}]*\}|\$\{\s*[a-zA-Z_$][\w$]*\s*\}|\+\s*(?:process\.)?argv\[1\]|\+\s*[a-zA-Z_$][\w$]*(?![\w$.]))/g;

/** Tracked directories whose JS can carry a direct-invocation guard. */
const SCANNED_PREFIXES = ['tools/', 'test/', 'installer/', 'config/'];

/** Tracked, but not ours to edit (ADR 0022: vendored skill text stays pristine). */
const EXCLUDED = ['.agents/skills/'];

/** Extensions that can hold an entry-point guard. */
const EXTENSIONS = ['.mjs', '.js', '.cjs'];

/**
 * Hand-built entry-path URLs in one file's text.
 *
 * Pure, so the cases below need no fixtures on disk.
 *
 * Matches across line breaks and derives each finding's line number from the
 * match offset, so a prefix continued on the NEXT line is still reported
 * against the line the slashes are actually on.
 *
 * @param {string} text
 * @returns {{line: number; text: string}[]}
 */
export function findInText(text) {
  const findings = [];
  // matchAll, not exec on a module-level /g/: matchAll clones the regex
  // internally, so the shared lastIndex is never advanced across calls (a stale
  // lastIndex would make the second call start mid-string and silently skip the
  // start of the file). Building a fresh RegExp per call would also work but
  // trips security/detect-non-literal-regexp.
  for (const m of text.matchAll(BROKEN)) {
    const line = text.slice(0, m.index).split(/\r?\n/).length;
    const start = text.lastIndexOf('\n', m.index) + 1;
    const end = text.indexOf('\n', m.index);
    findings.push({line, text: text.slice(start, end === -1 ? text.length : end).trim()});
  }
  return findings;
}

/**
 * Every scanned file in the repo, via git so untracked build products (dist/)
 * and local drafts are never picked up.
 *
 * @returns {string[]} repo-relative paths
 */
export function candidateFiles() {
  const out = execFileSync('git', ['ls-files'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 8 << 20,
  });
  return out
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .filter(
      f =>
        EXTENSIONS.includes(path.extname(f)) &&
        SCANNED_PREFIXES.some(p => f.startsWith(p)) &&
        !EXCLUDED.some(p => f.startsWith(p))
    );
}

/**
 * Hand-built entry-path URLs across a set of files.
 *
 * @param {string[]} files repo-relative paths
 * @returns {{file: string; line: number; text: string}[]}
 */
export function findHandBuiltEntrypointUrls(files) {
  const findings = [];
  for (const file of files) {
    const abs = path.join(REPO_ROOT, file);
    if (!fs.existsSync(abs)) continue;
    for (const hit of findInText(fs.readFileSync(abs, 'utf8'))) {
      findings.push({file, ...hit});
    }
  }
  return findings;
}

// ── the detector ────────────────────────────────────────────────────────────

test('the three-slash template spelling is flagged, with its line number', () => {
  const src = [
    '// guard',
    '// Only run when invoked directly.',
    'if (p && import.meta.url === `' + THREE_SLASHES + '${p}`) {',
    '  run();',
    '}',
  ].join('\n');
  const findings = findInText(src);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 3);
  assert.match(findings[0].text, /import\.meta\.url/);
});

test('the concatenation spelling of the same bug is flagged too', () => {
  const findings = findInText("const u = '" + THREE_SLASHES + "' + process.argv[1];");
  assert.equal(findings.length, 1);
  assert.match(findings[0].text, /process\.argv/);
});

// The next three are the shapes a per-line matcher cannot see. The reviewer of
// PR #421 found them: the operator leads the next line, so the slashes and the
// `+` land on different lines and the bug passes the invariant.

test('a concatenation whose operator LEADS the next line is flagged', () => {
  const src = "const u = '" + THREE_SLASHES + "'\n  + process.argv[1];";
  const findings = findInText(src);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 1, 'reported against the line the slashes are on');
  assert.equal(findings[0].text, "const u = '" + THREE_SLASHES + "'");
});

test('an indented operator-leading concatenation is flagged', () => {
  const src = 'if (x) {\n  const u = "' + THREE_SLASHES + '"\n    + process.argv[1];\n}';
  const findings = findInText(src);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 2);
});

test('a template literal continued on the next line is flagged', () => {
  const src = 'const u = `' + THREE_SLASHES + '"\n  + p`;';
  const findings = findInText(src);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 1);
});

test('several occurrences are each reported, on their own lines', () => {
  const src = [
    "const a = '" + THREE_SLASHES + "' + p;",
    '// unrelated',
    'const b = `' + THREE_SLASHES + '${p}`;',
  ].join('\n');
  const findings = findInText(src);
  assert.deepEqual(
    findings.map(f => f.line),
    [1, 3]
  );
});

test('the two-slash template is NOT flagged — it is correct', () => {
  // The trap: it reads almost identically to the bug and is right, because the
  // entry path already supplies the third slash.
  const src =
    'if (process.argv[1] && import.meta.url === new URL(`' +
    TWO_SLASHES +
    '${process.argv[1]}`).href) {';
  assert.deepEqual(findInText(src), []);
});

test('every other correct spelling is left alone', () => {
  const correct = [
    'if (import.meta.url === pathToFileURL(process.argv[1]).href) {}',
    'const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);',
    "const isMain = process.argv[1] && path.basename(process.argv[1]) === 'x.mjs';",
    "const isMain = process.argv[1] && process.argv[1].endsWith('x.mjs');",
  ];
  for (const line of correct) assert.deepEqual(findInText(line), [], line);
});

test('a plain literal POSIX file URL is not a finding', () => {
  // Fixtures and docs legitimately spell out POSIX URLs; only interpolation or
  // concatenation right after the slashes is the bug.
  assert.deepEqual(findInText("const u = '" + THREE_SLASHES + "home/runner/work/x.mjs';"), []);
});

test('a sandbox stub interpolating a non-entry path is not a finding', () => {
  // #416's sweep test stubs nsIFileIO.newFileURI with a file:/// template over
  // a FIXTURE path. That is a URI builder for a test double, not an entry-path
  // guard — the invariant is about `import.meta.url` vs `process.argv[1]`.
  const src = 'newFileURI: file => ({spec: `' + THREE_SLASHES + '${file.path}`}),';
  assert.deepEqual(findInText(src), []);
});

test('a non-argv concatenation after the slashes is not a finding', () => {
  const src = "const u = '" + THREE_SLASHES + "' + file.path;";
  assert.deepEqual(findInText(src), []);
});

test('the detector does not flag its own source', () => {
  assert.deepEqual(
    findInText(fs.readFileSync(new URL(import.meta.url), 'utf8')),
    [],
    'the pattern must stay escaped and the cases assembled at runtime, or this ' +
      'file is its own first finding and the invariant is unsatisfiable'
  );
});

// ── the repo invariant ───────────────────────────────────────────────────────

test('repo invariant: no script hand-builds a file URL for its entry path', () => {
  const findings = findHandBuiltEntrypointUrls(candidateFiles());
  assert.deepEqual(
    findings,
    [],
    'use pathToFileURL(process.argv[1]).href, or compare paths — a hand-built ' +
      'file URL is wrong on POSIX and silently skips the step that runs it.\n' +
      findings.map(f => `  ${f.file}:${f.line}  ${f.text}`).join('\n')
  );
});

test('the invariant actually scans the shipped tools, not an empty set', () => {
  // A typo in SCANNED_PREFIXES would make the invariant vacuously true.
  const files = candidateFiles();
  assert.ok(files.length > 50, `only ${files.length} files scanned`);
  assert.ok(
    files.some(f => f.startsWith('tools/ci/')),
    'tools/ci must be in scope — that is where the bug lived'
  );
  assert.ok(
    files.some(f => f.startsWith('tools/publish/')),
    'tools/publish must be in scope'
  );
});
