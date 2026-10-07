# 0041: AV + VirusTotal gate — a detection is a publish veto

- **Status:** accepted
- **Date:** 2026-10-07

## Context

0032 pins the toolchain because antivirus engines score fresh, unsigned binaries and verdicts are
only comparable when the bytes are — but the gate those stable bytes exist for was never recorded.
[0030](./0030-partial-publishes.md) builds its whole holdback mechanism on the assumption that a
refusing gate exists, and 0032's Context tells the #157 Defender story as motivation for pinning,
while nothing in the log says what the gate actually does. The audit ranked this among the top four
missing records (2026-10-06, P2-12 / #446): an unsigned binary plus a refusing gate is exactly the
kind of "no" that gets re-litigated.

## Decision

A detection blocks the publish; an unavailable scan warns but does not block. The **host AV gate**
scans the exact bytes about to be uploaded (Windows Defender on Windows, ClamAV elsewhere): any
detection hard-fails the run and _refuses to publish_; a missing scanner only warns. The
**VirusTotal gate** (when `VT_API_KEY` is set) fails on multi-engine consensus —
`malicious >= threshold` (default 3), not a single-engine false positive — or on a **veto engine**
(Microsoft) reporting malicious at any count; any fail verdict returns before the publishing
section, so no asset is uploaded. Unavailability (missing key, transient API error, analysis never
completing) degrades to a warning, never a silent pass. Verdicts are ledgered per sha256
(`tools/ci/avLedger.mjs`, re-scanned by the `av-watchdog`): skipped engines are recorded as
`unknown`, never as clean, and the ledger is never the reason a release fails.

## Consequences

A single real detection blocks the release; the deliberate route around a false positive is
[0030](./0030-partial-publishes.md)'s role holdback — publish everything else, keep the flagged
bytes' last accepted version serving. The hash-keyed ledger makes a WDSI/SignPath clearance reusable
across rebuilds, which only works because 0032 makes those rebuilds byte-identical — the two records
are one policy: stable bytes (0032), clean bytes or no publish (here). The cost: the VT half is only
as strong as the key — CI must set `VT_API_KEY` or that half is warn-only, and a veto-engine false
positive is resolved by holding the role back, not by weakening the gate. Revisit-if: code signing
lands (#157) and the false-positive problem changes shape — the same condition 0030 and 0032 already
name.
