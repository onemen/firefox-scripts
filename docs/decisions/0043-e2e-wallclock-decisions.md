# 0043: E2E wall-clock items considered and deferred, with the reasons

- **Status:** accepted
- **Date:** 2026-10-09
- **Part of:** #444 (wall-clock burst, items 4–6)
- **Related:** [0017](./0017-ci-validation-contract.md) (path-filtered gates — the contract these
  items would amend), [0042](./0042-e2e-required-gate-advisory-reporter.md) (the item that shipped)

## Context

#444 ranked six wall-clock items. Item 1 (the required gate no longer waits on advisory legs)
shipped as ADR [0042](./0042-e2e-required-gate-advisory-reporter.md). Items 2 (a second dispatch
sample) and 3 (cache cleanup under the family policy) are operational, not code. Items 4–6 each
propose a change to the E2E workflow; this record is why they are **not** taken as-is, so the next
agent does not re-litigate them without new data.

## Decision

1. **The `updater` path filter is left whole (item 4).** The proposed split — snapshot-shaping
   paths out of the `updater` filter — does not survive inspection of what each path can break. The
   updater legs are the only thing that installs and exercises the built snapshot: `config/
   installer.conf` generates the config that ships inside `utils.zip` (the updater's own payload),
   and `tools/publish/upload.mjs` / `syncGeneratedFiles.mjs` decide the snapshot's baked identity —
   the 2026-09-25 regression (documented inline in the workflow) shipped green legs on every
   browser while every snapshot installer pointed at the release URLs. Those paths were added to
   the filter *because* skipping them lost real failures. The only path with no updater-matrix role
   is `installer/Makefile`, and removing a single path does not buy the 15m20s median change the
   issue hoped for. Revisit-if: the updater legs gain an artifact-level unit test, so a
   snapshot-shaping change has independent coverage.
2. **The macOS advisory decision is "accept the queue" (item 5).** `installer` and `core-lifecycle`
   macOS legs are not made advisory: their assertions are the same code path as Linux/Windows, but
   making a leg advisory to save runner-minutes trades away the only macOS signal on PRs that touch
   installer or core. The measured cost is a queued leg on full runs, which is a latency symptom,
   not a correctness one — and item 1 already removed the tail that dominated merge latency.
   Revisit-if: macOS queueing starts failing runs rather than delaying them.
3. **The snapshot is not cached on its input hash (item 6).** `pnpm snapshot:dev` runs `upload.mjs
   --local`, which bakes the **building machine's absolute `file://` path** into the generated
   updater config (`applyUpdaterLocalOverrides`) — the E2E harness compensates per-run with
   override prefs. A cache entry is therefore a build from a *specific* runner workspace, and a
   restore that does not match it reintroduces exactly the class of failure the 2026-09-25
   regression was. The saved time is ~30 s on a hit; the failure mode is a green-looking snapshot
   that tests the wrong paths. Revisit-if: the local build stops baking absolute paths (e.g. a
   relative/`env.json`-driven base), at which point the artifact becomes cacheable safely.
4. **The carried-over "false OK_STATUSES auto-close comment" is not a defect.** The comment claims
   no `gh issue close` exists anywhere; `tools/check-browser-downloads.mjs` calls
   `closeResolvedFailureIssues(...)` for every `OK_STATUSES` browser, which closes via the API. No
   change made.

## Consequences

Items 4–6 stay open as *measured and declined* rather than silently dropped: the issue can close
with the reasoning intact, and a future proposal starts from these thresholds instead of re-deriving
them. The two revisits that would change this record are named above (artifact-level updater
coverage; a path-free local snapshot build).
