# NNNN: Short decision title (the no)

- **Status:** accepted <!-- accepted | superseded by [NNNN](./NNNN-slug.md) -->
- **Date:** YYYY-MM-DD

<!-- An amendment that keeps this record valid carries a machine-readable link line,
     validated by check-decisions.mjs (ADR 0029) — on THIS record when it amends another:
       - **Amends:** [NNNN](./NNNN-slug.md) (what changed)
     ... and the reciprocal line on the amended record:
       - **Amended:** [NNNN](./NNNN-slug.md) (what changed)
     A date-only form is also valid:  - **Amended:** YYYY-MM-DD — what changed -->

## Context

What proposal or situation forced the decision. A few sentences on the system state and constraints,
with links to code or docs. Write this **after** the decision is made — not as a design brief for a
PR.

## Decision

What was decided, in one or two sentences. The usual record is a product-shaped **no** (we will not
build X). Name the existing primitive that covers the need.

## Consequences

What stays simple, what gets harder, and the **revisit-if** — the concrete condition that would
reopen this. Half a page is enough.

Do not use this template for a layout or UI tweak, a library pick the code already encodes, or
because a PR shipped.
