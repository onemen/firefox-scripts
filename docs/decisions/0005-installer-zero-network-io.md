# 0005: The C installer performs zero network I/O

- **Status:** accepted
- **Date:** 2026-08-03

## Context

The installer originally shelled out to `curl`/`unzip` at runtime to download and extract packages —
extra runtime dependencies, and the package host matters: GitHub release-asset CDNs send no
`Access-Control-Allow-Origin`, so a browser tab cannot fetch from them. The installer already embeds
a web UI and a local HTTP server on `127.0.0.1`.

## Decision

The C binary performs **zero network I/O**. The browser tab (served by the installer's local server)
fetches every external payload — package zips, hash manifest, Waterfox release list, latest-release
JSON — from CORS-enabled hosts (GitHub Pages in prod, jsDelivr in dev) and POSTs the raw bytes to
the local server (`/api/upload`). Vendored miniz extracts the zips in-process on every platform; no
`curl`, no `unzip`, no external process (`90127e3`, 2026-08-03).

## Consequences

The installer stays a single small native binary with no runtime dependencies, and a failed fetch
surfaces as a UI banner instead of a silent partial install. The tab must trust the CORS host —
https plus hash verification ([0002](./0002-hash-based-update-detection.md)) gates the content, and
the session token ([0010](./0010-session-token-no-cors.md)) gates the upload API. Revisit-if: the
installer ever needs to work without a browser, or a dependency-free HTTP client is embedded.
