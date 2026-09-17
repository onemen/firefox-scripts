  /* ========================================================================
     Init
     ======================================================================== */
  function getSessionToken() {
    const m = /[?&]t=([0-9a-f]{32})/.exec(window.location.search);
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
