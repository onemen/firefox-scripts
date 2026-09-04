---
name: ai-review
description:
  Review a PR the ADR 0020 way — run the local `pnpm review:local` reviewer, assess every finding as
  right / wrong / useless, post the accepted ones as a PR review via `gh pr review` (never `gh pr
  comment`), and verify it landed. Use when a PR is ready for review or the user asks for the AI
  review step.
---

# AI review of a PR (ADR 0020)

AI review is a **local, agent-run step** — not a CI bot. The agent that opened the PR runs the
review when the PR is ready, assesses the findings itself, and posts only the accepted ones. No
CI/repo AI secret exists or should be added; CodeRabbit `review:batch` is an optional deep pass.

## The protocol

1. **Run the reviewer** (reviews `main...HEAD` by default):

   ```bash
   pnpm review:local
   ```

   Output lands in `dist/review/` (RDJSON diagnostics + a markdown summary). Needs `GEMINI_API_KEY`
   (default provider, Gemini 3.6 Flash) in the root `.env` or the environment; OpenRouter is an
   optional backup. Flags: `--provider <id>`, `--model <name>`, `--base-ref`, `--head-ref`,
   `--max-findings`, `--max-files`, `--dry-run`.

2. **Assess every finding** as one of:

   - **right** — a concrete bug, security hole, regression, or footgun with a specific failure mode;
     will be fixed in this PR;
   - **wrong** — the model misread the code or the repo's intent;
   - **useless** — true but trivial, stylistic, or already covered by the gates.

   Default to wrong/useless when unsure; the reviewer is advisory and fail-soft by design.

3. **Post each accepted finding as its own line-anchored, individually resolvable review thread** —
   never an issue comment, and not one body-only review lumping findings together:

   ```bash
   gh api "repos/{owner}/{repo}/pulls/<n>/reviews" \
     -f commit_id="$(git rev-parse HEAD)" -f event=COMMENT \
     -f 'comments[][path]=tools/foo.mjs' -F 'comments[][line]=42' \
     -f 'comments[][body]=🤖 **AI review — agent-posted (ADR 0020)** — minor — <why + fix>'
   ```

   One thread per finding, anchored to `path` + `line` on the PR head commit, so each thread is
   independently resolvable the moment its fix lands. Fallback when anchoring is not possible (e.g.
   a PR-wide provenance note): `gh pr review <n> --comment` with a one-line header (provider/model,
   files, counts) + one line per finding (`file:line — severity — why`). Reviews have a body, not a
   title.

   **Agent provenance marker:** reviews post under the user's own GitHub account, so every
   agent-posted review comment or review body begins with a single provenance line — one line only,
   no callout block: `🤖` + what the comment is + which agent produced it and from what review run.
   Example: `🤖 AI review triage (Codebuff agent — result of the CodeRabbit review:batch run)`. The
   marker is what separates agent activity from the user's own in the timeline.

4. **Verify it landed** and that it is a review, not a comment:

   ```bash
   gh pr view <n> --json reviews
   ```

5. **Resolve each thread as soon as its fix lands** — the fix commit is named in the thread body,
   and one GraphQL mutation closes it (thread ids come from `gh api …/pulls/<n>/reviewThreads`):

   ```bash
   gh api graphql -f query='mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}' -f id=<thread-id>
   ```

   Don't hold threads open until merge — an open thread on fixed code is stale state. Anything still
   unresolved just before merging must be resolved then; `main` requires conversation resolution.

## Judgment calibrations from the audit in ADR 0020

- Provider history: the retired CI Groq bot was the weakest reviewer (~52% useless findings); the
  local Gemini default is the current default for a reason — still assess, don't rubber-stamp.
- The diff leaves the workstation for the provider's API — same data-handling expectation as any LLM
  review. Repo secrets are never part of a diff.
- The review is not gated on CI. It can help debug failing checks; it never blocks a merge by itself
  — the agent's assessment is the filter.

## Also know

- `.github/workflows/ai-review.yml` was removed; do not re-add CI AI review.
- `tools/ai-review.mjs` configures providers as an array of `{id, label, model, keyEnv, endpoint}`;
  the first entry whose API key is set is used, with per-file fallback.
- CodeRabbit is quota-limited (~1 review/hour, shared bot/CLI quota — `.coderabbit.yaml`); use
  `@coderabbitai review` for a one-off deep pass, `pnpm review:batch` for batched branch reviews.
