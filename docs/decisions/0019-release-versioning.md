# 0019: Release versioning — stable artifact names, date-stamped component tags, moving `latest`

- **Status:** accepted
- **Date:** 2026-08-27

## Context

Publishing currently uploads everything to one `latest` release (`RELEASE_NAME` in
`config/installer.conf`). The updater and the installer tab fetch artifacts by **fixed names** from
`releases/download/latest/...` (`utils.zip`, `fx-folder.zip`, `updater-ui.zip`, `installer_<os>`,
`helper_<os>` — baked into `updater-config.sys.mjs`, [0013]) so artifact names must never change per
version. Users asked for: no versioned zip names (`utils-1.0.1.zip` would break the updater URLs and
unzip into a `utils-1.0.1/` folder), no "new version" signal when only the installer changed, and a
version that communicates freshness without pretending every package changed.

## Decision

- Artifact names are **permanent and unversioned**: `utils.zip`, `fx-folder.zip`, `updater-ui.zip`,
  `installer_win.exe` / `installer_mac` / `installer_linux`, `helper_<os>`.
- Releases are tagged **per component + date**: `scripts-<YYYY-MM-DD>` (the zips) and
  `installer-<YYYY-MM-DD>` (installer + helper binaries). A component release is created only when
  that component changed.
- `latest` (existing moving tag) always carries the **complete asset set** and stays GitHub's
  "Latest"; component releases are created with `make_latest=false`. README, docs and the updater
  point only at `latest` — never at versioned URLs.

## Consequences

A new installer never re-publishes unchanged zips: no re-upload, no hash churn, no user confusion.
Humans read the date tags; machines keep reading `hashes.json` ([0002]) — the date is a lookup aid,
not an update mechanism. The stable `latest` URL keeps the updater/README links constant. Added
cost: publishing stamps two extra tags per release — the pipeline work belongs in publish automation
[#33](https://github.com/onemen/firefox-scripts/issues/33) under the v1.0 gate (the `latest`-tag
move already ships, P0-1/#40). Revisit-if: users need semantic version comparisons — only then add
semver aliases on top, never rename artifacts.
