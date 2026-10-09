# 0042: E2E gate reports the required legs; advisory legs get a warn-only reporter

- **Status:** accepted
- **Date:** 2026-10-09
- **Corrected:** 2026-10-09 — the first version cited a leg-vs-leg comparison as the defect; the
  Effect section now carries the measured set-vs-set numbers (required set was the tail in 3 of 4
  runs; 0–43 s of routine saving, bounded worst case)
- **Amends:** [0025](./0025-waterfox-hard-gate.md) — the advisory tail no longer decides when the
  required check reports
- **Part of:** #444 (wall-clock burst, item 1)

## Context

`e2e-gate` is the E2E branch-protection check, and its `needs:` list held every leg — required and
advisory alike (ADR [0017](./0017-ci-validation-contract.md) made the fork legs advisory,
[0021](./0021-tiered-publish-gating-shared-resolver.md) / [0025](./0025-waterfox-hard-gate.md) the
tiering). `verify.sh` accepted a non-green _advisory_ result with a `::warning::` and still exited
0, so those legs never blocked a merge. They also decided **when** the required check went green,
because a job cannot report before every job in its `needs:` list is terminal — and that wait was
unbounded, not merely slow.

The original case compared the slowest **leg** in each class on run `37555489120`: required
`portable-firefox · windows` **3m08s** vs advisory `browser-matrix · zen` **3m21s**. That comparison
does not settle the question, because a gate waits for the slowest **set**, not the slowest leg —
and the required set is 21 legs against the advisory set's 7–10.

Measured on set completion (2026-10-09, four runs — `37555489120`, `37918862079`, `37920040547`,
`37920973737`): the required set was the tail in **three of four** (e.g. required +271 s vs advisory
+220 s on the very run cited above). The advisory set outlived it once, by **43 s**. So the defect
was not a routinely paid wait; it was an **unbounded** one — a hung or flaky advisory leg (the snap
store's CDN 502s and snapd deadlocks are documented in #444) would hold the required check for up to
that leg's timeout, despite being unable to block a merge.

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
gate's verdict. The advisory job is a second ubuntu runner per E2E run (5 s measured).

**Effect, measured rather than assumed:** on the four runs above the split saved **0 s** in three
(required set already the tail) and **43 s** in one. The honest value is therefore **decoupling and
a bounded worst case**, not routine seconds — the required check's timing no longer depends on the
flakiest vendors. Do not cite this change as a minutes-scale wall-clock win.

Revisit-if: much of the advisory set graduates to required (ADR 0025's waterfox path) — then the
split collapses back, or the reporters swap roles.
