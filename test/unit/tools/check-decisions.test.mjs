// test/unit/tools/check-decisions.test.mjs — Unit tests for the ADR-log
// checker (tools/check-decisions.mjs). The real docs/decisions tree is
// validated by `pnpm check:decisions` itself; these tests pin the parser and
// the ADR 0029 amendment rules with fixture directories.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const scriptUrl = pathToFileURL(path.join(REPO_ROOT, 'tools', 'check-decisions.mjs')).href;
const {checkDecisionsDir, parseStatusBlock} = await import(scriptUrl);

function makeDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decisions-'));
  for (const [name, content] of Object.entries(files)) {
    const p = path.join(dir, name);
    fs.mkdirSync(path.dirname(p), {recursive: true});
    fs.writeFileSync(p, content);
  }
  return dir;
}

// A minimal valid record whose status block carries the given extra fields.
function record(number, slug, {fields = '', title = null} = {}) {
  const titleLine = title ?? `# ${number}: Record ${number}`;
  return `${titleLine}\n\n- **Status:** accepted\n- **Date:** 2026-09-16${fields}\n\n## Context\n\nBody.\n`;
}

function index(records) {
  return `# Decision records\n\n${records.map(f => `- [${f}](./${f})`).join('\n')}\n`;
}

const errorsFor = result => result.errors;

test('parseStatusBlock: fields, blank-line end, wrapped continuation lines', () => {
  const fields = parseStatusBlock(
    [
      '# 0029: Title',
      '',
      '- **Status:** accepted',
      '- **Date:** 2026-09-16',
      '- **Amends:** [0019](./0019-release-versioning.md) (what changed),',
      '  [0020](./0020-local-agent-ai-review.md) (also this)',
      '',
      '## Context',
      '',
      'Prose.',
    ]
      .join('\n')
      .split('\n')
  );
  assert.deepEqual(fields.get('Status'), ['accepted']);
  assert.deepEqual(fields.get('Date'), ['2026-09-16']);
  assert.deepEqual(fields.get('Amends'), [
    '[0019](./0019-release-versioning.md) (what changed), [0020](./0020-local-agent-ai-review.md) (also this)',
  ]);
  assert.equal(fields.size, 3);
});

test('parseStatusBlock: repeated keys accumulate values', () => {
  const fields = parseStatusBlock(
    ['# 0001: Title', '', '- **Status:** accepted', '- **Amends:** one', '- **Amends:** two']
      .join('\n')
      .split('\n')
  );
  assert.deepEqual(fields.get('Amends'), ['one', 'two']);
});

test('parseStatusBlock: no status block → empty map', () => {
  assert.equal(
    parseStatusBlock(['# 0002: Title', '', '## Context'].join('\n').split('\n')).size,
    0
  );
});

