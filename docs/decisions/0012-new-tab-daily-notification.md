# 0012: Update notification = new tab, daily check only

- **Status:** accepted
- **Date:** 2026-08-01
- **Amended:** [0026](./0026-publish-channels-and-dead-channel-fallback.md) — scoped test-channel
  exception to the silent-exit invariant
- **Amended:** [0029](./0029-status-line-amendments.md) — its own amendment convention
- **Amended:** [0037](./0037-up-to-date-check-rate-limit.md) — the two-pref daily gate is collapsed
  into one pref (`lastScriptsCheckDate`, two writers: the up-to-date check and the shown tab);
  `lastUpdateTabShown` is retired

## Context

The updater must tell the user an update is available without OS-level integration and must not nag.
(Two daily prefs tracked the tab-shown and user-decided days originally;
[0037](./0037-up-to-date-check-rate-limit.md) collapsed them into one — see below.)

## Decision

Notification is a new tab (`b.addTrustedTab` of the updater UI), never an OS notification, and the
check runs on a **daily timer** (startup + an in-session daily re-check) — no "Check for updates
now" button. Since [0037](./0037-up-to-date-check-rate-limit.md) a single daily pref,
`lastScriptsCheckDate` (YYYY-MM-DD), gates the check: the scheduler writes it on the up-to-date
path, the tab writes it once shown, and terminal user actions (install / skip / restart) re-record
it. An ignored tab is suppressed for the day and the pending update resurfaces tomorrow; per-package
`skippedHash.*` prefs suppress a specific remote hash and are cleared when the remote hash changes
or local files match (`b5405a8`, 2026-08-01; confirmed in the Aug 2026 design review).

## Consequences (amended 2026-09-26 by [0037](./0037-up-to-date-check-rate-limit.md))

No OS notification permissions, no scheduler beyond the daily timer (amended 2026-09-23, #292: the
original `setInterval` never actually fired — window-bound timer globals don't exist in the ESM's
module scope — so the mechanism is now an `nsITimer` (`TYPE_REPEATING_SLACK`) living for the
session's duration; the daily pref keeps gating every invocation). If a package cannot be downloaded
the check exits silently — there is no fallback UI. Scoped exception: a test-channel build whose own
manifest is unreachable falls back to the stable channel per
[0026](./0026-publish-channels-and-dead-channel-fallback.md) — still through this tab, no new
surface. Revisit-if: OS notifications or a manual check button are ever requested.
