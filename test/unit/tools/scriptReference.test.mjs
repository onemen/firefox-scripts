// docs/script-reference.md is generated from package.json, and this is the test
// that says so: the page must equal what the generator produces right now, and
// the generator must refuse a script it cannot place. Between them, a script
// added, renamed or given a new body fails here rather than leaving a reference
// page that documents a command nobody can run any more.
//
// The staleness check runs in CI as `pnpm check:script-reference`, so the last
// test drives the CLI itself on a fixture whose package.json does not match its
// page: a comparison that cannot fail is not a gate.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {cpSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';

import {groupScripts, renderReference} from '../../../tools/script-reference.mjs';
import {SCRIPT_SECTIONS, sectionOf} from '../../../tools/scriptSections.mjs';

const REPO_ROOT = path.join(import.meta.dirname, '..', '..', '..');
const PAGE = path.join(REPO_ROOT, 'docs', 'script-reference.md');
const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
const FENCED_SCRIPT = /^pnpm ([a-z0-9:-]+) {2,}# (.*)$/gm;

/** The script names and bodies the committed page lists, in page order. */
function documentedScripts() {
  return [...readFileSync(PAGE, 'utf8').matchAll(FENCED_SCRIPT)].map(m => [m[1], m[2]]);
}

/** Run the generator CLI in `cwd`, returning its stdout or throwing its failure. */
function runGenerator(cwd, mode) {
  return execFileSync(process.execPath, ['tools/script-reference.mjs', mode], {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
  });
}

test('every script in package.json appears exactly once in the reference page', () => {
  const names = documentedScripts().map(([name]) => name);
  assert.deepEqual([...names].sort(), Object.keys(pkg.scripts).sort());
  assert.equal(new Set(names).size, names.length, 'a script is listed twice');
});

test('the reference page carries each script body, not a paraphrase', () => {
  const bodies = new Map(documentedScripts());
  const wrong = Object.entries(pkg.scripts).filter(([name, body]) => bodies.get(name) !== body);
  assert.deepEqual(wrong, [], 'a body in the page differs from package.json');
});

test('every script lands in a documented section', () => {
  assert.deepEqual(
    Object.keys(pkg.scripts).filter(name => !sectionOf(name)),
    [],
    'a script matches no SCRIPT_SECTIONS entry, so the page would drop it'
  );
});

test('groupScripts preserves the section order and each section keeps package.json order', () => {
  const groups = groupScripts(pkg.scripts);
  assert.deepEqual(
    [...groups.keys()],
    SCRIPT_SECTIONS.map(([name]) => name),
    'the groups no longer follow the section order'
  );
  for (const [section, entries] of groups) {
    const names = entries.map(([name]) => name);
    assert.ok(names.length > 0, `section ${section} is empty and would render no heading`);
    assert.deepEqual(
      names,
      Object.keys(pkg.scripts).filter(name => names.includes(name))
    );
  }
});

test('a script outside every section is a hard error, not a dropped row', () => {
  assert.throws(() => renderReference({mystery: 'echo hi'}), /matches no section/);
});

test('the committed page is what the generator produces', () => {
  runGenerator(REPO_ROOT, '--check');
});

test('check mode fails a stale page and write mode fixes it', () => {
  // A fixture inside the gitignored dist/ tree: node resolves the repo's own
  // prettier by walking up, and the tool resolves its paths from its own copy.
  const fixture = path.join(REPO_ROOT, 'dist', 'scratch', 'script-reference-fixture');
  rmSync(fixture, {recursive: true, force: true});
  mkdirSync(path.join(fixture, 'tools'), {recursive: true});
  mkdirSync(path.join(fixture, 'docs'), {recursive: true});
  mkdirSync(path.join(fixture, 'config'), {recursive: true});
  for (const file of ['script-reference.mjs', 'scriptSections.mjs']) {
    cpSync(path.join(REPO_ROOT, 'tools', file), path.join(fixture, 'tools', file));
  }
  cpSync(
    path.join(REPO_ROOT, 'config', 'prettier.config.js'),
    path.join(fixture, 'config', 'prettier.config.js')
  );
  // The page is the real one; the package.json differs in one script body.
  cpSync(PAGE, path.join(fixture, 'docs', 'script-reference.md'));
  writeFileSync(
    path.join(fixture, 'package.json'),
    `${JSON.stringify({scripts: {...pkg.scripts, 'lint:mdx': 'node tools/check-docs-mdx.mjs --changed'}}, null, 2)}\n`
  );

  assert.throws(() => runGenerator(fixture, '--check'), /is stale/);
  assert.match(runGenerator(fixture, '--write'), /wrote docs\/script-reference\.md/);
  assert.match(runGenerator(fixture, '--check'), /matches package\.json/);
  rmSync(fixture, {recursive: true, force: true});
});
