// test/unit/installer/selfUpdateBanner.test.mjs — the installer self-update
// banner: its FALLBACK destination, and which ingest surface it trusts.
//
// Fallback destination: the banner's normal branch downloads data.downloadUrl
// (an asset URL from the managed "download" map).  When a newer publish carries
// no download entry for THIS platform, installer/src/self_update.c still reports
// updateAvailable with an empty download_url, and the tab opens a human-facing
// page instead.  That page must be the permanently-named `latest` release: the
// rolling /releases listing can be topped by a dated component release
// (scripts-<date>) that carries no installer asset, leaving the user to hunt
// for the binary.
//
// Ingest surface: fetchRaw resolves an ArrayBuffer, so passing it straight
// to the mechanismSince gate would make JSON.parse throw on every payload
// ("[object ArrayBuffer]"), the catch would turn that into "not post-cutover",
// and every post-cutover binary would silently fall through to the legacy
// release-body flow. The banner keeps working, which is exactly why it would
// go unnoticed — so these cases assert WHICH surface was ingested, not just
// that a banner showed.
//
// The tab's JS only runs inside the shipped IIFE, so the cases drive the real
// fragments through the shared harness (test/shared/webUiSandbox.mjs).  Pure
// Node — no compiler, no built binary (this belongs to `pnpm test`, not
// `pnpm test:hash`; see installer/test/README.md for the split).

import {test} from 'node:test';
import assert from 'node:assert/strict';

import {loadWebUi} from '../../shared/webUiSandbox.mjs';

const LATEST_RELEASE_URL = 'https://github.com/onemen/firefox-scripts/releases/tag/latest';
const PAGES_PAYLOAD_URL = 'https://onemen.github.io/firefox-scripts/self-update.json';
const RELEASES_URL = 'https://api.github.com/repos/onemen/firefox-scripts/releases?per_page=10';

/** The self-update verdict the C side reports for "newer build, no URL for us". */
const NO_URL_UPDATE_AVAILABLE = {
  updateAvailable: true,
  downloadUrl: '',
  buildDate: '2026-01-01',
  latestDate: '2026-10-01',
};

/**
 * Every endpoint a self-update check walks: build info, the package-url
 * descriptor (which carries BOTH ingest surfaces — the Pages payload and the
 * release listing), and the local endpoint the tab POSTs an ingest into and
 * GETs the C-side verdict from.
 *
 * @param {object} verdict body served by GET /api/self-update
 * @returns {Record<string, Function>} route table for loadWebUi
 */
function selfUpdateRoutes(verdict, buildInfo) {
  return {
    '/api/build-info': () => ({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          selfUpdateDisabled: false,
          buildDate: '2026-01-01',
          isLocal: false,
          ...buildInfo,
        }),
    }),
    '/api/package-urls': () => ({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({selfUpdatePagesUrl: PAGES_PAYLOAD_URL, releasesUrl: RELEASES_URL}),
    }),
    [PAGES_PAYLOAD_URL]: () => rawJson({mechanismSince: '2026-01-01', installerDate: '2026-10-01'}),
    [RELEASES_URL]: () =>
      rawJson({
        installerDate: '2026-10-01',
        download: {
          installer_win:
            'https://github.com/onemen/firefox-scripts/releases/download/latest/installer_win.exe',
        },
      }),
    // The tab checks the POST BODY's "ok" field (postRaw returns r.json()),
    // not the HTTP status.
    '/api/self-update': method => json(method === 'POST' ? {ok: true} : verdict),
  };
}

function json(body) {
  return {ok: true, status: 200, json: () => Promise.resolve(body)};
}

function rawJson(body) {
  return {
    ok: true,
    status: 200,
    arrayBuffer: () => Promise.resolve(new TextEncoder().encode(JSON.stringify(body)).buffer),
  };
}

test('self-update banner falls back to the latest release tag, not /releases', async () => {
  const ui = loadWebUi({routes: selfUpdateRoutes(NO_URL_UPDATE_AVAILABLE)});

  await ui.ctx.checkSelfUpdate();
  await ui.settle();

  assert.equal(
    ui.element('update-banner').style.display,
    'flex',
    'banner shown for an available update'
  );

  const button = ui.element('btn-self-update');
  assert.ok(button && typeof button.onclick === 'function', 'update button wired up');

  button.onclick();

  assert.equal(ui.opened.length, 1, 'exactly one page opened');
  assert.equal(ui.opened[0].url, LATEST_RELEASE_URL);
  assert.equal(ui.opened[0].target, '_blank');
  assert.equal(ui.opened[0].features, 'noopener');
});

