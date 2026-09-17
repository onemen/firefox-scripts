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

