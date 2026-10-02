# 0038: OS-temp residency and reclamation

## Status

- **Status:** accepted
- **Date:** 2026-10-02

Recorded because it names a storage home (the OS temp dir) and a reclamation primitive (live-root
registry + age prune); neither had a record, and the class of leak it governs has recurred three
times (see Context). It amends no earlier record — [0008] covers generated files in `dist/`, not
temp residency.

## Context

The OS temp dir is used by four actors and reclaimed by none of them. On 2026-10-02 the dev
machine's `%TEMP%` still held, from the repo's own work:

- 11 `fxs-e2e-*` Firefox profiles, 412 MB — the E2E mkdtemps one per scenario and each scenario's
  `finally` only covers the success path, so an interrupted run strands ~50 MB;
- `firefox-portable-setup.exe` + `firefox-esr-140-portable-setup.exe`, 140 MB — the local download
  cache, which defaults to the OS temp dir and had no eviction;
- `fxs-portable`, 365 MB — a whole browser, from a run that pointed `PORTABLE_BROWSER_DIR` there;
- 4 `fxs-updater-ui-*` staging dirs — the shipped updater's `finally` cleanup, lost when the browser
  is killed mid-swap;
- plus ~762 MB of ad-hoc agent probe scratch.

Windows prunes temp files only after ~30 days, so nothing disappears on its own. Earlier records
fixed single instances of this class ([0028]-era `cr-batch-*` husks, the #378 mkdtemp sweep of 2130
unit-test dirs, the #379 scratch-file rule) and each time the next actor re-leaked.

## Decision

1. **The OS temp dir is an allowed home, with an owner.** Temp residency is not itself the defect;
   unowned residency is. Every creator registers what it makes.
2. **Creator-side reclamation is synchronous with creation.** `tempDir()` in
   `test/e2e/shared/helpers.mjs` registers each root; the registry is swept on `exit`, `SIGINT`,
   `SIGTERM`, `SIGHUP` and both crash events, each handler reproducing Node's default disposition so
   exit codes and stacks are unchanged. A root that still will not delete is recorded in
   `dist/e2e-leaked-temp.txt` rather than silently dropped.
3. **Age is the only liveness signal for the backstop.** Each E2E entry point prunes
   harness-prefixed roots older than 6h before its first scenario. A stale `.parentlock` is exactly
   the stranded case, so it must never be read as "in use"; a live leg's profile is seconds old.
4. **The shipped updater does the same thing inside the browser.** Its staging dir is named per
   process (one session reuses one dir; two browsers never collide) and reclaimed on startup when
   older than 24h. The installer's `%TEMP%\installer_win.log` rotates at 256 KB, one generation.
5. **Caches are caches, not storage.** `pnpm e2e:portable` refuses a destination inside the OS temp
   dir (`--allow-temp-dir` overrides); cached installers are pruned after 7 days.
6. **Unowned litter is a gate, not a habit.** `test-hygiene.test.mjs` fails when the OS temp dir
   holds a `fxs-*` entry older than 24h (`FXS_TEMP_KEEP` marks a deliberate one). Agent scratch
   belongs in the repo's gitignored `dist/scratch/`.

## Consequences

- An E2E leg interrupted in any way — Ctrl-C, agent timeout, `process.exit`, power loss — leaves at
  most what the next run's prune reclaims; in the normal case, nothing. One platform asymmetry: on
  Windows a parent's `child.kill()` is `TerminateProcess`, which no JS handler can intercept, so the
  prune (not the sweep) is what reclaims a harness run killed by its parent.
- CI is unaffected: its temp dir is per-job, and the prune/gate only ever name `fxs-*` entries.
- The 24h/6h/7d thresholds are the liveness heuristic; lowering them trades reclaim speed for a
  bigger window in which a slow run's directory looks abandoned.
- Nothing here deletes pre-existing entries automatically — a human clears its own `%TEMP%`.
