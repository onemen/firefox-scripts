// test/unit/installer/buildBanner.test.mjs — the "⚠ Test build" banner.
//
// showBuildBanner() (20-banners.js) reads /api/build-info and, for a local or
// dev build, reveals #build-banner with one line saying WHICH build is running:
// the snapshot directory for a local test build, the artifact branch for a dev
// build.  It is the only thing telling a tester that the installer in front of
// them is not the published one, so a wrong label (or a banner that shows up on
// a prod build) sends someone debugging the wrong binary.
//
// /api/build-info's isLocal / isDev / distPath / devBranch are baked by the C
// side from INSTALLER_LOCAL / INSTALLER_DEV (installer/src/platform.h), so the
// cases here pin the tab's half of that contract.

import {test} from 'node:test';
import assert from 'node:assert/strict';

import {loadWebUi, jsonResponse} from '../../shared/webUiSandbox.mjs';

function json(body) {
  return jsonResponse(body);
}

/** Boot the tab on a build whose /api/build-info is `info`. */
async function bootTab(info) {
  const ui = loadWebUi({
    routes: {
      '/api/ping': () => json({ok: true}),
      '/api/browsers': () => json([]),
      '/api/package-urls': () => json({error: 'no packages'}),
      '/api/build-info': () => json(info),
    },
  });
  ui.fireDOMContentLoaded();
  await ui.settle();
  return ui;
}

test('a local test build names the snapshot it serves from', async () => {
  const ui = await bootTab({
    isLocal: true,
    isDev: false,
    selfUpdateDisabled: true,
    distPath: 'C:/code/firefox-scripts/dist/local-main-abc1234',
    buildDate: '2026-10-01',
  });

  const banner = ui.element('build-banner');
  assert.equal(banner.hidden, false, 'banner revealed');
  assert.equal(
    ui.element('build-banner-detail').textContent,
    'Local test build — Files are served from the local snapshot: ' +
      'C:/code/firefox-scripts/dist/local-main-abc1234'
  );
});

test('a dev build names the artifact branch', async () => {
  const ui = await bootTab({
    isLocal: false,
    isDev: true,
    selfUpdateDisabled: true,
    devBranch: 'dev-build-1738',
    buildDate: '2026-10-01',
  });

  assert.equal(ui.element('build-banner').hidden, false, 'banner revealed');
  assert.equal(
    ui.element('build-banner-detail').textContent,
    'Development build — Artifacts are on the dev-build-1738 branch.'
  );
});

test('a prod build shows no banner', async () => {
  const ui = await bootTab({
    isLocal: false,
    isDev: false,
    selfUpdateDisabled: false,
    buildDate: '2026-10-01',
  });

  // The banner element exists in the shipped markup with `hidden`, and the tab
  // must leave it that way: the user-visible claim, independent of which
  // getElementById calls the code happens to make.
  assert.equal(ui.element('build-banner').hidden, true, 'banner stays hidden');
  assert.equal(ui.element('build-banner-detail').textContent, '', 'no detail line');
});

test('local wins over dev: a local build is labelled by its snapshot', async () => {
  // --local snapshots are built from a dev-shaped tree in some flows; the label
  // must describe what actually serves the files.
  const ui = await bootTab({
    isLocal: true,
    isDev: true,
    selfUpdateDisabled: true,
    distPath: 'C:/snapshots/local-x',
    devBranch: 'dev-build-1738',
    buildDate: '2026-10-01',
  });

  assert.match(ui.element('build-banner-detail').textContent, /^Local test build — /);
});
