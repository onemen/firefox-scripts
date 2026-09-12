# 0026: Publish channels — stable (CI-only) vs test (branch-only dev), dead-test-channel fallback

- **Status:** accepted
- **Date:** 2026-09-12
- **Extends:** [0009](./0009-unified-publish-modes.md) (unified publish modes — the pipeline and the
  prod gate are unchanged; this record defines the channel model on top of them)

## Context

[0009] gave dev publishing a disposable `dev-build-<id>` branch + prerelease. Real usage diverged
from that contract: dev builds acquired actual users (`dev-build-main-450468f` shows real download
counts), but a dev install's generated config points **exclusively** at its own branch (jsDelivr
`@dev-build-<id>`, `-dev` asset names, `IS_DEV`). When that branch is deleted the daily check's
manifest fetch 404s and the check exits silently ([0002]'s failure rule) — the install is stranded
forever, invisibly: it never compares against the stable channel because its config contains no
stable URLs. Separately, prod publishing needs the full cross-OS binary set ([0024]), which only CI
can build; a local `--mode=prod` run publishes an incomplete asset set. And RC-style announcements
want a browsable page, while routine dev testing wants no release clutter.

## Decision

Two channels. **Stable** = `--mode=prod` (`latest` release + gh-pages). **Test** = `--mode=dev`.

1. **Test publishes are branch-only.** `--mode=dev` pushes artifacts to the `dev-build-<id>` branch
   and creates **no release**. `--mode=dev --note="<label>"` opts into a prerelease page (title
   `dev-build-<id> — <label>`, body: the note, a test-build warning, and provenance — source commit
   and date) for RC-style announcements. The existing `dev-build-main-450468f` release stays as a
   historical artifact; it is not deleted and not re-created.
2. **Test-channel configs carry the stable channel's URLs.** The generators emit `STABLE_HASHES_URL`
   / `STABLE_ZIP_BASE_URL` / `STABLE_UI_BASE_URL` / `STABLE_HELPER_BASE_URL` (derived from
   `config/installer.conf` per [0013] — no hardcoded URLs) into dev builds only; stable builds get
   empty values, the channel being their own.
3. **Dead-test-channel fallback.** When a test-channel daily check cannot fetch its own manifest
   (branch deleted or expired), it fetches the **stable** manifest from the `STABLE_*` URLs and runs
   the same hash comparison ([0002] unchanged). A difference is auto-installed through the existing
   updater flow (the updater is always auto-install within reachability); installing stable rewrites
   the installed `updater-config.sys.mjs` with prod URLs, so the channel migrates itself. What
   happened is recorded through the updater tab's existing banner surface ([0012] — no new
   notification mechanism, daily-gate prefs pattern applies). If stable is also unreachable, the
   existing silent exit stands.
4. **Prod is CI-only.** A real (non-`--local`) `--mode=prod` run outside the Pages publish workflow
   is rejected before building; prod publishes go through CI, which builds the full installer +
   helper set for all platforms ([0024]).

This supersedes the "if a package cannot be downloaded the check exits silently — no fallback UI"
invariant (AGENTS.md / `docs/`) **for the test channel only**; stable-channel behavior is unchanged.

## Consequences

Test installs keep auto-updating within their branch while it lives; a branch may only be deleted
once the fallback logic has reached its users (republish into the same `DEV_BUILD_ID` first — the
existing installs auto-install the fixed updater from the still-alive branch). The bootstrap
republish is the delivery mechanism, so no consent banner is needed for the fix itself. `--local`
snapshots keep the silent-exit behavior (ephemeral by design). Revisit-if: test installs must
outlive their branch with per-branch identity intact (a fork distribution channel), or stable itself
needs a migration path — then supersede this record.
