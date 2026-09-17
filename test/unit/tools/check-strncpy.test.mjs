// test/unit/tools/check-strncpy.test.mjs — pins the strncpy lint gate: call
// detection (file/line/text), comment prose staying out of scope, and the
// repo-level invariant the gate exists for — installer/src carries zero
// `strncpy(` call sites since the 2026-09 sweep.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {findStrncpyCalls} from '../../../tools/check-strncpy.mjs';

function makeDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-strncpy-'));
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), {recursive: true});
    fs.writeFileSync(full, content);
  }
  return dir;
}

test('finds a strncpy call with file, line, and trimmed text', () => {
  const dir = makeDir({
    'sample.c': [
      'void f(void) {',
      '    strncpy(dst, src, n - 1);',
      '    dst[n - 1] = 0;',
      '}',
    ].join('\n'),
  });
  try {
    const findings = findStrncpyCalls([path.join(dir, 'sample.c')], dir);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].file, 'sample.c');
    assert.equal(findings[0].line, 2);
    assert.match(findings[0].text, /^strncpy\(dst, src, n - 1\);$/);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('matches spaced call syntax and calls wrapped across lines', () => {
  const dir = makeDir({
    'spaced.c': 'strncpy (a, b, c);\n',
    'wrapped.c': 'strncpy(\n    a, b, c);\n',
    'split-paren.c': 'strncpy\n(a, b, c);\n',
  });
  try {
    const findings = findStrncpyCalls(
      [path.join(dir, 'spaced.c'), path.join(dir, 'wrapped.c'), path.join(dir, 'split-paren.c')],
      dir
    );
    assert.deepEqual(
      findings.map(f => [f.file, f.line]),
      [
        ['spaced.c', 1],
        ['wrapped.c', 1],
        ['split-paren.c', 1],
      ]
    );
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('scans nested directories (helper/), skips vendor/, reports paths relative to root', () => {
  const dir = makeDir({
    'top.c': 'strncpy(a, b, c);\n',
    'nested/helper.c': 'strncpy(x, y, z);\n',
    'vendor/vendored.c': 'strncpy(v, w, u);\n',
  });
  try {
    // Recursive listing with the same vendor/ exclusion the CLI's listCSources
    // applies — the pure function itself takes an explicit file list.
    const list = [];
    (function walk(d) {
      for (const e of fs
        .readdirSync(d, {withFileTypes: true})
        .sort((a, b) => a.name.localeCompare(b.name))) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) {
          if (e.name !== 'vendor') walk(full);
        } else if (e.isFile() && /\.c$/.test(e.name)) {
          list.push(full);
        }
      }
    })(dir);
    const files = findStrncpyCalls(list, dir).map(f => f.file);
    assert.ok(files.includes('top.c'), 'top-level scanned');
    assert.ok(files.includes('nested/helper.c'), 'nested dirs scanned');
    assert.ok(!files.some(f => f.includes('vendor')), 'vendor/ excluded');
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('ignores prose that merely mentions strncpy (no call syntax)', () => {
  const dir = makeDir({
    'comments.c': [
      '/* strlen-bounded copy: strncpy would read the whole buffer',
      ' * (gcc -fanalyzer out-of-bounds read). */',
      '// replaced by snprintf in the 2026-09 sweep',
      'snprintf(dst, sizeof(dst), "%s", src);',
    ].join('\n'),
  });
  try {
    assert.deepEqual(findStrncpyCalls([path.join(dir, 'comments.c')], dir), []);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('ignores non-C files', () => {
  const dir = makeDir({'notes.txt': 'strncpy(a, b, c);', 'code.h': 'strncpy(a, b, c);'});
  try {
    assert.deepEqual(
      findStrncpyCalls([path.join(dir, 'notes.txt'), path.join(dir, 'code.h')], dir),
      []
    );
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('repo invariant: installer/src has zero strncpy call sites', () => {
  assert.deepEqual(findStrncpyCalls(), []);
});
