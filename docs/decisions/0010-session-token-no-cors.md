# 0010: Local installer server gated by session token, no CORS

- **Status:** accepted
- **Date:** 2026-08-21

## Context

The installer runs a local HTTP server on `127.0.0.1:8777` while a browser is open. A malicious web
page in any browser can reach `http://127.0.0.1:8777/…` and drive the API or read responses unless
the server authenticates requests and refuses cross-origin reads.

## Decision

Every state-changing route requires `?t=<16-hex>` matching a per-run token embedded in the installer
tab's URL, generated from the OS CSPRNG with a fail-closed startup (never a time/pid seed).
Responses carry no `Access-Control-Allow-Origin` header, so cross-origin pages cannot read them. A
security smoke test asserts every `/api/*` route rejects a missing/wrong token and no response has
the CORS header (`44a7e2e`, `e0411c8`).

## Consequences

Stale restored tabs (old token) are inert — they render a "closed" placeholder and cannot shut down
or restart the installer. The token is deliberately logged at startup for local diagnostics; it must
never be logged in CI or remote contexts. Revisit-if: a token-free localhost trust model (random
ephemeral ports plus Origin checks) is adopted.
