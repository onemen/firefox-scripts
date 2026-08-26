# 0002: Hash-based update detection with manifest-driven file lists

- **Status:** accepted
- **Date:** 2026-08-01

## Context

The previous in-browser updater (`scriptsUpdater.js` / `scriptsUpdater.xhtml`) was never tested and
was reverted (`d43fb4e`): the loader imported a `.sys.mjs` module that never existed, the check
compared the manifest `date` against `versionInfo.json` (0001) so it could never fire after a real
install, the config "update" only downloaded a zip instead of writing into the browser directory,
and the hash code was dead/buggy. The installer already had a proven, tested hash-based status
logic; the updater rewrite should reuse it rather than invent a second pipeline. The installer also
previously kept its own hardcoded file lists, which drifted from the published packages.

## Decision

Update detection is hash-based, per package, with **no version numbers**: SHA-256 over the sorted
relative paths (`rel_path + "\n"` followed by the file bytes); a missing file contributes only its
path. The canonical file list is read from the published manifest's `files` array — no hardcoded
lists in the installer or updater (`5e54f4e`). `versionInfo.json` is obsolete (0001); the manifest
`date` is display-only. Waterfox bundles the legacy BootstrapLoader, so `config.js` skips only that
load on Waterfox.

## Consequences

One hash pass yields both presence (≥1 file present → installed) and aggregate status (equal → up to
date). Both sides must hash the **same** file set: the publish-side `files` array is the single
source of the list, so a listed-but-missing file on disk makes local and published hashes diverge
forever. Partial installs hash deterministically (missing = path only). Revisit-if: versioned
artifacts are needed, or the file list gains a second maintainer.
