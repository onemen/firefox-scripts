# 0038: A `core/**` change must arrive with a test change

## Status

- **Status:** accepted
- **Date:** 2026-10-05

Related: [0017](./0017-ci-validation-contract.md) (required checks never go missing — the gate lives
as a step inside the always-running `checks` job rather than as its own filtered job, so it cannot
be skipped out from under branch protection), [0002](./0002-hash-based-update-detection.md) (why
`core/**` ships as hashed packages and why a silent breakage there is expensive).

## Context

`core/**` is the code every user runs, and both of its failure modes are silent. `config.js` wraps
every call in `catch (ex) {}` — deliberately, so a broken autoconfig can never stop the browser from
starting — which means an upstream API drift there degrades to "nothing installed", with no console
error to grep for and nothing in CI to attribute it to. `userChrome.js` and `BootstrapLoader.js`
fail the same way: at startup, on every profile at once.

So a `core/**` edit ships a risk nobody notices from the diff alone. The issue has asked for a
mechanical "core changed && no test changed → fail" gate since it was filed, and deliberately
withheld it until real coverage existed to point at (#416 stubs + sweep unit tests, #417 the
scheduled Nightly leg, #418 the delayed-registration scenario). Those are all on `main`; this
records the gate itself.

## Decision

1. **Fire only on `core/**`.** Every other PR is untouched, so the gate's blast radius is the
   directory whose failures are silent.
2. **Require SOME test change, never a specific one.** Naming which test _should_ change is a
   reviewer's judgement; a wrong guess here would block a correct PR, and a gate that blocks correct
   PRs gets deleted — losing the coverage it exists to protect. The failure message lists every
   offending core file so the author is never left guessing.
3. **Waivable with `#no-core-test-gate` in the PR body**, for changes that provably cannot be
   covered (a comment, a rename). The marker is named in the failure output, so a waived gate is
   visible rather than silent.
4. **The gate's own files are exempt** (the script and its unit test). Otherwise fixing the gate
   would itself demand a `core/**` test change — the gate could never be repaired in place.
5. **Diff against the merge-base**, not the branch tip: a `main` commit landing mid-PR can neither
   fire the gate nor mask a real violation. An unresolvable merge base falls back to a working-tree
   diff; the gate never silently disables itself.
6. **A tooling failure stands down, loudly.** If the changed-file set cannot be computed, the gate
   prints a notice and passes — an outage is not a policy violation.
7. **The decision logic is pure and unit-tested.** A gate whose own logic is untested eventually
   blocks the wrong PR. It also never blocks on stdin (the PR body is read from a file), because a
   blocking read hangs the gate rather than reporting a verdict — the first local run did exactly
   that.

## Consequences

- A `core/**` edit now costs one test edit. That is the intended tax, and the waiver is the escape
  for the cases where it is not worth paying.
- The gate is advisory in practice: it lives in the `checks` job, which is always run and already
  required, so it cannot go missing the way a filtered job can (ADR 0017). It amends nothing: 0017's
  required-job contract is unchanged, and a policy check inside an existing always-running job needs
  no amendment to it.
- `AGENTS.md` and `docs/ci-inventory.md` now state the rule and the waiver, so the policy is
  discoverable from the docs an agent reads before changing `core/**`.
