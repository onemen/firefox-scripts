// test/unit/tools/checkAptGet.test.mjs — the bounded-apt gate (issue #461):
// raw `sudo apt-get update|install` command lines fail; the bound-apt
// wrapper itself is exempt; prose mentions never fire.

import {after, test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {findRawAptGetCalls} from '../../../tools/check-apt-get.mjs';

const tmpDirs = [];
after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, {recursive: true, force: true});
});

function writeTmp(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fxs-apt-'));
  tmpDirs.push(dir);
  const paths = [];
  for (const [name, text] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), {recursive: true});
    fs.writeFileSync(full, text);
    paths.push(full);
  }
  return {dir, paths};
}

test('flags a raw sudo apt-get update/install command line', () => {
  const {paths} = writeTmp({
    'job.yml':
      '      run: |\n        sudo apt-get update -qq\n        sudo apt-get install -y -qq xvfb\n',
  });
  const findings = findRawAptGetCalls(paths, path.parse(paths[0]).dir);
  assert.equal(findings.length, 2);
  assert.deepEqual(
    findings.map(f => f.line),
    [2, 3]
  );
});

test('the natural one-line step form fires (regression: CodeRabbit #483)', () => {
  // The original gate required `sudo apt-get` at the line start, so the most
  // common real shape — an inline `run:` step — sailed through unchecked.
  const {paths} = writeTmp({
    'job.yml': '      - name: x\n        run: sudo apt-get install -y -qq xvfb\n',
  });
  const findings = findRawAptGetCalls(paths, path.parse(paths[0]).dir);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 2);
});

test('flags BEFORE the verb fire (regression: the `\\s+\\s-` typo)', () => {
  // The gate once required TWO whitespace characters before a pre-verb flag
  // (`\s+\s-`), so the ordinary `apt-get -y install xvfb` — one space — walked
  // straight through the #461 gate. Caught by the CodeRabbit batch pass.
  const {paths} = writeTmp({
    'job.yml':
      [
        '        apt-get -y install xvfb',
        '        sudo apt-get -qq update',
        '        apt-get -y -qq install git',
      ].join('\n') + '\n',
  });
  const findings = findRawAptGetCalls(paths, path.parse(paths[0]).dir);
  assert.deepEqual(
    findings.map(f => f.line),
    [1, 2, 3]
  );
});

test('wrapper, short-spelling, root and chained forms all fire', () => {
  const {paths} = writeTmp({
    'e2e.yml':
      [
        '        timeout 60 sudo apt-get install -y xvfb',
        '        apt install -y xvfb',
        '        apt-get update -qq',
        '        sudo -E apt-get install -y git',
        '        make setup && sudo apt-get install -y jq',
        '        echo hi | sudo apt-get update',
        '        foo; sudo apt-get install -y curl',
      ].join('\n') + '\n',
  });
  const findings = findRawAptGetCalls(paths, path.parse(paths[0]).dir);
  assert.deepEqual(
    findings.map(f => f.line),
    [1, 2, 3, 4, 5, 6, 7]
  );
});

test('a trailing comment never fires, but a real command before it does', () => {
  const {paths} = writeTmp({
    'ci.yml':
      [
        '      # && sudo apt-get install -y foo (prose only)',
        '        echo x && sudo apt-get update -qq # real command',
      ].join('\n') + '\n',
  });
  const findings = findRawAptGetCalls(paths, path.parse(paths[0]).dir);
  assert.deepEqual(
    findings.map(f => f.line),
    [2]
  );
});

test('prose mentions (comments, backticks) never fire', () => {
  const {paths} = writeTmp({
    'ci.yml':
      '# break `apt-get update` for everyone.\n      # file fails `apt-get update` with a hash-sum mismatch.\n      - name: Harden apt sources\n',
  });
  assert.deepEqual(findRawAptGetCalls(paths, path.parse(paths[0]).dir), []);
});

test('non-YAML paths are ignored even with command-positioned text', () => {
  const {dir, paths} = writeTmp({
    'notes.md': 'sudo apt-get update -qq\n',
    'script.mjs': '// sudo apt-get update -qq\n',
  });
  assert.deepEqual(findRawAptGetCalls(paths, dir), []);
});

test('prose inside a description block never fires (the `so apt-get update` trap)', () => {
  // Regression: `apt sources … so apt-get update cannot fail` matched when
  // flags were `\S+` tokens — `so` read as a flag. It is real text in
  // .github/actions/harden-apt/action.yml:17.
  const {paths} = writeTmp({
    'action.yml':
      'description: >-\n  Remove unused third-party apt sources (Google Chrome et al.) so apt-get update cannot fail on\n  their out-of-band index churn\n',
  });
  assert.deepEqual(findRawAptGetCalls(paths, path.parse(paths[0]).dir), []);
});

test('live repo: no raw call sites outside bound-apt', async () => {
  const {findRawAptGetCalls: live} = await import('../../../tools/check-apt-get.mjs');
  assert.deepEqual(live(), []);
});

test('the bound-apt wrapper file itself is exempt', async () => {
  const {findRawAptGetCalls: live} = await import('../../../tools/check-apt-get.mjs');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const wrapper = path.join(root, '.github', 'actions', 'bound-apt', 'action.yml');
  assert.ok(fs.existsSync(wrapper), 'wrapper action exists');
  assert.deepEqual(live([wrapper], root), []);
});