test('self-update banner still downloads the asset when a download URL is present', async () => {
  const assetUrl =
    'https://github.com/onemen/firefox-scripts/releases/download/latest/installer_win.exe';
  const ui = loadWebUi({
    routes: selfUpdateRoutes({...NO_URL_UPDATE_AVAILABLE, downloadUrl: assetUrl}),
  });

  await ui.ctx.checkSelfUpdate();
  await ui.settle();

  ui.element('btn-self-update').onclick();

  assert.deepEqual(ui.downloads, [{href: assetUrl, download: ''}]);
  assert.ok(
    !ui.opened.some(o => String(o.url).includes('/releases/tag/')),
    'the normal branch never opens a release page'
  );
});

test('self-update banner stays hidden when self-update is disabled', async () => {
  const ui = loadWebUi({
    routes: {
      '/api/build-info': () =>
        json({selfUpdateDisabled: true, isLocal: true, buildDate: '2026-01-01'}),
    },
  });

  await ui.ctx.checkSelfUpdate();
  await ui.settle();

  // checkSelfUpdate returns before wiring anything on a disabled build, so the
  // button has no handler and the banner stays hidden (both elements exist in
  // the shipped markup).
  assert.equal(ui.element('btn-self-update').onclick, null, 'no button handler');
  assert.deepEqual(ui.opened, [], 'nothing opened');
});

test('a post-cutover build ingests the Pages payload, not the legacy release body', async () => {
  // issue #401. fetchRaw hands back an ArrayBuffer; the mechanismSince gate
  // needs text. With the buffer passed through, JSON.parse threw on every
  // payload, the catch reported "not post-cutover", and the tab fell through
  // to the legacy flow — so the assertion that matters is that the releases
  // listing is NEVER fetched for a post-cutover build.
  const ui = loadWebUi({routes: selfUpdateRoutes(NO_URL_UPDATE_AVAILABLE)});

  await ui.ctx.checkSelfUpdate();
  await ui.settle();

  assert.ok(
    ui.fetches.some(f => f.url === PAGES_PAYLOAD_URL),
    'the Pages payload was fetched'
  );
  assert.ok(
    ui.fetches.some(f => f.url === '/api/self-update' && f.method === 'POST'),
    'and POSTed to the local endpoint, so the managed payload is the one in force'
  );
  assert.ok(
    !ui.fetches.some(f => f.url === RELEASES_URL),
    'the legacy release-body fallback must not be fetched for a post-cutover build'
  );
});

test('a pre-cutover build still takes the legacy release-body flow', async () => {
  // The other half of the gate: buildDate < mechanismSince must NOT trust the
  // Pages payload, or pre-cutover binaries would stop reading release bodies
  // that still carry the managed block.
  const ui = loadWebUi({
    routes: {
      ...selfUpdateRoutes(NO_URL_UPDATE_AVAILABLE, {
        selfUpdateDisabled: false,
        buildDate: '2025-12-01',
        isLocal: false,
      }),
      [PAGES_PAYLOAD_URL]: () =>
        rawJson({mechanismSince: '2026-09-29', installerDate: '2026-10-01'}),
    },
  });

  await ui.ctx.checkSelfUpdate();
  await ui.settle();

  assert.ok(
    ui.fetches.some(f => f.url === RELEASES_URL),
    'an older binary falls back to the release listing'
  );
});

test('a payload without mechanismSince is treated as pre-cutover', async () => {
  // A managed body with no cutover marker must not be trusted as the Pages
  // surface; the tab falls back exactly as it did before #341.
  const ui = loadWebUi({
    routes: {
      ...selfUpdateRoutes(NO_URL_UPDATE_AVAILABLE),
      [PAGES_PAYLOAD_URL]: () => rawJson({installerDate: '2026-10-01'}),
    },
  });

  await ui.ctx.checkSelfUpdate();
  await ui.settle();

  assert.ok(
    ui.fetches.some(f => f.url === RELEASES_URL),
    'no cutover marker means the legacy flow'
  );
});
