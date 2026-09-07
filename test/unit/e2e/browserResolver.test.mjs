// test/unit/e2e/browserResolver.test.mjs — Unit tests for
// test/e2e/shared/browserResolver.mjs (ADR 0021, plan:
// docs/browser-downloads-resilience.local.md).
//
// Tests: fetchJsonWithRetry ladder, resolveBrowserVersion chains (bsys6-first
// LibreWolf, waterfox GitHub→CDN, chain exhaustion), waterfox version
// compare, resolveInstallerUrl source order + ci-downloads fallback + pinned
// version, findCiDownloadsAsset 404 silence, verifySha256.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const resolverUrl = pathToFileURL(
  path.join(REPO_ROOT, 'test', 'e2e', 'shared', 'browserResolver.mjs')
).href;
const {
  fetchJsonWithRetry,
  resolveBrowserVersion,
  resolveInstallerUrl,
  findCiDownloadsAsset,
  resetCiDownloadsProbe,
  ciDownloadsAssetName,
  compareWaterfoxVersions,
  parseWaterfoxVersion,
  verifySha256,
  CI_DOWNLOADS_TAG,
} = await import(resolverUrl);

// Retry backoff: the unit-test floor (see the env fallback below).
process.env.BROWSER_RESOLVER_BACKOFF_MS = '0';

/** Install a fetch stub; returns the restore function. */
function stubFetch(routes) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    calls.push({url: u, method: opts.method || 'GET'});
    for (const [pattern, handler] of routes) {
      if (typeof pattern === 'string' ? u.includes(pattern) : pattern.test(u)) {
        return handler(u);
      }
    }
    throw new Error(`unexpected fetch: ${u}`);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

const okJson = body => ({
  ok: true,
  status: 200,
  json: async () => body,
  text: async () => JSON.stringify(body),
  arrayBuffer: async () => Buffer.from(JSON.stringify(body)),
});
const okText = body => ({
  ok: true,
  status: 200,
  json: async () => body,
  text: async () => body,
  arrayBuffer: async () => Buffer.from(body),
});
const httpError = status => ({
  ok: false,
  status,
  json: async () => ({}),
  text: async () => '',
  arrayBuffer: async () => Buffer.alloc(0),
});

// ── fetchJsonWithRetry ───────────────────────────────────────────────────────

test('fetchJsonWithRetry: retries a failing endpoint then succeeds', async () => {
  let n = 0;
  const {restore} = stubFetch([
    ['example.org', () => (n++ < 2 ? httpError(502) : okJson({value: 7}))],
  ]);
  try {
    assert.deepEqual(await fetchJsonWithRetry('https://example.org/x'), {value: 7});
    assert.equal(n, 3);
  } finally {
    restore();
  }
});

test('fetchJsonWithRetry: throws after the last attempt', async () => {
  const {restore} = stubFetch([['example.org', () => httpError(500)]]);
  try {
    await assert.rejects(fetchJsonWithRetry('https://example.org/x', {attempts: 2}), /HTTP 500/);
  } finally {
    restore();
  }
});

// ── resolveBrowserVersion ────────────────────────────────────────────────────

test('resolveBrowserVersion: LibreWolf prefers the bsys6 releases API', async () => {
  const {restore, calls} = stubFetch([
    ['repos/librewolf/bsys6/releases/latest', () => okJson({tag_name: '155.0-1', assets: []})],
    ['api/v1/packages/librewolf', () => okJson([])],
  ]);
  try {
    const resolved = await resolveBrowserVersion('librewolf');
    assert.equal(resolved.version, '155.0-1');
    assert.equal(resolved.source, 'codeberg-bsys6-releases');
    assert.ok(
      !calls.some(c => c.url.includes('/packages/librewolf')),
      'packages API must not be consulted when bsys6 answers'
    );
  } finally {
    restore();
  }
});

test('resolveBrowserVersion: LibreWolf falls back to the packages API', async () => {
  const {restore} = stubFetch([
    ['repos/librewolf/bsys6/releases/latest', () => httpError(502)],
    [
      'api/v1/packages/librewolf',
      () =>
        okJson([
          {type: 'generic', name: 'librewolf-source', version: '154.0.1-2'},
          {type: 'generic', name: 'librewolf', version: '155.0-1'},
        ]),
    ],
  ]);
  try {
    const resolved = await resolveBrowserVersion('librewolf');
    assert.equal(resolved.version, '155.0-1');
    assert.equal(resolved.source, 'codeberg-packages');
  } finally {
    restore();
  }
});

