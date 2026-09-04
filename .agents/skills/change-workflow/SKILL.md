---
name: change-workflow
description:
  Step-by-step workflow for making code changes in this repository — identify the subsystem, read
  the right docs and skills, avoid generated files, make the smallest change, regenerate, and
  validate with the matching test. Use when planning or starting any code change, or when the user
  asks about the process.
---

# Making a change

## Before editing

1. **Identify the affected subsystem** — installer (`installer/`), chrome scripts (`core/`), web UI
   (`installer/web/`), publish tooling (`tools/publish/`), or docs (`docs/`).
2. **Read the relevant docs** — `docs/DEVELOPING.md` first (structure, build, tests, CI);
   `docs/auto-updater.md` / `docs/status-logic.md` for the updater; the decision log
   `docs/decisions/index.md` (steering veto list) before any architectural or design change;
   `docs/local_plan/` drafts when they cover the area.
3. **Load a matching skill** from `.agents/skills/` — `ai-review` (PR review step),
   `generated-files` (regeneration), `publishing` (releases). This workflow covers the rest.
4. **Check whether the affected files are generated** — generated files are gitignored and never
   hand-edited; edit the source and regenerate (see the `generated-files` skill).

## Making the change

- Make the **smallest appropriate change** — prefer a single-file edit over multi-file refactoring;
  no unrelated formatting, renaming, dependency bumps, or architectural changes.
- Preserve upstream provenance in `core/`: avoid unrelated changes to upstream-derived files
  (outside `updater/`, from xiaoxiaoflood/firefox-scripts, MPL-2.0).
- Conventions matter (see AGENTS.md → Conventions): `.sys.mjs` via `ChromeUtils.importESModule` with
  full `chrome://`/`resource://` specifiers; no `innerHTML` in the updater tab; clang-format LLVM
  base for C; text files are LF (normalize CRLF at read in tools that parse tracked files).
- When a source of a generated file changes, regenerate on demand
  (`node tools/publish/syncGeneratedFiles.mjs`, Makefile targets, or it happens at publish time).

## Validate

| Change                           | Validate with                                                           |
| -------------------------------- | ----------------------------------------------------------------------- |
| C (`installer/src/`)             | build the affected target (`make dist_win` / `dist_linux` / `dist_mac`) |
| Hash / file list                 | `pnpm test:hash`                                                        |
| Publish helpers / hashing        | `pnpm test` (unit tests in `test/unit/`)                                |
| Decision log (`docs/decisions/`) | `pnpm check:decisions` (duplicate numbers + stale links)                |
| Generated-file sources           | `node tools/publish/syncGeneratedFiles.mjs`                             |
| Packaging / publish scripts      | `pnpm upload:local -- --mode=prod`                                      |

Pre-PR gates: `pnpm lint`, `pnpm format`, `pnpm test`, and the hash test. **Do not claim tests
passed if the required toolchain or environment was unavailable.**

PRs that modify `core/**` must add or extend a test where feasible; if not, the PR description must
explain why (CI gate tracked in issue #30).

## Before finishing

- generated files are regenerated on demand (Makefile / createZip / syncGeneratedFiles);
- no `.local` files were used as authoritative sources;
- `docs/local_plan/` changes remain in its own repository;
- no unrelated files were modified;
- failed/unavailable validation is reported;
- when the PR is ready for review, run the ADR 0020 review step (see the `ai-review` skill).
