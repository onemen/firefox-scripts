---
name: ai-review
description:
  Review a PR the ADR 0020 way — run the local `pnpm review:local` reviewer, assess every finding as
  right / wrong / useless with the disputed line quoted before any rejection, and post each accepted
  finding as its own line-anchored, individually resolvable review thread (fallback: `gh pr review
  <n> --comment`, never `gh pr comment`), resolving each thread as its fix lands. Use when a PR is
  ready for review or the user asks for the AI review step.
---

# AI review of a PR (ADR 0020)

AI review is a **local, agent-run step** — not a CI bot. The agent that opened the PR runs the
review when the PR is ready, assesses the findings itself, and posts only the accepted ones. No
CI/repo AI secret exists or should be added. External review triggers (CodeRabbit
`@coderabbitai review` / `pnpm review:batch`) require explicit operator instruction — never
self-initiated (see the boundary section below).

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

   Default to wrong/useless only with the line in hand — see "Rejecting a finding" below. With
   nothing quoted yet the honest state is _unverified_, not _wrong_; the reviewer is advisory and
   fail-soft by design.

### Rejecting a finding — quote the line, or don't reject

A `wrong` verdict is a claim about code you have read, so make it checkable:

- **Quote the disputed line with `path:line` in the posted triage** — what the finding says versus
  what is actually there. No quote, no rejection: an unquoted "wrong" is an assertion, and the
  operator cannot tell the reviewer's misread from your mistake.
- **Read the PR's own head, not the checked-out branch or `main`** — `git show <head-sha>:path`,
  `git diff origin/main...HEAD -- path`. A file the PR adds exists on no other branch, and a line
  the PR fused, moved or rewrote reads differently (or is absent) in `main`. Inspecting the wrong
  artifact is the standard way a real finding gets "disproved".
- **A finding about text you edited in this PR is a finding about your own diff.** The reviewer is
  reading what you produced; yours is the weaker reading.
- **If the reviewer's remedy is stronger than your fix, take the stronger one or say why not, in the
  thread.** Quietly shipping the weaker remedy is a rejection in disguise.
- **Post rejections like acceptances** (reason + quoted line), so the disagreement is auditable and
  cheap to reverse.

### One batch, two rejections, 2026-09-22 — one right, one wrong

Same batch, same reviewer, opposite outcomes; the difference was whether the line was quoted before
rejecting. Keep both halves in view: the rule is "quote it", not "always accept".

- **Wrong rejection — PR #299, `AGENTS.md:87`.** Finding: _"remove the stray hyphen before 'One
  decision'"_. The posted triage was _"the hyphen it saw belongs to the `Docs-only`/list formatting
  around it, not to the sentence — the paragraph reads correctly in the rendered file. No change
  made"_ — no line quoted. Reality: that edit had fused two list bullets, so the file read
  `… (Context / Decision / Consequences). -One decision per record.` — "One decision per record" had
  become part of the template bullet and the list structure was gone. The local audit pass
  re-flagged it as **must fix** and it was corrected in `ff58af0`. Nothing rendered correctly: the
  rejected hyphen _was_ the bug, and a `sed -n '<n>,<n+6>p'` on the PR head would have shown it.
- **Right rejection — PR #295, dedupe watchdog issues by hash prefix.** Triage: `openFlaggedIssue`
  already keys on a title that embeds the prefix, `closeClearedIssues` reads it back out. Re-checked
  against the PR head: `open.find(i => i.title === title)` plus `hashPrefixOf(title)` parsing the
  12-char prefix out of that same title — the title _is_ the identity, and a second notion would add
  a divergence with no behaviour change. Stands.
- **Also that batch, not a rejection but the same instinct — PR #295, hashless scan results.** The
  reviewer's remedy was _"hash every result **before** the upload so nothing is ever hashless"_; the
  fix shipped was the weaker fail-soft skip at the ledger call sites. The skipped branches were
  exactly the results that explain a hiccup, so the ledger dropped the record it exists to keep; the
  stronger remedy landed later (`06c775b`, 16 scan-vt tests). An under-fixed acceptance costs as
  much as a wrong rejection.

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
  `state=open` vs reopened issues, `--fix` convergence). These PRs warrant the CodeRabbit pass — but
  that pass is operator-initiated (boundary below): recommend it and wait for the explicit
  instruction, and meanwhile treat the local pass as advisory garnish, not evidence of health.
- **Findings on pristine third-party skills (ADR 0022, `metadata.github-repo` frontmatter) are
  auto-rejected** — the content is byte-identical to upstream and must not be edited. The replay
  burned quota to flag upstream's own wording ("truncated sentence") — a false positive by
  construction. Don't even relay them upstream without checking the source first.
- **Check coverage before trusting a zero** — the summary lists provider-skipped files; a
  zero-findings pass that skipped half the files proves nothing. (Planned tooling fix: a coverage
  line in the summary.)

## Review-trigger boundary — operator-initiated only

The agent-run step is `pnpm review:local` plus the triage/posting of its findings. External
reviewers are the **operator's** call, never the agent's initiative:

- **Never invoke `@coderabbitai review` (or any external review trigger) unprompted.** It posts as
  the user, consumes their included-review quota (~1/hour), and adds timeline activity they did not
  ask for. Recommend the pass and wait for the explicit instruction.
- **`pnpm review:batch` likewise requires explicit operator instruction** to run — same reason: it
  posts CodeRabbit reviews to PRs under the user's account and spends their quota.
- **When the operator does run `review:batch`** (or any external reviewer), the agent triages its
  findings right / wrong / useless exactly as for the local pass and posts each accepted finding per
  the protocol above: line-anchored individually resolvable threads (fallback review body, never
  `gh pr comment`), the 🤖 provenance marker (e.g.
  `🤖 AI review triage (Codebuff agent — result of the CodeRabbit review:batch run)`), and each
  thread resolved as its fix lands. External findings get the same scrutiny as local ones —
  assessed, not rubber-stamped.

## Also know

- `.github/workflows/ai-review.yml` was removed; do not re-add CI AI review.
- `tools/ai-review.mjs` configures providers as an array of `{id, label, model, keyEnv, endpoint}`;
  the first entry whose API key is set is used, with per-file fallback.
- CodeRabbit is quota-limited (~1 review/hour, shared bot/CLI quota — `.coderabbit.yaml`):
  `@coderabbitai review` for a one-off deep pass, `pnpm review:batch` for batched branch reviews —
  both strictly on explicit operator instruction (see the boundary section above).
