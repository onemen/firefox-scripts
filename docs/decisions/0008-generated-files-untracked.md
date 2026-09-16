# 0008: Generated files untracked, regenerated on demand

- **Status:** accepted
- **Date:** 2026-08-18
- **Amended:** 2026-09-16 — the source-coverage mapping is no longer hand-maintained:
  `tools/publish/generatedRegistry.mjs` is the single registry (generated files, their shipping
  rels, scan excludes, installer-hash excludes), and `test/unit/generatedRegistry.test.mjs` fails
  `pnpm test` when a generated file's hash-input wiring is missing — the trap below is now
  mechanical, not remembered

## Context

Committing the generated files ([0004](./0004-commit-generated-files.md)) cost diff noise (a
one-line CSS edit re-encoded the whole gzip byte-array in `resources.h`), hook machinery
(pre-commit/pre-push/post-rewrite + `core.hooksPath` + `install-githooks.mjs`) and a
committed-vs-fresh sync gate before every prod publish. None of it was necessary: the Makefile and
`createZip.mjs` already ran Node to regenerate the files, so a fresh clone never depended on the
committed copies.

## Decision

The generated files (`updater-config.sys.mjs`, `updater.css`, `_config.h`, `resources.h`) are
**gitignored and regenerated on demand** — by the Makefile on every build, by `createZip.mjs` at
publish time, or by hand via `node tools/publish/syncGeneratedFiles.mjs`. The git hooks, the
`prepare` script and the publish sync gate are deleted. Publish hashes are re-pointed at the **true
sources**: the utils/updater-ui sets explicitly add back their generated files (`extraFiles`), and
the installer hash covers `installer/src` + `installer/web/*` + `config/installer.conf`
(`computeFileSetHash`). `upload` deletes the generated files from disk when it finishes
(`cleanGenerated`), so the working tree always matches a fresh clone (`1ee0b83`, 2026-08-18).

## Consequences

No hook machinery, no diff noise, and a UI/config change still bumps the package hashes — but only
because the hash inputs were reworked to name the sources, not the artifacts. The trap: if a
generated file is added or removed without updating the hash inputs, updates silently stop
propagating. **Closed 2026-09-16** (see Amended): add the file to
`tools/publish/generatedRegistry.mjs` and the tests enforce the rest — an unwired generated file
fails `pnpm test`. Revisit-if: a deterministic-publish CI check (run `upload:local` twice and diff
the snapshots) is wanted, or a non-Node consumer appears.
