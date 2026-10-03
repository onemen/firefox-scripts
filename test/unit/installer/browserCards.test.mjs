// test/unit/installer/browserCards.test.mjs — the installer tab's browser
// cards: what the user is told about each package.
//
// The cards are the product's main screen and the most branch-heavy code in the
// tab, and nothing covered them: componentStatus()/groupHeaderStatus()
// (10-ingest.js) turn five server booleans into four states, and 30-render.js
// renders those states into a collapsed group badge, a per-package row badge and
// the set of install checkboxes.  The e2e suite drives the HTTP API and asserts
// on element ids, so a transposed config/utils label — or a group badge that
// contradicts its own rows — passed CI silently.
//
// The cases below drive the real fragments through the shared harness
// (test/shared/webUiSandbox.mjs), whose DOM is the shipped installer/web/
// index.html, so `.browser-card[data-binary-key="…"]` and `.chk-config` resolve
// exactly as they do in the tab.

import {test} from 'node:test';
import assert from 'node:assert/strict';

import {loadWebUi, jsonResponse, rawResponse} from '../../shared/webUiSandbox.mjs';

const FIREFOX_BIN = 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';
const FX_ZIP = 'https://example.test/fx-folder.zip';
const UTILS_ZIP = 'https://example.test/utils.zip';
const UI_ZIP = 'https://example.test/updater-ui.zip';
const HASHES = 'https://example.test/hashes.json';

/** The sanitized key 30-render.js stores / 40-install.js looks a card up by. */
const FIREFOX_KEY = 'C__Program_Files_Mozilla_Firefox_firefox_exe';

/** A detected browser/profile; only the five status booleans vary per case. */
function browser(overrides = {}) {
  return {
    index: 0,
    name: 'Firefox',
    version: '142.0',
    exe: FIREFOX_BIN,
    binaryPath: FIREFOX_BIN,
    profilePath: 'C:\\Users\\me\\AppData\\Roaming\\Mozilla\\Firefox\\Profiles\\abc.default',
    configInstalled: 1,
    utilsInstalled: 1,
    hashCheckOk: 1,
    configUpToDate: 1,
    utilsUpToDate: 1,
    ...overrides,
  };
}

/**
 * Boot the tab with `browsers` as the local detection snapshot, with every
 * remote ingest surface stubbed so the cards render (a failed package fetch
 * hides them behind the network-error banner instead).
 */
async function bootTab(browsers) {
  const ui = loadWebUi({
    routes: {
      '/api/ping': () => jsonResponse({ok: true}),
      '/api/build-info': () =>
        jsonResponse({selfUpdateDisabled: true, isLocal: false, isDev: false}),
      '/api/browsers': () => jsonResponse(browsers),
      '/api/package-urls': () =>
        jsonResponse({
          fxFolderUrl: FX_ZIP,
          utilsUrl: UTILS_ZIP,
          updaterUiUrl: UI_ZIP,
          hashesUrl: HASHES,
        }),
      [FX_ZIP]: () => rawResponse('PK fx'),
      [UTILS_ZIP]: () => rawResponse('PK utils'),
      [UI_ZIP]: () => rawResponse('PK ui'),
      [HASHES]: () => rawResponse('{"files":{}}'),
      '/api/upload?kind=config': () => jsonResponse({ok: true}),
      '/api/upload?kind=utils': () => jsonResponse({ok: true}),
      '/api/upload?kind=ui': () => jsonResponse({ok: true}),
      '/api/manifest': () => jsonResponse({ok: true}),
      '/api/waterfox': () => jsonResponse({ok: true}),
    },
  });
  ui.fireDOMContentLoaded();
  await ui.settle();
  return ui;
}

/** The card, found the way 40-install.js finds it. */
const cardOf = ui => ui.find('.browser-card[data-binary-key="' + FIREFOX_KEY + '"]');
const headerBadge = ui => ui.text(cardOf(ui).querySelector('.card-status-badge'));
const configBadge = ui => ui.text(cardOf(ui).querySelector('.component-status-cell > span'));
const utilsBadge = (ui, index = 0) => ui.text(ui.element('badge-utils-' + index));

test('a fresh install reads All Up To Date on the card and on both rows', async () => {
  const ui = await bootTab([browser()]);

  assert.equal(headerBadge(ui), 'All Up To Date');
  assert.equal(configBadge(ui), 'config.js: Up To Date');
  assert.equal(utilsBadge(ui), 'utils: Up To Date');
  // Nothing to install, so nothing is offered and nothing is actionable.
  assert.deepEqual(
    cardOf(ui)
      .querySelectorAll('.chk-component')
      .map(c => c.getAttribute('id')),
    [],
    'no checkboxes when both packages match'
  );
  assert.equal(cardOf(ui).querySelector('.btn-action').disabled, true, 'Install stays disabled');
});

