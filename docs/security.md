# Security

Threat model, audit checklist, and tooling for the installer and updater.

## Threat model

The installer runs a local HTTP server on `127.0.0.1` for the duration of an install and opens a tab
in a browser. The primary threat is a **malicious web page open in any browser while the installer
is running**: the page can reach `http://127.0.0.1:<port>/...` and try to drive the installer API or
read its responses. The updater (a privileged script inside the browser) downloads packages from the
update server, so the secondary threat is a **compromised/malicious update source** delivering a
tampered archive. The local-server security model is recorded as ADR
[0010](./decisions/0010-session-token-no-cors.md).

Mitigations in place:

- **Session token.** Every state-changing API route requires `?t=<32-hex>` matching the per-run
  token embedded in the installer tab's URL. The token is generated from a CSPRNG (`BCryptGenRandom`
  on Windows, `getentropy` on POSIX); startup **fails closed** if secure randomness is unavailable.
- **No CORS.** Responses carry no `Access-Control-Allow-Origin` header, so cross-origin pages cannot
  read installer responses (the UI is same-origin).
- **Hash-verified packages.** Zips are verified against the published manifest hash **before** any
  extraction (updater) and before install (installer).
- **Zip-slip guard.** `extractZipFlatten`/`copyFileList` reject entry names that could escape the
  destination directory (absolute paths, backslashes, drive letters, `.`/`..`).
- **Elevated-copy helper.** When an update lands in an admin-protected install dir, the updater tab
  downloads a standalone helper binary and runs it outside the browser sandbox (see "Helper threat
  model" below).

## Helper threat model (elevated copy)

The helper (`installer/src/helper/helper_*.{c}`, shipped as `helper_win.exe` etc.) exists to copy
config files into an admin-protected browser install dir when the plain, unprivileged copy fails. It
self-elevates exactly once (`asInvoker` manifest + a single `runas` relaunch on Windows,
`pkexec`/`sudo` on Linux, `osascript … with administrator privileges` on macOS); there is no
persistent elevated service and no elevation bypass — the user always sees the OS prompt.

Trust chain: the helper's **argv comes only from our own updater tab** (`updater.js`, running as
privileged chrome script), so the caller is already inside the browser's trust boundary. Before the
tab spawns the helper it verifies the downloaded bytes against the published `<helper>.sha256`
sidecar (issue #33) and checks the executable magic (PE/ELF/Mach-O, #275) — a tampered or corrupted
binary is refused before execution. Helper-side hardening (issue #274) treats the command line
itself as only semi-trusted: argument-shape violations (`argc` parity), `..` path components, and
command-line/probe-filename overflow attempts are rejected with `EXIT_BAD_ARGS` rather than
executed. Defense here is defense in depth — none of these checks is what stands between a web page
and the helper; that distance is made of the updater's own sandbox and the hash-verified download
chain.

## Audit checklist (per release candidate)

Run through every item; each maps to code that already exists.

1. **API auth** — every state-changing route requires the session token. The authoritative route
   classification lives in `test/e2e/installer/apiRoutes.mjs` (gated: `status`, `install`,
   `self-update`, `manifest`, `upload`, `waterfox`, `hg-tags`, `close-browser`, `open-folder`,
   `rescan`, `restart`; plus `shutdown`, which is gated but answers `200 ignored` to a stale token;
   open: `ping`, `build-info`, `browsers`, `package-urls`; token-reflecting: `claim`).
   `test/unit/e2e/apiRouteContract.test.mjs` diffs that list against the routes actually registered
   and gated in `installer/src/*.c` on every `pnpm test`, and the CI smoke test probes a running
   installer against the same sets — so this list cannot drift from code without failing CI.
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
   already uses `Subprocess.call` with argv arrays. The admin-copy fallback no longer shells out at
   all: it is an in-process buffered copy (2026-09-15 audit P2 fix); the remaining interpolated
   calls are the path-verified `pkill` sweep and hash/dialog helpers.
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
- `test/e2e/installer/smoke-security.mjs` — CI security smoke test: boots the installer headless
  (`--smoke-test`) and asserts every state-changing `/api` route rejects a missing/wrong session
  token, valid tokens pass the gate, and no response carries `Access-Control-Allow-Origin`. Runs in
  the CI workflow on Windows after `pnpm upload:local --mode=dev`; run it locally the same way.
- External reviews (e.g. Greptile on PRs) act as a second pair of eyes; treat findings as hypotheses
  to verify against this checklist, not as ground truth.
