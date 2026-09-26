# 0037: The daily gate is a single pref (lastScriptsCheckDate)

- **Status:** accepted
- **Date:** 2026-09-26
- **Amends:** [0012](./0012-new-tab-daily-notification.md) — collapses the two-pref daily gate into
  one pref with two writers

## Context

ADR 0012 gated the daily check with two prefs: `lastUpdateTabShown` (written when the tab opens) and
`lastScriptsCheckDate` (written by the tab UI when the user decided). #333 initially added a third,
`lastVerifiedDate`, written only on the up-to-date path, so a machine observation could not be
confused with a user decision. Reviewing that landed the simpler model: the three prefs did not pay
for themselves. The user-facing behaviors the split was meant to protect are all preserved by one
pref with two writers — and "Remind me Tomorrow" was always a same-day tab suppressor, not a
decision that changes the update's fate: a pending update resurfaces tomorrow regardless; the only
ways to stop it permanently are to install it or check "Don't show again for this update".

## Decision

One daily pref, `extensions.firefox-scripts.lastScriptsCheckDate` (YYYY-MM-DD), gates every check.
It means "the updater handled today" and has exactly two writers:

1. **`checkForUpdates`** (scriptsUpdater.sys.mjs), when a check ran, the manifest was reached
   (`manifestReached: false` leaves the day unwritten — a network-failure day must not consume the
   next one), and every package matched it — the up-to-date path costs one fetch + one hash pass per
   **day**, not per browser session (the pre-#333 gap).
2. **The updater tab** (updater.js in updater-ui.zip, `engineInit`), right after the tab is up and
   rendered, when the tab was shown for a pending update — so an ignored tab does not re-open the
   same day and the scheduler stays quiet for the day.

Terminal user actions (install / per-package skip / restart) re-record the day through
`recordUserDecision`, keeping a post-midnight re-check quiet; "Remind me Tomorrow" and plain close
do not write anything extra — tomorrow's check re-runs and the tab comes back.

## Consequences

- A pending update resurfaces **daily** until it is installed or skipped per package; a tab closed
  without acting is a same-day suppression only. That is the intended notification contract — the
  old `lastUpdateTabShown` semantics for the tab, plus the #333 rate limit for the happy path,
  expressed in one pref.
- `lastUpdateTabShown` and the #333-era `lastVerifiedDate` are retired; existing installs simply
  stop reading them (a stale value is inert; no migration).
- Verified by `test/unit/e2e/scriptsUpdater-daily-gate.test.mjs` (up-to-date write, same-day
  no-fetch, unreachable-manifest guard, pending-update path, retired-name canary across the module
  and the tab engine).
