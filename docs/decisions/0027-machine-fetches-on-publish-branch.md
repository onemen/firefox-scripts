# 0027: Machine fetches live on the publish branch; releases are the human surface

- **Date:** 2026-09-14
- **Status:** accepted

## Context

The artifact surface spans two hosts: the `gh-pages` publish branch (zips, helpers, `hashes.json`,
`updater-ui.zip` — CORS-enabled, required by the localhost installer tab) and GitHub release assets
attached to `latest` (zips + installers — for humans). Before this record the in-browser updater
still fetched its package zips from `releases/download/latest` (`ZIP_BASE_URL`), so the two
privileged consumers disagreed on the zip host, and any future Pages-hosting migration would have
had to touch fetch URLs baked into every installed browser.

## Decision

Every **machine** fetch — installer tab, in-browser updater, helper download, manifest check — reads
from the publish branch (`ZIP_BASE_URL` = `ZIP_PAGES_URL` = `HELPER_BASE_URL`, all the gh-pages host
in prod; the dev-build branch via jsDelivr in dev). GitHub **releases** are the human surface:
manual downloads, archive browsing, the dated component releases the self-update listing reads via
the releases _API_ (metadata, not artifact bytes).

Consequences:

- `config/installer.conf` pins one host; the generators propagate it (a config change shifts the
  package hashes, so new URLs reach installed browsers with the next publish — the designed
  propagation).
- Migrating Pages hosting (e.g. to the GitHub Actions deployment model) touches only
  `tools/publish/uploadToPages.mjs` — the single upload seam — and no fetch URL, because the public
  URL is unchanged by that migration.
- Release-asset zips stay published (humans expect them; README revert instructions and the future
  download page link them), but nothing automated fetches from `releases/download/*`.
- Bandwidth for machine fetches moves to Pages, which serves exactly the files that are needed per
  check (manifest + changed zips) instead of the release-asset CDN redirect chain.

## Extends

- [0003](./0003-hash-manifest-on-gh-pages.md) — the manifest's host becomes the host for all
  artifact fetches, not just the manifest.
- [0026](./0026-publish-channels-and-dead-channel-fallback.md) — the stable-channel fallback URLs in
  dev builds derive from the same literal (gh-pages), not from release assets.
