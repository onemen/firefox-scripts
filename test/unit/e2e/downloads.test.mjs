// test/unit/e2e/downloads.test.mjs — Unit tests for test/e2e/shared/downloads.mjs
//
// Tests: resolveDownloadUrl (per-platform URL resolution + error cases,
// including the #35 firefox-dev hard-gate coverage on all 3 OSes),
// downloadTo cache reuse (HEAD size match → reuse, mismatch/missing →
// re-download), downloadTo progress-aware behavior (#143: a stalled connection
// fails fast, a slow-but-advancing transfer completes, an interrupted transfer
// resumes via a Range request), downloadDir (BROWSER_DL_DIR override),
// parseFirefoxVersion (the --installed-version output parser).

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
const {DOWNLOADS, downloadDir, downloadTo, parseFirefoxVersion, resolveDownloadUrl} = await import(
  downloadsUrl
);

// ── resolveDownloadUrl ────────────────────────────────────────────────────

test('resolveDownloadUrl: official installer URLs per platform', async () => {
  const win = await resolveDownloadUrl('firefox', 'win32');
  const mac = await resolveDownloadUrl('firefox', 'darwin');
  const linux = await resolveDownloadUrl('firefox', 'linux');
  assert.match(win, /^https:\/\/download\.mozilla\.org\/\?product=firefox-latest&os=win64/);
  assert.match(mac, /^https:\/\/download\.mozilla\.org\/\?product=firefox-latest&os=osx/);
  assert.match(linux, /^https:\/\/download\.mozilla\.org\/\?product=firefox-latest&os=linux64/);
});

test('resolveDownloadUrl: firefox-dev resolves on all 3 OSes (#35 hard gate)', async () => {
  const win = await resolveDownloadUrl('firefox-dev', 'win32');
  const mac = await resolveDownloadUrl('firefox-dev', 'darwin');
  const linux = await resolveDownloadUrl('firefox-dev', 'linux');
  assert.match(win, /product=firefox-devedition-latest&os=win64/);
  assert.match(mac, /product=firefox-devedition-latest&os=osx/);
  assert.match(linux, /product=firefox-devedition-latest&os=linux64/);
});

test('dmg app names match the browser discovery registry (space-safe volumes)', async () => {
  const browsersUrl = pathToFileURL(
    path.join(REPO_ROOT, 'test', 'e2e', 'shared', 'browsers.mjs')
  ).href;
  const {BROWSERS} = await import(browsersUrl);
  for (const browser of ['firefox', 'firefox-dev']) {
    const recipe = DOWNLOADS[browser]?.install?.mac;
    assert.ok(recipe?.app, `${browser} needs a mac dmg recipe`);
    // installDmg copies `<mount>/<app>` and discovery looks for
    // BROWSERS[browser].mac[0] under /Applications — the two must agree.
    assert.equal(recipe.app, BROWSERS[browser].mac[0]);
  }
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
  // waterfox has a win recipe now (ADR 0021), so the manual-only error only
  // applies to its non-win platforms.
  await assert.rejects(
    resolveDownloadUrl('waterfox', 'linux'),
    /manual install only.*waterfox\.net/
  );
});

