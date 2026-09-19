---
name: batch-loop
description:
  Work a batch of independently shippable tasks in one session — one worktree + PR per task per the
  change-workflow rules, stacked PRs for dependent tasks, one-shot CI checks at natural pauses, the
  ADR 0020 review step as wait-filler, and a turn-end contract instead of sleeping. Load when the
  user hands over several tasks to work as a batch, numbered or not.
---

# Batch Loop Protocol

The user handed you a batch of tasks in one message — numbered or not. Number them yourself on
receipt (input order = task numbers) so the status line and later replies can address each task
individually. Work through them in order, in THIS session only. Never suggest a new session/thread.
The batch stays open across turns until the user says `stop`.

## Batch-worthiness check (first)

Before running the loop, check the items are really a batch — independently shippable units:

- Items that are trivial (one-line tweaks) or that together describe ONE change ("add X, wire it up,
  test it") are not a batch. Propose a single worktree + PR covering them instead and, on agreement,
  follow the `change-workflow` skill normally (the never-idle-wait rule still applies).
- Confirmed batch → number the tasks and run the independence screen below.

## Status line

Restate a compact status line for ALL tasks at the start of every reply:

```
1) done | 2) ci | 3) pending
```

States: `pending` (not started) → `ci` (PR open, checks running) → `done` (checks green; the PR
merges only with the user's explicit approval) or `blocked` (3 failed fix attempts — list it in the
final summary).

## Independence screen (before starting)

Scan the batch for tasks that touch the same files or subsystems.

- **Independent tasks** branch from `main` — parallel PRs.
- **Dependent tasks** become **stacked PRs** (branch N+1 branches from branch N, PR base is branch
  N, merge in order). Flag any suspect pair to the user before starting instead of guessing.

## Loop

1. Restate the status line, then branch:
   - At least one `pending` → pick the FIRST one and go to step 2.
   - No `pending` but some `ci` → go to step 5.
   - No `pending` AND no `ci` → go to step 6.
2. Do the task in its own worktree, strictly per the `change-workflow` skill (worktree path and
   naming, `pnpm install`, generated-file regeneration, validation matrix, commit footer, PR rules —
   **deferred to that skill, not restated here**). Commit, push, `gh pr create`.
3. Mark the task `ci` and continue the loop with the next `pending` task.
4. Between tasks, check CI one-shot — `gh pr checks <branch>` per open PR:
   - Green → mark `done`; remove that worktree (verify the directory is really gone — Windows
     `node_modules` husk; recipe in `change-workflow`).
   - Red → work in that task's worktree, fix, push (CI re-runs), stay `ci`. After 3 failed attempts,
     mark `blocked` and move on.
   - Still running → leave it and continue the loop.
5. No `pending` tasks left but CI is running: run the ADR 0020 review step (`pnpm review:local`) on
   your own open PRs — that is the designated wait-filler, per the `ai-review` skill. Then end the
   turn with the status line and: "All tasks in CI — send more tasks to fill the wait, or 'stop' to
   close this session."6. ALL TASKS SETTLED (done/blocked). Do NOT stop, do NOT sleep, do NOT say
   "waiting". Run the post-run smoke checklist below, then post the batch summary — PR links, what
   is ready to merge, what is blocked — and end the turn with exactly: "Batch complete — send the
   next batch, or 'stop' to close this session." Optionally render a big-font status board in the
   app's Preview tab (a small local HTML file, refreshed each turn) as the availability signal.

## Post-run smoke checklist

Run before the step-6 summary — every item is a one-command verification:

- [ ] **Terminal states only** — every task is `done` (PR open, checks green) or `blocked` (listed
      in the summary); nothing is silently `pending` or `ci`.
- [ ] **No worktree residue** — `git worktree list` shows no batch worktrees and the
      `<workspace>/worktrees/` listing confirms the directories are gone; the husk recipe ran
      (`rm -rf node_modules` → `git worktree remove --force` → verify) and `git worktree prune`
      reports nothing.
- [ ] **No orphan branches** — every batch branch is either pushed with an open PR or deleted; no
      unpushed local batch branch lingers.
- [ ] **Main checkout clean** — `git status --short` shows no uncommitted duplicates of work that
      was committed to the batch branches (verify byte-identity against the branch, then discard);
      untracked files the agent did not create are reported, never deleted.
- [ ] **Per-PR verification reported** — each open PR's summary states the one-shot `gh pr checks`
      result (green, or still-running at turn end) and the ADR 0020 `pnpm review:local` step ran (0
      findings, or findings posted/resolved per the `ai-review` skill).
- [ ] **Companion changes landed** — PRs that add an authored skill (or otherwise shift a pinned
      inventory) updated the matching live-repo test in the same change — the `sync-skill-gates`
      inventory test is the trap the first dry run caught.

## Rules

- **NEVER call sleep** and never idle-wait on CI, tests, or builds — the never-idle-wait rule in the
  `change-workflow` skill applies at all times. End the turn instead.
- **Never merge a PR without the user's explicit approval** (AGENTS.md Critical Rule) — the summary
  reports ready/merged/blocked state and stops there.
- One worktree per task; never link the parent's node_modules into it.
- When the user replies with more tasks — numbered or not — append them to the batch and continue
  from the status line. The batch stays open until the user says `stop`.
