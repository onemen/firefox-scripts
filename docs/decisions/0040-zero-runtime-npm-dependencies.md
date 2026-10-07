# 0040: Zero runtime npm dependencies in `core/` and `installer/src`

- **Status:** accepted
- **Date:** 2026-10-07
- **Amends:** [0033](./0033-dependency-update-policy.md) — the runtime-zero boundary is now its own
  record; 0033 governs updates to the tooling tree only

## Context

The rule that nothing shipped runs against an npm package is load-bearing, but until now it existed
only as _context_ inside the dependency-update policy: 0033's opening paragraph asserts it and its
Consequences refuse runtime-dep requests, while the record's actual subject is how the tooling tree
updates. That is the boundary, not the update policy — and nothing in the tree enforces it (no lint
rule, no gate): `package.json` has an empty `dependencies` map and 20 `devDependencies` by
convention, not by check. The audit that proposed this record ranked it the highest-value missing
decision (2026-10-06, P2-12 / #446): the shipped artifacts are plain browser JS and C with in-tree
vendored code, and that is precisely the kind of "no" that gets re-litigated the first time someone
proposes a shared utility package.

## Decision

`core/` and `installer/src/` ship **zero runtime npm dependencies** — what reaches a user's browser
or disk contains no package-resolution step and no registry-sourced code (vendored, reviewed source
like `miniz` is in-tree input, not a package dependency). The npm tree exists only for build, test
and publish tooling, which updates under [0033](./0033-dependency-update-policy.md). Adding a
runtime dependency is an architecture change requiring an ADR that amends this record — never a
dependency update.

## Consequences

Shipped bytes do not depend on the registry, so the supply chain a user trusts is the one 0002/0003
hash-pin and 0032's toolchain pin already describe; tooling churn under 0033 cannot reach a release.
The cost: no shared helper packages — small utilities are copied across `core/` and the C side
rather than imported, and C code stays in-tree (sha256, miniz). The gap this record closes is
awareness, not enforcement: a lint rule asserting the boundary would be the natural next step and
would amend this record only if it changed the rule. Revisit-if: a runtime dependency ever becomes
necessary — 0033's own revisit-if, which must then amend **both** records.
