// Every gh call is an injected recorder: create/upload/delete/dispatch are
// driven against fixtures, never a real repository or release. The dispatch
// must pin `version`, because cleanup matches the asset by exact name.

import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

import {CI_DOWNLOADS_TAG, ciDownloadsAssetName} from '../../e2e/shared/browserResolver.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const toolUrl = pathToFileURL(path.join(REPO_ROOT, 'tools', 'ci', 'ciDownload.mjs')).href;

const {ciDownload, inferBrowserVersion} = await import(toolUrl);

// test-hygiene: every mkdtemp root created here is removed by the sweep.
const tempRoots = [];
after(() => {
  for (const root of tempRoots) fs.rmSync(root, {recursive: true, force: true});
});

/** A gh-shaped 404, the way execFileSync surfaces it. */
function notFound() {
  return Object.assign(new Error('gh release view: Not Found (HTTP 404)'), {status: 404});
}

/**
 * Fixture-backed gh: recorded calls, scripted responses (object → JSON, Error →
 * thrown), unscripted call → throw.
 */
function scriptedGh(responses) {
  const calls = [];
  let next = 0;
  const gh = args => {
    calls.push(args);
    if (next >= responses.length) {
      throw new Error(`unscripted gh call: gh ${args.join(' ')}`);
    }
    const response = responses[next++];
    if (response instanceof Error) throw response;
    return typeof response === 'string' ? response : JSON.stringify(response);
  };
  return {gh, calls};
}

/** A real fixture installer on disk (the tool checks existence). */
function tmpInstaller(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-download-'));
  tempRoots.push(root);
  const file = path.join(root, name);
  fs.writeFileSync(file, 'fixture installer bytes');
  return file;
}

const noop = () => {};

// ── --clean ────────────────────────────────────────────────────────────────

test('--clean deletes exactly the ci-downloads release + tag', () => {
  const {gh, calls} = scriptedGh(['']);
  const code = ciDownload({argv: ['--clean'], gh, log: noop});
  assert.equal(code, 0);
  assert.deepEqual(calls, [['release', 'delete', CI_DOWNLOADS_TAG, '--yes', '--cleanup-tag']]);
});

test('--clean on an absent release is success (the steady state), not an error', () => {
  const {gh, calls} = scriptedGh([notFound()]);
  const code = ciDownload({argv: ['--clean'], gh, log: noop});
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
});

test('--clean surfaces an unexpected gh failure (the CLI turns it into exit 1)', () => {
  const {gh} = scriptedGh([Object.assign(new Error('HTTP 500: server error'), {status: 500})]);
  assert.throws(() => ciDownload({argv: ['--clean'], gh, log: noop}), /HTTP 500/);
});

// ── validation exits before any gh call ────────────────────────────────────

test('--help → 0, usage printed, no gh call', () => {
  const {gh, calls} = scriptedGh([]);
  const logs = [];
  const code = ciDownload({argv: ['--help'], gh, log: (...a) => logs.push(a.join(' '))});
  assert.equal(code, 0);
  assert.equal(calls.length, 0);
  assert.match(logs.join('\n'), /Usage: pnpm ci:download/);
});

test('no installer file → 1 with usage, no gh call', () => {
  const {gh, calls} = scriptedGh([]);
  const code = ciDownload({argv: [], gh, log: noop});
  assert.equal(code, 1);
  assert.equal(calls.length, 0);
});

test('installer not on disk → 1, no gh call', () => {
  const {gh, calls} = scriptedGh([]);
  const code = ciDownload({argv: [path.join(REPO_ROOT, 'does-not-exist.exe')], gh, log: noop});
  assert.equal(code, 1);
  assert.equal(calls.length, 0);
});

test('browser not inferable → 1, no gh call', () => {
  const file = tmpInstaller('setup.exe');
  const {gh, calls} = scriptedGh([]);
  const code = ciDownload({argv: [file], gh, log: noop});
  assert.equal(code, 1);
  assert.equal(calls.length, 0);
});

test('browser known but no version → 1, no gh call (version pins the run)', () => {
  const file = tmpInstaller('zen.installer.exe');
  const {gh, calls} = scriptedGh([]);
  const code = ciDownload({argv: [file, '--browser', 'zen'], gh, log: noop});
  assert.equal(code, 1);
  assert.equal(calls.length, 0);
});

test('valueless --browser → 1 with usage, before anything runs', () => {
  const {gh, calls} = scriptedGh([]);
  const code = ciDownload({argv: ['--browser'], gh, log: noop});
  assert.equal(code, 1);
  assert.equal(calls.length, 0);
});

