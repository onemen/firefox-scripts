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
- **Host/Origin validation.** A request whose `Host` is not `localhost:<port>` / `127.0.0.1:<port>`
  for the port the server bound — or whose `Origin`, when present, is not that same local origin —
  is refused with 403 before routing. This is what stops DNS rebinding: a rebound name is
  same-origin from the browser's point of view, so "no CORS header" alone would not keep the
  response away from it. An absent `Host` (HTTP/1.0) is tolerated; no browser page can omit it.
- **Hash-verified packages.** The updater verifies each zip against the published manifest hash
  before extraction and copies only manifest-listed files. The installer verifies uploads against
  the manifest it ingested — candidate bytes before they are stored, stored zips when the manifest
  arrives (`installer_verify_upload` / `installer_verify_stored_zips`). Exactly when that applies —
  and when it does not — is spelled out under "Stated invariants" below.
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

## Stated invariants (what the mitigations do NOT cover)

Four boundaries the threat model must state explicitly rather than leave to code reading:

- **Upload verification is conditional.** `installer_verify_upload()` checks a candidate upload
  against the _ingested_ manifest before the zip is stored; `installer_verify_stored_zips()`
  re-checks the stored zips when a manifest is ingested. But with no manifest reachable there is
  nothing to verify against (the documented fallback — the zip is its own reference),
  `updater-ui.zip` uploads are excluded (the `!is_ui` gate in `main.c`), and the EXTRACT states read
  the stored buffers without re-verifying. The checks gate _storage_, not extraction.
- **Privileged fetch URLs derive only from config.** The installer performs no network I/O; every
  URL the tab fetches (zips, manifest, self-update payload, release lists) arrives via
  `/api/package-urls`, which `main.c` builds from the `INSTALLER_*` macros generated from
  `config/installer.conf`. The one hardcoded URL in the tab (`installer/web/script/20-banners.js`)
  is a `window.open()` navigation to the human-facing `latest` release page — no bytes from it enter
  the install chain.
- **The manifest is an unsigned trust root.** `hashes.json` is served over HTTPS from gh-pages but
  is not signed: the hash chain detects tampering in transit or at rest, not a compromised
  publisher. Whoever can publish to the repository / pages controls the reference hashes; HTTPS plus
  the GitHub publish path is the trust anchor.
- **`--admin-copy` is an unrestricted elevated copy.** `admin_copy_mode()` copies arbitrary
  `src`/`dst` argv pairs with no path validation beyond creating the destination's parent
  directories (entry guard: `argc >= 4` in `main.c`). It is safe only because the relaunch
  originates from our own installer/updater behind a single OS elevation prompt — treat the argument
  surface as privileged and validate paths in any new caller.

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
  the CI workflow on Windows after `pnpm snapshot:dev`; run it locally the same way.
- External reviews (e.g. Greptile on PRs) act as a second pair of eyes; treat findings as hypotheses
  to verify against this checklist, not as ground truth.
