  /* ========================================================================
     Installation (group-level: install to all profiles in group)
     ======================================================================== */
  function startGroupInstall(group) {
    // Strict checkbox gating (#180 follow-up): a component is installed only
    // when the user explicitly checks its checkbox.  The Install button is
    // disabled until at least one checkbox on the card is checked, so the
    // checked set is always the exact install set — nothing rides along.
    installQueue = [];
    // Resolve this group's card ONCE via its sanitized data-binary-key (the
    // same key derivation as getCardProgressEls).  The config checkbox is then
    // queried card-scoped: matching on data-group with the raw binary path is
    // unreliable because Windows paths contain backslashes, which CSS
    // attribute-selector strings treat as escape sequences (e.g. "C:\\Program"
    // parses as "C:Program"), so the selector silently fails and config gets
    // installed even when its checkbox was left unchecked.
    const binaryKey = (group.binaryPath || '').replace(/[^a-zA-Z0-9_-]/g, '_');
    const groupCard = document.querySelector('.browser-card[data-binary-key="' + binaryKey + '"]');

    group.browsers.forEach(function (b, idx) {
      const configChk = groupCard ? groupCard.querySelector('.chk-config') : null;
      const utilsChk = qs('chk-utils-' + b.index);

      // config.js lives in the shared binary dir, so it only needs to be
      // installed ONCE per group (first profile) - avoids double UAC prompts.
      // No config checkbox rendered means its badge shows "Up To Date" —
      // a missing checkbox selects nothing.
      const doConfig = idx === 0 && Boolean(configChk && configChk.checked);

      // Same rule as config: a missing utils checkbox means its badge shows
      // "Up To Date" — never auto-install a component the UI did not offer.
      const doUtils = Boolean(utilsChk && utilsChk.checked);

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
        'browsers=' + (group.browsers ? group.browsers.length : 'none'),
        'configUpToDate=' +
          (group.browsers && group.browsers[0] ? group.browsers[0].configUpToDate : 'n/a'),
        'utilsUpToDate=' +
          (group.browsers && group.browsers[0] ? group.browsers[0].utilsUpToDate : 'n/a')
      );
      showDebug('Nothing to install: no component checkbox is checked.');
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

