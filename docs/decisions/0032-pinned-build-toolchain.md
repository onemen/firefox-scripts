# 0032: The Windows build toolchain is pinned, byte-for-byte

- **Status:** accepted
- **Date:** 2026-09-17

## Context

`installer_win.exe` is a fresh, unsigned binary on every build, and antivirus engines score exactly
that: a mid-cycle MSYS2 upgrade (gcc 16.1.0 → 16.2.0) changed the compiler output overnight and the
rebuilt binary was falsely flagged by Defender's ML the next day (#157). Verdicts are only
comparable — and reproducible for a WDSI/SignPath submission — when the bytes are.

## Decision

The Windows build toolchain is pinned: `config/msys2-toolchain.json` fixes the whole UCRT64 package
set (gcc, binutils, CRT, headers, winpthreads, and the library packages behind them) with per-file
SHA-256s; `.github/actions/pinned-msys2` installs exactly those files with `pacman -U`, puts the
tree first on PATH, and `msys2Toolchain.mjs --provenance` fails the job unless the compiler/linker
actually used report the pinned versions from one directory. Toolchain upgrades are deliberate
manifest edits, never `pacman -Syu` drift.

## Consequences

Reproducing a published build is two commands (`pnpm toolchain:local` + PATH export) and the
`deterministic` job proves environment-vs-pin byte-identity, so AV/WDSI submissions can cite a
rebuildable byte set. The cost is maintenance: the manifest must be bumped by hand on every
toolchain update, and Node's zlib (which shapes the embedded assets) stays version-sensitive —
reproduce published bytes with the node/zlib pair `--provenance` records (measured 2026-09-17).
Revisit-if the AV posture changes so that shipped-byte stability stops mattering.
