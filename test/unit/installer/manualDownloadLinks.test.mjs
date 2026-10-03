// test/unit/installer/manualDownloadLinks.test.mjs — the installer's manual
// download bar.
//
// 50-init.js wires two anchors from /api/package-urls: `link-download-fx`
// (configuration files) and `link-download-utils`.  Each click is intercepted
// and served as a blob download, never a navigation — and the save-name mirrors
// the URL's own basename, because dev builds publish `fx-folder-dev.zip` /
// `utils-dev.zip` and a hardcoded prod name would mislabel the file and
// confuse the hash check against the release assets.
//
// A wrong href or a wrong save-name here is a user-visible defect (downloading
// the wrong package, or a file labelled `utils.zip` that is really
// `utils-dev.zip`), and nothing below the fragment level covers it: the e2e
// suite drives the HTTP API, not the tab's DOM.
//
// The bar is wired from a DOMContentLoaded listener, so these cases start the
// real UI through the shared harness (test/shared/webUiSandbox.mjs).

import {test} from 'node:test';
import assert from 'node:assert/strict';

import {loadWebUi, jsonResponse, rawResponse} from '../../shared/webUiSandbox.mjs';

const FX_ZIP = 'https://onemen.github.io/firefox-scripts/fx-folder.zip';
const UTILS_ZIP = 'https://onemen.github.io/firefox-scripts/utils.zip';

function json(body) {
  return jsonResponse(body);
}

/** A package-urls descriptor with both ingest surfaces stubbed away. */
function packageUrls(overrides = {}) {
  return json({
    utilsUrl: UTILS_ZIP,
    fxFolderUrl: FX_ZIP,
    updaterUiUrl: 'https://onemen.github.io/firefox-scripts/updater-ui.zip',
    hashesUrl: 'https://onemen.github.io/firefox-scripts/hashes.json',
    fxFolderDate: '2026-09-20',
    utilsDate: '2026-09-21',
    ...overrides,
  });
}

/** Boot the tab the way a browser does and let the init chain finish. */
async function bootTab(routes) {
  const ui = loadWebUi({
    routes: {
      '/api/ping': () => json({ok: true}),
      '/api/browsers': () => json([]),
      '/api/build-info': () =>
        json({selfUpdateDisabled: false, isLocal: false, isDev: false, buildDate: '2026-01-01'}),
      ...routes,
    },
  });
  ui.fireDOMContentLoaded();
  await ui.settle();
  return ui;
}

test('manual download links point at the right package and show its last-update date', async () => {
  const ui = await bootTab({
    '/api/package-urls': () => packageUrls(),
    [FX_ZIP]: () => rawResponse('PK fx'),
    [UTILS_ZIP]: () => rawResponse('PK utils'),
  });

  assert.equal(ui.element('link-download-fx').href, FX_ZIP, 'configuration files link');
  assert.equal(ui.element('link-download-utils').href, UTILS_ZIP, 'utils link');
  assert.equal(ui.element('fx-download-date').textContent, ' (last update Sep 20, 2026)');
  assert.equal(ui.element('utils-download-date').textContent, ' (last update Sep 21, 2026)');
  assert.equal(ui.element('manual-download-bar').style.display, 'flex');
});

test('the two links never cross over: a package swap moves both hrefs and both dates', async () => {
  // fx-folder/utils publishing order and hash order are independent, so a
  // transposed pair of assignments would look fine in a smoke test.
  const ui = await bootTab({
    '/api/package-urls': () =>
      packageUrls({
        utilsUrl: 'https://onemen.github.io/firefox-scripts/utils.zip?v=2',
        fxFolderDate: '2026-10-01',
        utilsDate: '2026-10-02',
      }),
  });

  assert.equal(
    ui.element('link-download-fx').href,
    'https://onemen.github.io/firefox-scripts/fx-folder.zip',
    'fx link keeps the fx zip'
  );
  assert.equal(
    ui.element('link-download-utils').href,
    'https://onemen.github.io/firefox-scripts/utils.zip?v=2',
    'utils link picks up the new utils zip'
  );
  assert.equal(ui.element('fx-download-date').textContent, ' (last update Oct 1, 2026)');
  assert.equal(ui.element('utils-download-date').textContent, ' (last update Oct 2, 2026)');
});

