# 0024: Release asset set — ARM64 Linux pair and universal macOS installer

- **Status:** accepted
- **Date:** 2026-09-09
- **Extends:** [0019](./0019-release-versioning.md) (release versioning — stable names, date tags,
  moving `latest`). The versioning decision is unchanged; this record enumerates what the asset set
  is.

## Context

[0019] fixed the artifact _naming scheme_ but predates the platform expansion of PRs
[#165](https://github.com/onemen/firefox-scripts/pull/165) and
[#166](https://github.com/onemen/firefox-scripts/pull/166): Windows-only installers no longer cover
the supported surface — issue [#132](https://github.com/onemen/firefox-scripts/issues/132) (ARM64
Linux) and the universal-mac decision (Linux/macOS parity for v1.0, recorded on issue #4) added
platforms, and the enumerations in [0019] no longer matched what the publish pipeline ships.

## Decision

- The `latest` release carries exactly: `utils.zip`, `fx-folder.zip`, `installer_win.exe`,
  `installer_linux` (x86_64), `installer_linux_aarch64`, `installer_mac` (**universal** — one
  x86_64 + arm64 asset, CI-verified with `lipo`).
- gh-pages serves the fetch-side twins: `updater-ui.zip`, `helper_win.exe`, `helper_linux`,
  `helper_linux_aarch64`, `helper_mac` — never release assets ([0019]'s rule, unchanged).
- Names stay permanent and unversioned; per-component date tags and the moving `latest` follow
  [0019] exactly. New platforms extend the set; they never rename or version existing artifacts.

## Consequences

`tools/publish/paths.js` and the publish manifests are the machine-readable enumeration; this record
is the "why" for humans: platform parity was a v1.0 requirement, and the asset set grows additively
from here. `docs/ci-inventory.md` rows stay synchronized with the CI legs that build and verify each
artifact. Revisit-if: a platform is dropped upstream or a packaging format changes — then supersede
this record rather than renaming artifacts.
