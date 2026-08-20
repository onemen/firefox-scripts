# Security

Threat model, audit checklist, and tooling for the installer and updater.

## Threat model

The installer runs a local HTTP server on `127.0.0.1` for the duration of an install and opens a tab
in a browser. The primary threat is a **malicious web page open in any browser while the installer
is running**: the page can reach `http://127.0.0.1:<port>/...` and try to drive the installer API or
read its responses. The updater (a privileged script inside the browser) downloads packages from the
update server, so the secondary threat is a **compromised/malicious update source** delivering a
tampered archive.

Mitigations in place:

- **Session token.** Every state-changing API route requires `?t=<16-hex>` matching the per-run
  token embedded in the installer tab's URL. The token is generated from a CSPRNG (`BCryptGenRandom`
  on Windows, `getentropy` on POSIX); startup **fails closed** if secure randomness is unavailable.
- **No CORS.** Responses carry no `Access-Control-Allow-Origin` header, so cross-origin pages cannot
  read installer responses (the UI is same-origin).
- **Hash-verified packages.** Zips are verified against the published manifest hash **before** any
  extraction (updater) and before install (installer).
- **Zip-slip guard.** `extractZipFlatten`/`copyFileList` reject entry names that could escape the
  destination directory (absolute paths, backslashes, drive letters, `.`/`..`).

## Audit checklist (per release candidate)

Run through every item; each maps to code that already exists.

1. **API auth** — every state-changing route requires the session token: `/api/install`,
   `/api/upload`, `/api/manifest`, `/api/self-update`, `/api/waterfox`, `/api/hg-tags`,
   `/api/close-browser`, `/api/open-folder`, `/api/rescan`, `/api/restart`, `/api/shutdown` (checked
   via `request_has_valid_token()` in `installer/src/main.c`).
2. **No CORS headers** — grep for `Access-Control-Allow-Origin` across `installer/src/`; only
   comments may mention it.
3. **Token entropy** — `generate_session_token()` must come from the OS CSPRNG and fail closed
   (never degrade to a time/pid seed).
4. **Zip safety** — `extractZipFlatten`/`copyFileList` in
   `core/chrome/utils/updater/scriptsUpdater.sys.mjs` reject unsafe entry names; `ensureUpdaterUi`
   verifies the manifest hash before extracting.
5. **Shell usage** — `system()`/`popen()` calls in the C installer interpolate detected paths
   (browser binaries, profiles); paths come from user-writable files (`profiles.ini`, registry) so a
   path containing `"` or `$()` could break quoting. Reviewed, but new shell calls must use
   argv-array APIs (`CreateProcess*`, `execvp`) instead. `tools/publish/remote-ui/updater.js`
   already uses `Subprocess.call` with argv arrays.
6. **No eval / dynamic regex on untrusted input** — eslint (`security/detect-eval-with-expression`,
   `security/detect-unsafe-regex`) flags these.
7. **No secrets in logs** — the session token is logged at startup
   (`[startup] ... session_token=...`) deliberately (local, single-user diagnostic); do not log it
   in CI or remote contexts.

## Tooling

- `pnpm lint` — ESLint (incl. `eslint-plugin-security`) + clang-format check +
  `make -C installer analyze`.
- `make analyze` (in `installer/`) — `gcc -fanalyzer` over the installer C sources, filtered by
  `tools/analyze-c.mjs` to memory-safety/UB classes (use-after-free, leaks, NULL deref, overflow,
  uninit). Exits nonzero on any finding. Vendored `miniz` is excluded.
- `pnpm test` / `installer/test/test_hash.mjs` — verifies the C hash algorithm matches the JS
  reference, so a tampered package is detected consistently.
- `tools/test/smoke-security.mjs` — CI security smoke test: boots the installer headless
  (`--smoke-test`) and asserts every state-changing `/api` route rejects a missing/wrong session
  token, valid tokens pass the gate, and no response carries `Access-Control-Allow-Origin`. Runs in
  the CI workflow on Windows after `pnpm upload:local --mode=dev`; run it locally the same way.
- External reviews (e.g. Greptile on PRs) act as a second pair of eyes; treat findings as hypotheses
  to verify against this checklist, not as ground truth.
