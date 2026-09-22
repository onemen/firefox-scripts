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

**The main worktree is read-only for task work.** Make every change — docs and skill text included,
however small — in a task worktree; never edit files in the shared checkout. It is the one place
other threads and the user rely on to stay stable, and "small" edits collide with parallel work.

**Guard it.** The way this rule breaks is a relative path that resolves a level up — a bare
`docs/x.md` instead of `../worktrees/<slug>/docs/x.md` — and both checkouts usually sit on the same
commit, so reading the file back proves nothing (the text looks right in either tree). Snapshot the
shared checkout when the task starts and check it before finishing:

```bash
node tools/check-main-clean.mjs --record   # task start; --record covers deliberate WIP left there
node tools/check-main-clean.mjs            # before finishing — exits 1 on anything it gained
```

With no baseline recorded it fails on ANY dirty path in the shared checkout, which is the intended
default. Recovery is the usual one: check the diff really is yours, move it into the worktree, then
`git -C <main> checkout -- <paths>`.

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
- **Format only through the project's tooling** — `pnpm format:fix` to apply, `pnpm format` to
  check; the same for C (clang-format runs from the Makefile/`pnpm`, never by hand). A bare
  `prettier --write <file>` on its own does **not** read `config/prettier.config.js` or
  `config/.prettierignore`, so it reformats files the gates deliberately leave alone: on 2026-09-22
  that turned a 90-line e2e change into a 777-line diff in which the real change is invisible to a
  reviewer, and the reformat had to be reverted by hand.
- Preserve upstream provenance in `core/`: avoid unrelated changes to upstream-derived files
  (outside `updater/`, from xiaoxiaoflood/firefox-scripts, MPL-2.0).
- Conventions matter (see AGENTS.md → Conventions): `.sys.mjs` via `ChromeUtils.importESModule` with
  full `chrome://`/`resource://` specifiers; no `innerHTML` in the updater tab; clang-format LLVM
  base for C; text files are LF (normalize CRLF at read in tools that parse tracked files).
- When a source of a generated file changes, regenerate on demand
  (`node tools/publish/syncGeneratedFiles.mjs`, Makefile targets, or it happens at publish time).

## Validate

| Change                           | Validate with                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------------- |
| C (`installer/src/`)             | build the affected target (`make dist_win` / `dist_linux` / `dist_mac`)               |
| Hash / file list                 | `pnpm test:hash` (needs a built snapshot; auto-generates one and hard-fails on stale) |
| Publish helpers / hashing        | `pnpm test` (unit tests in `test/unit/`)                                              |
| Decision log (`docs/decisions/`) | `pnpm check:decisions` (duplicates, stale links, `Amends:`/`Amended:` reciprocity)    |
| Generated-file sources           | `node tools/publish/syncGeneratedFiles.mjs`                                           |
| Packaging / publish scripts      | `pnpm upload:local -- --mode=prod`                                                    |

This table mirrors AGENTS.md → "Testing & QA" (the source of truth); if the two ever disagree, fix
AGENTS.md first and this table second.

Pre-PR gates: `pnpm lint`, `pnpm format`, `pnpm test`, and the hash test. **Do not claim tests
passed if the required toolchain or environment was unavailable.**

PRs that modify `core/**` must add or extend a test where feasible; if not, the PR description must
explain why (CI gate tracked in issue #30).

## Never idle-wait

Never call `sleep`, busy-wait, or sit in a polling loop while CI, local tests, builds, or other
background processes run — and never re-run a finished command just to "check again soon".

- **Local commands** (builds, test suites, publish snapshots) run once in the foreground; when they
  finish, report the result — no progress theater, no retry loops.
- **Remote CI** is checked at natural pauses only, one-shot — `gh pr checks <branch>` or a single
  `gh run list` / `gh run view`. No `gh run watch`, no backgrounded `&` watchers: background jobs do
  not reliably survive between turns in this environment.
- **While CI runs, either do useful work or end the turn.** Useful work: the next batch task (see
  the `batch-loop` skill) or the ADR 0020 review step (`pnpm review:local` on your own open PRs, see
  the `ai-review` skill). If nothing is actionable, end the turn with a status summary and an
  explicit question — the turn end itself is the user's cue. Idle time is the user's decision, not
  yours to manage.

## Before finishing

- generated files are regenerated on demand (Makefile / createZip / syncGeneratedFiles);
- no `.local` files were used as authoritative sources;
- no unrelated files were modified;
- failed/unavailable validation is reported;
- when the PR is ready for review, run the ADR 0020 review step (see the `ai-review` skill);
- **merged-PR issues with open checklist items:** when the merge auto-closes a tracking issue that
  still has unchecked `- [ ]` items, the merge solved only part of the issue — re-open it (REST:
  `gh api -X PATCH repos/<owner>/<repo>/issues/<n> -f state=open`; `gh issue edit --reopen` can
  silently no-op), verify the state, and post a comment recording what the merge solved and what
  stays open (precedent: #239 auto-closed #157 on 2026-09-18; the issue was reopened with its
  checklist intact).
