  /* ========================================================================
     Self-Update Banner — date-based (ADR 0019 amendment)

     The tab ingests two payloads before asking the server for a verdict:
       • /api/package-urls.releasesUrl — the releases listing (newest first);
         the newest managed installer-<date> body wins (a fresh installer
         publish is never masked by a scripts-only republish of `latest`)
       • /api/package-urls.selfUpdateUrl — the latest release (fallback,
         covers a repo where no installer-<date> release exists yet)
     The C side parses the managed installerDate/download block and compares
     it with the binary's baked build date.  Local/dev test builds never
     check: the snapshot exists to test THIS build.
     ======================================================================== */
  let selfUpdateIngested = false;

  function ingestSelfUpdateSource(url) {
    if (!url) return Promise.resolve(false);
    return fetchRaw(url)
      .then(function (buf) {
        return postRaw('/api/self-update', buf);
      })
      .then(function (res) {
        // Return the actual success so ingestSelfUpdateSources falls through
        // to the selfUpdateUrl fallback when the releases POST is rejected
        // (CodeRabbit review:batch, PR #238); selfUpdateIngested still only
        // sticks on a successful ingest.
        const ok = Boolean(res && res.ok);
        if (ok) selfUpdateIngested = true;
        return ok;
      })
      .catch(function (err) {
        console.error('[ingest] self-update release fetch failed: ' + (err && err.message));
        return false;
      });
  }

  function ingestSelfUpdateSources(pkg) {
    if (selfUpdateIngested) return Promise.resolve();
    // Newest managed installer-<date> body first; the latest release as
    // fallback.  Harmless duplicate ingests: the server just overwrites.
    return ingestSelfUpdateSource(pkg && pkg.releasesUrl).then(function (managed) {
      if (!managed) return ingestSelfUpdateSource(pkg && pkg.selfUpdateUrl);
      return null;
    });
  }

  function checkSelfUpdate() {
    fetchJSON('/api/build-info')
      .then(function (info) {
        if (info && info.selfUpdateDisabled) return null;
        return fetchJSON('/api/package-urls').then(ingestSelfUpdateSources);
      })
      .then(function () {
        if (!selfUpdateIngested) return null;
        return fetchJSON('/api/self-update').then(function (data) {
          if (!data || data.error) {
            // Silently ignore network/API errors -- banner stays hidden
            return null;
          }
          if (data.updateAvailable) {
            qs('new-version-tag').textContent = data.latestDate;
            const currentEl = qs('current-date-tag');
            if (currentEl && data.buildDate) currentEl.textContent = data.buildDate;
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
                // A newer build is published but the managed block has no URL
                // for this platform yet — fall back to the releases page.
                window.open(
                  'https://github.com/onemen/firefox-scripts/releases',
                  '_blank',
                  'noopener'
                );
              }
            };
          }
          return null;
        });
      })
      .catch(function () {
        /* banner stays hidden on any failure */
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