// ── create + upload + dispatch ─────────────────────────────────────────────

test('release absent → created; asset renamed to the expected name and uploaded with --clobber', () => {
  const file = tmpInstaller('Waterfox Setup 6.7.1.1.exe');
  const expected = ciDownloadsAssetName('waterfox', '6.7.1.1');
  const {gh, calls} = scriptedGh([notFound(), '', '']);
  const code = ciDownload({argv: [file, '--no-dispatch'], gh, log: noop});
  assert.equal(code, 0);
  assert.equal(calls.length, 3, 'view → create → upload, and nothing else');

  assert.deepEqual(calls[0], ['release', 'view', CI_DOWNLOADS_TAG, '--json', 'assets']);

  const create = calls[1];
  assert.deepEqual(create.slice(0, 5), ['release', 'create', CI_DOWNLOADS_TAG, '--target', 'main']);
  assert.equal(create[create.indexOf('--notes') + 1], create.at(-1));
  assert.match(create.at(-1), /ADR 0021/, 'the release body marks the stash as temporary');

  const upload = calls[2];
  assert.deepEqual(upload.slice(0, 3), ['release', 'upload', CI_DOWNLOADS_TAG]);
  assert.equal(path.basename(upload[3]), expected, 'uploaded under the resolver’s expected name');
  assert.notEqual(
    path.resolve(upload[3]),
    path.resolve(file),
    'the renamed copy is staged in tmp, never next to the user’s file'
  );
  assert.equal(upload[4], '--clobber');
  // The source file survives untouched.
  assert.ok(fs.existsSync(file));
});

test('release already exists → no create, straight to upload', () => {
  const file = tmpInstaller('Waterfox Setup 6.7.1.1.exe');
  const {gh, calls} = scriptedGh([{assets: []}, '']);
  const code = ciDownload({argv: [file, '--no-dispatch'], gh, log: noop});
  assert.equal(code, 0);
  assert.equal(
    calls.some(args => args[1] === 'create'),
    false,
    'the fixed-tag release is created on demand only'
  );
  assert.deepEqual(calls[1].slice(0, 3), ['release', 'upload', CI_DOWNLOADS_TAG]);
});

test('dispatch pins version — the cleanup job matches the asset by exact name', () => {
  const file = tmpInstaller('Waterfox Setup 6.7.1.1.exe');
  const {gh, calls} = scriptedGh([notFound(), '', '', '']);
  const code = ciDownload({argv: [file], gh, log: noop});
  assert.equal(code, 0);
  assert.deepEqual(calls.at(-1), [
    'workflow',
    'run',
    'e2e.yml',
    '-f',
    'browser=waterfox',
    '-f',
    'version=6.7.1.1',
  ]);
});

test('--browser/--version override inference and flow into asset + dispatch', () => {
  const file = tmpInstaller('librewolf-155.0-1-windows-x86_64-setup.exe');
  const {gh, calls} = scriptedGh([notFound(), '', '', '']);
  const code = ciDownload({
    argv: [file, '--browser', 'waterfox', '--version', '9.9.9'],
    gh,
    log: noop,
  });
  assert.equal(code, 0);
  assert.equal(
    path.basename(calls[2][3]),
    ciDownloadsAssetName('waterfox', '9.9.9'),
    'override wins over the filename’s inference'
  );
  assert.deepEqual(calls.at(-1), [
    'workflow',
    'run',
    'e2e.yml',
    '-f',
    'browser=waterfox',
    '-f',
    'version=9.9.9',
  ]);
});

// ── filename inference (shared with the resolver’s shapes) ─────────────────

test('inferBrowserVersion: the four supported installer shapes', () => {
  assert.deepEqual(inferBrowserVersion('librewolf-155.0-1-windows-x86_64-setup.exe'), {
    browser: 'librewolf',
    version: '155.0-1',
  });
  assert.deepEqual(inferBrowserVersion('Waterfox Setup 6.7.1.1.exe'), {
    browser: 'waterfox',
    version: '6.7.1.1',
  });
  assert.deepEqual(inferBrowserVersion('floorp-12.17.2-installer.exe'), {
    browser: 'floorp',
    version: '12.17.2',
  });
  assert.deepEqual(inferBrowserVersion('zen-1.21.16b-installer.exe'), {
    browser: 'zen',
    version: '1.21.16b',
  });
  assert.equal(inferBrowserVersion('setup.exe'), null);
});
