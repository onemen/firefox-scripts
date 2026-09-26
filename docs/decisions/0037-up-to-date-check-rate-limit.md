# 0037: An up-to-date check is rate-limited by a machine-written lastVerifiedDate

- **Status:** accepted
- **Date:** 2026-09-26
- **Amends:** [0012](./0012-new-tab-daily-notification.md) — adds a third daily pref for the
  up-to-date path; the two-pref user-decision model is otherwise intact

## Context

ADR 0012 gates the daily check with two prefs: `lastUpdateTabShown` (written when the tab opens) and
`lastScriptsCheckDate` (written ONLY by the tab UI when the user decides). That leaves the happy
path unrecorded: when the check runs and everything is up to date, the function returns without
writing anything, so **every new browser session re-ran the full check** — a manifest fetch plus
hashing of every installed package — instead of once per day (the 24h in-session timer was already
gated; the gap was across sessions). Re-running is silent and cheap-ish, but it is exactly the
behavior the "daily check" decision was meant to specify, and the code comment ("same-day re-checks
are pref-gated no-ops") overstated it. The obvious fix — writing `lastScriptsCheckDate` from the
gate — was rejected: it would flip a machine observation into a fake user decision and break ADR
0012's semantics (a pending update must keep resurfacing, which rests on "that pref means the USER
decided").

## Decision

A third daily pref, `extensions.firefox-scripts.lastVerifiedDate` (YYYY-MM-DD), is written by
`checkForUpdates` **only** when a check ran, the manifest was actually reached, and every package
matched it — "the check ran today and found nothing", never "the user decided". The gate skips the
check when any of the three daily prefs equals today. Consequences of that definition:

- The user-decision model of [0012](./0012-new-tab-daily-notification.md) is untouched:
  `lastScriptsCheckDate` still has exactly one writer (the tab UI), a pending update still
  resurfaces on the next session, and a closed-without-acting tab still records nothing.
- An **unreachable manifest never writes the marker** (the check result carries
  `manifestReached: false`): a network-failure day must not rate-limit away the next day of checks.
  The marker is also not written when an update is pending — that path has its own gating
  (`lastUpdateTabShown`).
- The marker is deliberately **not cleared** when an update later appears: a stale verified date
  only means the check re-runs once and rewrites it, so cleared/absent/stale are all the same safe
  state.

## Consequences

The happy path costs one manifest fetch + one hash pass per day instead of per session; a release
published mid-day is picked up on the next day's first check (or the next session after any
non-verified day), which is the accepted trade for not hammering the manifest host on every browser
start. No UI, no new surface, no migration: absent pref = pre-fix behavior. Verified by
`test/unit/e2e/scriptsUpdater-daily-gate.test.mjs` (marker write, same-day no-fetch, decision-pref
isolation, unreachable-manifest guard, pending-update path, pref-name canary).
