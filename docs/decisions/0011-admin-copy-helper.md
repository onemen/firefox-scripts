# 0011: Admin-rights copy via a standalone self-elevating helper

- **Status:** accepted
- **Date:** 2026-08-01

## Context

Config updates write `config.js` / `config-prefs.js` into the browser installation directory
(`GreD`) — `C:\Program Files\…` on Windows — which the un-elevated browser process cannot write. The
updater must copy files there with exactly one elevation prompt, and the elevation helper must not
be a cacheable stale binary.

## Decision

Admin copies use a small standalone C binary (`helper_win.exe` / `helper_linux` / `helper_mac`,
sources at `installer/src/helper/`), downloaded fresh into the per-run temp dir (never cached in the
profile), unblocked (Zone.Identifier / chmod +x), and invoked via argv arrays
(`Subprocess.call(helper <src> <dst> …)`). It self-elevates once (Windows `runas`, Linux `pkexec` →
`sudo`, macOS `osascript`) and exits `2` on cancelled elevation, which the tab maps to "elevation
cancelled". The updater tries a direct `IOUtils` copy first for user-owned installs (`a251313`,
`60845ed`).

## Consequences

Exactly one UAC / pkexec / osascript prompt per admin install, and no stale helper to re-verify —
the binary is a fixed HTTPS asset re-downloaded each run and deleted after install. The helper is
downloaded from the gh-pages branch ([0003](./0003-hash-manifest-on-gh-pages.md)). Revisit-if:
elevation is automated (issue #32) or an in-process elevation API appears.
