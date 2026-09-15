// test/e2e/installer/apiRoutes.mjs — the installer's /api route + session-token
// contract, in one place.
//
// Two consumers must agree on which route requires the session token:
//
// - test/e2e/installer/smoke-security.mjs probes a RUNNING installer against
//   these sets, so it needs a built binary and only runs in the E2E job.
// - test/unit/e2e/apiRouteContract.test.mjs diffs these sets against the routes
//   actually registered and gated in installer/src/*.c — static analysis, so it
//   runs on every `pnpm test` with no build.
//
// The second check is why the lists live here rather than inline in the smoke
// test: it compares C reality against the SAME sets the smoke test enforces, so
// adding, renaming or re-gating an /api route without classifying it fails the
// unit test instead of silently escaping the security smoke test.
//
// Route names are bare (the `/api/` prefix is added by the consumers).

/**
 * State-changing routes: a missing or stale `?t=` token is refused with
 * `{"error":"unauthorized"}`. Every one must call `request_has_valid_token()`
 * in its C handler (installer/src/main.c).
 */
export const GATED_API_ROUTES = [
  'status',
  'install',
  'self-update',
  'manifest',
  'upload',
  'waterfox',
  'hg-tags',
  'close-browser',
  'open-folder',
  'rescan',
  'restart',
];

/**
 * `/api/shutdown` is token-gated too, but is its own case: a stale tab (it
 * closes itself on exit) or a foreign local page must not be able to kill a
 * running installer, and must not be told why — so a missing/mismatched token
 * gets HTTP 200 `{"status":"ignored"}` instead of an error. Its comparison is
 * hand-rolled against `installer_session_token()` in
 * installer/src/http_server.c rather than `request_has_valid_token()`.
 */
export const SHUTDOWN_API_ROUTE = 'shutdown';

/**
 * `/api/claim` never rejects: it reports whether the caller's token is the
 * current run's (`{"ok":1,"current":0|1}`), which is how the UI tells a live
 * installer tab from a stale restored one. Read-only in effect.
 */
export const TOKEN_REFLECTING_API_ROUTE = 'claim';

/**
 * Read-only routes: usable without a token (an anonymous fetch must be able to
 * discover the installer), but never CORS-enabled either.
 */
export const OPEN_API_ROUTES = ['ping', 'build-info', 'browsers', 'package-urls'];

/** The refused-with-error body every `GATED_API_ROUTES` handler returns. */
export const UNAUTHORIZED_REJECT_BODY = 'unauthorized';

/** The ignored-request body `/api/shutdown` returns for a missing/stale token. */
export const SHUTDOWN_REJECT_BODY = 'ignored';
