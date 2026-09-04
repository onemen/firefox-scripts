# 0020: AI review is a local, agent-run step (CI Groq bot retired)

- **Status:** accepted
- **Date:** 2026-08-29

_Problem surface:_ PR review tooling

## Context

`tools/ai-review.mjs` originally ran as an advisory bot from CI (`.github/workflows/ai-review.yml`),
gated on the `GROQ_API_KEY` secret. A 2026-08-29 audit of every bot review on merged PRs measured
the Groq / `gpt-oss-120b` combination as the **weakest reviewer** (~52% useless findings) and its
free tier as the most rate-limited — large PRs were only partially reviewed (recurring HTTP 429
skips). CodeRabbit remains useful but its free plan allows roughly **1 review/hour**, so it cannot
be the high-volume daily reviewer. A better free model is available for local, agent-run review via
a cloud API (Gemini 3.6 Flash through Google AI Studio, 1,500 requests/day, no credit card).

## Decision

AI review is a **local, agent-run step**, not a CI bot:

- When a PR is ready for review, the agent that created it runs `pnpm review:local`
  (`node tools/ai-review.mjs`) on the branch, then **assesses each finding** (right / wrong /
  useless, per the audit methodology) and posts each accepted finding as its own **line-anchored
  review thread** on the PR head commit (`gh api …/pulls/<n>/reviews` with `commit_id`, `path`,
  `line`, `event=COMMENT`) — one thread per finding, each independently resolvable as its fix
  lands. Fallback when anchoring is not possible: a single `gh pr review <n> --comment -b
  "<text>"` whose body is a one-line header (provider/model, files, counts) plus each finding as
  `file:line — severity — why`. Reviews have a body, not a title. `gh pr comment` (an issue
  comment) is never used for findings — it leaves no review record. Because reviews post under
  the user's own GitHub account, every agent-posted review comment or body begins with a one-line
  🤖 provenance marker stating it was posted by an agent (no callout blocks). The agent verifies
  the review landed with
  `gh pr view <n> --json reviews` — and each thread is resolved as soon as the fix named in it
  lands, not held open until merge. `main` requires conversation resolution, so every review
  thread (agent- or bot-created) must be resolved before merging.

- The review command is **local**, but the model is a **cloud provider**: the reviewed diff is sent
  to the configured endpoint's HTTPS API (e.g. Gemini, which is hosted by Google). This is the same
  data-handling expectation as any LLM review — diff text leaves the workstation for the provider to
  process; repo secrets are never part of a diff.
- `tools/ai-review.mjs` configures providers as an **array of objects**
  (`{id, label, model, keyEnv, endpoint}`); the **first entry whose API key is set** is used, with
  per-file fallback. **Gemini 3.6 Flash is the default** (`GEMINI_API_KEY`). OpenRouter remains as
  an optional backup; Groq was removed (retired).
- `.github/workflows/ai-review.yml` was **removed**; no repo/CI secret is required.
- CodeRabbit `review:batch` stays as an optional deep ~1-review/hour pass for the PRs that warrant
  it.

## Consequences

- No CI bot noise, no per-push comments, no token stored in CI; review output lands on the PR
  filtered by the agent's assessment.
- Review quality depends on the agent performing the step and on the configured model — not on a
  scheduled bot.
- Requires `GEMINI_API_KEY` in the agent's local `.env` (untracked); the CI AI-review workflow
  (`ai-review.yml`) is removed, so no CI secret is stored.
- The formerly-Not-recorded "AI-review tooling" entry in `index.md` is superseded by this record.
