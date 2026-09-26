# 0012: Update notification = new tab, daily check only

- **Status:** accepted
- **Date:** 2026-08-01
- **Amended:** [0026](./0026-publish-channels-and-dead-channel-fallback.md) — scoped test-channel
  exception to the silent-exit invariant
- **Amended:** [0029](./0029-status-line-amendments.md) — its own amendment convention
- **Amended:** 2026-09-26 — the daily gate is one pref with two writers (#333)

## Context

The updater must tell the user an update is available without OS-level integration and must not nag.

## Decision

Notification is a new tab of the updater UI, never an OS notification, and the check runs on a
**daily cadence** (startup + an in-session daily re-check) — no "Check for updates now" button. One
daily pref (YYYY-MM-DD) gates the check, with two writers (amended 2026-09-26, #333): the scheduler
writes it when a check ran and found everything up to date (an unreachable or unparseable manifest
never counts), and the tab writes it once shown. An ignored tab is suppressed for the day and the
pending update resurfaces tomorrow; per-package skip prefs suppress a specific remote hash and are
cleared when the remote hash changes or local files match (`b5405a8`, 2026-08-01; confirmed in the
Aug 2026 design review).

## Consequences

No OS notification permissions, no scheduler beyond the daily cadence (amended 2026-09-23, #292: the
re-check mechanism must not be window-bound — the ESM's module scope outlives any single browser
window; the daily pref keeps gating every invocation). If a package cannot be downloaded the check
exits silently — there is no fallback UI. Scoped exception: a test-channel build whose own manifest
is unreachable falls back to the stable channel per
[0026](./0026-publish-channels-and-dead-channel-fallback.md) — still through this tab, no new
surface. Revisit-if: OS notifications or a manual check button are ever requested.
