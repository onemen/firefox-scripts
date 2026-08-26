# 0001: versionInfo.json and a GitHub Gist were the update-version mechanism

- **Status:** superseded by [0002](./0002-hash-based-update-detection.md)
- **Date:** 2026-01-05

## Context

The upstream firefox-scripts tree shipped `versionInfo.json` as the version source for update checks
(`a24af78`, 2026-01-05).The 2026 installer / publish rewrite inherited it: the early publish
pipeline published per-package hashes **and** `versionInfo.json` to a **GitHub Gist** (`9b91fda`,
2026-07-28 — `updateGistHashes` in the first `checkAndUpload.mjs`), and the updater compared the
manifest's `date` against the local `versionInfo.json`. Meanwhile the installer treated
`versionInfo.json` as an obsolete file — excluded from the hash and deleted after install — so after
a real install the file did not exist and the date-based check could never fire. A transitional
state kept it shipping inside the zips "for an external update-checker" before it was removed
entirely (`c943037`, 2026-08-10).

## Decision

Drop `versionInfo.json` and the Gist as version/update sources. Update detection is hash-based
([0002](./0002-hash-based-update-detection.md)) and the manifest's `date` field is display-only.
`versionInfo.json` is excluded from the zips and the hash; previously-installed copies are deleted
after install (`installer/src/obsolete_files.h`).

## Consequences

No version numbers to compare, so any source change propagates as a hash change. External consumers
that relied on `versionInfo.json` inside the zips lost it. Revisit-if: a marketing version or
rollout channel ever needs versioned artifacts.
