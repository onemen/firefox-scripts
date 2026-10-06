# 0039: record-validation keys on the updater legs alone

## Status

- **Status:** accepted
- **Date:** 2026-10-06
- **Amends:** [0021](./0021-tiered-publish-gating-shared-resolver.md) (its "record-validation
  skipped for partial runs" escape is untouched; what changes is which job results the hard-gate
  record keys on — the aggregate gate drops out of the condition, the updater legs stay)

Related: [0025](./0025-waterfox-hard-gate.md) (waterfox is one of the recorded browsers, on its
single required Windows leg), [0034](./0034-fork-e2e-legs-pin-to-validated-release.md) (the fork
record's separate file and condition — untouched by this).

## Context

`record-validation` writes `validated.json` — the file the prod publish pre-flight compares against
the current releases. Its condition used to require `needs.e2e-gate.result == 'success'` **and**
`needs.updater.result == 'success'`. The gate, though, is a summary of every leg: one red unrelated
required leg (say, `installer` on one OS) or one red advisory leaves the gate non-success, and the
record was skipped even when all nine updater legs — the only evidence this job reads — ran and
passed.

That was a latent inefficiency until #380 made it structural. The workflow lost its `push: [main]`
and `schedule:` triggers; the nightly revalidation is now the only run `main` gets. A nightly with
one flaked non-updater leg used to skip the record, and the publish gate then read drift until the
next green night — a full day of a blocked publish for a leg the record never looks at.

## Decision

The condition keys on `needs.updater.result == 'success'` alone (plus the event guards: never on a
PR, never on a partial dispatch). The updater legs are the evidence the recorder consumes — per-leg
version artifacts from exactly those nine legs — so their result is the only job result that can
rationally gate the record. The gate drops out of the condition entirely.

What makes the widening safe is what did **not** change: the recorder's own agreement contract
(`collectLegVersions`) still throws unless every `VALIDATED_BROWSER` has one artifact per expected
OS and all legs agree, so a partially-failed updater matrix produces holes and exits 1. The
condition decides _when the recorder runs_; the recorder decides _what may land in the record_. A
contract test (`test/unit/tools/record-validation-condition.test.mjs`) parses the condition out of
the workflow so an edit that reintroduces the gate clause — or drops a guard — fails a test instead
of surfacing as a mysteriously stale record.

## Consequences

The record no longer freezes when an unrelated leg fails; the publish drift gate reflects what the
updater legs actually validated, every night. The cost is naming honesty: a green record on a run
whose gate is red is now _expected_, and reads as "the updater legs passed" — not "the run passed".
The ADR 0021 partial-dispatch skip survives unchanged (a single-browser escape still never touches
`validated.json`); a full dispatch — the nightly revalidation — records, which is what keeps the
publish gate satisfied without a main-push run. If a future leg type starts feeding the recorder,
this condition must be revisited, not extended silently.
