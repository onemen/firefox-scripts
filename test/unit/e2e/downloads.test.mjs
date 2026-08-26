// test/unit/e2e/downloads.test.mjs — Unit tests for test/e2e/shared/downloads.mjs
//
// Tests: resolveDownloadUrl (per-platform URL resolution + error cases),
// downloadTo cache reuse (HEAD size match → reuse, mismatch/missing →
// re-download), downloadDir (BROWSER_DL_DIR override).

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createServer} from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const downloadsUrl = pathToFileURL(
  path.join(REPO_ROOT, 'test', 'e2e', 'shared', 'downloads.mjs')
).href;
const {downloadDir, downloadTo, resolveDownloadUrl} = await import(downloadsUrl);

// ── resolveDownloadUrl ────────────────────────────────────────────────────

test('resolveDownloadUrl: official installer URLs per platform', async () => {
  const win = await resolveDownloadUrl('firefox', 'win32');
  const mac = await resolveDownloadUrl('firefox', 'darwin');
  const linux = await resolveDownloadUrl('firefox', 'linux');
  assert.match(win, /^https:\/\/download\.mozilla\.org\/\?product=firefox-latest&os=win64/);
  assert.match(mac, /^https:\/\/download\.mozilla\.org\/\?product=firefox-latest&os=osx/);
  assert.match(linux, /^https:\/\/download\.mozilla\.org\/\?product=firefox-latest&os=linux64/);
});

test('resolveDownloadUrl: accepts short platform names (win/mac)', async () => {
  assert.equal(
    await resolveDownloadUrl('firefox', 'win'),
    await resolveDownloadUrl('firefox', 'win32')
  );
  assert.equal(
    await resolveDownloadUrl('firefox', 'mac'),
    await resolveDownloadUrl('firefox', 'darwin')
  );
});

test('resolveDownloadUrl: floorp uses the stable GitHub latest-download URL', async () => {
  assert.equal(
    await resolveDownloadUrl('floorp', 'win32'),
    'https://github.com/Floorp-Projects/Floorp/releases/latest/download/floorp-windows-x86_64.installer.exe'
  );
});

test('resolveDownloadUrl: librewolf resolves the latest version from the packages API', async () => {
  // Stub global fetch: no network in unit tests. The stub mimics Gitea's
  // package list (newest-first); the resolver must pick the `generic`
  // `librewolf` package and build the version-embedded installer URL.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => [
      {type: 'generic', name: 'librewolf-source', version: '154.0.1-2'},
      {type: 'generic', name: 'librewolf', version: '154.0.1-2'},
      {type: 'generic', name: 'librewolf', version: '153.0.4-1'},
    ],
  });
  try {
    const url = await resolveDownloadUrl('librewolf', 'win32');
    assert.equal(
      url,
      'https://librewolf.dev/api/packages/librewolf/generic/librewolf/154.0.1-2/librewolf-154.0.1-2-windows-x86_64-setup.exe'
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('resolveDownloadUrl: manual-only browsers throw with the official page', async () => {
  await assert.rejects(
    resolveDownloadUrl('waterfox', 'win32'),
    /manual install only.*waterfox\.net/
  );
});

test('resolveDownloadUrl: unknown browser throws', async () => {
  await assert.rejects(resolveDownloadUrl('not-a-browser', 'linux'), /has no automated install/);
});

// ── downloadTo cache reuse ────────────────────────────────────────────────

/** Serve `body` on GET and HEAD (HEAD gets headers only), counting GETs. */
function startServer(body) {
  let getCount = 0;
  const server = createServer((req, res) => {
    res.writeHead(200, {'content-length': String(body.length)});
    if (req.method === 'GET') {
      getCount++;
      res.end(body);
    } else {
      res.end();
    }
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        getCount: () => getCount,
        url: `http://127.0.0.1:${server.address().port}/installer.bin`,
      });
    });
  });
}

test('downloadTo: reuses a local file that matches the remote size', async () => {
  const body = Buffer.from('x'.repeat(4096));
  const {server, getCount, url} = await startServer(body);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-reuse-'));
  const dest = path.join(tmp, 'installer.bin');
  try {
    fs.writeFileSync(dest, body); // cache-restored file, correct size
    await downloadTo(url, dest);
    assert.equal(getCount(), 0, 'no GET issued — cached file reused');
  } finally {
    server.close();
    fs.rmSync(tmp, {recursive: true, force: true});
  }
});

test('downloadTo: re-downloads when the cached file size mismatches', async () => {
  const body = Buffer.from('y'.repeat(8192));
  const {server, getCount, url} = await startServer(body);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-mismatch-'));
  const dest = path.join(tmp, 'installer.bin');
  try {
    fs.writeFileSync(dest, Buffer.from('partial')); // cut-short download
    await downloadTo(url, dest);
    assert.equal(getCount(), 1, 'GET issued — mismatched file re-fetched');
    assert.deepEqual(fs.readFileSync(dest), body);
  } finally {
    server.close();
    fs.rmSync(tmp, {recursive: true, force: true});
  }
});

test('downloadTo: downloads when no local file exists', async () => {
  const body = Buffer.from('z'.repeat(2048));
  const {server, getCount, url} = await startServer(body);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-fresh-'));
  const dest = path.join(tmp, 'installer.bin');
  try {
    await downloadTo(url, dest);
    assert.equal(getCount(), 1, 'GET issued — fresh download');
    assert.deepEqual(fs.readFileSync(dest), body);
  } finally {
    server.close();
    fs.rmSync(tmp, {recursive: true, force: true});
  }
});

// ── downloadDir ───────────────────────────────────────────────────────────

test('downloadDir: honors BROWSER_DL_DIR, defaults to the OS temp dir', () => {
  const prev = process.env.BROWSER_DL_DIR;
  try {
    process.env.BROWSER_DL_DIR = '/ci/cache/browser-dl';
    assert.equal(downloadDir(), '/ci/cache/browser-dl');
  } finally {
    if (prev === undefined) delete process.env.BROWSER_DL_DIR;
    else process.env.BROWSER_DL_DIR = prev;
  }
  assert.equal(downloadDir(), os.tmpdir());
});