test('resolveBrowserVersion: waterfox falls back to the CDN index (newest non-beta)', async () => {
  const {restore} = stubFetch([
    ['api.github.com/repos/BrowserWorks/Waterfox', () => httpError(500)],
    [
      'cdn.waterfox.com',
      () =>
        okText(
          '<a href="/waterfox/releases/6.6.9/">a</a><a href="/waterfox/releases/6.7.0-beta.1/">b</a><a href="/waterfox/releases/6.7.0/">c</a><a href="/waterfox/releases/G5.1.13/">legacy</a>'
        ),
    ],
  ]);
  try {
    const resolved = await resolveBrowserVersion('waterfox');
    assert.equal(resolved.version, '6.7.0');
    assert.equal(resolved.source, 'waterfox-cdn-index');
  } finally {
    restore();
  }
});

test('resolveBrowserVersion: pin short-circuits the chain', async () => {
  const {restore, calls} = stubFetch([['api.github.com', () => okJson({tag_name: 'v1.2.3'})]]);
  try {
    const resolved = await resolveBrowserVersion('zen', {pin: '1.21.16b'});
    assert.equal(resolved.version, '1.21.16b');
    assert.equal(resolved.source, 'pinned');
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

test('resolveBrowserVersion: exhausts the chain with a combined error', async () => {
  const {restore} = stubFetch([[/codeberg\.org|Floorp-Projects/, () => httpError(503)]]);
  try {
    await assert.rejects(
      resolveBrowserVersion('floorp'),
      /all version sources failed for floorp: github-releases: HTTP 503/
    );
  } finally {
    restore();
  }
});

test('resolveBrowserVersion: unknown browser', async () => {
  await assert.rejects(resolveBrowserVersion('nope'), /no version chain/);
});

// ── waterfox version compare ─────────────────────────────────────────────────

test('compareWaterfoxVersions: pre-release aware ordering', () => {
  assert.ok(compareWaterfoxVersions('6.7.0-beta.3', '6.7.0') < 0, 'beta < release');
  assert.ok(compareWaterfoxVersions('6.7.0-beta.1', '6.6.9') > 0, 'new beta > old release');
  assert.ok(compareWaterfoxVersions('6.7.1.1', '6.7.1') > 0, 'four-part > three-part');
  assert.ok(compareWaterfoxVersions('6.7.0', '6.7.0') === 0);
  assert.ok(compareWaterfoxVersions('6.7.0-alpha.1', '6.7.0-beta.1') < 0, 'alpha < beta');
  assert.ok(compareWaterfoxVersions('6.5.0-beta-1', '6.5.0-beta.2') < 0, 'legacy dash form');
});

test('parseWaterfoxVersion: parses display versions, rejects legacy junk', () => {
  assert.deepEqual(parseWaterfoxVersion('155.0.1'), {
    numbers: [155, 0, 1],
    pre: null,
    preNumber: 0,
  });
  assert.equal(
    parseWaterfoxVersion('G5.1.13'),
    null,
    'legacy G-prefix scheme is not published anymore'
  );
  assert.deepEqual(parseWaterfoxVersion('6.7.0-beta.1'), {
    numbers: [6, 7, 0],
    pre: 'beta',
    preNumber: 1,
  });
});

// ── ci-downloads ─────────────────────────────────────────────────────────────

test('ciDownloadsAssetName: matches the vendor installer shapes', () => {
  assert.equal(
    ciDownloadsAssetName('librewolf', '155.0-1'),
    'librewolf-155.0-1-windows-x86_64-setup.exe'
  );
  assert.equal(ciDownloadsAssetName('waterfox', '6.7.1.1'), 'waterfox-6.7.1.1-setup.exe');
  assert.equal(ciDownloadsAssetName('floorp', '12.17.2'), 'floorp-12.17.2-installer.exe');
  assert.equal(ciDownloadsAssetName('zen', '1.21.16b'), 'zen-1.21.16b-installer.exe');
});

test('findCiDownloadsAsset: silent null on 404 (steady state: no release)', async () => {
  resetCiDownloadsProbe();
  const {restore, calls} = stubFetch([['releases/tags/ci-downloads', () => httpError(404)]]);
  try {
    assert.equal(await findCiDownloadsAsset('whatever.exe'), null);
    assert.ok(!calls.some(c => /warn|error/i.test(c.url)), 'no noisy retry');
  } finally {
    restore();
  }
});

test('findCiDownloadsAsset: resolves the matching asset URL', async () => {
  resetCiDownloadsProbe();
  const {restore} = stubFetch([
    [
      'releases/tags/ci-downloads',
      () =>
        okJson({
          assets: [
            {name: 'other.exe', browser_download_url: 'https://x/other.exe'},
            {
              name: 'librewolf-155.0-1-windows-x86_64-setup.exe',
              browser_download_url: 'https://x/lw.exe',
            },
          ],
        }),
    ],
  ]);
  try {
    assert.equal(
      await findCiDownloadsAsset('librewolf-155.0-1-windows-x86_64-setup.exe'),
      'https://x/lw.exe'
    );
    assert.equal(await findCiDownloadsAsset('missing.exe'), null);
  } finally {
    restore();
  }
});

// ── resolveInstallerUrl ──────────────────────────────────────────────────────

test('resolveInstallerUrl: LibreWolf official mirror first, then ci-downloads', async () => {
  resetCiDownloadsProbe();
  const {restore} = stubFetch([
    // version chain: bsys6 answers
    ['repos/librewolf/bsys6/releases/latest', () => okJson({tag_name: '155.0-1', assets: []})],
    // official mirrors: both 404 (HEAD)
    ['librewolf.dev', () => ({ok: false, status: 404})],
    ['dl.librewolf.net', () => ({ok: false, status: 404})],
    // bsys6 asset probe also 404s
    [/librewolf-\d/, () => ({ok: false, status: 404})],
    // ci-downloads has the asset
    [
      'releases/tags/ci-downloads',
      () =>
        okJson({
          assets: [
            {
              name: 'librewolf-155.0-1-windows-x86_64-setup.exe',
              browser_download_url: 'https://x/ci-lw.exe',
            },
          ],
        }),
    ],
  ]);
  try {
    const resolved = await resolveInstallerUrl('librewolf');
    assert.equal(resolved.url, 'https://x/ci-lw.exe');
    assert.equal(resolved.source, CI_DOWNLOADS_TAG);
    assert.equal(resolved.version, '155.0-1');
    assert.equal(resolved.sha256Url, null, 'no vendor sha256 for hand-uploaded assets');
  } finally {
    restore();
  }
});

test('resolveInstallerUrl: bsys6 release asset before ci-downloads', async () => {
  resetCiDownloadsProbe();
  const {restore} = stubFetch([
    // version chain: bsys6 answers WITH the installer in its assets
    [
      'repos/librewolf/bsys6/releases/latest',
      () =>
        okJson({
          tag_name: '155.0-1',
          assets: [
            {
              name: 'other-asset.tar.xz',
              browser_download_url: 'https://codeberg.org/other.tar.xz',
            },
            {
              name: 'librewolf-155.0-1-windows-x86_64-setup.exe',
              browser_download_url:
                'https://codeberg.org/librewolf/bsys6/releases/download/155.0-1/librewolf-155.0-1-windows-x86_64-setup.exe',
            },
          ],
        }),
    ],
    // official mirrors: both 404 (HEAD)
    ['librewolf.dev', () => ({ok: false, status: 404})],
    ['dl.librewolf.net', () => ({ok: false, status: 404})],
    // the bsys6 asset URL itself answers (HEAD probe)
    [/bsys6\/releases\/download/, u => ({ok: true, status: 200, url: u})],
    // ci-downloads must never be consulted
    [
      'releases/tags/ci-downloads',
      () => {
        throw new Error('ci-downloads must not be reached when the bsys6 asset answers');
      },
    ],
  ]);
  try {
    const resolved = await resolveInstallerUrl('librewolf');
    assert.match(resolved.url, /bsys6\/releases\/download.*setup\.exe$/);
    assert.equal(resolved.source, 'codeberg-bsys6-asset');
    assert.match(resolved.sha256Url, /dl\.librewolf\.net.*\.sha256sum$/);
  } finally {
    restore();
  }
});

test('resolveInstallerUrl: pin skips version-agnostic mirrors (floorp/zen) → ci-downloads', async () => {
  resetCiDownloadsProbe();
  const {restore} = stubFetch([
    // The version-agnostic official mirror MUST NOT be probed: it always
    // serves the latest release, so honoring it under a pin would download
    // the newest installer while labeling it the pinned version (ADR 0023).
    [
      'releases/latest/download/floorp-windows-x86_64.installer.exe',
      () => {
        throw new Error('version-agnostic mirror reached under a pin');
      },
    ],
    // ci-downloads carries the EXACT pinned asset.
    [
      'releases/tags/ci-downloads',
      () =>
        okJson({
          assets: [
            {
              name: 'floorp-12.17.2-installer.exe',
              browser_download_url: 'https://x/ci-floorp.exe',
            },
          ],
        }),
    ],
  ]);
  try {
    const resolved = await resolveInstallerUrl('floorp', {version: '12.17.2'});
    assert.equal(resolved.url, 'https://x/ci-floorp.exe');
    assert.equal(resolved.source, CI_DOWNLOADS_TAG);
    assert.equal(resolved.version, '12.17.2');
  } finally {
    restore();
  }
});

test('resolveInstallerUrl: unpinned floorp keeps the stable latest mirror', async () => {
  resetCiDownloadsProbe();
  const {restore} = stubFetch([
    // version chain: GitHub releases answers
    ['repos/Floorp-Projects/Floorp/releases/latest', () => okJson({tag_name: 'v12.17.3'})],
    // the stable mirror answers (HEAD probe) — the official source wins
    [
      'releases/latest/download/floorp-windows-x86_64.installer.exe',
      u => ({ok: true, status: 200, url: u}),
    ],
  ]);
  try {
    const resolved = await resolveInstallerUrl('floorp');
    assert.equal(
      resolved.url,
      'https://github.com/Floorp-Projects/Floorp/releases/latest/download/floorp-windows-x86_64.installer.exe'
    );
    assert.equal(resolved.source, 'official');
    assert.equal(resolved.version, '12.17.3');
    assert.equal(resolved.sha256Url, null);
  } finally {
    restore();
  }
});

test('resolveBrowserVersion: BROWSER_PIN_VERSION env pins the chain', async () => {
  const prev = process.env.BROWSER_PIN_VERSION;
  process.env.BROWSER_PIN_VERSION = '155.0-1';
  let consulted = false;
  const {restore} = stubFetch([
    [
      'repos/librewolf/bsys6/releases/latest',
      () => {
        consulted = true;
        return httpError(500);
      },
    ],
  ]);
  try {
    const resolved = await resolveBrowserVersion('librewolf');
    assert.equal(resolved.version, '155.0-1');
    assert.equal(resolved.source, 'pinned');
    assert.equal(consulted, false, 'a pin must short-circuit the chain entirely');
  } finally {
    if (prev === undefined) delete process.env.BROWSER_PIN_VERSION;
    else process.env.BROWSER_PIN_VERSION = prev;
    restore();
  }
});

test('resolveInstallerUrl: official mirror wins and carries the sha256 sum URL', async () => {
  resetCiDownloadsProbe();
  const {restore} = stubFetch([
    ['repos/librewolf/bsys6/releases/latest', () => okJson({tag_name: '155.0-1', assets: []})],
    [/librewolf\.dev.*setup\.exe$/, u => ({ok: true, status: 200, url: u})],
    [/releases\/tags/, () => httpError(404)],
  ]);
  try {
    const resolved = await resolveInstallerUrl('librewolf', {version: '155.0-1'});
    assert.match(resolved.url, /^https:\/\/librewolf\.dev\//);
    assert.equal(resolved.source, 'official');
    assert.match(resolved.sha256Url, /dl\.librewolf\.net.*\.sha256sum$/);
  } finally {
    restore();
  }
});

test('resolveInstallerUrl: throws when every source is down', async () => {
  resetCiDownloadsProbe();
  const {restore} = stubFetch([
    [
      /codeberg\.org|librewolf\.dev|dl\.librewolf\.net|librewolf-\d/,
      () => ({ok: false, status: 404}),
    ],
    ['releases/tags/ci-downloads', () => httpError(404)],
  ]);
  try {
    // Pinned: this tests the installer-source chain, not the version chain.
    await assert.rejects(
      resolveInstallerUrl('librewolf', {version: '155.0-1'}),
      /no installer source answered/
    );
  } finally {
    restore();
  }
});

// ── verifySha256 ─────────────────────────────────────────────────────────────

test('verifySha256: accepts a matching vendor sum and rejects a mismatch', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sha-test-'));
  try {
    const file = path.join(tmp, 'installer.exe');
    fs.writeFileSync(file, 'payload');
    // sha256('payload') — the resolver recomputes it, so the vector must be exact.
    const sha = '239f59ed55e737c77147cf55ad0c1b030b6d7ee748a7426952f9b852d5a935e5';
    const {restore} = stubFetch([['sha256sum', () => okText(`${sha}  installer.exe`)]]);
    try {
      const verified = await verifySha256(file, 'https://x/installer.exe.sha256sum');
      assert.equal(verified, sha);
      // Mismatch: serve a wrong sum.
      globalThis.fetch = async () => okText('deadbeef  installer.exe');
      await assert.rejects(
        verifySha256(file, 'https://x/installer.exe.sha256sum'),
        /sha256 mismatch/
      );
    } finally {
      restore();
    }
  } finally {
    fs.rmSync(tmp, {recursive: true, force: true});
  }
});