test('a stale package makes the card Update Available and offers exactly that package', async () => {
  const ui = await bootTab([browser({utilsUpToDate: 0})]);

  assert.equal(headerBadge(ui), 'Update Available');
  // The row badges must agree with the header and name the RIGHT package:
  // this is the transposition the whole grouping exists to prevent.
  assert.equal(configBadge(ui), 'config.js: Up To Date', 'config.js is fine');
  assert.equal(utilsBadge(ui), 'utils: Update Available', 'utils is the stale one');

  const boxes = cardOf(ui).querySelectorAll('.chk-component');
  assert.equal(boxes.length, 1, 'only the stale package is selectable');
  assert.equal(boxes[0].getAttribute('id'), 'chk-utils-0');
  assert.equal(boxes[0].getAttribute('data-component'), 'utils');
  assert.equal(boxes[0].getAttribute('data-browser'), '0');
  // The card stays expanded: a pending update must not be hidden behind a
  // collapsed "all good" header.
  assert.equal(cardOf(ui).classList.contains('card-collapsed'), false);
});

test('a missing package reads Not Installed on the card and offers both packages', async () => {
  const ui = await bootTab([browser({configInstalled: 0})]);

  assert.equal(headerBadge(ui), 'Not Installed');
  assert.equal(configBadge(ui), 'config.js: Not Installed');
  assert.equal(utilsBadge(ui), 'utils: Up To Date', 'the installed package is still fine');

  const boxes = cardOf(ui).querySelectorAll('.chk-component');
  assert.equal(boxes.length, 1, 'only the missing package needs installing');
  assert.equal(boxes[0].classList.contains('chk-config'), true);
});

test('an unverified hash manifest reads Checking, never Up To Date', async () => {
  // Without the manifest the tab cannot claim the files match, so it must not
  // show a green badge — `componentStatus` returns 'checking' before it looks
  // at the up-to-date flags at all.
  const ui = await bootTab([browser({hashCheckOk: 0, configUpToDate: 0, utilsUpToDate: 0})]);

  assert.equal(headerBadge(ui), 'Checking...');
  assert.equal(configBadge(ui), 'config.js: Checking...');
  assert.equal(utilsBadge(ui), 'utils: Checking...');
  assert.deepEqual(cardOf(ui).querySelectorAll('.chk-component'), [], 'nothing selectable yet');
});

test('an available update outranks a missing package on the card badge', async () => {
  // The header badge summarizes the worst ACTIONABLE state: one package has an
  // update the user can act on, so "Not Installed" would understate the card.
  // groupHeaderStatus's precedence is update > missing > checking > ok, and
  // nothing else pins it.
  const ui = await bootTab([browser({configInstalled: 0, utilsUpToDate: 0})]);

  assert.equal(headerBadge(ui), 'Update Available');
  assert.equal(configBadge(ui), 'config.js: Not Installed');
  assert.equal(utilsBadge(ui), 'utils: Update Available');
});

test('the success banner appears only when every package matches, as a direct child', async () => {
  const fresh = await bootTab([browser()]);
  const banner = fresh.element('browser-list').querySelectorAll(':scope > .success-banner');
  assert.equal(banner.length, 1, 'all up to date');
  assert.match(fresh.text(banner[0]), /all active browsers and profiles are up-to-date/);

  const stale = await bootTab([browser({utilsUpToDate: 0})]);
  assert.deepEqual(
    stale.element('browser-list').querySelectorAll(':scope > .success-banner'),
    [],
    'no banner while work is outstanding'
  );
});

test('one card per binary, with a utils badge per profile', async () => {
  const ui = await bootTab([
    browser(),
    browser({
      index: 1,
      profilePath: 'C:\\Users\\me\\AppData\\Roaming\\Mozilla\\Firefox\\Profiles\\xyz.dev-edition',
      utilsUpToDate: 0,
    }),
  ]);

  assert.equal(ui.findAll('.browser-card').length, 1, 'same binary, one card');
  // The group badge folds over EVERY profile of the binary, not just the first:
  // a stale second profile must not hide behind an up-to-date first one.
  assert.equal(headerBadge(ui), 'Update Available');
  // config.js lives in the shared binary dir, so it is reported once per card…
  assert.equal(cardOf(ui).querySelectorAll('.component-status-cell').length, 1);
  // …while utils is per profile, and each badge is keyed by the browser index
  // the install path reads back with qs('chk-utils-' + b.index).
  assert.equal(utilsBadge(ui, 0), 'utils: Up To Date');
  assert.equal(utilsBadge(ui, 1), 'utils: Update Available');
  assert.deepEqual(
    cardOf(ui)
      .querySelectorAll('.chk-component')
      .map(c => c.getAttribute('id')),
    ['chk-utils-1'],
    'only the stale profile is selectable, and its id matches its index'
  );
});