test('clean log: no errors', () => {
  const dir = makeDir({
    'index.md': index(['0001-a.md', '0002-b.md']),
    '0001-a.md': record('0001', 'a'),
    '0002-b.md': record('0002', 'b'),
  });
  try {
    assert.deepEqual(errorsFor(checkDecisionsDir(dir)), []);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('duplicate number and title/filename mismatch are caught', () => {
  const dir = makeDir({
    'index.md': index(['0001-a.md', '0001-b.md']),
    '0001-a.md': record('0001', 'a'),
    '0001-b.md': record('0001', 'b'),
  });
  try {
    const errors = errorsFor(checkDecisionsDir(dir));
    assert.ok(
      errors.some(e => e.includes('duplicate ADR number 0001')),
      errors.join('\n')
    );
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }

  const dir2 = makeDir({
    'index.md': index(['0001-a.md']),
    '0001-a.md': record('0002', 'a'),
  });
  try {
    assert.ok(
      errorsFor(checkDecisionsDir(dir2)).some(e => e.includes('does not match filename number'))
    );
  } finally {
    fs.rmSync(dir2, {recursive: true, force: true});
  }
});

test('ADR 0029: reciprocal Amends/Amended pair is accepted', () => {
  const dir = makeDir({
    'index.md': index(['0001-base.md', '0002-amendment.md']),
    '0001-base.md': record('0001', 'base', {
      fields: '\n- **Amended:** [0002](./0002-amendment.md) — adds a fallback',
    }),
    '0002-amendment.md': record('0002', 'amendment', {
      fields: '\n- **Amends:** [0001](./0001-base.md) (adds a fallback)',
    }),
  });
  try {
    assert.deepEqual(errorsFor(checkDecisionsDir(dir)), []);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('ADR 0029: one-sided Amends fails; the missing reciprocal is named', () => {
  const dir = makeDir({
    'index.md': index(['0001-base.md', '0002-amendment.md']),
    '0001-base.md': record('0001', 'base'),
    '0002-amendment.md': record('0002', 'amendment', {
      fields: '\n- **Amends:** [0001](./0001-base.md) (adds a fallback)',
    }),
  });
  try {
    const errors = errorsFor(checkDecisionsDir(dir));
    assert.ok(
      errors.some(
        e =>
          e.includes('0002-amendment.md') &&
          e.includes('not reciprocated') &&
          e.includes('Amended:')
      ),
      errors.join('\n')
    );
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('ADR 0029: one-sided Amended fails symmetrically', () => {
  const dir = makeDir({
    'index.md': index(['0001-base.md', '0002-amendment.md']),
    '0001-base.md': record('0001', 'base', {
      fields: '\n- **Amended:** [0002](./0002-amendment.md) — adds a fallback',
    }),
    '0002-amendment.md': record('0002', 'amendment'),
  });
  try {
    const errors = errorsFor(checkDecisionsDir(dir));
    assert.ok(
      errors.some(
        e => e.includes('0001-base.md') && e.includes('not reciprocated') && e.includes('"Amends:"')
      ),
      errors.join('\n')
    );
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('ADR 0029: missing target, non-record target, number mismatch, self-link', () => {
  const dir = makeDir({
    'index.md': index(['0001-a.md']),
    '0001-a.md': record('0001', 'a', {
      fields:
        '\n- **Amends:** [0099](./0099-ghost.md) (missing)\n- **Amends:** [0002](./index.md) (not a record)\n- **Amends:** [0003](./0001-a.md) (number mismatch)\n- **Amends:** [0001](./0001-a.md) (self)',
    }),
  });
  try {
    const errors = errorsFor(checkDecisionsDir(dir));
    assert.ok(
      errors.some(e => e.includes('target missing: ./0099-ghost.md')),
      errors.join('\n')
    );
    assert.ok(
      errors.some(e => e.includes('is not a decision record')),
      errors.join('\n')
    );
    assert.ok(
      errors.some(e => e.includes('does not match the target filename')),
      errors.join('\n')
    );
    assert.ok(
      errors.some(e => e.includes('links to itself')),
      errors.join('\n')
    );
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('ADR 0029: date-only Amended line carries no link and is accepted', () => {
  const dir = makeDir({
    'index.md': index(['0001-a.md']),
    '0001-a.md': record('0001', 'a', {
      fields: '\n- **Amended:** 2026-09-15 — clarified the fallback wording',
    }),
  });
  try {
    assert.deepEqual(errorsFor(checkDecisionsDir(dir)), []);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('ADR 0029: link-free Amends and non-date Amended prose fail (declared but empty)', () => {
  const dir = makeDir({
    'index.md': index(['0001-a.md']),
    '0001-a.md': record('0001', 'a', {
      fields:
        '\n- **Amends:** typo, no link here\n- **Amends:** [1](./0001-a.md) (not a 4-digit link)\n- **Amended:** some free-form prose without a date',
    }),
  });
  try {
    const errors = errorsFor(checkDecisionsDir(dir));
    assert.equal(
      errors.filter(e => e.includes('declares no amendment target')).length,
      3,
      errors.join('\n')
    );
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('ADR 0029: a non-record NNNN-looking file cannot satisfy reciprocity', () => {
  const dir = makeDir({
    'index.md': index(['0001-base.md', '0002-amendment.md']),
    '0001-base.md': record('0001', 'base'),
    '0002-amendment.md': record('0002', 'amendment', {
      fields: '\n- **Amends:** [0001](./0001-note.txt) (points at a non-record file)',
    }),
    // A file whose basename looks like NNNN-slug but is not a .md record.
    '0001-note.txt': 'not a record\n',
  });
  try {
    const errors = errorsFor(checkDecisionsDir(dir));
    assert.ok(
      errors.some(e => e.includes('0002-amendment.md') && e.includes('is not a decision record')),
      errors.join('\n')
    );
    // And it must never be treated as a reciprocal target.
    assert.ok(!errors.some(e => e.includes('not reciprocated')), errors.join('\n'));
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('superseded-by still validated alongside amendments', () => {
  const dir = makeDir({
    'index.md': index(['0001-old.md']),
    '0001-old.md': record('0001', 'old').replace(
      '- **Status:** accepted',
      '- **Status:** superseded by [0040](./0040-x.md)'
    ),
  });
  try {
    const errors = errorsFor(checkDecisionsDir(dir));
    assert.ok(
      errors.some(e => e.includes('superseded-by target missing')),
      errors.join('\n')
    );
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('index.md must mention every record; broken relative links fail', () => {
  const dir = makeDir({
    'index.md': index(['0001-a.md']),
    '0001-a.md': record('0001', 'a', {fields: '\n- **See:** [ghost](./0002-nope.md)'}),
    '0002-b.md': record('0002', 'b'),
  });
  try {
    const errors = errorsFor(checkDecisionsDir(dir));
    assert.ok(
      errors.some(e => e.includes('0002-b.md: not listed in index.md')),
      errors.join('\n')
    );
    assert.ok(
      errors.some(e => e.includes('broken link: ./0002-nope.md')),
      errors.join('\n')
    );
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
