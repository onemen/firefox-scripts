// test/unit/tools/test-hygiene.test.mjs — convention gate: test files that
// create temp trees must clean them up.
//
// Why this exists: on 2026-09-30 the user's Temp folder held 2233 entries, 2130
// of them (95%) leaked by exactly three unit suites — `dispatch-ref-repo-*`
// (1216, releaseRef.test.mjs), `fxs-gate-pathutils-*` (534,
// scriptsUpdater-daily-gate.test.mjs), `build-epoch-repo-*`/`build-epoch-nogit-*`
// (380, buildEpoch.test.mjs). Node's test runner never removes mkdtemp roots,
// Windows never cleans Temp younger than 30 days, and a daily `pnpm test` (CI,
// pre-push hooks, agent review runs) re-leaked ~300 dirs per day. The leaking
// suites were fixed in the same change that added this gate; the gate keeps the
// class of bug from regrowing silently.
//
// Pinned rules (per test file under test/, excluding this one):
//   1. `mkdtempSync`/`mkdtemp` present ⇒ the file also removes (rmSync family)
//      — the repo idiom is a `tempRoots` registry + one top-level `after()`
//      sweep (check-skills.test.mjs); per-test `t.after` is fine for helpers
//      that receive `t`;
//   2. a mkdtemp path that ends in `.md` is a scratch *document*, not a test
//      fixture — agent sessions must not stage scratch files into tempdir() at
//      all (on this machine /tmp IS the user's Temp), so this fails loudly.
//
// Rule 3 is a MACHINE-STATE check (not a source scan): the OS temp dir must
// hold no `fxs-*` entry older than 24h. It is the backstop for the two classes
// the source scan cannot see — the E2E harness' ~50 MB profile roots when a run
// is killed (the exit sweep and prune in test/e2e/shared/helpers.mjs normally
// reclaim those; a hard kill escapes both), and ad-hoc agent scratch
// (`fxs-manual-*`, `fxs-probe-*`, `s9keep*.log`, …) that no rule can attribute
// to a file. On 2026-10-02 the user's Temp still held 11 stranded E2E profiles
// (412 MB), a 365 MB `fxs-portable` browser and ~762 MB of probe scratch.
//
// Escape hatch for a deliberately long-lived `fxs-*` directory:
// FXS_TEMP_KEEP=<comma-separated names or prefixes>.
//
// Not pinned: production `tools/` and `test/e2e/shared/` creators that
// deliberately stage under the repo's gitignored `dist/` — outside the user's
// Temp, swept by the existing clean-checkout hygiene.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const TEST_ROOT = path.join(REPO_ROOT, 'test');
const SELF = fileURLToPath(import.meta.url);

/** Every .mjs file under `dir`, recursively, as absolute paths. */
function listTestFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTestFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.mjs')) out.push(full);
  }
  return out;
}

test('test files that mkdtemp must clean up (no leaked temp roots)', () => {
  const offenders = [];
  for (const file of listTestFiles(TEST_ROOT)) {
    if (path.resolve(file) === path.resolve(SELF)) continue;
    const source = fs.readFileSync(file, 'utf-8').replace(/\r\n/g, '\n');
    const creates = /\bmkdtemp(?:Sync)?\(/.test(source);
    const removes = /\b(?:rm|rmdir)Sync\(/.test(source);
    if (creates && !removes) offenders.push(path.relative(REPO_ROOT, file));
    // Scratch-document rule: a mkdtemp whose path argument ends in .md is an
    // agent staging a scratch file into the user's Temp. Scan the call's
    // argument with a linear paren counter (a nested-quantifier regex here
    // trips security/detect-unsafe-regex) and flag any string literal ending
    // in .md — quoted or nested, e.g. mkdtempSync(path.join(os.tmpdir(),
    // 'scratch.md')).
    if (/\bmkdtemp(?:Sync)?\(/.test(source)) {
      for (const match of source.matchAll(/\bmkdtemp(?:Sync)?\(/g)) {
        let depth = 1;
        let i = match.index + match[0].length;
        while (i < source.length && depth > 0) {
          depth +=
            source[i] === '(' ? 1
            : source[i] === ')' ? -1
            : 0;
          i += 1;
        }
        const args = source.slice(match.index + match[0].length, i - 1);
        if (/["'`]([^"'`]*\.md)["'`]/.test(args)) {
          offenders.push(`${path.relative(REPO_ROOT, file)} (stages a .md scratch file)`);
        }
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'temp-leak convention violated — every suite that mkdtemps under the OS ' +
      'tempdir must remove what it creates (tempRoots + top-level after() ' +
      'sweep, or per-test t.after). See test-hygiene.test.mjs header: 2130 ' +
      'leaked dirs in the user Temp on 2026-09-30.'
  );
});

/** Names in FXS_TEMP_KEEP that cover `name` (exact or prefix match). */
function isKept(name, patterns) {
  return patterns.some(p => name === p || name.startsWith(p));
}

test('the OS temp dir holds no firefox-scripts leftovers', () => {
  const minAgeMs = 24 * 60 * 60 * 1000;
  const keep = (process.env.FXS_TEMP_KEEP || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const offenders = [];
  for (const entry of fs.readdirSync(os.tmpdir(), {withFileTypes: true})) {
    if (!entry.name.startsWith('fxs-')) continue;
    if (isKept(entry.name, keep)) continue;
    let stat;
    try {
      stat = fs.statSync(path.join(os.tmpdir(), entry.name));
    } catch {
      continue;
    }
    // Anything younger than the threshold belongs to a run in flight — the E2E
    // sweep owns that window, and this gate must never race a live run.
    if (Date.now() - stat.mtimeMs < minAgeMs) continue;
    const hours = Math.round((Date.now() - stat.mtimeMs) / 3_600_000);
    offenders.push(`${entry.name} (${hours}h old)`);
  }
  assert.deepEqual(
    offenders,
    [],
    'firefox-scripts leftovers in the OS temp dir — the E2E exit sweep ' +
      '(test/e2e/shared/helpers.mjs) reclaims stranded profile roots at run ' +
      'time, and agent scratch belongs in the repo gitignored dist/scratch/, ' +
      'never in the OS temp dir. Remove the entries above, or mark a ' +
      'deliberately long-lived one with FXS_TEMP_KEEP=<name>.'
  );
});