test('config is offered once per card, however many profiles need it', async () => {
  // startGroupInstall reads the FIRST `.chk-config` on the card
  // (40-install.js:21) but only ever installs config for idx === 0, so that is
  // correct as long as a card renders exactly ONE config checkbox.  It does:
  // config.js lives in the shared binary dir, so setConfigStatus runs once, on
  // the binary row, from group.browsers[0] — the profile rows carry utils
  // badges only.
  //
  // This case exists because the N-checkboxes-one-read shape is a real trap:
  // if config status ever moved onto the per-profile rows, every profile would
  // render a checkbox, the user could tick all three, and two of them would do
  // nothing at all — silently. Pin the count so that refactor has to break this.
  const ui = await bootTab([
    browser({configUpToDate: 0}),
    browser({index: 1, profilePath: 'C:\\Users\\me\\profile-two', configUpToDate: 0}),
    browser({index: 2, profilePath: 'C:\\Users\\me\\profile-three', configUpToDate: 0}),
  ]);
  const card = cardOf(ui);
  const configBoxes = card.querySelectorAll('.chk-config');

  assert.equal(configBoxes.length, 1, 'one config checkbox for the whole binary');
  assert.equal(
    card.querySelectorAll('.component-status-cell').length,
    1,
    'config status on the binary row'
  );
  assert.deepEqual(
    configBoxes.map(c => c.getAttribute('data-group')),
    [FIREFOX_BIN],
    'and it names the binary it belongs to'
  );
  assert.equal(
    ui.text(card.querySelector('.component-status-cell > span')),
    'config.js: Update Available'
  );
});

test('a group badge is the worst of its own rows', async () => {
  // The header and the rows are rendered by different code from the same
  // helpers; if they ever disagree the user sees a green card with a red row.
  const cases = [
    {overrides: {}, header: 'All Up To Date'},
    {overrides: {utilsUpToDate: 0}, header: 'Update Available'},
    {overrides: {configInstalled: 0}, header: 'Not Installed'},
    {overrides: {hashCheckOk: 0}, header: 'Checking...'},
    {overrides: {utilsInstalled: 0, configUpToDate: 0}, header: 'Update Available'},
  ];
  for (const {overrides, header} of cases) {
    const ui = await bootTab([browser(overrides)]);
    assert.equal(headerBadge(ui), header, JSON.stringify(overrides));
    const rows = [configBadge(ui), utilsBadge(ui)];
    const rowHeader =
      rows.some(r => r.includes('Update Available')) ? 'Update Available'
      : rows.some(r => r.includes('Not Installed')) ? 'Not Installed'
      : rows.every(r => r.includes('Checking')) ? 'Checking...'
      : 'All Up To Date';
    assert.equal(rowHeader, header, 'header agrees with its rows: ' + JSON.stringify(overrides));
  }
});

test('the Install button unlocks only once a package is checked', async () => {
  // Strict gating (#180 follow-up): the checked set is the install set, so a
  // button that enables itself would install something the user never picked.
  const ui = await bootTab([browser({configInstalled: 0, utilsUpToDate: 0})]);
  const card = cardOf(ui);
  const btn = card.querySelector('.btn-action');
  const boxes = card.querySelectorAll('.chk-component');

  assert.equal(btn.disabled, true, 'nothing checked yet');
  assert.equal(boxes.length, 2, 'both packages need work');

  boxes[0].checked = true;
  boxes[0].dispatch('change', {target: boxes[0]});
  assert.equal(btn.disabled, false, 'one check unlocks Install');

  boxes[0].checked = false;
  boxes[1].checked = false;
  boxes[1].dispatch('change', {target: boxes[1]});
  assert.equal(btn.disabled, true, 'unchecking re-locks it');
});

test('the open-folder buttons carry the index and kind the server needs', async () => {
  // The buttons are built as an innerHTML string, so this also proves the
  // harness parses injected markup rather than storing an opaque string — the
  // delegated listener reads these attributes off the real node.
  const ui = await bootTab([
    browser(),
    browser({index: 1, profilePath: 'C:\\Users\\me\\profile-two'}),
  ]);
  ui.route('/api/open-folder?browser=1&kind=profile', () => jsonResponse({ok: true}));

  const card = cardOf(ui);
  const buttons = card.querySelectorAll('.btn-open-folder');
  assert.equal(buttons.length, 3, 'one per binary plus one per profile');
  assert.deepEqual(
    buttons.map(b => b.getAttribute('data-kind')),
    ['binary', 'profile', 'profile']
  );
  assert.deepEqual(
    buttons.map(b => b.getAttribute('data-browser')),
    ['0', '0', '1']
  );

  ui.fireDocument('click', {target: buttons[2], preventDefault() {}});
  await ui.settle();
  assert.ok(
    ui.fetches.some(f => f.url === '/api/open-folder?browser=1&kind=profile'),
    'the delegated handler resolved the button through closest()'
  );
});

test('the tab never asks for an element the shipped markup lacks', async () => {
  // The drift guard: every getElementById the fragments make must resolve in
  // installer/web/index.html, or a guard that reads `if (!el) return` is
  // silently doing nothing in production too.
  const ui = await bootTab([browser({utilsUpToDate: 0})]);
  assert.deepEqual(ui.missingIds, []);
});
