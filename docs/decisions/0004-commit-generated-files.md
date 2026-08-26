# 0004: Generated files committed and synced by git hooks

- **Status:** superseded by [0008](./0008-generated-files-untracked.md)
- **Date:** 2026-08-02

## Context

The installer C build and the publish pipeline depend on generated files (`installer/src/_config.h`,
`installer/src/resources.h`, `core/chrome/utils/updater/updater-config.sys.mjs`) derived from
`config/installer.conf` and `installer/web/*`. Committing them seemed to give a self-contained
fresh-clone C build and pinned zip content.

## Decision

Commit the generated files and keep them in sync with git: pre-commit / pre-push / post-rewrite
hooks plus an `install-githooks.mjs` installer (`core.hooksPath`), and a publish gate in
`upload.mjs` that verified committed-vs-fresh before every prod publish (`9d2deb2`, 2026-08-02).

## Consequences

Real costs: `resources.h` is a gzip byte-array, so a one-line UI change re-encoded the whole stream
(~1.4k-line diffs); hooks had to be installed per clone and could be bypassed (`--no-verify`,
rebases, amends); every prod publish ran a sync gate. Reversed 2026-08-18
([0008](./0008-generated-files-untracked.md)). Revisit-if: a consumer that cannot run Node at build
time appears.
