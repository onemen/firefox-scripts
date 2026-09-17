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
    if (/[?&]t=[0-9a-f]{32}/.test(path)) return path;
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
        // NOTE: the self-update release JSON is NOT ingested here — it is
        // owned by ingestSelfUpdateSources() (releases-list first, latest
        // fallback).  A POST of the raw latest-release body here would
        // overwrite the managed installer payload with a block-less one and
        // the banner would silently never show.
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

