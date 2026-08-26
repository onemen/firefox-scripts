# 0012: Update notification = new tab, daily check only

- **Status:** accepted
- **Date:** 2026-08-01

## Context

The updater must tell the user an update is available without OS-level integration and must not nag.
Two daily prefs track two different things: when the notification tab was shown, and when the user
actually decided.

## Decision

Notification is a new tab (`b.addTrustedTab` of the updater UI), never an OS notification, and the
check runs on a **daily timer** — no "Check for updates now" button. `lastUpdateTabShown`
(YYYY-MM-DD) is set when the tab opens, so an ignored tab does not re-open the same day;
`lastScriptsCheckDate` is set only by the tab UI on a real decision (install / skip / Remind me
Tomorrow / restart). Closing the tab without acting records nothing, so the pending update
resurfaces. Per-package `skippedHash.*` prefs suppress a specific remote hash and are cleared when
the remote hash changes or local files match (`b5405a8`, 2026-08-01; confirmed in the Aug 2026
design review).

## Consequences

No OS notification permissions, no scheduler beyond a `setInterval`, and an ignored update is never
marked as "checked". If a package cannot be downloaded the check exits silently — there is no
fallback UI. Revisit-if: OS notifications or a manual check button are ever requested.
