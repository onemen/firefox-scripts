# 0014: Browser restart via resume_session_once + explicit --profile

- **Status:** accepted
- **Date:** 2026-07-31

## Context

After an install the installer closes the target browser and relaunches it with a clean cache, and
its own UI tab must come back — otherwise the server stays open forever with no tab to close it.
Firefox has **no `-restore` command-line flag**; the forced-restore mechanism is the one-shot pref
`browser.sessionstore.resume_session_once`, which Firefox clears after the next launch.

## Decision

The restart worker quits the browser gracefully (WM_CLOSE — `taskkill /F` would look like a crash),
writes `user_pref("browser.sessionstore.resume_session_once", true)` into each relaunched profile's
`prefs.js`, and relaunches with an explicit `--profile <path>` so the UI URL cannot be routed to a
different running instance. The UI tab is closed first (navigated to `about:blank`, which is not
persisted) and the session token is rotated so stale restored tabs are inert (`a664cdb`,
2026-07-31).

## Consequences

The user's session restores and exactly one installer tab reopens on the live server; the restart
flow always targets the known profile. The one-shot pref must be written to `prefs.js`, not
`user.js` (which would re-apply forever). Revisit-if: Firefox ships a `-restore` flag or the
sessionstore API changes.
