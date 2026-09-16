# 0029: Decision amendments are first-class status lines, not prose

- **Status:** accepted
- **Date:** 2026-09-16
- **Amends:** [0019](./0019-release-versioning.md) (its 2026-09-12 / 2026-09-13 amendment sections),
  [0020](./0020-local-agent-ai-review.md) (its inline **Amended** prose),
  [0026](./0026-publish-channels-and-dead-channel-fallback.md) (its in-place partial supersede),
  [0012](./0012-new-tab-daily-notification.md) (0026's scoped exception to its silent-exit invariant
  is now declared on the record itself)

## Context

The index says amendments supersede rather than edit — yet 0019, 0020 and 0026 all changed decisions
in place and nothing recorded it structurally: `check-decisions.mjs` validates supersede targets,
duplicate numbers and broken links, but an in-place amendment is invisible to it. The 2026-09-15
audit flagged this as the failure mode: the next agent reads only the steering list, sees a clean
`accepted` record, and re-proposes the amended-away behavior. Superseding for every amendment would
churn numbers and bury still-valid decisions under stubs.

## Decision

An amendment keeps its record and gets a **first-class status line**. Under `- **Status:**`, the
amended record carries a machine-readable `Amended:` line, and the amending record (when there is
one — 0029 itself, here) carries the reciprocal `Amends:` line:

```markdown
- **Amends:** [0019](./0019-release-versioning.md) (what changed)
- **Amended:** [0029](./0029-status-line-amendments.md) (what changed)
```

Links use the `[NNNN](target-file.md)` form so the number is checkable. `check-decisions.mjs` fails
when a target is missing, is not a record, does not match its `[NNNN]`, links to itself, or is not
**reciprocated** — X Amends Y ⇔ Y Amended X. A self-contained
`- **Amended:** YYYY-MM-DD — what changed` line (no link) is also valid: it declares the date in
machine-readable form. Supersede stays the tool for reversing a decision; status lines record
additive amendments.

## Consequences

Amendments become grep- and gate-visible: the steering list stays honest without renumbering, and a
one-sided amendment fails `pnpm check:decisions` in CI instead of silently diverging from the index.
Cost: every amendment is now a two-file edit (the record and its counterpart), and the checker owns
one more convention. Revisit-if: amendments start chain-nesting (a record amending an amendment) —
then promote the links to a dedicated front-matter block or move amendment history into the
superseding records.
