// The two lint aggregates are hand-written lists in package.json, and drift
// between them is invisible at runtime: a stage added to `lint` but not to
// `lint:all` simply never runs in the report-all view, and a stage named in an
// aggregate that no longer exists fails the whole chain at the worst moment (the
// pre-push hook, after the change is already written). Both directions are
// pinned here, so adding a stage to one list and forgetting the other fails a
// test rather than surviving to CI.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';

const pkg = JSON.parse(
  readFileSync(path.join(import.meta.dirname, '..', '..', '..', 'package.json'), 'utf8')
);

/**
 * The `scripts` block is grouped in the order the developer docs walk through
 * the work, which is what makes 56 entries findable. Nothing enforces that at
 * runtime: `pnpm lint` composes its stages by name, so a family split across
 * the block still runs, it just stops being readable. The order is pinned here
 * so a new script appended at the end (the way the block drifted before)
 * fails.
 */
const SCRIPT_SECTIONS = [
  ['lint', /^lint(:|$)/],
  ['format', /^format(:|$)/],
  ['test', /^(test(:|$)|e2e:)/],
  ['check', /^check:/],
  ['hooks', /^hooks:/],
  ['docs', /^docs:/],
  ['toolchain', /^toolchain:/],
  ['scan', /^scan:/],
  ['snapshot', /^snapshot:/],
  ['publish', /^publish:/],
  ['release', /^(release:|fetch:|release:dev-clean$)/],
  ['review', /^review:/],
  ['ci', /^ci:/],
];

/**
 * The `lint:*` stage names an aggregate command composes, in order.
 *
 * @param {string | undefined} command the aggregate script body
 * @returns {string[]} stage names as spelled in the command
 */
function composedStages(command) {
  return (command ?? '').match(/\blint:[a-z0-9-]+/g) ?? [];
}

test('composedStages reads the stages out of an aggregate command', () => {
  assert.deepEqual(composedStages('pnpm run lint:js && pnpm run lint:md'), ['lint:js', 'lint:md']);
  assert.deepEqual(composedStages('node tools/whatever.mjs'), []);
  assert.deepEqual(composedStages(undefined), []);
});

test('scripts stay grouped in their documented sections, in the documented order', () => {
  const sections = [];
  for (const name of Object.keys(pkg.scripts)) {
    const section = SCRIPT_SECTIONS.find(([, matches]) => matches.test(name))?.[0];
    assert.ok(section, `\`${name}\` falls in no documented section`);
    const previous = sections.at(-1);
    assert.ok(
      !previous || previous.index <= SCRIPT_SECTIONS.findIndex(([s]) => s === section),
      `\`${name}\` (${section}) sits after a ${previous?.section} script (\`${previous?.name}\`)`
    );
    sections.push({name, section, index: SCRIPT_SECTIONS.findIndex(([s]) => s === section)});
  }
  assert.deepEqual(
    SCRIPT_SECTIONS.filter(([section]) => !sections.some(s => s.section === section)),
    [],
    'a documented section has no scripts left'
  );
});

test('pnpm lint and pnpm lint:all compose the same stages', () => {
  const fast = composedStages(pkg.scripts.lint);
  const all = composedStages(pkg.scripts['lint:all']);
  assert.ok(fast.length > 0, 'pnpm lint composes nothing at all');
  assert.deepEqual([...all].sort(), [...fast].sort(), 'lint:all and lint disagree');
});

test('test:coverage runs the same glob as pnpm test, with the flag in front of it', () => {
  // Node only honors --experimental-test-coverage when it precedes the test
  // files: after the glob it runs the suites and prints no report at all, exit
  // code 0, which is a coverage gate that looks green and reports nothing. The
  // flag has to lead, which is why this body repeats the glob instead of
  // wrapping `pnpm test` (and why the repetition is pinned here).
  const glob = body => body.match(/"(test\/[^"]+)"/)?.[1];
  assert.equal(glob(pkg.scripts['test:coverage']), glob(pkg.scripts.test));
  assert.match(pkg.scripts['test:coverage'], /^node --experimental-test-coverage --test /);
});

test('every lint:* stage is composed into pnpm lint, and every stage it names exists', () => {
  const composed = composedStages(pkg.scripts.lint);
  const declared = Object.keys(pkg.scripts).filter(
    name => name.startsWith('lint:') && name !== 'lint:all'
  );
  assert.deepEqual(
    declared.filter(name => !composed.includes(name)),
    [],
    'declared as a lint stage but never composed into pnpm lint'
  );
  assert.deepEqual(
    composed.filter(name => !(name in pkg.scripts)),
    [],
    'composed into pnpm lint but missing from package.json'
  );
});
