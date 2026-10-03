---
name: cr-batch-review
description:
  Run the operator-requested CodeRabbit batch pass (`pnpm review:batch`) and carry the findings
  through the ADR 0020 posting protocol — check the quota first, assess every finding as right /
  wrong / useless with the disputed line quoted, post each accepted finding as its own
  line-anchored, individually resolvable review thread BEFORE writing any fix, and post a review
  record even when there are no findings. Use when the user asks for a CodeRabbit review, a batch
  review, a deep review pass, or invokes `review:batch`. The everyday default is the cheaper local
  reviewer (`ai-review` / `pnpm review:local`) — reach for this one when the user names CodeRabbit
  or the batch, not on your own initiative.
---

# CodeRabbit batch review → ADR 0020 posting

The **protocol** — triage, anchoring, the 🤖 marker, resolution — is
[ADR 0020](../../../docs/decisions/0020-local-agent-ai-review.md) and is identical to the local
reviewer's. This skill only adds what is specific to the batch pass. Do not restate or re-interpret
the protocol here; if the two ever disagree, the ADR wins.

## Before you run anything: the quota gate

The free plan allows a small number of reviews per rolling hour, shared between the bot and the CLI,
and the window refills. **Check before you spend:**

```bash
cr usage          # or: pnpm review:batch -- --check
```

If `Remaining` is `0`, stop and tell the user when it refills (`Full capacity: in N minutes`) rather
than starting a run that will fail. Spending the last slot on a run that cannot finish is worse than
waiting, and the quota is the user's.

**Operator-initiated only** (ADR 0020, amended 2026-09-15). `review:batch` posts under the user's
own GitHub account and spends their quota. Never run it unprompted — not on a PR you opened, not
because a PR looks unreviewed. Recommend it and wait.

## Run it

```bash
pnpm review:batch -- --pr 57 --pr 59     # explicit PRs
pnpm review:batch -- --open --since 3d    # recently-updated open PRs
```

The script merges the heads onto one temp branch, reviews the combined diff in a single quota slot,
and writes `dist/review/batch-findings.json`. Read that report — it carries `severity`, `category`,
`path`, `startLine`/`line` and the body per finding.

**The anchors are merged-branch-relative, not per-PR.** Several PRs share one tree, so one PR's
insertions shift another's lines and the same `path:line` can point at different code on a given
head. The report does not say which PR owns a finding. Before posting, work out the owning PR (which
head contains that line) and **re-verify the anchor against that head**. A stale report is worse
than none: the script now removes the old file before each run and exits non-zero if it cannot write
a new one, so if the file is absent the run failed — say so instead of posting from memory.

## Assess, then post, then fix

Triage every finding as **right / wrong / useless** before posting anything, quoting the disputed
line in the assessment. External findings get the same scrutiny as local ones — never a rubber
stamp.

Then, in this order:

1. **Post every accepted finding first.** One line-anchored thread per finding on the owning PR,
   each with the 🤖 provenance marker, each independently resolvable. Fall back to a single
   `gh pr review <n> --comment` body when anchoring is impossible; never `gh pr comment`. _This is
   deliberate: a thread posted after the fix cannot be anchored to the offending line and leaves no
   record of what was found. Post, then fix, then resolve._
2. **Record what you rejected.** A wrong or useless finding still gets a thread with the disputed
   line quoted and the reason it does not hold. **Delete it on the spot.** If it is genuinely right,
   the quote proves it. If it is genuinely wrong, the next reader can see it was considered and why
   it was dropped — otherwise a rejected finding vanishes silently and the next agent re-raises it.
3. **Always leave a review record, including a clean one.** Zero findings is a _result_, not an
   absence: post a short body saying what was reviewed (provider, files, counts) and that nothing
   was found. Otherwise "reviewed, nothing to fix" and "never reviewed" look identical on the PR.
4. **Fix, then resolve each thread** with a reply naming the commit that fixed it.

Verify the review landed with `gh pr view <n> --json reviews`. `main` requires conversation
resolution, so no thread may be left open at merge.

## Housekeeping

`review:batch` sweeps `coderabbit-update-*` dirs older than `--temp-grace` (default 30 min) from
`%TEMP%`, skipping any a live run still holds open. A fresh dir left behind is normal — it means
another run owns it. If you finish the batch with residue, it is yours to clean; a stale one is not.

## Also know

- The bot's auto-review is **off** by design (`.coderabbit.yaml`) so pushes do not burn quota.
  `@coderabbitai review` and `review:batch` share the same pool.
- `pre_merge_checks.docstrings` (CodeRabbit's docstring-coverage gate) is a **GitHub-side PR
  check**. The CLI does not evaluate it, so it never appears in this run's output.
