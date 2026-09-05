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

## Local reviewer vs CodeRabbit — evidence from PR #123 (2026-09)

Head-to-head on the same PR: local `review:local` 12 findings / 6 accepted (50%); CodeRabbit 11
findings / 9 right + 1 partial (86%). They catch **different classes of bug** — treat them as
complementary on CI/platform PRs:

- **Local reviewer** is strongest on code-internal footguns: env coercion (NaN backoff),
  `throw undefined`, spread overriding a coercion, arg-parsing degradation, notification-spam
  design. Its misses were cross-file: claims about code it didn't trace ("undeclared `repo`"
  declared 7 lines up, object-shape assumptions, ISO-timestamps-sorted-as-strings false alarm).
- **CodeRabbit** is strongest on linter receipts (actionlint, zizmor) and **GitHub platform
  semantics**: concurrency races, API pagination, data-loss paths (temp file written next to the
  user's file). Its main weakness: it doesn't run anything — a live probe disproved its waterfox CDN
  claim in one minute.
- **Verify platform-semantics fixes before implementing.** The zizmor "scope `issues: write` to the
  job" fix silently dropped `actions: write` (a job-level `permissions:` block REPLACES the
  workflow-level one) and 403'd every subsequent prod publish — reverted in #125. Linter-clean is
  not semantics-correct.
- **Probe external endpoints live, don't reason statically** — one `node --input-type=module -e`
  fetch settles regex-vs-reality claims (CDN hrefs) in seconds and is posted as evidence in the
  thread.
- **Chase "minor" findings to root cause** — investigating a dispatch-args nit uncovered
  `BROWSER_PIN_VERSION` exported but read by nothing, a bug BOTH reviews missed until then.
- Never merge a linter-suggested security scoping on a publish/release workflow without walking
  every capability that job uses.

### Second sample — PR #122 replay (2026-09, pre-fix commit `1c3e8a0`)

Replayed the local reviewer against the commit **before** #122's CodeRabbit-triage fixes
(CodeRabbit: 7 actionable, 5 accepted + fixed): **0 code findings** (rate-limit noise; 1–2 files
skipped per pass — treat as "far fewer", not a hard zero). Directionally consistent with #123 and
sharper:

- **On tooling/workflow PRs (`.github/**`, `tools/ci|publish/**`) the local reviewer is nearly
  blind** — its diff-hunk window can't see cross-file API semantics (`behind_by` vs `ahead_by`,
  `state=open` vs reopened issues, `--fix` convergence). Run CodeRabbit (`@coderabbitai review`) on
  these PRs and treat the local pass as advisory garnish, not evidence of health.
- **Findings on pristine third-party skills (ADR 0022, `metadata.github-repo` frontmatter) are
  auto-rejected** — the content is byte-identical to upstream and must not be edited. The replay
  burned quota to flag upstream's own wording ("truncated sentence") — a false positive by
  construction. Don't even relay them upstream without checking the source first.
- **Check coverage before trusting a zero** — the summary lists provider-skipped files; a
  zero-findings pass that skipped half the files proves nothing. (Planned tooling fix: a coverage
  line in the summary.)

## Also know

- `.github/workflows/ai-review.yml` was removed; do not re-add CI AI review.
- `tools/ai-review.mjs` configures providers as an array of `{id, label, model, keyEnv, endpoint}`;
  the first entry whose API key is set is used, with per-file fallback.
- CodeRabbit is quota-limited (~1 review/hour, shared bot/CLI quota — `.coderabbit.yaml`); use
  `@coderabbitai review` for a one-off deep pass, `pnpm review:batch` for batched branch reviews.
