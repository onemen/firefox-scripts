---
name: publishing
description:
  Publish releases of firefox-scripts with the unified upload pipeline — prod (latest release +
  gh-pages, main only) vs dev (disposable dev-build-<id> branch), token prerequisites, what gets
  rebuilt, and post-publish cleanup. Use when the user asks to publish, release, deploy, or upload,
  or wants to test a build in a real browser.
---

# Publishing a release

Publishing requires **explicit user permission** — when in doubt, stop at `upload:local` (the
token-less offline check). All modes require a **clean worktree**.

## Modes

| Mode | Release tag      | Publish branch                         | Artifact names  | Branch gate    |
| ---- | ---------------- | -------------------------------------- | --------------- | -------------- |
| prod | `latest`         | `gh-pages` (live site)                 | `utils.zip`     | must be `main` |
| dev  | `dev-build-<id>` | `dev-build-<id>` (served via jsDelivr) | `utils-dev.zip` | any branch     |

Prod publishes to the **live** `latest` release and gh-pages site. Dev lands on a per-run disposable
branch; dev URLs are baked into the regenerated generated files **on purpose**. Delete the dev
branch after testing (`pnpm dev-clean` automates it).

## Commands

```bash
# Offline validation (no token, any branch)
pnpm upload:local -- --mode=dev     # snapshot to dist/dev-<branch>-<hash>/
pnpm upload:local -- --mode=prod    # snapshot to dist/prod-<branch>-<hash>/

# Real publish (needs GITHUB_TOKEN_VAR in .env; GITHUB_TOKEN_VAR is the fixed name — never rename)
pnpm upload -- --mode=dev           # dev-build-<id> branch + pre-release
pnpm upload -- --mode=prod          # latest release + gh-pages (main only)
```

Prerequisites: Node ≥ 20.19 + pnpm; token with `contents:write` in the untracked root `.env` (copied
from `.env-example`); clean worktree. `--ref=<branch|commit>` builds another ref in a temporary
worktree without touching your checkout. CI publishes via `.github/workflows/pages.yml` (manual
dispatch, per-OS serial jobs).

## Flow (one run)

1. Loads the last published hashes from the publish branch manifest (or the newest local snapshot in
   `--local` mode).
2. Computes SHA-256 source hashes per package/binary; **rebuilds only what changed** (everything in
   `--mode=dev`/`--force`).
3. Uploads changed artifacts — **release assets (prod): utils/fx-folder zips + installers**; **Pages
   branch only: updater-ui.zip (never a release asset — the updater fetches it from the branch
   itself), helper binaries, and `hashes.json`**. Pages sends `Access-Control-Allow-Origin: *`,
   which the installer tab needs (release-asset CDNs do not).
4. Publishes `hashes.json` to the same branch. Generated files are regenerated during the run and
   deleted from disk at the end (`cleanGenerated`).

The installer/browser tab does the network fetching (ADR 0005: the C binary has zero network I/O).

## Standard sequences

Test a feature in a real browser:

```bash
# on the feature branch
pnpm upload:local -- --mode=dev     # optional offline check first
pnpm upload -- --mode=dev           # publish the dev build (explicit permission!)
# … install/test via the printed dev URLs …
pnpm dev-clean                      # delete dev-build-<id> branch + release when done
```

Production release (from `main`, gates green: `pnpm lint`, `pnpm format`, `pnpm test`,
`pnpm test:hash`, then `upload:local -- --mode=prod`):

```bash
pnpm upload -- --mode=prod
```

## Rules

- **Never publish without explicit user permission**; never touch `latest`/gh-pages casually.
- **Never hand-edit generated files** — regenerated during publish (see the `generated-files`
  skill).
- Prod requires `main`; `hashes.json` name is mode-independent (consumers depend on it).
- Full walkthrough: `docs/DEVELOPING.md` → Publishing; decision: ADR
  [0009](../../../docs/decisions/0009-unified-publish-modes.md).
