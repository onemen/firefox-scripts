'use strict';

/**
 * Firefox Scripts - Updater Tab UI (client side)
 *
 * Runs inside chrome://firefox-scripts/content/ui/updater.html (shipped in
 * updater-ui.zip, installed into the profile's chrome/utils/updater/ui/). This
 * document is chrome-privileged and the privileged engine — updater.js, loaded
 * before this file — exposes itself as window.UpdaterEngine. This script
 * renders engine state and forwards user actions as direct engine calls; there
 * is no remote page, no iframe and no postMessage bridge.
 *
 * State flow: UpdaterEngine.init() performs tab plumbing and a fresh hash check
 * (so restored tabs and direct chrome:// visits show the truth, never a stale
 * snapshot), then calls onState with the snapshot; every engine action pushes a
 * new state and install flows push progress via onProgress.
 */

/* global UpdaterEngine */ // defined by updater.js, loaded before this file

const $ = id => document.getElementById(id);

let state = null; // last full state from the engine (null = not received yet)

/* ---------------- helpers ---------------- */

function logoUrl(brand) {
  // Brand is mapped by the engine (brandLogoName); fall back to Firefox.
  return `logos/${brand || 'firefox'}.png`;
}

/** @param {string} dateStr - "YYYY-MM-DD" */
function formatScriptsDate(dateStr) {
  if (!dateStr) {
    return '';
  }
  const parts = dateStr.split('-');
  if (parts.length !== 3) {
    return '';
  }
  const date = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/* ---------------- rendering ---------------- */

function render() {
  if (!state) {
    return;
  }
  const s = state;

  // Reveal the card as a single unit on the first state render: the card is
  // hidden in CSS until .revealed, so there is no header-then-rows flash while
  // the engine's hash check is in flight.
  const list = document.querySelector('.browser-list');
  if (list) {
    list.classList.add('revealed');
  }

  // Browser identity card.
  $('card-title').textContent = s.appName || 'Firefox';
  $('card-version').textContent = s.appVersion || '';
  $('card-logo').src = logoUrl(s.brand);
  $('binary-path').textContent = s.binaryPath || '';
  $('profile-path').textContent = s.profilePath || '';

  const pkgs = [
    ['config', s.packages && s.packages.config],
    ['utils', s.packages && s.packages.utils],
  ];
  const anyNeeded = pkgs.some(([, p]) => p && p.updateNeeded);

  $('success-banner').hidden = anyNeeded;
  $('btn-remind-tomorrow').hidden = !anyNeeded;

  for (const [kind, p] of pkgs) {
    const pending = Boolean(p && p.updateNeeded);
    $(`${kind}-badge-update`).hidden = !pending;
    $(`${kind}-badge-ok`).hidden = pending;
    const select = $('chk-' + kind);
    if (select && !pending) {
      select.checked = false;
    }
    const skip = $(`skip-${kind}`);
    if (skip) {
      skip.hidden = !pending;
      const input = $(`skip-${kind}-input`);
      if (input) {
        input.checked = Boolean(p && p.skipped);
        input.disabled = Boolean(s.installing);
      }
    }
  }

  // Snap scenario (config can't be installed in-tab): hide the config install
  // checkbox (the Update button then only ever installs utils) and surface the
  // amber manual-install band between the two rows instead.
  const cfgPkg = s.packages && s.packages.config;
  const cfgManual = Boolean(cfgPkg && cfgPkg.updateNeeded && cfgPkg.manualInstall);
  const chkConfig = $('chk-config');
  if (chkConfig) {
    chkConfig.hidden = cfgManual;
    if (cfgManual) {
      chkConfig.checked = false;
    }
  }
  $('config-manual').hidden = !cfgManual;
  $('manual-installer').href = s.installerUrl || '#';

  // Manual download links: show the real zip URLs (they end with
  // fx-folder.zip / utils.zip, or the -dev names in dev builds) exactly like
  // the installer's links; clicks are forwarded to the engine (it fetches and
  // serves the zip) so the updater tab is never navigated.
  $('link-download-fx').href = s.fxFolderUrl || '#';
  $('link-download-utils').href = s.utilsUrl || '#';
  $('fx-download-date').textContent = formatScriptsDate(
    s.packages && s.packages.config && s.packages.config.date
  );
  $('utils-download-date').textContent = formatScriptsDate(
    s.packages && s.packages.utils && s.packages.utils.date
  );

  // Buttons.
  $('btn-restart').disabled = !(s.restartEnabled && !s.installing);
  updateInstallButton();

  if (!s.installing) {
    hideProgress();
  }
}

/** Update button enabled only while at least one checkbox is checked. */
function updateInstallButton() {
  const installing = Boolean(state && state.installing);
  const anyChecked = document.querySelectorAll('.chk-component:checked').length > 0;
  // install is the only place the flow may run; while it runs keep it disabled.
  $('btn-install').disabled = installing || !anyChecked;
}

/** Progress bar is driven by progress messages, not by the full state. */
function showProgress(pct, text, error) {
  const bar = $('card-progress');
  bar.hidden = false;
  $('card-progress-fill').style.width = `${pct}%`;
  $('card-progress-step').textContent = text || '';
  $('card-progress-percent').textContent = `${pct}%`;
  const err = $('card-progress-error');
  err.style.display = error ? 'block' : 'none';
  if (error) {
    err.textContent = error;
  }
}

function hideProgress() {
  $('card-progress').hidden = true;
  $('card-progress-error').style.display = 'none';
}

/* ---------------- events ---------------- */

function bindEvents() {
  $('btn-close').addEventListener('click', () => UpdaterEngine.close());

  $('btn-install').addEventListener('click', () => {
    const kinds = [...document.querySelectorAll('.chk-component:checked')].map(
      el => el.dataset.kind
    );
    if (kinds.length > 0) {
      UpdaterEngine.install(kinds);
    }
  });

  $('btn-restart').addEventListener('click', () => UpdaterEngine.restart());

  $('btn-remind-tomorrow').addEventListener('click', () => UpdaterEngine.remind());

  // Per-package "Don't show again for this update" checkboxes.
  document.addEventListener('change', event => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) {
      return;
    }
    if (input.classList.contains('chk-component')) {
      updateInstallButton();
      return;
    }
    const kind = input.dataset.skip; // 'config' | 'utils'
    if (!kind) {
      return;
    }
    UpdaterEngine.setSkip(kind, input.checked);
  });

  // Manual download links — the engine fetches the zip and hands it to the
  // browser via a blob URL + save dialog, so this tab is never navigated away.
  const bindDownload = (linkId, kind) => {
    const link = $(linkId);
    if (link) {
      link.addEventListener('click', event => {
        event.preventDefault();
        UpdaterEngine.download(kind);
      });
    }
  };
  bindDownload('link-download-fx', 'config');
  bindDownload('link-download-utils', 'utils');

  // Open-folder buttons (binary dir + profile dir).
  const bindOpenFolder = (id, kind) => {
    const el = $(id);
    if (el) {
      el.addEventListener('click', event => {
        event.preventDefault();
        UpdaterEngine.revealFolder(kind);
      });
    }
  };
  bindOpenFolder('btn-open-folder-binary', 'binary');
  bindOpenFolder('btn-open-folder-profile', 'profile');
  // Manual-install panel actions (Snap config): open the host config dir and
  // download the installer. "Download configuration files" reuses the zip
  // download bound above via kind 'config'.
  bindDownload('manual-download-config', 'config');
  bindDownload('manual-installer', 'installer');
  bindOpenFolder('manual-open-config', 'config');
}

/* ---------------- init ---------------- */

/** Reveal the test/dev build banner from the engine's generated config. */
function showBuildBanner() {
  const info = window.UpdaterEngine && window.UpdaterEngine.buildInfo;
  if (!info || (!info.isLocal && !info.isDev)) {
    return;
  }
  const banner = $('build-banner');
  const detail = $('build-banner-detail');
  if (!banner || !detail) {
    return;
  }
  const label = info.isLocal ? 'Local test build' : 'Development build';
  const source =
    info.isLocal ?
      'Files are read from the local snapshot: ' + info.distPath
    : 'Artifacts are on the ' + info.devBranch + ' branch.';
  detail.textContent = label + ' — ' + source;
  banner.hidden = false;
}

function init() {
  if (!window.UpdaterEngine) {
    // Engine missing (utils.zip absent): nothing the page can do — never spin
    // a blank card.
    document.body.textContent =
      'The updater engine could not be loaded. Reinstall the latest scripts.';
    return;
  }
  UpdaterEngine.onState = snapshot => {
    state = snapshot;
    render();
  };
  UpdaterEngine.onProgress = showProgress;
  bindEvents();
  showBuildBanner();
  UpdaterEngine.init();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