test('resolveDownloadUrl: waterfox resolves through the resolver chain (win, ADR 0021)', async () => {
  // Stub fetch: GitHub tag API + CDN index. The resolver must prefer the
  // GitHub tag and build the versioned CDN setup URL.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    const u = String(url);
    if (u.includes('BrowserWorks/Waterfox')) {
      return {ok: true, json: async () => ({tag_name: 'v6.7.1.1'})};
    }
    if (u.includes('cdn.waterfox.com')) {
      return {
        ok: true,
        text: async () =>
          '<a href="/waterfox/releases/6.6.9/">6.6.9</a><a href="/waterfox/releases/6.7.0-beta.1/">b</a><a href="/waterfox/releases/6.7.1.1/">6.7.1.1</a>',
      };
    }
    if (u.startsWith('https://cdn.waterfox.com/waterfox/releases/6.7.1.1/')) {
      return {ok: true, status: 200};
    }
    throw new Error(`unexpected fetch: ${u}`);
  };
  try {
    const url = await resolveDownloadUrl('waterfox', 'win32');
    assert.match(
      url,
      /^https:\/\/cdn\.waterfox\.com\/waterfox\/releases\/6\.7\.1\.1\/WINNT_x86_64\//
    );
    assert.match(url, /Waterfox%20Setup%206\.7\.1\.1\.exe$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
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

// ── downloadTo: progress-aware transfer (#143) ────────────────────────────

/**
 * Fast download timings for the stall/resume tests (milliseconds instead of the
 * 60 s stall window / 20 min budget / 5 s backoff defaults). Returns a restore
 * function.
 */
function withFastDownloadTimings() {
  const saved = {
    DOWNLOAD_STALL_TIMEOUT_MS: process.env.DOWNLOAD_STALL_TIMEOUT_MS,
    DOWNLOAD_TOTAL_BUDGET_MS: process.env.DOWNLOAD_TOTAL_BUDGET_MS,
    DOWNLOAD_RETRY_BACKOFF_MS: process.env.DOWNLOAD_RETRY_BACKOFF_MS,
  };
  process.env.DOWNLOAD_STALL_TIMEOUT_MS = '200';
  process.env.DOWNLOAD_TOTAL_BUDGET_MS = '60000';
  process.env.DOWNLOAD_RETRY_BACKOFF_MS = '1';
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function listen(server) {
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${server.address().port}/installer.bin`);
    });
  });
}

test('downloadTo: stalled connection fails fast — healthy progress is never aborted', async () => {
  const restore = withFastDownloadTimings();
  // First chunk, then silence forever: a dead stream. The transfer must fail
  // after the stall window (with retries), not hang until a wall clock kills it.
  const server = createServer((req, res) => {
    res.writeHead(200, {'content-length': '8192'});
    res.write(Buffer.alloc(1024));
    // no res.end() — the connection stays open and silent
  });
  const url = await listen(server);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-stall-'));
  const dest = path.join(tmp, 'installer.bin');
  const t0 = Date.now();
  try {
    await assert.rejects(downloadTo(url, dest), /stalled/);
    const elapsed = Date.now() - t0;
    // 5 attempts × 200 ms stall + tiny backoff ≈ 1 s; generous bound only
    // guards against a CI hiccup — the point is the bound is the stall
    // window, not minutes of wall clock.
    assert.ok(
      elapsed < 30_000,
      `stall detection took ${elapsed}ms — not bounded by the stall window`
    );
    assert.equal(fs.statSync(dest).size, 1024, 'partial file kept on disk for a later resume');
  } finally {
    restore();
    server.close();
    server.closeAllConnections?.();
    fs.rmSync(tmp, {recursive: true, force: true});
  }
});

test('downloadTo: slow-but-progressing download completes (#143 home-link case)', async () => {
  const restore = withFastDownloadTimings();
  const body = Buffer.alloc(1000, 0x53);
  // Drip 5 × 200 bytes with 60 ms gaps: inter-chunk gaps sit well inside the
  // 200 ms stall window, so bytes keep advancing and the transfer completes —
  // exactly the healthy-but-slow case the old wall-clock timeout killed.
  const server = createServer((req, res) => {
    res.writeHead(200, {'content-length': String(body.length)});
    let i = 0;
    const drip = setInterval(() => {
      if (i >= body.length) {
        clearInterval(drip);
        res.end();
        return;
      }
      res.write(body.subarray(i, i + 200));
      i += 200;
    }, 60);
  });
  const url = await listen(server);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-drip-'));
  const dest = path.join(tmp, 'installer.bin');
  try {
    await downloadTo(url, dest);
    assert.deepEqual(fs.readFileSync(dest), body, 'byte-complete file despite the slow drip');
  } finally {
    restore();
    server.close();
    server.closeAllConnections?.();
    fs.rmSync(tmp, {recursive: true, force: true});
  }
});

test('downloadTo: interrupted transfer resumes via Range instead of restarting', async () => {
  const restore = withFastDownloadTimings();
  const body = Buffer.alloc(4096, 0x52);
  let attempts = 0;
  let sawRange = false;
  let rangeStart = -1;
  const server = createServer((req, res) => {
    attempts++;
    const range = req.headers.range;
    if (range) {
      // Any retry: honor the Range request the client sent after attempt 1
      // died mid-body — serve only the missing tail as 206.
      sawRange = true;
      rangeStart = Number(
        String(range)
          .replace(/^bytes=/, '')
          .split('-')[0]
      );
      res.writeHead(206, {'content-length': String(body.length - rangeStart)});
      res.end(body.subarray(rangeStart));
      return;
    }
    res.writeHead(200, {'content-length': String(body.length)});
    if (attempts === 1) {
      // Attempt 1: flush 1 KB to the client, THEN cut the connection mid-body
      // (destroy immediately would race the flush and deliver zero bytes).
      res.write(body.subarray(0, 1024), () => {
        setTimeout(() => res.socket.destroy(), 10);
      });
      return;
    }
    res.end(body); // a non-ranged retry wants the full body
  });
  const url = await listen(server);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-resume-'));
  const dest = path.join(tmp, 'installer.bin');
  try {
    await downloadTo(url, dest);
    assert.equal(attempts, 2, 'exactly one retry after the interrupted attempt');
    assert.ok(sawRange, 'retry sent a Range header (resume, not restart)');
    assert.equal(rangeStart, 1024, 'resumed from the bytes already on disk');
    assert.deepEqual(fs.readFileSync(dest), body, 'resumed file is byte-complete');
  } finally {
    restore();
    server.close();
    server.closeAllConnections?.();
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

// ── parseFirefoxVersion (--installed-version output) ─────────────────────

test('parseFirefoxVersion: stable / dev / esr branded lines', () => {
  assert.equal(parseFirefoxVersion('Mozilla Firefox 155.0.1\n'), '155.0.1');
  assert.equal(parseFirefoxVersion('Mozilla Firefox 156.0b3'), '156.0b3');
  assert.equal(parseFirefoxVersion('Mozilla Firefox 128.0esr'), '128.0esr');
});

test('parseFirefoxVersion: leading noise / extra lines do not confuse it', () => {
  assert.equal(
    parseFirefoxVersion('Gtk-WARNING **: cannot open display\nMozilla Firefox 155.0.1'),
    '155.0.1'
  );
  assert.equal(parseFirefoxVersion('Mozilla Firefox 155.0.1\nBuildID: 20260829000000'), '155.0.1');
});

test('parseFirefoxVersion: unbranded dotted-numeric fallback, null on garbage', () => {
  // Some brandings phrase the line without the "Mozilla Firefox" prefix.
  assert.equal(parseFirefoxVersion('Firefox 155.0.1'), '155.0.1');
  assert.equal(parseFirefoxVersion('Mozilla Firefox'), null);
  assert.equal(parseFirefoxVersion(''), null);
  assert.equal(parseFirefoxVersion('cannot open display'), null);
});
