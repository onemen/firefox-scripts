# 0019: Release versioning — stable artifact names, date-stamped component tags, moving `latest`

- **Status:** accepted
- **Date:** 2026-08-27

## Context

Publishing currently uploads the release assets to one `latest` release (`RELEASE_NAME` in
`config/installer.conf`). Artifacts are fetched by **fixed names**, but not all from the release:
the release serves `utils.zip`, `fx-folder.zip` and `installer_<os>`; the CORS-enabled gh-pages
branch serves `updater-ui.zip`, `helper_<os>` and `hashes.json` — the ui zip and helpers are never
release assets, because the privileged updater fetches them from the branch (issue #102: the
scheduler once pointed at the release for the ui zip and silently 404'd). Names are baked into
`updater-config.sys.mjs` and [0013]'s config, so artifact names must never change per version. Users
asked for: no versioned zip names (`utils-1.0.1.zip` would break the updater URLs and unzip into a
`utils-1.0.1/` folder), no "new version" signal when only the installer changed, and a version that
communicates freshness without pretending every package changed.

## Decision

- Artifact names are **permanent and unversioned**. The `latest` release carries exactly the package
  zips + installers: `utils.zip`, `fx-folder.zip`, `installer_win.exe` / `installer_linux` /
  `installer_linux_aarch64` / `installer_mac` (universal x86_64 + arm64 — one asset, both slices).
  `updater-ui.zip` and `helper_<os>` (also covering `helper_linux_aarch64`) are gh-pages-branch
  artifacts — never release assets.
- Releases are tagged **per component + date**: `scripts-<YYYY-MM-DD>` (the zips) and
  `installer-<YYYY-MM-DD>` (installer + helper binaries). A component release is created only when
  that component changed.
- `latest` (existing moving tag) always carries the **complete release asset set** — both package
  zips + the installers — and stays GitHub's "Latest"; component releases are created with
  `make_latest=false`. README, docs and the updater point only at `latest` — never at versioned
  URLs.

## Amendment (2026-09-09)

The asset set grew without touching the decision:
[#166](https://github.com/onemen/firefox-scripts/pull/166) added the ARM64 Linux pair
(`installer_linux_aarch64` as a release asset, `helper_linux_aarch64` on gh-pages) and
[#165](https://github.com/onemen/firefox-scripts/pull/165) made `installer_mac` universal (x86_64 +
arm64 in the one asset, CI-verified with `lipo`). Names stay unversioned and permanent;
per-component date tags and the moving `latest` are unchanged.

## Consequences

A new installer never re-publishes unchanged zips: no re-upload, no hash churn, no user confusion.
Humans read the date tags; machines keep reading `hashes.json` ([0002]) — the date is a lookup aid,
not an update mechanism. The stable `latest` URL keeps the updater/README links constant. Added
cost: publishing stamps two extra tags per release — the pipeline work belongs in publish automation
[#33](https://github.com/onemen/firefox-scripts/issues/33) under the v1.0 gate (the `latest`-tag
move already ships, P0-1/#40). Revisit-if: users need semantic version comparisons — only then add
semver aliases on top, never rename artifacts.