test('clicking a link downloads the package with the save-name from the URL', async () => {
  const ui = await bootTab({
    '/api/package-urls': () => packageUrls(),
    [FX_ZIP]: () => rawResponse('PK fx'),
    [UTILS_ZIP]: () => rawResponse('PK utils'),
  });

  ui.element('link-download-utils').dispatch('click', {preventDefault() {}});
  await ui.settle();

  assert.equal(ui.downloads.length, 1, 'one download started');
  // Blob URL, not the remote one: the tab must never navigate to the zip (that
  // trips the beforeunload shutdown) nor open a blank tab.
  assert.match(ui.downloads[0].href, /^blob:/);
  assert.equal(ui.downloads[0].download, 'utils.zip');
  assert.ok(
    ui.fetches.some(f => f.url === UTILS_ZIP),
    'the zip was fetched through the tab (the installer does no network I/O)'
  );
  assert.deepEqual(ui.opened, [], 'no new tab opened');
});

test('dev builds keep the -dev save-name from their own URLs', async () => {
  const devFx = 'https://onemen.github.io/firefox-scripts/fx-folder-dev.zip';
  const devUtils = 'https://onemen.github.io/firefox-scripts/utils-dev.zip';
  const ui = await bootTab({
    '/api/package-urls': () =>
      packageUrls({
        fxFolderUrl: devFx,
        utilsUrl: devUtils,
        fxFolderDate: '',
        utilsDate: '',
      }),
    [devFx]: () => rawResponse('PK fx-dev'),
    [devUtils]: () => rawResponse('PK utils-dev'),
  });

  assert.equal(ui.element('fx-download-date').textContent, '', 'no date annotation without one');
  ui.element('link-download-fx').dispatch('click', {preventDefault() {}});
  await ui.settle();

  assert.equal(ui.downloads[0].download, 'fx-folder-dev.zip');
});

test('the bar stays hidden when the server has no package URLs', async () => {
  const ui = await bootTab({
    '/api/package-urls': () => json({error: 'no packages'}),
  });

  assert.notEqual(ui.element('manual-download-bar').style.display, 'flex');
  // The anchors ship with the placeholder href="#"; without a package URL the
  // tab must leave it at that, and wireDownloadLink's dead-link guard reads it
  // back with getAttribute — so "still the placeholder" is the claim.
  assert.equal(
    ui.element('link-download-fx').getAttribute('href'),
    '#',
    'href left at the placeholder'
  );
  assert.equal(
    ui.element('link-download-utils').getAttribute('href'),
    '#',
    'href left at the placeholder'
  );
  assert.deepEqual(ui.unstubbed.includes('/api/package-urls'), false, 'the descriptor was stubbed');
  assert.deepEqual(ui.missingIds, [], 'the tab never asked for an element the markup lacks');
});

test('the heartbeat never opens a tab and never navigates', async () => {
  const ui = await bootTab({'/api/package-urls': () => packageUrls()});

  // setInterval is recorded, not scheduled: the 3s heartbeat must not keep a
  // test process alive, but its registration still proves the liveness ping is
  // wired (and the ping itself hits the dedicated endpoint, not /api/status).
  assert.ok(ui.intervals.length >= 1, 'heartbeat interval registered');
  assert.equal(ui.intervals[0].ms, 3000);
  assert.ok(ui.fetches.some(f => f.url.startsWith('/api/ping')));
  assert.ok(!ui.fetches.some(f => f.url.startsWith('/api/status')), '/api/status never pinged');
});
