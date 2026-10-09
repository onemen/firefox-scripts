# 0042: E2E gate reports the required legs; advisory legs get a warn-only reporter

- **Status:** accepted
- **Date:** 2026-10-09
- **Amends:** [0025](./0025-waterfox-hard-gate.md) — the advisory tail no longer decides when the
  required check reports
- **Part of:** #444 (wall-clock burst, item 1)

## Context

`e2e-gate` is the E2E branch-protection check, and its `needs:` list held every leg — required and
advisory alike (ADR [0017](./0017-ci-validation-contract.md) made the fork legs advisory,
[0021](./0021-tiered-publish-gating-shared-resolver.md) / [0025](./0025-waterfox-hard-gate.md) the
tiering). `verify.sh` accepted a non-green _advisory_ result with a `::warning::` and still exited
0, so those legs never blocked a merge. They did something worse: they decided **when** the required
check went green, because a job cannot report before every job in its `needs:` list is terminal.

Measured on run `37555489120` (2026-10-07): slowest required leg `portable-firefox · windows`
**3m08s** vs slowest advisory `browser-matrix · zen` **3m21s**; the gate therefore reported at the
advisory leg's pace, not the required set's. Every PR paid the difference.

## Decision

1. **`e2e-gate` needs the required legs only** (`snapshot`, `installer`, `helper`, `updater`,
   `updater-waterfox`, `portable-firefox`, `core-lifecycle`). It reports as soon as they end.
2. **A separate `e2e-advisory` job verifies the advisory legs** (`browser-matrix`, `fork-portable`,
   `esr-matrix`, `esr-portable`, `snap-firefox`) through the same `verify-gate` engine, emits a
   `::warning::` per leg on request, `needs: e2e-gate` so it runs after it, and always exits 0. It
   is **not** a required check and must never be added to branch protection; the gate contract pins
   that it defines no `required:` input (verify.sh FAILS a non-green required job, which would
   silently harden an advisory leg into a merge blocker).
3. **The static contract grows multi-gate support** (`tools/check-gate-coverage.mjs`): each gate's
   own wiring is checked, then one workflow-level pass requires every non-gate job to appear in at
   least one gate's `needs:` — the old single-gate silent-bypass rule, now across gates.

## Consequences

With only advisory legs outstanding the required check is already green — #444 item 1's acceptance
condition — while a red fork or snap leg still surfaces on the PR as a warning and in the advisory
job's own log. `e2e-triage` and `snap-store-watch` are unaffected: both read job results, not the
gate's verdict. The advisory job is a second ubuntu runner per E2E run (5s measured) and buys back
the whole advisory tail in merge latency. Revisit-if: much of the advisory set graduates to required
(ADR 0025's waterfox path) — then the split collapses back, or the reporters swap roles.
