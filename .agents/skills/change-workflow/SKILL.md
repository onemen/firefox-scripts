---
name: change-workflow
description:
  Step-by-step workflow for making code changes in this repository — identify the subsystem, read
  the right docs and skills, avoid generated files, make the smallest change, regenerate, and
  validate with the matching test. Use when planning or starting any code change, or when the user
  asks about the process.
---

# Making a change

## Worktrees & node_modules

Do task work in a fresh `git worktree add ../<parent>/worktrees/<slug> -b <branch>` (one folder per
task, trivially deletable, out of the parent dir). A stale-husk sweep after threads exit is just
`rmdir worktrees/*`.

**Removing a worktree (Windows gotcha):** `git worktree remove` — even `--force` — can silently
leave the pnpm `node_modules` behind: the deep `.pnpm` paths exceed `MAX_PATH`, part of the
filesystem deletion fails, and git deregisters the worktree anyway. `git worktree list` then looks
clean while a husk stays on disk (22 of these accumulated in one week). `--force` only relaxes git's
_cleanliness_ check (untracked/modified files, submodules); it does not make the filesystem delete
more thorough. Remove in this order, and verify at the end:

```bash
rm -rf <workspace>/worktrees/<slug>/node_modules   # delete deps FIRST ...
git worktree remove --force <workspace>/worktrees/<slug>
git worktree list                                   # ... then verify the dir is really gone
```

A dead husk is provably safe to delete: fully unregistered (`git worktree prune` reports nothing),
no `.git` file inside, and nothing but `node_modules` in the directory. Anything else — report it,
don't delete it. The officially blessed alternative is the same two steps manually: `rm -rf` the
directory, then `git worktree prune`.

A fresh worktree carries no install: run `pnpm install` in it before running tools. pnpm hard-links
packages from the global content-addressable store, so this is fast and disk-cheap, and the worktree
stays fully self-contained — nothing done inside it can corrupt the parent checkout. When the opt-in
githooks are installed (`pnpm hooks:install`), the `post-checkout` hook already does this for
brand-new worktrees, so a fresh worktree is ready to use immediately. (The hook does not copy the
root `.env` — the GitHub token stays in the main checkout only; copy it by hand if a token-using
command must run from a worktree.)

Never link/symlink the parent's node_modules into a worktree (junction or otherwise). A shared
mutable store looks cheaper but corrupted the parent install twice in one day: pnpm invoked inside
the worktree re-homes the parent's `.pnpm` link farm toward the worktree's virtual store, and
removing the worktree then leaves the parent with dangling links.
(`tools/publish/refNodeModules.mjs` is internal to the `--ref` publish flow — do not reuse it for
task worktrees.)

## Before editing

1. **Identify the affected subsystem** — installer (`installer/`), chrome scripts (`core/`), web UI
   (`installer/web/`), publish tooling (`tools/publish/`), or docs (`docs/`).
2. **Read the relevant docs** — `docs/DEVELOPING.md` first (structure, build, tests, CI);
   `docs/auto-updater.md` / `docs/status-logic.md` for the updater; the decision log
   `docs/decisions/index.md` (steering veto list) before any architectural or design change.
3. **Load a matching skill** from `.agents/skills/` — `ai-review` (ADR 0020 review step),
   `code-review` (standards/spec diff review), `generated-files` (regeneration), `publishing`
   (releases). Full inventory: the Skills table in AGENTS.md.
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
- no unrelated files were modified;
- failed/unavailable validation is reported;
- when the PR is ready for review, run the ADR 0020 review step (see the `ai-review` skill).
