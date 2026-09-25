# 0035: Installer binaries ship sha256 sidecars everywhere they go

- **Status:** accepted
- **Amends:** [0019](./0019-release-versioning.md) (completes its 2026-09-09 helper-only sidecar
  scheme for the installer; declared here per the ADR 0029 convention)
- **Date:** 2026-09-24

Related: [0027](./0027-machine-fetches-on-publish-branch.md) (machine fetches read the publish
branch), [0024](./0024-release-asset-set.md) (asset naming under [0019]'s stable-name rule).

## Context

The 2026-09-09 helper-sidecar amendment (#174, issue #33) shipped checksum sidecars for the helper
only; the installer — the artifact that elevates and rewrites the install dir — shipped with no
verification data at all (issue #324). How checksums are published is a decision of its own, not
release versioning: it touches every publish surface and the self-update URL resolution, none of
which 0019 governs.

## Decision

- **Every installer binary gains a `<installer asset name>.sha256` sidecar** —
  `installer_win.exe.sha256` on Windows, `installer_linux.sha256` / `installer_linux_aarch64.sha256`
  / `installer_mac.sha256` elsewhere (`<hex>  <name>` per sha256sum — byte-identical format to the
  helper's, one shared renderer in `hashUtils.mjs`). Sidecars ride the installer everywhere it goes:
  `latest` release assets, the `installer-<date>` component releases, the gh-pages mirror,
  dev-build-* branches, and local snapshots. They are derived from the staged bytes at publish time,
  never reused, and are not hashed content — `hashes.json` is untouched.
- **The managed self-update download map stays binary-only.** The C parser resolves its URL by a
  plain substring search for the asset name, and `installer_win.exe` is a prefix of
  `installer_win.exe.sha256` — a sidecar entry would shadow the binary's URL.
- **No consumer change yet.** Verifying the downloaded installer against its sidecar (the #174
  mirror for the installer) is a tracked follow-up; until then the sidecars serve manual
  verification and the future consumer.
- Nothing is removed: fixed asset names stay fixed, sidecars are purely additive (a partial publish
  that ships an installer ships its sidecar too).

## Consequences

Manual verification now covers the elevated artifact, not just the helper, at the cost of one more
asset per platform in every publish surface. The substring-shadow constraint becomes load-bearing:
any future managed-download entry keyed by asset name must not collide with a `.sha256` suffix —
component releases key the sidecar separately and the sync loop filters on that suffix (pinned by
`test/unit/publish/installerSha256.test.mjs`). Revisit-if: the installer gains a tab-side sidecar
check (the tracked follow-up) — this record then gains the consumer contract.
