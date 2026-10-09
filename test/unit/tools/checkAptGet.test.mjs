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
