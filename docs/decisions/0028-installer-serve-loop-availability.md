# 0028: Installer serve loop bounded by per-connection read deadlines

- **Status:** accepted
- **Date:** 2026-09-15

## Context

The installer's local HTTP server runs a single-threaded blocking `accept()` loop on
`127.0.0.1:8777` (see [ADR 0010](./0010-session-token-no-cors.md) for the trust model). One stalled
connection therefore blocks every request behind it — including the tab's `/api/status` polling and
the browser's zip uploads. [ADR 0010](./0010-session-token-no-cors.md) covered who may drive the API
(session token, no CORS) but not whether the server stays reachable: availability was an unrecorded
decision. The 2026-09-15 comprehensive audit flagged the missing per-connection timeout as a P1
reliability finding.

## Decision

Every accepted socket carries two independent read deadlines:

- **Idle — 10 s `SO_RCVTIMEO`** (also set on the listen socket under Winsock, where the accepted
  handle does not reliably inherit it). Aborts connections that send nothing at all.
- **Total — 30 s monotonic-clock bound over the whole request-read phase**, checked after every
  successful recv. Necessary because a client dribbling one byte every few seconds resets the idle
  deadline forever; the idle bound alone does not close the finding.

On expiry the request is answered `408 Request Timeout` — a response, not just a close, so a client
can distinguish "server shed you" from a network failure — and the connection is closed. A clean
client close before finishing a request (`recv` returning 0) stays silent. The overrides
(`http_server_set_timeouts`, honored only under `--smoke-test` via `FXS_HTTP_RECV_TIMEOUT_MS` /
`FXS_HTTP_REQUEST_TOTAL_TIMEOUT_MS`) exist so the security smoke can shorten the deadlines to
seconds; production always runs the defaults.

## Consequences

The serve loop sheds stalled and dribbling clients instead of wedging: the smoke test asserts both
that an idle connection and a dribbler (one byte per 300 ms against a 1 s idle deadline) receive
408, and that the server keeps serving valid-token requests afterwards. Deadline overrides are
unreachable outside `--smoke-test` builds/runs. Revisit-if: the installer ever needs concurrent
request handling (threads or a poll loop) — at that point per-connection deadlines stop being the
availability boundary.
