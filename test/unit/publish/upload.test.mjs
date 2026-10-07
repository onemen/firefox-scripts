// upload.mjs parses flags at module top level and requireMode() is main()'s
// first statement, so every case below exits before any git, network or
// filesystem side effect. --mode has no silent default (ADR 0030).

import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const UPLOAD = path.join(REPO_ROOT, 'tools', 'publish', 'upload.mjs');

/**
 * Run upload.mjs as a subprocess; every guard under test throws/returns before
 * I/O.
 */
function runUpload(args) {
  const res = spawnSync(process.execPath, [UPLOAD, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (res.error) throw res.error;
  return {status: res.status, out: `${res.stdout || ''}${res.stderr || ''}`};
}

test('no --mode → fails first, before anything else runs', () => {
  const {status, out} = runUpload(['--include=all']);
  assert.equal(status, 1);
  assert.match(out, /Missing required --mode=prod\|dev/);
});

test('no --include → fails at import, before main()', () => {
  const {status, out} = runUpload([]);
  assert.equal(status, 1);
  assert.match(out, /Missing --include=<roles>/);
});

test('--include= (empty) → rejected', () => {
  const {status, out} = runUpload(['--include=']);
  assert.equal(status, 1);
  assert.match(out, /--include= needs at least one role/);
});

test('--include=<unknown role> → rejected', () => {
  const {status, out} = runUpload(['--include=bogus']);
  assert.equal(status, 1);
  assert.match(out, /Unknown --include role 'bogus'/);
});

test('--build-only with --skip-build → mutually exclusive', () => {
  const {status, out} = runUpload(['--build-only', '--skip-build', '--include=all']);
  assert.equal(status, 1);
  assert.match(out, /mutually exclusive/);
});

test('every removed flag fails loudly instead of turning into a real upload', () => {
  const removed = [
    '--dry-run',
    '--packages-only',
    '--binaries-only',
    '--ci',
    '--skip=all',
    '--no-tag',
    '--keep-copy',
    '--verbose',
    '--quiet',
  ];
  for (const flag of removed) {
    const {status, out} = runUpload([flag, '--mode=dev', '--include=all']);
    assert.equal(status, 1, `${flag} must fail the run`);
    assert.match(out, /Unknown flag/, `${flag} must be reported as unknown`);
    assert.match(
      out,
      /snapshot:prod|prod publishes are workflow-only/,
      `${flag} must point the caller at the replacement`
    );
  }
});
