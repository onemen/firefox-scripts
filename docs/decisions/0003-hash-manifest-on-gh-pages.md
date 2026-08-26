# 0003: Hash manifest published to the gh-pages branch, not a Gist

- **Status:** accepted
- **Date:** 2026-08-06

## Context

The early publish pipeline wrote the per-package hash manifest to a GitHub Gist. The installer tab —
and the browser-fetch architecture ([0005](./0005-installer-zero-network-io.md)) — needs to fetch
the manifest from the web. GitHub Pages sends `Access-Control-Allow-Origin: *` while Gists and
release-asset CDNs do not (release assets only 302 to a CDN with no CORS header). The manifest also
changes more often than a release and must be pushed content-addressed so an idle run creates no
commit.

## Decision

The hash manifest (`hashes.json`) lives on the **gh-pages** branch, pushed in a single
content-addressed commit per publish run (`uploadToPages.mjs`), and served at
`https://<owner>.github.io/<repo>/hashes.json`. The Gist is gone (`c897d6a`, 2026-08-06).

## Consequences

The browser tab and the in-browser updater can fetch the manifest cross-origin. The branch is also
the home of the helper binaries and the installer-facing zips, so one CORS-enabled host serves
everything the tab needs. Revisit-if: a host with proper CORS headers and atomic updates replaces
the branch (e.g. a future docs site's static host).
