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

  /* ========================================================================
     Utility
     ======================================================================== */
  function getLogo(type) {
    const t = (type || '').toLowerCase();
    return LOGOS[t] || DEFAULT_LOGO;
  }

  function logoImgMarkup(url) {
    return '<img class="browser-logo" src="' + escAttr(url) + '" alt="" />';
  }

  function detectType(name, exe) {
    const n = (name || exe || '').toLowerCase();
    if (n.indexOf('zen') !== -1) return 'zen';
    if (n.indexOf('waterfox') !== -1) return 'waterfox';
    if (n.indexOf('librewolf') !== -1) return 'librewolf';
    if (n.indexOf('floorp') !== -1) return 'floorp';
    if (n.indexOf('firefox') !== -1) return 'firefox';
    return 'default';
  }

  function qs(id) {
    return document.getElementById(id);
  }

  function escHtml(s) {
    if (!s) return '';
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function escAttr(s) {
    if (!s) return '';
    return s
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function getProfileName(profilePath) {
    if (!profilePath) return '(no profile)';
    const parts = profilePath.replace(/\\/g, '/').split('/');
    return parts[parts.length - 1] || parts[parts.length - 2] || profilePath;
  }

  /** Per-component status: 'ok' | 'update' | 'missing' | 'checking'. */
  function componentStatus(b, kind) {
    const installed = kind === 'config' ? b.configInstalled : b.utilsInstalled;
    if (!installed) return 'missing';
    if (!b.hashCheckOk) return 'checking';
    const upToDate = kind === 'config' ? b.configUpToDate : b.utilsUpToDate;
    return upToDate ? 'ok' : 'update';
  }

  /** Aggregate card status for the collapsed header badge. */
  function groupHeaderStatus(group) {
    let hasUpdate = false;
    let hasMissing = false;
    let hasChecking = false;
    group.browsers.forEach(function (b) {
      const kinds = ['config', 'utils'];
      for (let i = 0; i < kinds.length; i++) {
        const st = componentStatus(b, kinds[i]);
        if (st === 'update') hasUpdate = true;
        else if (st === 'missing') hasMissing = true;
        else if (st === 'checking') hasChecking = true;
      }
    });
    if (hasUpdate) return 'update';
    if (hasMissing) return 'missing';
    if (hasChecking) return 'checking';
    return 'ok';
  }

  /* ========================================================================
     Grouping: unique binary path -> one card with per-profile rows
     ======================================================================== */
  function groupByBinary(data) {
    const map = {};
    data.forEach(function (b) {
      const key = b.binaryPath;
      if (!map[key]) {
        map[key] = {
          binaryPath: b.binaryPath,
          name: b.name,
          exe: b.exe,
          version: b.version || '',
          browsers: [],
        };
      }
      map[key].browsers.push(b);
    });
    return Object.keys(map)
      .map(function (k) {
        return map[k];
      })
      .sort(function (a, b) {
        const an = (a.name || '').toLowerCase();
        const bn = (b.name || '').toLowerCase();
        if (an < bn) return -1;
        if (an > bn) return 1;
        return 0;
      });
  }

  /* ========================================================================
     API Helpers
     ======================================================================== */
  /** Append the session token (?t=...) to a local API path if not present. */
  function withToken(path) {
    if (/[?&]t=[0-9a-f]{16}/.test(path)) return path;
    const t = getSessionToken();
    if (!t) return path;
    const sep = path.indexOf('?') >= 0 ? '&' : '?';
    return path + sep + 't=' + t;
  }

  function fetchJSON(url) {
    return fetch(withToken(url))
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .catch(function (err) {
        console.error('fetchJSON', url, err);
        return null;
      });
  }

  /** Fetch a URL as raw bytes with a timeout (network failure -> rejected). */
  function fetchRaw(url, timeoutMs, init) {
    const ctrl = new AbortController();
    const timer = setTimeout(function () {
      ctrl.abort();
    }, timeoutMs || 20000);
    return fetch(url, Object.assign({signal: ctrl.signal}, init))
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url);
        return r.arrayBuffer();
      })
      .then(
        function (buf) {
          clearTimeout(timer);
          return buf;
        },
        function (err) {
          clearTimeout(timer);
          throw err;
        }
      );
  }

  /** POST raw bytes (zip or JSON) to a local ingest endpoint. */
  function postRaw(path, body) {
    return fetch(withToken(path), {method: 'POST', body: body}).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + path);
      return r.json();
    });
  }

  /* ========================================================================
     Network Error Banner
     ======================================================================== */
  function showNetworkError() {
    const el = qs('network-error-banner');
    if (el) el.style.display = 'block';
  }

  function hideNetworkError() {
    const el = qs('network-error-banner');
    if (el) el.style.display = 'none';
  }

  // Install-blocking state: once the package zips are known to be
  // unreachable there is nothing to install or update against, so no browser
  // card is rendered.  renderBrowsers() checks this flag so any later
  // re-render (initial /api/browsers resolving after the ingest failure, or
  // a post-install refresh) keeps the notification instead of restoring
  // cards.  Fresh page loads reset it, so a recovered network re-enables the
  // normal UI on the next refresh.
  let installBlocked = false;

  /** Replace the browser cards with a clear blocked notification. */
  function renderInstallBlocked() {
    installBlocked = true;
    const container = qs('browser-list');
    if (!container) return;
    container.innerHTML = [
      '<div class="empty-state">',
      '  <h3>Installation Unavailable</h3>',
      '  <p>The installation packages could not be downloaded, so nothing can be installed or updated.',
      '  Check your network connection and refresh this page, or close this tab.</p>',
      '</div>',
    ].join('');
  }

  /**
   * Animate the freshly-validated browser-list content in. Runs once per page
   * load: the 'revealed' class persists across card re-renders (install
   * refresh), so only the first validated paint animates.
   *
   * No automatic scroll: on load the list sits below the short header, always
   * in view, and a scrollIntoView(block:'start') here clamps to maxScroll on
   * pages only slightly taller than the viewport — which slammed the page to
   * the very bottom and flashed the footer into view (issue #4 review).
   */
  function revealCards(container) {
    if (!container || container.classList.contains('revealed')) return;
    container.classList.add('revealed');
  }

  /* ========================================================================
     Remote-data ingestion
     The installer C binary performs no network I/O: this tab is its only
     network access.  Fetch every external payload (package zips, hash
     manifest, Waterfox releases, Firefox beta/devedition hg tags, installer
     latest-release JSON — all CORS-enabled hosts) and POST the raw bytes to
     the local server, which
     * ingests them into memory.  The small hash manifest is fetched in
     * PARALLEL with the zips (not after them) so the "Checking..." status
     * resolves as soon as it lands; a one-time retry after the zips finish
     * covers old-format manifests (no `files` arrays) that derive their file
     * lists from the uploaded bytes.  The two install-critical failure modes
     * are handled differently:
     *  * zip fetch/upload failed  -> nothing can be installed or updated:
     *    the caller hides the browser cards and shows the network-error
     *    banner (the server also refuses installs whose package is missing).
     *    updater-ui.zip is the exception: it rides along with utils but a
     *    failed fetch never blocks installation (the updater self-heals).
     *  * hash manifest failed     -> non-blocking: the packages are still
     *    available, so installs continue normally and the status check falls
     *    back to file presence.  No user message.
     * The Waterfox releases / hg tags / installer latest-release lookups are
     * informational — a failure there just leaves the version display at its
     * application.ini fallback and the self-update banner empty, and must not
     * claim installation is blocked.
     ======================================================================== */
  function ingestRemoteData(urls, browsersData) {
    let zipsFailed = false;
    let manifestFailed = false;
    function failZip(err) {
      zipsFailed = true;
      console.error('[ingest] package zip fetch failed: ' + (err && err.message));
    }
    function failManifest(err) {
      manifestFailed = true;
      console.error('[ingest] hash manifest fetch failed: ' + (err && err.message));
    }

    // Step 1: package zips.  The fetches are independent, so run them
    // concurrently — serializing them made the startup critical path twice as
    // long on slow connections.  updater-ui.zip is optional: it rides along
    // with utils but a failed fetch must not block installation (the updater
    // self-heals later).
    const ingestZips = Promise.all([
      fetchRaw(urls.fxFolderUrl)
        .then(function (zip) {
          return postRaw('/api/upload?kind=config', zip);
        })
        .catch(failZip),
      fetchRaw(urls.utilsUrl)
        .then(function (zip) {
          return postRaw('/api/upload?kind=utils', zip);
        })
        .catch(failZip),
      fetchRaw(urls.updaterUiUrl)
        .then(function (zip) {
          return postRaw('/api/upload?kind=ui', zip);
        })
        .catch(function (err) {
          console.error('[ingest] updater-ui zip fetch failed: ' + (err && err.message));
        }),
    ]);

    // Step 2: hash manifest (file lists + hashes for the status checks).
    // Fetch it in PARALLEL with the zips: it is a few KB, so the
    // "Checking..." status resolves long before the package zips finish
    // downloading.  The manifest URL always points at the latest gh-pages
    // revision, so a cached response would serve stale hashes and wrong
    // up-to-date flags — force a fresh fetch (mirrors the updater's
    // no-store).  Old-format manifests (no `files` arrays) need the uploaded
    // zips to derive their file lists; the retry below re-POSTs the manifest
    // once the zips are in.
    const ingestManifest = fetchRaw(urls.hashesUrl, 20000, {cache: 'no-store'})
      .then(function (buf) {
        return postRaw('/api/manifest', buf);
      })
      .catch(failManifest);

    // Legacy fallback: a manifest without `files` arrays cannot be parsed
    // until the zips are available on the server, so retry it once when they
    // land.
    const manifestRetry = ingestZips.then(function () {
      if (!manifestFailed) return null;
      return fetchRaw(urls.hashesUrl, 20000, {cache: 'no-store'})
        .then(function (buf) {
          return postRaw('/api/manifest', buf);
        })
        .catch(failManifest);
    });

    // Step 3: Waterfox releases, Firefox beta/devedition hg tags + installer
    // latest release — independent of the zips and manifest, so start them now
    // (concurrent with step 1) and only join them before resolving.  Not
    // install-critical: a failure only leaves version/self-update info at its
    // fallback, so these do not trigger the network-error banner.
    const hgUrls = {};
    if (Array.isArray(browsersData)) {
      browsersData.forEach(function (b) {
        if (b.hgTagsUrl) hgUrls[b.hgTagsUrl] = true;
      });
    }
    const ingestHgTags = Object.keys(hgUrls).map(function (url) {
      return fetchRaw(url)
        .then(function (buf) {
          return postRaw('/api/hg-tags', buf);
        })
        .catch(function (err) {
          console.error('[ingest] hg tags fetch failed: ' + (err && err.message));
        });
    });

    const ingestInfo = Promise.all(
      [
        fetchRaw(urls.waterfoxUrl)
          .then(function (buf) {
            return postRaw('/api/waterfox', buf);
          })
          .catch(function (err) {
            console.error('[ingest] waterfox releases fetch failed: ' + (err && err.message));
          }),
        fetchRaw(urls.selfUpdateUrl)
          .then(function (buf) {
            return postRaw('/api/self-update', buf);
          })
          .catch(function (err) {
            console.error('[ingest] self-update fetch failed: ' + (err && err.message));
          }),
      ].concat(ingestHgTags)
    );

    return {
      // Full ingestion: zips, manifest (with legacy retry) and the
      // informational payloads.  Only a missing package blocks the UI.  A
      // missing hash manifest is not an error for the user: installs proceed
      // and the server computes the expected hashes from the uploaded
      // packages until the manifest is available again.
      done: Promise.all([ingestZips, ingestManifest, manifestRetry, ingestInfo]).then(function () {
        if (zipsFailed) {
          showNetworkError();
        } else {
          hideNetworkError();
        }
        return {zipsFailed: zipsFailed, manifestFailed: manifestFailed};
      }),
      // Resolves true once the hash manifest has been successfully ingested —
      // the caller refreshes the "Checking..." cards at this point, without
      // waiting for the still-downloading package zips.
      manifestReady: ingestManifest.then(function () {
        return !manifestFailed;
      }),
    };
  }

  /* ========================================================================
     Self-Update Banner
     ======================================================================== */
  function checkSelfUpdate() {
    fetchJSON('/api/self-update').then(function (data) {
      if (!data) return;
      if (data.error) {
        // Silently ignore network/API errors -- banner stays hidden
        return;
      }
      if (data.updateAvailable) {
        qs('new-version-tag').textContent = 'v' + data.latestVersion;
        qs('update-banner').style.display = 'flex';
        qs('btn-self-update').onclick = function () {
          if (data.downloadUrl) {
            // Download via an in-page anchor click (no target=_blank): the
            // same gesture as the manual-download links — no popup blocker,
            // no blank tab.  GitHub serves the asset with
            // Content-Disposition: attachment, so the browser shows its
            // save dialog instead of navigating away.
            const a = document.createElement('a');
            a.href = data.downloadUrl;
            a.download = '';
            a.rel = 'noopener';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
          } else {
            alert(
              'Update available: v' +
                data.latestVersion +
                '. Please download the latest installer from the repository.'
            );
          }
        };
      }
    });
  }

  /* ========================================================================
     Test/Dev build banner
     ======================================================================== */
  function showBuildBanner() {
    fetchJSON('/api/build-info').then(function (info) {
      if (!info || (!info.isLocal && !info.isDev)) return;
      const banner = qs('build-banner');
      const detail = qs('build-banner-detail');
      if (!banner || !detail) return;
      const label = info.isLocal ? 'Local test build' : 'Development build';
      const source =
        info.isLocal ?
          'Files are served from the local snapshot: ' + info.distPath
        : 'Artifacts are on the ' + info.devBranch + ' branch.';
      detail.textContent = label + ' — ' + source;
      banner.hidden = false;
    });
  }

  /* ========================================================================
     Browser List Rendering (grouped by binary path, then per-profile rows)
     ======================================================================== */
  function renderBrowsers(data) {
    const container = qs('browser-list');

    // The packages are unreachable: keep the blocked notification instead of
    // rendering cards (see renderInstallBlocked).
    if (installBlocked) return;

    if (!data || data.length === 0) {
      container.innerHTML = [
        '<div class="empty-state">',
        '  <h3>No Browsers Detected</h3>',
        '  <p>Please start Firefox, Zen Browser, Waterfox, LibreWolf, or Floorp and click Rescan.</p>',
        '</div>',
      ].join('');
      return;
    }

    browsers = data;
    groups = groupByBinary(data);
    container.innerHTML = '';

    groups.forEach(function (group) {
      const card = buildGroupCard(group);
      container.appendChild(card);
    });

    // Success banner: once every active browser/profile is up to date (hash
    // check succeeded) there is nothing left to do, so state clearly that the
    // installation/update finished.  The tab always opens (it is the only
    // component with network access), so this banner also appears on startup
    // when everything is already up to date.
    const allDone =
      groups.length > 0 &&
      groups.every(function (group) {
        return group.browsers.every(function (b) {
          return componentStatus(b, 'config') === 'ok' && componentStatus(b, 'utils') === 'ok';
        });
      });
    if (allDone) {
      const doneBanner = document.createElement('div');
      doneBanner.className = 'success-banner';
      doneBanner.innerHTML =
        GREEN_CHECK +
        ' Installation / update finished &mdash; all active browsers and profiles are up-to-date.';
      container.insertBefore(doneBanner, container.firstChild);
    }

    // Any re-render must re-apply the per-card Restart buttons for groups that
    // completed an install this session (freshly built cards start disabled).
    updateRestartButtons();
  }

  function buildGroupCard(group) {
    const type = detectType(group.name, group.exe);
    const logo = getLogo(type);
    const card = document.createElement('div');
    card.className = 'browser-card';
    const binaryKey = (group.binaryPath || '').replace(/[^a-zA-Z0-9_-]/g, '_');
    card.setAttribute('data-binary-key', binaryKey);

    // ---- Header ----
    const header = document.createElement('div');
    header.className = 'browser-card-header';

    const titleGroup = document.createElement('div');
    titleGroup.className = 'browser-title-group';

    const iconWrap = document.createElement('div');
    iconWrap.className = 'browser-icon-wrapper';
    iconWrap.innerHTML = logoImgMarkup(logo);
    titleGroup.appendChild(iconWrap);

    const nameLine = document.createElement('div');
    nameLine.className = 'browser-name-line';

    const title = document.createElement('span');
    title.className = 'browser-title';
    title.textContent = group.name;
    nameLine.appendChild(title);

    if (group.version) {
      const version = document.createElement('span');
      version.className = 'browser-version';
      version.textContent = group.version;
      nameLine.appendChild(version);
    }
    titleGroup.appendChild(nameLine);

    header.appendChild(titleGroup);

    // Check installation and update status.
    // A card can be safely collapsed only when the hash check succeeded AND
    // every component matches: without the hash check the "up to date" status
    // is unverified and a pending update must not be hidden.
    const confidentUpToDate = group.browsers.every(function (b) {
      return componentStatus(b, 'config') === 'ok' && componentStatus(b, 'utils') === 'ok';
    });

    // Header status badge — shown only while the card is collapsed (CSS hides
    // it when expanded).  It summarizes the worst actionable state of the rows
    // instead of defaulting to "Not Installed" just because one component is
    // missing while another has an update available.
    const headerStatus = groupHeaderStatus(group);
    const headerBadge = document.createElement('span');
    headerBadge.className = 'card-status-badge';
    if (headerStatus === 'ok') {
      headerBadge.className += ' badge-uptodate';
      headerBadge.innerHTML = GREEN_CHECK + ' All Up To Date';
    } else if (headerStatus === 'update') {
      headerBadge.className += ' badge-need-update';
      headerBadge.innerHTML = YELLOW_DOT + ' Update Available';
    } else if (headerStatus === 'checking') {
      headerBadge.className += ' badge-checking';
      headerBadge.innerHTML = CHECKING_ICON + ' Checking...';
    } else {
      headerBadge.className += ' badge-missing';
      headerBadge.innerHTML = RED_X + ' Not Installed';
    }
    header.appendChild(headerBadge);
    card._headerBadge = headerBadge;

    // Collapse toggle — always visible, on the left before the logo.  Cards
    // whose hash check succeeded AND both components match start collapsed so
    // the list only surfaces what needs action; the user's manual expansion
    // is remembered across re-renders.  Any card can be toggled.
    if (confidentUpToDate && !expandedCards[binaryKey]) {
      card.classList.add('card-collapsed');
    }
    const chev = document.createElement('button');
    chev.className = 'card-chevron';
    chev.title = card.classList.contains('card-collapsed') ? 'Show details' : 'Hide details';
    chev.innerHTML = CHEVRON_ICON;
    chev.onclick = function () {
      card.classList.toggle('card-collapsed');
      expandedCards[binaryKey] = !card.classList.contains('card-collapsed');
      chev.title = card.classList.contains('card-collapsed') ? 'Show details' : 'Hide details';
    };
    titleGroup.insertBefore(chev, titleGroup.firstChild);

    const btn = document.createElement('button');
    btn.className = 'btn-action';
    btn.innerHTML = INSTALL_ICON + ' Install / Update';
    btn.title = 'Select from available updates';
    btn.onclick = function () {
      console.log(
        '[install] Install button clicked, disabled=' + this.disabled,
        group && group.binaryPath
      );
      if (this.disabled) {
        showDebug('Install button is disabled — check a component first');
        return;
      }
      try {
        startGroupInstall(group);
      } catch (e) {
        console.error('[install] startGroupInstall threw', e);
        showDebug('Install click error: ' + (e && e.message));
      }
    };
    header.appendChild(btn);
    card._installBtn = btn;

    // Per-card Restart button: always visible, but disabled until this group
    // has a completed install this session (enabled by updateRestartButtons()).
    // The server decides the restart scope from what was installed (config
    // update => all browsers of the binary, utils-only => just the affected
    // profile).
    const btnRestart = document.createElement('button');
    btnRestart.className = 'btn-restart';
    btnRestart.innerHTML = RESTART_ICON + ' Restart';
    // No tooltip while disabled — the button has nothing actionable yet.
    btnRestart.disabled = true;
    btnRestart.onclick = function () {
      restartedGroups[group.binaryPath || ''] = true;
      btnRestart.disabled = true;
      btnRestart.removeAttribute('title');
      btnRestart.innerHTML = RESTART_ICON + ' Restarting...';
      const firstIdx = group.browsers[0].index;
      console.log(
        '[install] Restart clicked for ' + group.binaryPath + ' (browser=' + firstIdx + ')'
      );
      fetchJSON('/api/restart?browser=' + firstIdx + '&t=' + getSessionToken())
        .then(function (data) {
          if (data && data.error) {
            // Restart failed server-side (e.g. could not launch): re-enable so
            // the user can retry without a new install.
            console.error('[install] Restart failed: ' + data.message);
            btnRestart.innerHTML = RESTART_ICON + ' Restart';
            delete restartedGroups[group.binaryPath || ''];
            btnRestart.disabled = false;
            btnRestart.title = 'Restart the browser(s) of this binary with a clean cache';
            return;
          }
          if (data && data.exiting) {
            clearAppAndShowClosed();
          } else if (data && data.rotate) {
            // Our own browser is being restarted: the server will reopen the UI
            // tab explicitly after relaunch.  Close this tab now so the session
            // store drops it (about:blank navigation is a reliable fallback
            // since window.close() is blocked for tabs not opened by script).
            btnRestart.innerHTML = RESTART_ICON + ' Restart Sent';
            try {
              window.close();
            } catch {
              // Only script-opened tabs honor window.close(); the about:blank
              // navigation below covers the rest.
            }
            setTimeout(function () {
              location.href = 'about:blank';
            }, 100);
          } else {
            btnRestart.innerHTML = RESTART_ICON + ' Restart Sent';
          }
        })
        .catch(function () {
          // Network failure: the server may or may not have acted.  Re-enable
          // so the user can retry.
          btnRestart.innerHTML = RESTART_ICON + ' Restart';
          delete restartedGroups[group.binaryPath || ''];
          btnRestart.disabled = false;
          btnRestart.title = 'Restart the browser(s) of this binary with a clean cache';
        });
    };
    header.appendChild(btnRestart);

    card.appendChild(header);

    // Collapsible body: animating grid-template-rows between 0fr and 1fr
    // transitions the card's height when it collapses/expands (see
    // .browser-card-body in style.css). The inner wrapper clips the content
    // during the transition via overflow:hidden.
    const body = document.createElement('div');
    body.className = 'browser-card-body';
    const bodyInner = document.createElement('div');
    bodyInner.className = 'browser-card-body-inner';
    body.appendChild(bodyInner);
    card.appendChild(body);

    // ---- Per-card Progress Bar ----
    const cardProgress = document.createElement('div');
    cardProgress.className = 'card-progress';
    cardProgress.style.display = 'none';
    cardProgress.innerHTML = [
      '<div class="card-progress-bar-container">',
      '  <div class="card-progress-bar-fill" style="width:0%"></div>',
      '</div>',
      '<div class="card-progress-status">',
      '  <span class="card-progress-step">Preparing...</span>',
      '  <span class="card-progress-percent">0%</span>',
      '</div>',
      '<div class="card-progress-error"></div>',
    ].join('');
    bodyInner.appendChild(cardProgress);

    // ---- Rows ----
    const rows = document.createElement('div');
    rows.className = 'browser-rows';

    // Row 1: Application Binary (shown once per group)
    const binRow = document.createElement('div');
    binRow.className = 'row-item';

    const b0 = group.browsers[0];
    const binBlock = document.createElement('div');
    binBlock.className = 'path-block';
    binBlock.innerHTML = [
      '<div class="path-title-row">',
      '  <span class="path-title">APPLICATION BINARY</span>',
      '  <button type="button" class="btn-open-folder" title="Open application folder" data-browser="' +
        b0.index +
        '" data-kind="binary">' +
        FOLDER_ICON +
        '</button>',
      '</div>',
      '<span class="path-value" title="' +
        escAttr(group.binaryPath) +
        '">' +
        escHtml(group.binaryPath) +
        '</span>',
    ].join('');
    binRow.appendChild(binBlock);

    // Config.js status for the binary row (shared per-binary)
    const configStatusCell = document.createElement('div');
    configStatusCell.className = 'component-status-cell';
    const configStatus = document.createElement('span');
    setConfigStatus(configStatus, b0, group.binaryPath);
    configStatusCell.appendChild(configStatus);
    binRow.appendChild(configStatusCell);
    card._configStatus = configStatus;

    rows.appendChild(binRow);

    // Profile rows: one per unique profile in the group.  The status badge
    // shares the first row with the "PROFILE FOLDER" label; the full path sits
    // on its own second row so a long path can wrap instead of being cut off.
    group.browsers.forEach(function (b) {
      const profRow = document.createElement('div');
      profRow.className = 'profile-row';
      const profileDisplay = b.profilePath || '(not detected)';

      const top = document.createElement('div');
      top.className = 'profile-row-top';
      top.innerHTML = [
        '<div class="profile-row-name-line">',
        '  <span class="profile-row-name">PROFILE FOLDER</span>',
        '  <button type="button" class="btn-open-folder" title="Open profile folder" data-browser="' +
          b.index +
          '" data-kind="profile">' +
          FOLDER_ICON +
          '</button>',
        '</div>',
      ].join('');

      // Status badges: only utils status per-profile
      const badges = document.createElement('div');
      badges.className = 'profile-row-badges';

      const utilsBadge = document.createElement('span');
      utilsBadge.id = 'badge-utils-' + b.index;
      setUtilsStatus(utilsBadge, b);
      badges.appendChild(utilsBadge);

      top.appendChild(badges);

      const pathEl = document.createElement('span');
      pathEl.className = 'profile-row-value';
      pathEl.title = profileDisplay;
      pathEl.textContent = profileDisplay;

      profRow.appendChild(top);
      profRow.appendChild(pathEl);
      rows.appendChild(profRow);
    });

    bodyInner.appendChild(rows);

    // Checkboxes start unchecked, so the button starts disabled until the
    // user selects a component to install.
    wireCardCheckboxes(card, btn);
    btn.disabled = true;

    return card;
  }

  /**
   * (Re-)wire a card's component checkboxes to enable its Install button only
   * while at least one is checked. Called at build time and again after an
   * in-place status refresh, when badge content (and its checkboxes) was
   * replaced.
   */
  function wireCardCheckboxes(card, btn) {
    const checkboxes = card.querySelectorAll('.chk-component');
    for (let i = 0; i < checkboxes.length; i++) {
      checkboxes[i].onchange = function () {
        const chks = card.querySelectorAll('.chk-component');
        let anyChecked = false;
        for (let j = 0; j < chks.length; j++) {
          if (chks[j].checked) {
            anyChecked = true;
            break;
          }
        }
        btn.disabled = !anyChecked;
      };
    }
  }

  /** Apply a browser's current status to its config.js status element. */
  function setConfigStatus(el, b, binaryPath) {
    const st = componentStatus(b, 'config');
    if (st === 'ok') {
      el.className = 'badge-uptodate';
      el.innerHTML = GREEN_CHECK + ' config.js: Up To Date';
    } else if (st === 'checking') {
      el.className = 'badge-checking';
      el.innerHTML = CHECKING_ICON + ' config.js: Checking...';
    } else if (st === 'update') {
      el.className = 'badge-update';
      el.innerHTML = [
        '<input type="checkbox" class="chk-component chk-config" data-group="' +
          escAttr(binaryPath) +
          '">',
        YELLOW_DOT + ' config.js: Update Available',
      ].join(' ');
    } else {
      el.className = 'badge-missing';
      el.innerHTML = [
        '<input type="checkbox" class="chk-component chk-config" data-group="' +
          escAttr(binaryPath) +
          '">',
        RED_X + ' config.js: Not Installed',
      ].join(' ');
    }
  }

  /** Apply a browser's current status to its utils status element. */
  function setUtilsStatus(el, b) {
    const st = componentStatus(b, 'utils');
    if (st === 'ok') {
      el.className = 'badge-uptodate';
      el.innerHTML = GREEN_CHECK + ' utils: Up To Date';
    } else if (st === 'checking') {
      el.className = 'badge-checking';
      el.innerHTML = CHECKING_ICON + ' utils: Checking...';
    } else if (st === 'update') {
      el.className = 'badge-update';
      el.innerHTML = [
        '<input type="checkbox" id="chk-utils-' +
          b.index +
          '" class="chk-component" data-browser="' +
          b.index +
          '" data-component="utils">',
        YELLOW_DOT + ' utils: Update Available',
      ].join(' ');
    } else {
      el.className = 'badge-missing';
      el.innerHTML = [
        '<input type="checkbox" id="chk-utils-' +
          b.index +
          '" class="chk-component" data-browser="' +
          b.index +
          '" data-component="utils">',
        RED_X + ' utils: Not Installed',
      ].join(' ');
    }
  }

  /* ========================================================================
     Installation (group-level: install to all profiles in group)
     ======================================================================== */
  function startGroupInstall(group) {
    // Build the install queue from the SERVER's status flags (configUpToDate /
    // utilsUpToDate), so the button works regardless of checkbox state.
    // When a checkbox is checked it acts as an override to include/exclude.
    installQueue = [];
    const anyChecked = document.querySelectorAll('.chk-component:checked').length > 0;
    // Resolve this group's card ONCE via its sanitized data-binary-key (the
    // same key derivation as getCardProgressEls).  The config checkbox is then
    // queried card-scoped: matching on data-group with the raw binary path is
    // unreliable because Windows paths contain backslashes, which CSS
    // attribute-selector strings treat as escape sequences (e.g. "C:\Program"
    // parses as "C:Program"), so the selector silently fails and config gets
    // installed even when its checkbox was left unchecked.
    const binaryKey = (group.binaryPath || '').replace(/[^a-zA-Z0-9_-]/g, '_');
    const groupCard = document.querySelector('.browser-card[data-binary-key="' + binaryKey + '"]');

    group.browsers.forEach(function (b, idx) {
      const configChk = groupCard ? groupCard.querySelector('.chk-config') : null;
      const utilsChk = qs('chk-utils-' + b.index);

      // config.js lives in the shared binary dir, so it only needs to be
      // installed ONCE per group (first profile) - avoids double UAC prompts.
      let doConfig = false;
      if (idx === 0) {
        if (configChk) doConfig = anyChecked ? configChk.checked : !b.configUpToDate;
        // No config checkbox rendered means its badge shows "Up To Date".
        // The configUpToDate flag is 0 until the hash check has run (e.g.
        // right after startup), so defaulting to !configUpToDate here would
        // silently install config — and raise a UAC prompt — when the user
        // only selected utils.  A missing checkbox selects nothing.
      }

      // Same rule as config: a missing utils checkbox means its badge shows
      // "Up To Date" — never auto-install a component the UI did not offer.
      let doUtils;
      if (utilsChk) doUtils = anyChecked ? utilsChk.checked : !b.utilsUpToDate;
      else doUtils = false;

      if (doConfig || doUtils) {
        installQueue.push({
          index: b.index,
          config: doConfig ? 1 : 0,
          utils: doUtils ? 1 : 0,
        });
      }
    });

    if (installQueue.length === 0) {
      console.log(
        '[install] QUEUE EMPTY',
        group.binaryPath,
        'anyChecked=' + anyChecked,
        'browsers=' + (group.browsers ? group.browsers.length : 'none'),
        'configUpToDate=' +
          (group.browsers && group.browsers[0] ? group.browsers[0].configUpToDate : 'n/a'),
        'utilsUpToDate=' +
          (group.browsers && group.browsers[0] ? group.browsers[0].utilsUpToDate : 'n/a')
      );
      showDebug('Nothing to install: no pending config or utils components were found.');
      return;
    }

    console.log(
      '[install] startGroupInstall queue=',
      installQueue
        .map(function (i) {
          return 'b' + i.index + '(config=' + i.config + ',utils=' + i.utils + ')';
        })
        .join(' ')
    );

    // Show per-card progress bar
    const els = getCardProgressEls(group);
    if (els) {
      els.container.style.display = 'flex';
      els.barFill.style.width = '0%';
      els.stepDesc.textContent = 'Starting installation...';
      els.percentEl.textContent = '0%';
      els.errorEl.style.display = 'none';
      els.errorEl.textContent = '';
    }

    processNextInQueue(group);
  }

  function processNextInQueue(group) {
    if (installQueue.length === 0) {
      progressDone('Installation complete for all profiles', group);
      return;
    }

    const item = installQueue.shift();
    const browserIndex = item.index;
    const b = getBrowserByIndex(browserIndex);
    if (!b) {
      processNextInQueue(group);
      return;
    }

    // Install only the checked components for this profile
    const url =
      '/api/install?browser=' +
      browserIndex +
      '&config=' +
      (item.config ? 1 : 0) +
      '&utils=' +
      (item.utils ? 1 : 0);

    console.log('[install] POST ' + url);

    function showError(msg) {
      const els = getCardProgressEls(group);
      if (els) {
        els.errorEl.textContent = msg;
        els.errorEl.style.display = 'block';
        els.stepDesc.textContent = 'Failed';
      }
    }

    fetchJSON(url)
      .then(function (result) {
        if (result && result.status === 'started') {
          pollGroupStatus(browserIndex, group, item);
        } else if (result && result.error) {
          showError(result.error);
          processNextInQueue(group);
        } else {
          showError('Installation did not start');
          processNextInQueue(group);
        }
      })
      .catch(function () {
        showError('Connection failed');
        processNextInQueue(group);
      });
  }

  function pollGroupStatus(browserIndex, group, item) {
    if (polling) return;
    polling = true;

    let els = getCardProgressEls(group);
    let sawProgress = false;

    function completeItem() {
      if (els) {
        els.stepDesc.textContent =
          'Completed profile ' +
          getProfileName((getBrowserByIndex(browserIndex) || {}).profilePath || '');
        els.barFill.style.width = '100%';
        els.percentEl.textContent = '100%';
      }
      polling = false;
      // Mirror the server's post-install status refresh in local state so a
      // re-render is correct even before /api/browsers responds.  Config files
      // live in the shared binary dir, so a config install marks every browser
      // of this group installed AND up to date.
      browsers.forEach(function (bb) {
        if (bb.binaryPath === group.binaryPath) {
          if (item.config) {
            bb.configInstalled = 1;
            bb.configUpToDate = 1;
          }
        }
      });
      const b = getBrowserByIndex(browserIndex);
      if (b) {
        if (item.utils) {
          b.utilsInstalled = 1;
          b.utilsUpToDate = 1;
        }
      }
      installedGroups[group.binaryPath || ''] = true;
      // A fresh install for this group makes its Restart button relevant
      // again (a previous Restart click consumed the group's restart scope).
      delete restartedGroups[group.binaryPath || ''];
      processNextInQueue(group);
    }

    function failItem(msg) {
      if (els) {
        els.stepDesc.textContent =
          'Failed for ' + getProfileName((getBrowserByIndex(browserIndex) || {}).profilePath || '');
        els.errorEl.textContent = msg;
        els.errorEl.style.display = 'block';
      }
      polling = false;
      processNextInQueue(group);
    }

    function poll() {
      fetchJSON('/api/status')
        .then(function (data) {
          if (!els) els = getCardProgressEls(group);

          if (!data) {
            // Transient failure while the single-threaded server is busy (e.g.
            // blocked on a UAC prompt or a slow download).  Retry instead of
            // dropping the item, which would leave the card stale.
            setTimeout(poll, 500);
            return;
          }

          const remaining = installQueue.length;
          let done = group.browsers.length - remaining - 1;
          if (done < 0) done = 0;
          const overallPct = Math.round(
            (done / group.browsers.length) * 100 +
              ((data.progress || 0) / 100) * (100 / group.browsers.length)
          );

          if (els) {
            els.barFill.style.width = overallPct + '%';
            els.percentEl.textContent = overallPct + '%';
          }

          const b = getBrowserByIndex(browserIndex);
          const profileName = b ? getProfileName(b.profilePath) : '';

          if (data.step === 'installing_config') {
            sawProgress = true;
            if (els) els.stepDesc.textContent = 'Installing config for ' + profileName + '...';
          } else if (data.step === 'installing_utils') {
            sawProgress = true;
            if (els) els.stepDesc.textContent = 'Installing utils for ' + profileName + '...';
          } else if (data.step === 'done') {
            completeItem();
            return;
          } else if (data.step === 'error') {
            failItem(data.message || 'Installation failed');
            return;
          } else if (data.step === 'idle' && sawProgress) {
            // The install finished but this poll missed the "done" step (a
            // concurrent /api/status consumer advanced the last step).  Treat
            // it as done so the queue advances and the card re-renders.
            completeItem();
            return;
          } else if (data.message) {
            if (els) els.stepDesc.textContent = data.message;
          }

          setTimeout(poll, 500);
        })
        .catch(function () {
          if (!els) els = getCardProgressEls(group);
          // Same as the !data case: transient, keep polling.
          setTimeout(poll, 500);
        });
    }

    poll();
  }

  function progressDone(msg, group) {
    // Update the card's progress bar to show 100%
    const els = getCardProgressEls(group);
    if (els) {
      els.barFill.style.width = '100%';
      els.stepDesc.textContent = msg;
      els.percentEl.textContent = '100%';
    }

    // Re-fetch browser data to refresh status badges and re-render the card.
    refreshAndRender(group, 0);
  }

  function refreshAndRender(group, attempts) {
    // Update the INSTALLED elements in place from the already-flipped local
    // state — existing cards keep their DOM, so nothing re-animates, no
    // checkbox resets, and the card simply shows fresh statuses (and
    // collapses once everything is up to date).  Then reconcile with the
    // authoritative /api/browsers payload the same way when it arrives.
    try {
      updateAllCardsInPlace(browsers);
    } catch (e) {
      showDebug('Re-render error (local): ' + (e && e.message));
    }

    fetchJSON('/api/browsers').then(function (data) {
      if (data) {
        try {
          updateAllCardsInPlace(data);
        } catch (e) {
          showDebug('Re-render error: ' + (e && e.message));
        }
      } else if (attempts < 3) {
        // Server was busy (single-threaded, mid-refresh) — retry shortly.
        setTimeout(function () {
          refreshAndRender(group, attempts + 1);
        }, 800);
      }
    });
  }

  /**
   * In-place refresh of every card from `data`: existing cards are updated
   * element-by-element (header badge, config cell, per-profile utils badges,
   * collapse state) instead of being rebuilt — the post-install view never
   * re-animates or flashes. Cards are only created/removed when the detected
   * browser set itself changed (new binary, or a browser was closed).
   */
  function updateAllCardsInPlace(data) {
    const container = qs('browser-list');
    if (!container || installBlocked) return;

    browsers = data;
    groups = groupByBinary(data);
    const seen = {};
    groups.forEach(function (group) {
      const key = (group.binaryPath || '').replace(/[^a-zA-Z0-9_-]/g, '_');
      seen[key] = true;
      let card = container.querySelector('.browser-card[data-binary-key="' + key + '"]');
      if (!card) {
        card = buildGroupCard(group);
        container.appendChild(card);
      }
      updateGroupCardInPlace(card, group);
    });
    // Drop cards whose binary is no longer detected (e.g. the app was closed).
    Array.prototype.slice
      .call(container.querySelectorAll('.browser-card'))
      .forEach(function (card) {
        const key = card.getAttribute('data-binary-key');
        if (!seen[key]) {
          container.removeChild(card);
        }
      });
    // Re-order the cards into the sorted group order: a browser detected on a
    // later Rescan can sort before cards that are already on screen. Moving an
    // existing node with appendChild does not restart its CSS entrance
    // animation, so the list just settles into name order without flashing.
    // The move is skipped when the order already matches: an appendChild on a
    // card cancels its grid-template-rows collapse transition (even a no-op
    // move, even one deferred to the next frame), which would make the
    // post-install collapse snap instead of animating.  Only Rescan/added-
    // browser flows reorder, where no collapse is happening.
    const expectedKeys = groups.map(function (g) {
      return (g.binaryPath || '').replace(/[^a-zA-Z0-9_-]/g, '_');
    });
    const actualKeys = Array.prototype.slice
      .call(container.children)
      .filter(function (el) {
        return el.classList.contains('browser-card');
      })
      .map(function (el) {
        return el.getAttribute('data-binary-key');
      });
    const orderChanged =
      actualKeys.length !== expectedKeys.length ||
      actualKeys.some(function (key, i) {
        return key !== expectedKeys[i];
      });
    if (orderChanged) {
      groups.forEach(function (group) {
        const key = (group.binaryPath || '').replace(/[^a-zA-Z0-9_-]/g, '_');
        const card = container.querySelector('.browser-card[data-binary-key="' + key + '"]');
        if (card) container.appendChild(card);
      });
    }
    maybeRenderSuccessBanner(container);
    updateRestartButtons();
  }

  /** Update one card's status elements from its group without rebuilding it. */
  function updateGroupCardInPlace(card, group) {
    const binaryKey = (group.binaryPath || '').replace(/[^a-zA-Z0-9_-]/g, '_');
    const b0 = group.browsers[0];
    const confidentUpToDate = group.browsers.every(function (b) {
      return componentStatus(b, 'config') === 'ok' && componentStatus(b, 'utils') === 'ok';
    });

    // Name + version.  The version refines after ingest without a rebuild:
    // beta/devedition cards first paint the application.ini milestone ("154.0")
    // then the hg-tag display version ("154.0b10"); Waterfox paints the ini
    // version then its GitHub marketing one.
    const title = card.querySelector('.browser-title');
    if (title) title.textContent = group.name;
    const nameLine = card.querySelector('.browser-name-line');
    let version = card.querySelector('.browser-version');
    if (group.version) {
      if (!version) {
        version = document.createElement('span');
        version.className = 'browser-version';
        if (nameLine) nameLine.appendChild(version);
      }
      version.textContent = group.version;
    } else if (version) {
      version.remove();
    }

    // Header badge (hidden by CSS while the card is expanded).
    const headerStatus = groupHeaderStatus(group);
    const headerBadge = card._headerBadge;
    if (headerBadge) {
      headerBadge.className = 'card-status-badge';
      if (headerStatus === 'ok') {
        headerBadge.className += ' badge-uptodate';
        headerBadge.innerHTML = GREEN_CHECK + ' All Up To Date';
      } else if (headerStatus === 'update') {
        headerBadge.className += ' badge-need-update';
        headerBadge.innerHTML = YELLOW_DOT + ' Update Available';
      } else if (headerStatus === 'checking') {
        headerBadge.className += ' badge-checking';
        headerBadge.innerHTML = CHECKING_ICON + ' Checking...';
      } else {
        headerBadge.className += ' badge-missing';
        headerBadge.innerHTML = RED_X + ' Not Installed';
      }
    }

    // Config.js status (shared binary row).
    if (card._configStatus) {
      setConfigStatus(card._configStatus, b0, group.binaryPath);
    }

    // Per-profile utils badges.
    group.browsers.forEach(function (b) {
      const el = document.getElementById('badge-utils-' + b.index);
      if (el) {
        setUtilsStatus(el, b);
      }
    });

    // Collapse once everything is up to date (hash-verified), remembering a
    // manual expansion; a card with pending work is always force-expanded so
    // the needed action stays visible.
    if (confidentUpToDate && !expandedCards[binaryKey]) {
      card.classList.add('card-collapsed');
    } else {
      card.classList.remove('card-collapsed');
    }
    const chev = card.querySelector('.card-chevron');
    if (chev) {
      chev.title = card.classList.contains('card-collapsed') ? 'Show details' : 'Hide details';
    }

    // Re-wire the (possibly replaced) component checkboxes; the button starts
    // disabled — the user picks what to install.
    const btn = card._installBtn;
    if (btn) {
      wireCardCheckboxes(card, btn);
      btn.disabled = true;
    }
  }

  /** Show/refresh the success banner when every active browser is up to date. */
  function maybeRenderSuccessBanner(container) {
    const allDone =
      groups.length > 0 &&
      groups.every(function (group) {
        return group.browsers.every(function (b) {
          return componentStatus(b, 'config') === 'ok' && componentStatus(b, 'utils') === 'ok';
        });
      });
    const existing = container.querySelector(':scope > .success-banner');
    if (allDone && !existing) {
      const doneBanner = document.createElement('div');
      doneBanner.className = 'success-banner';
      doneBanner.innerHTML =
        GREEN_CHECK +
        ' Installation / update finished &mdash; all active browsers and profiles are up-to-date.';
      container.insertBefore(doneBanner, container.firstChild);
    } else if (!allDone && existing) {
      container.removeChild(existing);
    }
  }

  function getBrowserByIndex(idx) {
    for (let i = 0; i < browsers.length; i++) {
      if (browsers[i].index === idx) return browsers[i];
    }
    return null;
  }

  /* ========================================================================
     Per-card Progress Helpers
     ======================================================================== */
  function getCardProgressEls(group) {
    const key = (group.binaryPath || '').replace(/[^a-zA-Z0-9_-]/g, '_');
    const card = document.querySelector('.browser-card[data-binary-key="' + key + '"]');
    if (!card) return null;
    return {
      container: card.querySelector('.card-progress'),
      barFill: card.querySelector('.card-progress-bar-fill'),
      stepDesc: card.querySelector('.card-progress-step'),
      percentEl: card.querySelector('.card-progress-percent'),
      errorEl: card.querySelector('.card-progress-error'),
    };
  }

  /* ========================================================================
     Shutdown helper (also called by beforeunload and exit button)
     ======================================================================== */
  function doShutdown() {
    // Use fetch with keepalive for reliable delivery on tab close
    // keepalive tells the browser not to abort the request on page unload.
    // Send the session token so the server only honors current-run tabs.
    const t = getSessionToken();
    fetch('/api/shutdown' + (t ? '?t=' + t : ''), {method: 'GET', keepalive: true}).catch(
      function () {}
    );
  }

  /* ========================================================================
     UI helpers (Exit / Restart completion)
     ======================================================================== */
  function clearAppAndShowClosed(msg) {
    const container = document.querySelector('.app-container');
    container.innerHTML = '';
    const div = document.createElement('div');
    div.className = 'closed-message';
    div.innerHTML =
      '<h2>' + (msg || 'Firefox Scripts Installer closed &mdash; you may close this tab') + '</h2>';
    container.appendChild(div);
  }

  /** Format "YYYY-MM-DD" as "Aug 1, 2026" (mirrors the updater tab). */
  function formatScriptsDate(dateStr) {
    if (!dateStr) return '';
    const parts = dateStr.split('-');
    if (parts.length !== 3) return '';
    const date = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    if (isNaN(date.getTime())) return '';
    return date.toLocaleDateString('en-US', {year: 'numeric', month: 'short', day: 'numeric'});
  }

  /** Annotate a manual-download link with its last-update date. */
  function setDownloadDate(id, dateStr) {
    const el = document.getElementById(id);
    if (!el) return;
    const formatted = formatScriptsDate(dateStr);
    el.textContent = formatted ? ' (last update ' + formatted + ')' : '';
  }

  /**
   * Download a package zip without navigating the tab or opening a new one.
   *
   * The zip hosts serve the files without Content-Disposition (Pages host), so
   * letting the browser follow the link would navigate the current tab to the
   * zip and trigger the beforeunload shutdown. Opening a new tab (target=_blank
   * / rel=noopener, which Firefox treats as _blank) would leave a blank tab.
   * Instead the zip is fetched (the Pages host is CORS-enabled — the ingest
   * flow already fetches these URLs) and handed to the browser as a same-origin
   * blob URL, where the `download` attribute is honored and the normal save
   * dialog / Downloads-folder behavior applies.
   */
  function downloadPackage(url, filename) {
    return fetchRaw(url, 60000).then(function (buf) {
      const blob = new Blob([buf], {type: 'application/zip'});
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(a.href);
    });
  }

  /**
   * Wire a manual-download link to downloadPackage. The click is always
   * swallowed: a '#' href (URLs not loaded yet) would otherwise jump the page,
   * and a real href must never navigate the tab.
   */
  function wireDownloadLink(link, filename) {
    link.addEventListener('click', function (e) {
      e.preventDefault();
      if (link.getAttribute('href') && link.getAttribute('href') !== '#') {
        downloadPackage(link.href, filename).catch(function (err) {
          console.error('[manual download] ' + filename + ' failed: ' + (err && err.message));
        });
      }
    });
  }

  // Enable the Restart button on every card whose group had a completed
  // install this session and whose Restart was not already clicked (the
  // server consumes the restart scope on a restart, so a re-click without a
  // fresh install would restart nothing new).  Called after each re-render so
  // freshly built cards pick up their restart button state (freshly built
  // cards start disabled).
  function updateRestartButtons() {
    for (let i = 0; i < groups.length; i++) {
      if (!installedGroups[groups[i].binaryPath]) continue;
      if (restartedGroups[groups[i].binaryPath]) continue;
      const key = (groups[i].binaryPath || '').replace(/[^a-zA-Z0-9_-]/g, '_');
      const card = document.querySelector('.browser-card[data-binary-key="' + key + '"]');
      if (!card) continue;
      const btn = card.querySelector('.btn-restart');
      if (btn) {
        btn.disabled = false;
        btn.title = 'Restart the browser(s) of this binary with a clean cache';
      }
    }
  }

  /* ========================================================================
     Init
     ======================================================================== */
  function getSessionToken() {
    const m = /[?&]t=([0-9a-f]{16})/.exec(window.location.search);
    return m ? m[1] : null;
  }

  function initInstallerUI() {
    // Show which server port this tab is connected to, centered above the cards.
    const connEl = document.createElement('div');
    connEl.className = 'conn-indicator';
    connEl.textContent = 'Connected to ' + location.host + ' ...';
    const list = qs('browser-list');
    if (list) {
      list.parentNode.insertBefore(connEl, list);
    } else {
      document.body.insertBefore(connEl, document.body.firstChild);
    }

    function heartbeat() {
      // Ping a dedicated liveness endpoint instead of /api/status: the status
      // handler advances the install state machine one step per call, so using
      // it for heartbeat could consume the final "done" step and make the
      // install poll miss completion (card never re-renders).  The token lets
      // the server count only current-run tabs as alive.
      const t = getSessionToken();
      fetch('/api/ping' + (t ? '?t=' + t : ''))
        .then(function (r) {
          return r.json();
        })
        .then(function () {
          connEl.textContent = 'Connected to ' + location.host + ' (server alive)';
          connEl.setAttribute('data-ok', '1');
        })
        .catch(function () {
          connEl.textContent =
            'Server at ' + location.host + ' is NOT reachable - restart the installer';
          connEl.removeAttribute('data-ok');
        });
    }
    // Establish the server-alive state right away instead of waiting for the
    // first 3s interval tick: without this the "Connected ... (server alive)"
    // label only appears after the cards are already visible.
    heartbeat();
    setInterval(heartbeat, 3000);

    // "Open folder" buttons are built dynamically (binary + profile rows) with
    // data-browser/data-kind; one delegated listener serves every card,
    // including cards rebuilt after an in-place status refresh.
    document.addEventListener('click', function (e) {
      const btn = e.target && e.target.closest ? e.target.closest('.btn-open-folder') : null;
      if (!btn) return;
      const idx = btn.getAttribute('data-browser');
      const kind = btn.getAttribute('data-kind');
      if (!idx || !kind) return;
      const t = getSessionToken();
      fetchJSON('/api/open-folder?browser=' + idx + '&kind=' + kind + (t ? '&t=' + t : '')).then(
        function (data) {
          if (!data || data.error) console.error('[open-folder] failed:', data && data.error);
        }
      );
    });

    // Banner starts hidden
    qs('update-banner').style.display = 'none';
    checkSelfUpdate();
    // Reveal the test/dev build banner up front on --local / --mode=dev builds.
    showBuildBanner();

    // Manual download bar: fetch the package URLs once and set them on two
    // links.  A click is intercepted and the zip is downloaded via
    // downloadPackage() (fetch -> blob URL -> <a download>): the current tab
    // is never navigated (navigating to the zip would trip the beforeunload
    // shutdown) and no blank tab is opened (no target=_blank / rel=noopener).
    // Each click is its own user gesture — no popup blocker, no
    // multi-download protection, and with the 'Ask where to save files
    // before downloading' preference each file shows its own save dialog.
    //
    // The tab is the installer's only network access: fetch every external
    // payload and POST it to the local server.  To keep startup fast, the
    // browser cards are painted from the LOCAL /api/browsers snapshot as soon
    // as it resolves (components show "Checking..." until the hash manifest is
    // ingested), then refined in place once the remote packages arrive.  If
    // the packages later turn out to be unreachable, the cards are replaced by
    // the blocked notification — a rare offline-only flash traded for cards
    // that appear immediately on every healthy startup.
    const container = qs('browser-list');
    container.innerHTML = '<div class="scanning-indicator">Scanning for running browsers...</div>';

    let browsersData = null;
    let pkg = null;

    const browsersLoaded = fetchJSON('/api/browsers').then(function (data) {
      browsersData = data;
      // Paint immediately from the local snapshot (data may be []).  A null
      // response means the local server is not answering yet: keep the
      // scanning indicator and let the Promise.all path handle the error.
      if (!installBlocked && data) {
        renderBrowsers(data);
        revealCards(container);
      }
      return data;
    });

    const pkgPromise = fetchJSON('/api/package-urls').then(function (data) {
      const pkgBar = qs('manual-download-bar');
      const linkFx = qs('link-download-fx');
      const linkUtils = qs('link-download-utils');
      if (!pkgBar || !linkFx || !linkUtils) return null;
      if (data && data.utilsUrl && data.fxFolderUrl) {
        linkFx.href = data.fxFolderUrl;
        linkUtils.href = data.utilsUrl;
        wireDownloadLink(linkFx, 'fx-folder.zip');
        wireDownloadLink(linkUtils, 'utils.zip');
        // Annotate each link with its last-update date (smaller font).
        setDownloadDate('fx-download-date', data.fxFolderDate);
        setDownloadDate('utils-download-date', data.utilsDate);
        pkgBar.style.display = 'flex';
        pkg = data;
        return data;
      }
      return null;
    });

    Promise.all([browsersLoaded, pkgPromise])
      .then(function () {
        const finish = function () {
          // Manifest dates are now known: refresh the link annotations.
          fetchJSON('/api/package-urls').then(function (pkg2) {
            if (pkg2) {
              setDownloadDate('fx-download-date', pkg2.fxFolderDate);
              setDownloadDate('utils-download-date', pkg2.utilsDate);
            }
          });
          checkSelfUpdate();
          // The cards were already animated on the early render; this is a
          // no-op when the container is already .revealed.
          revealCards(container);
        };

        if (!pkg) {
          // Server gave no URLs — nothing can be fetched or installed.
          showNetworkError();
          renderInstallBlocked();
          finish();
          return;
        }

        // The tab is the installer's only network access: fetch every
        // external payload and POST it to the local server, then re-sync the
        // status flags (hashes/versions) and the self-update banner.
        const ingest = ingestRemoteData(pkg, browsersData);

        // Fast status path: the small hash manifest resolves long before the
        // package zips, so refresh the already-rendered "Checking..." cards
        // the moment it lands — the install/update buttons become actionable
        // without waiting for the still-downloading zips.  The final refresh
        // below still runs afterwards to refine versions once every ingest
        // (zips, Waterfox releases, hg tags) has completed.
        ingest.manifestReady.then(function (ready) {
          if (!ready) return;
          fetchJSON('/api/browsers').then(function (fresh) {
            if (fresh) {
              try {
                updateAllCardsInPlace(fresh);
              } catch (e) {
                showDebug('Render error (status): ' + (e && e.message));
              }
            }
          });
        });

        ingest.done.then(function (ingest) {
          if (ingest && ingest.zipsFailed) {
            // Packages unreachable: nothing can be installed or updated.
            // Show the blocked notification (the network-error banner above
            // already explains the issue); the manual-download links and
            // self-update banner stay functional.
            renderInstallBlocked();
            finish();
            return;
          }
          // Zips (and optionally the manifest) are available.  Re-fetch the
          // browser list AFTER the ingests: the manifest and Waterfox-releases
          // POSTs re-evaluate hash status and versions on the server, so the
          // pre-ingest snapshot would render presence-based flags and the
          // application.ini fallback version.  Refine the already-rendered
          // cards in place so nothing re-animates or flashes.
          fetchJSON('/api/browsers').then(function (fresh) {
            if (fresh) {
              try {
                updateAllCardsInPlace(fresh);
              } catch (e) {
                showDebug('Render error (validated): ' + (e && e.message));
              }
            } else if (browsersData) {
              try {
                updateAllCardsInPlace(browsersData);
              } catch (e) {
                showDebug('Render error (fallback): ' + (e && e.message));
              }
            } else {
              container.innerHTML = [
                '<div class="empty-state">',
                '  <h3>Could Not Reach Installer</h3>',
                '  <p>Make sure the Firefox Scripts Installer server is running.</p>',
                '</div>',
              ].join('');
            }
            finish();
          });
        });
      })
      .catch(function () {
        // Local server error while loading the package URLs — the packages
        // cannot be reached, so show the blocked notification.
        showNetworkError();
        renderInstallBlocked();
        revealCards(container);
      });

    // NOTE: the beforeunload->shutdown handler is NOT registered here.  It is
    // registered by the DOMContentLoaded handler only for a tab carrying the
    // CURRENT session token (verified via /api/claim).  A manually-opened
    // page (no ?t= token) or a stale restored tab must not kill the installer
    // when closed or refreshed — the tab is the installer's only UI and its
    // recovery path ("reload the installer tab") must survive.

    // Wire the Rescan button: ask the server to re-run browser detection,
    // then re-render the cards from a fresh /api/browsers snapshot — a browser
    // opened after startup gets a card, one that was closed loses its card.
    const btnRescan = qs('btn-rescan');
    if (btnRescan) {
      btnRescan.addEventListener('click', function () {
        const t = getSessionToken();
        btnRescan.disabled = true;
        fetchJSON('/api/rescan' + (t ? '?t=' + t : ''))
          .then(function (data) {
            if (!data || !data.ok) return null;
            return fetchJSON('/api/browsers');
          })
          .then(function (fresh) {
            if (fresh) {
              try {
                updateAllCardsInPlace(fresh);
              } catch (e) {
                showDebug('Render error (rescan): ' + (e && e.message));
              }
            }
          })
          .catch(function () {
            // The heartbeat surfaces server reachability; ignore here.
          })
          .then(function () {
            btnRescan.disabled = false;
          });
      });
    }

    // Wire exit button
    const btnExit = qs('btn-exit');
    if (btnExit) {
      btnExit.addEventListener('click', function () {
        btnExit.disabled = true;
        const t = getSessionToken();
        fetch('/api/shutdown' + (t ? '?t=' + t : ''), {method: 'GET', keepalive: true})
          .catch(function () {})
          .then(function () {
            // Best effort tab close: only script-opened tabs honor
            // window.close(), so the closed-message fallback below covers
            // the rest (if close succeeded the page is gone and the timeout
            // never fires).
            try {
              window.close();
            } catch {
              // best effort — see the comment above
            }
            setTimeout(clearAppAndShowClosed, 300);
          });
      });
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    // A restored tab from a PREVIOUS installer run points at the same fixed
    // port but carries an old ?t= session token.  Detect it and show a
    // "closed" placeholder instead of the installer UI, and never register the
    // beforeunload shutdown handler, so closing the stale tab doesn't kill the
    // current installer.
    const token = getSessionToken();
    if (!token) {
      // Manually-opened page (no token).  Render the UI but do NOT register
      // the close->shutdown handler: closing or refreshing this tab must not
      // stop the installer.  The Exit button still works (explicit action).
      initInstallerUI();
      return;
    }
    fetchJSON('/api/claim?t=' + token)
      .then(function (data) {
        if (data && !data.current) {
          clearAppAndShowClosed(
            'This installer tab is from a previous session &mdash; you may close it.'
          );
          return;
        }
        // Current-session tab: closing it stops the installer.
        window.addEventListener('beforeunload', function () {
          doShutdown();
        });
        initInstallerUI();
      })
      .catch(function () {
        // Claim failed (server not answering yet?): treat as current and
        // register the handler so closing the tab still stops the installer.
        window.addEventListener('beforeunload', function () {
          doShutdown();
        });
        initInstallerUI();
      });
  });
})();
