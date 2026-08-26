# 0016: Dedicated chrome://firefox-scripts content namespace

- **Status:** accepted
- **Date:** 2026-08-01

## Context

The updater modules and tab UI resolve under `chrome://…` URIs. Reusing the userChromeJS loader's
`content userchromejs` namespace would couple the updater's URLs to the loader's and break on
subfolder moves; a dedicated namespace keeps the updater self-contained. The rationale was dropped
from `docs/auto-updater.md` during the 0006/0007 rewrites, so it is recorded here.

## Decision

`chrome.manifest` maps a dedicated `content firefox-scripts updater/` namespace; the updater
resolves `chrome://firefox-scripts/content/…`, and the tab UI lives under
`chrome://firefox-scripts/content/ui/…`. `utils.zip` and `updater-ui.zip` share it, so both packages
resolve without manifest changes.

## Consequences

The updater's URLs are independent of the loader namespace and survive subfolder moves; the
`chrome.manifest` mapping is the single registration point. Revisit-if: the updater merges into the
userChromeJS loader namespace.
