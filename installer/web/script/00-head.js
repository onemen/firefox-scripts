// Firefox Scripts Installer — Web UI (v005 design + multi-profile)
(function () {
  'use strict';

  /* ========================================================================
     Debug helpers — surface any JS error in the UI itself
     ======================================================================== */
  let debugEl = null;
  function ensureDebugEl() {
    if (debugEl && document.body && document.body.contains(debugEl)) return debugEl;
    const app = document.querySelector('.app-container');
    if (!app) return null;
    debugEl = document.createElement('div');
    debugEl.id = 'debug-banner';
    debugEl.style.cssText =
      'position:fixed;top:0;left:0;right:0;z-index:99999;' +
      'background:#b91c1c;color:#fff;font:12px/1.4 monospace;' +
      'padding:6px 12px;display:none;white-space:pre-wrap;';
    app.parentNode.appendChild(debugEl);
    return debugEl;
  }
  function showDebug(msg) {
    const el = ensureDebugEl();
    if (el) {
      el.textContent = String(msg);
      el.style.display = 'block';
    }
    console.error('[install] ' + msg);
  }
  window.onerror = function (msg, src, line, col) {
    showDebug('JS ERROR: ' + msg + ' (' + src + ':' + line + ':' + col + ')');
  };

  /* ========================================================================
     Browser logos — official brand PNGs served by the installer at
     /logos/<type>.png (embedded via embed.mjs; same files shipped to the
     updater's chrome://firefox-scripts/content/logos/).
     ======================================================================== */
  const LOGOS = {
    zen: '/logos/zen.png',
    firefox: '/logos/firefox.png',
    waterfox: '/logos/waterfox.png',
    librewolf: '/logos/librewolf.png',
    floorp: '/logos/floorp.png',
  };

  const DEFAULT_LOGO = '/logos/firefox.png';

  const GREEN_CHECK = [
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"',
    '  stroke-linecap="round" stroke-linejoin="round">',
    '<polyline points="20 6 9 17 4 12"/></svg>',
  ].join('');

  const RED_X = [
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"',
    '  stroke-linecap="round" stroke-linejoin="round">',
    '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  ].join('');

  const YELLOW_DOT = [
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#eab308" stroke-width="3"',
    '  stroke-linecap="round" stroke-linejoin="round">',
    '<circle cx="12" cy="12" r="6"/></svg>',
  ].join('');

  const INSTALL_ICON = [
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">',
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>',
    '<polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
  ].join('');

  const RESTART_ICON = [
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">',
    '<path d="M1 4v6h6"/>',
    '<path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>',
  ].join('');

  // Chevron for collapsing/expanding up-to-date cards (rotated 90deg via CSS
  // when the card is expanded, pointing down instead of right).
  const CHEVRON_ICON = [
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"',
    '  stroke-linecap="round" stroke-linejoin="round">',
    '<polyline points="9 18 15 12 9 6"/></svg>',
  ].join('');

  const CHECKING_ICON = [
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"',
    '  stroke-linecap="round" stroke-linejoin="round">',
    '<circle cx="12" cy="12" r="6"/></svg>',
  ].join('');

  const FOLDER_ICON = [
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"',
    '  stroke-linecap="round" stroke-linejoin="round">',
    '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
  ].join('');

  /* ========================================================================
     State
     ======================================================================== */
  let browsers = []; // flat browser list from API
  let groups = []; // grouped by binaryPath
  let polling = false;
  let installQueue = []; // queue of profile indices for group install
  const installedGroups = {}; // binaryPath -> true; groups with a completed install this session
  const restartedGroups = {}; // binaryPath -> true; groups whose Restart was clicked (re-enabled on next install)
  const expandedCards = {}; // binaryKey -> true; up-to-date cards the user manually expanded

