# Troubleshooting

Symptom → fix. For the design behind these symptoms see [auto-updater.md](./auto-updater.md),
[status-logic.md](./status-logic.md) and [security.md](./security.md); for CI failures see
[continuous-integration.md](./continuous-integration.md).

## The installer

### The installer does nothing / no tab opens

- **Port 8777 is taken.** A second installer attaches to the instance already serving the port and
  opens its existing tab instead of starting a new server — check for a stray `installer_win.exe` in
  Task Manager and kill it, then re-run.
- **The tab opened but shows a network banner.** The C installer performs zero network I/O (ADR
  [0005](./decisions/0005-installer-zero-network-io.md)): the _tab_ fetches the zips, manifest and
  release lists from GitHub/Pages and POSTs them to the local server. A blocked or offline network
  surfaces as a banner and a refused install — fix connectivity (or a proxy blocking
  `api.github.com` / `onemen.github.io`) and retry.
- **No browser detected.** The installer detects browsers from running processes and their profile
  lock files. Start the browser once (so its lock file exists) or launch it from the installer tab's
  instructions, then re-run.

### Windows Defender / AV flags `installer_win.exe`

The binaries are unsigned, stripped, statically-linked PEs — the classic ML false-positive profile.
Do **not** publish a flagged build; see
[DEVELOPING.md → AV false positives and the AV scan gate](./DEVELOPING.md#av-false-positives-and-the-av-scan-gate)
for the gate, the measured root causes, and the WDSI/SignPath handling. Trackers: issues
[#157](https://github.com/onemen/firefox-scripts/issues/157) (detection) and
[#159](https://github.com/onemen/firefox-scripts/issues/159) (signing).

### Elevation is cancelled or fails

On Windows, installing into `Program Files` needs one UAC prompt (delivered by the freshly
downloaded standalone helper). Cancel is a **distinct exit code**, not a crash — re-run and accept
the prompt, or install to a per-user location that needs no elevation.

## The updater

### The updater tab never opens

- The daily check runs **once per day** (one pref, ADR
  [0012](./decisions/0012-new-tab-daily-notification.md)). Same-day restarts intentionally do
  nothing.
- A **completed** check that finds everything up to date records the day; an **unreachable manifest
  does not** — so a network failure does not rate-limit you away for 24 h, the next session retries.
- Open the tab manually to test: `chrome://firefox-scripts/content/ui/updater.html`. If it opens,
  the engine is fine and the issue is the check/gate, not the UI.

### Status shows the wrong state

The status words and the exact file-existence vs hash rules are defined in
[status-logic.md](./status-logic.md). In short: **Installed ≠ Up to date** — presence is a file
check, up-to-date is a per-package SHA-256 manifest comparison; a stale or partial install is still
"installed".

### An update is stuck / the tab shows errors

1. Open the **Browser Console** (`Ctrl+Shift+J`) and filter for `Firefox Scripts` — updater errors
   are logged with that prefix (tab-script errors are additionally routed through the console
   service so they survive ConsoleAPI limits, issue #292).
2. Check the packaged hashes match what is published:
   [`pnpm test:hash`](./DEVELOPING.md#test-installer-hash-verification).
3. A per-package **skip** is remembered (`extensions.firefox-scripts.skippedHash.<pkg>`): the
   package then shows _Skipped_, not _Update available_. Clear the pref to make the update
   resurface.

### After a Firefox update the scripts are gone

The scripts live in the browser install dir + profile and are re-copied by the updater; a
**browser-managed update** replaces the install dir. Re-run the installer (or wait for the daily
check) — see [auto-updater.md](./auto-updater.md).

## Publish / CI

### `pnpm publish:all` aborts with a STAGING banner

The staging guard refuses a **prod** publish whose target (repo, Pages host, release name) does not
match `config/installer.conf` — env vars cannot silently redirect a release. For an intentional
rehearsal set `FIREFOX_SCRIPTS_ALLOW_STAGING=1` (documented in `.env-example`); dev-mode publishes
only warn, and `snapshot:*` local runs never touch GitHub so they skip the guard entirely.

### The publish gate fails before uploading

The gate requires: main-only, no browser-version drift, an E2E run for this exact SHA, AV clean,
VirusTotal below the threshold with no Microsoft veto, a complete staging tree, and a
`pages-publish` slot. Read the failing step's log — each condition names its own error. See
[ci-inventory.md](./ci-inventory.md) for which job runs where and
[continuous-integration.md](./continuous-integration.md) for the path filters.

### A test or gate passes locally but fails in CI

Local builds and CI builds are **not the same bytes** (floating binutils/crt unless the pinned
toolchain is used) — measured in
[DEVELOPING.md → Why a clean local scan does not clear a CI build](./DEVELOPING.md#why-a-clean-local-scan-does-not-clear-a-ci-build-measured-2026-09-17).
Download what CI staged (`gh run download <run-id> -n staged-win`) instead of trusting a local scan.
For test/CLI repro, match the Node version (≥ 24) and run `pnpm lint && pnpm test`.

### Generated-file or hash-test failures

`pnpm test:hash` refuses to run against a snapshot whose installer was built from different sources
— regenerate with `pnpm snapshot:prod` on a clean tree. Never hand-edit the six generated files; see
[DEVELOPING.md → Generated files](./DEVELOPING.md#generated-files) and ADR
[0008](./decisions/0008-generated-files-untracked.md).

## Getting more detail

- **Interactive debugging of `core/` files:** [debugging-with-rdp.md](./debugging-with-rdp.md).
- **Deciding before changing architecture:** the ADR log [decisions/index.md](./decisions/index.md).
- **Still stuck?** Search/open an issue: <https://github.com/onemen/firefox-scripts/issues>.
