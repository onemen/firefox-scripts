# 0013: config/installer.conf is the single source of truth

- **Status:** accepted
- **Date:** 2026-08-01

## Context

URLs and paths (repo owner/name, release tag, hashes URL, zip base, helper base, default port) had
to stay consistent across the C installer, the publish scripts and the in-browser updater; they
drifted when edited in several places.

## Decision

All shared values live in `config/installer.conf`. Generators expand it into
`installer/src/_config.h` (C, Makefile `config` target), `tools/publish/paths.js` (JS) and
`core/chrome/utils/updater/updater-config.sys.mjs` (updater, at publish time). Changing one line —
e.g. `RELEASE_NAME` — propagates everywhere, and because `updater-config.sys.mjs` ships inside
`utils.zip`, a URL change shifts the package hash and the updater treats it as an update (`d6f193c`,
2026-08-01).

## Consequences

One place to edit, and config changes flow through the hash-based detector
([0002](./0002-hash-based-update-detection.md)). Secrets are excluded by convention — tokens live in
`.env`, never in `installer.conf`. Revisit-if: the config outgrows key/value lines (e.g. per-browser
overrides).
