# Repository Guidelines

## Scope

**firefox-scripts** installs and keeps up to date the helper scripts that let Firefox-family
browsers (Firefox stable/Nightly/Developer Edition, Waterfox, Zen, LibreWolf, Floorp) run legacy
(non-WebExtension) extensions. Three parts:

1. **Native C installer** (`installer/`) — detects a running browser, serves an embedded web UI over
   `127.0.0.1:8777`, and copies two packages: **fx-folder** (`core/fx-folder/`) to the browser
   install dir, **utils** (`core/chrome/utils/`) to `ProfD/chrome/utils/`.
2. **In-browser updater** (`core/chrome/utils/updater/`) — daily hash-manifest check; self-updates
   and opens the updater tab (chrome-privileged page shipped in `updater-ui.zip`).
3. **Updater tab UI** (`tools/publish/remote-ui/` → `updater-ui.zip`) — the tab's HTML/JS/CSS and
   logos; `scriptsUpdater.sys.mjs` (utils.zip) keeps it current before opening the tab.

Architecture deep dive: `docs/DEVELOPING.md` (structure, installer/updater flow, publishing) and
`docs/auto-updater.md`.

## Critical Rules

- **Never hand-edit generated files.** They are gitignored build products, regenerated on demand
  from their sources (see the Generated files section).
- **Do not publish or upload** unless the user explicitly asks. Use `upload:local` for offline
  validation.
- **Never merge a PR without the user's explicit approval** — open PRs for review and wait.
- **Never expose the GitHub token.** It lives only in an untracked root `.env` under the fixed
  `GITHUB_TOKEN_VAR` name — do not commit, log, or rename that variable.
- **Do not introduce Python**; build and asset tooling uses Node.js.
- Prefer the smallest change that solves the requested problem. Avoid unrelated refactoring,
  formatting, renaming, dependency updates, or architectural changes.
- Do not base work on `.local` files/dirs; they are local drafts and gitignored.
- Preserve upstream provenance in `core/`: files outside `updater/` come from
  xiaoxiaoflood/firefox-scripts (MPL-2.0); `updater/` is custom (MIT). Avoid unrelated changes to
  upstream-derived files.
- Read the relevant `docs/`, plus the decision log `docs/decisions/index.md`, before architectural
  or design changes.
- Keep `docs/ci-inventory.md` synchronized when changing workflow names, triggers, path filters,
  gates, scheduled jobs, or watchdog behavior. Keep workflow job names and required/advisory status
  semantics accurate.

## Architecture invariants

Full design notes live in `docs/` (`DEVELOPING.md`, `auto-updater.md`, `status-logic.md`). These
facts most often cause bugs:

- **Single source of truth** is `config/installer.conf`: it generates `installer/src/_config.h` (C),
  `core/chrome/utils/updater/updater-config.sys.mjs` (updater), and feeds `tools/publish/paths.js`.
- **Hash-based detection.** Per-package SHA-256 manifest (`hashes.json`): for each file
  `sha256(rel_path + '\n') + sha256(file_bytes)`, files sorted case-insensitively; a missing file
  contributes only its path. Equal → Up to date; differs with at least one file present → Update
  available; zero files present → Not installed. JS ref `tools/publish/hashUtils.mjs`; C twin
  `compute_directory_sha256` in `installer/src/detect_browser.c`; cross-checked by
  `installer/test/test_hash.mjs`.
- **The C installer does zero network I/O** — the browser tab fetches the zips, manifest and release
  lists from CORS-enabled hosts and POSTs the bytes to the local server.
- **Updater flow:** `scriptsUpdater.sys.mjs` does a daily check of utils + fx-folder → if either
  needs an update it keeps `updater-ui.zip` current (silent download+verify+extract into
  `chrome/utils/updater/ui`) → opens one
  `b.addTrustedTab(chrome://firefox-scripts/content/ui/updater.html)` → `updater.js` (same package)
  downloads, verifies, extracts and copies; admin-protected dirs use a freshly downloaded standalone
  helper binary (single UAC prompt, exit 2 = cancelled). If a package cannot be downloaded the check
  exits silently — no fallback UI.
- **Publishing:** `--mode=prod` → `latest` release + `gh-pages` (branch `main` only); `--mode=dev` →
  disposable `dev-build-<id>` branch, `-dev` artifact names, served via jsDelivr. Requires a clean
  worktree; real runs need `GITHUB_TOKEN_VAR`.
- **Gotchas:** Waterfox skips `BootstrapLoader.js` in `config.js`. Per-package skip prefs
  `extensions.firefox-scripts.skippedHash.<pkg>`; daily gate prefs `lastScriptsCheckDate` /
  `lastUpdateTabShown`. `versionInfo.json` is obsolete (excluded from zips; installed copies cleaned
  by `installer/src/obsolete_files.h`).

## Decision records

Architecture decisions are recorded as ADRs (architecture decision records) in `docs/decisions/` —
the **steering veto list**: open [docs/decisions/index.md](./docs/decisions/index.md) before
proposing a new primitive, surface, storage home, or architecture change. A decision already made
usually covers the need.

- Template: `docs/decisions/0000-template.md` — copy to the next unused `NNNN` with a kebab-case
  slug; keep the record to roughly half a page (Context / Decision / Consequences).
- One decision per record. Supersede, don't edit: mark the old record `superseded by NNNN` and list
  it under the index's Historical section. Validate with `pnpm check:decisions`.

## Skills

Task-scoped instruction modules an agent loads on demand when the task matches them — deep dive
detail lives there so this file stays a checklist, not a manual. All skills are direct children of
`.agents/skills/<name>/` (flat, tracked; ADR 0022):

- **Third-party** (`metadata.github-repo` in `SKILL.md`): installed and updated only via
  `gh skill install` / `gh skill update`; kept byte-identical to upstream — never linted or
  formatted (excluded from the gates; see `eslint.config.js` / `.prettierignore`). Drift is surfaced
  by the weekly watchdog as a tracking issue; updates land as reviewed PRs.
- **Authored here**: fully covered by the lint/format gates; updates are normal PRs.

| Skill               | Class       | Load when the task involves                                            |
| ------------------- | ----------- | ---------------------------------------------------------------------- |
| `ai-review`         | authored    | Reviewing a PR — the ADR 0020 local review step                        |
| `change-workflow`   | authored    | Making code changes — subsystem, docs, validation order                |
| `generated-files`   | authored    | Regenerating or reasoning about the untracked build files              |
| `publishing`        | authored    | Releasing — `upload` / `upload:local`, prod/dev modes                  |
| `cavecrew`          | third-party | Delegating locate / small-edit / diff-review subtasks to subagents     |
| `code-review`       | third-party | Reviewing a diff against the repo's standards and originating spec     |
| `debugging-firefox` | third-party | Debugging live Firefox via DevTools RDP (`docs/debugging-with-rdp.md`) |
| `grill-me`          | third-party | Stress-testing a plan or design before committing to it                |
| `lavish`            | third-party | Turning complex/visual agent output into annotatable HTML artifacts    |

All paths are `<root>/.agents/skills/<name>/SKILL.md`.

## Commands

Package manager is **pnpm** (root-only workspace, `"type": "module"`). Git hooks are opt-in only
(`pnpm hooks:install`: pre-push gate + worktree post-checkout) and never generate files — generated
files are produced on demand by the build/publish tooling.

```bash
pnpm install
pnpm lint          # eslint + markdownlint (MD056 table integrity) + C format check + gcc -fanalyzer
pnpm format        # check: C + prettier
pnpm format:fix    # apply both
pnpm test          # unit tests (test/unit/, pure Node, no build)
pnpm review:local  # local AI review of main...HEAD via tools/ai-review.mjs (ADR 0020)

# hash parity JS vs C (auto-generates a prod snapshot via upload:local if needed;
# also works against the newest dev- snapshot, so it runs after upload:local --mode=dev)
pnpm test:hash
```

**Publish — only when the user explicitly asks.** `upload:local` is the token-less offline check:

```bash
pnpm upload:local -- --mode=prod         # full snapshot to dist/prod-<branch>-<hash>/ (no token)
pnpm upload -- --mode=prod               # zips + binaries → latest release + gh-pages
```

`--mode=prod|dev` is required; prod publishes the `latest` release + gh-pages from `main` only, dev
publishes to `dev-build-<id>` (delete the branch after testing). Full walkthrough:
`docs/DEVELOPING.md`.

Installer build (Windows: MSYS2 UCRT64 `mingw32-make`): `make dist_win` / `dist_linux` / `dist_mac`,
`helper_*`, `resources`, `config`, `verify`.

## Testing & QA

Match the change to its validation:

| Change                           | Validate with                                                           |
| -------------------------------- | ----------------------------------------------------------------------- |
| C (`installer/src/`)             | build the affected target (`make dist_win` / `dist_linux` / `dist_mac`) |
| Hash / file list                 | `pnpm test:hash`                                                        |
| Publish helpers / hashing        | `pnpm test` (unit tests in `test/unit/`)                                |
| Decision log (`docs/decisions/`) | `pnpm check:decisions` (duplicate numbers + stale links)                |
| Generated-file sources           | `node tools/publish/syncGeneratedFiles.mjs`                             |
| Packaging / publish scripts      | `pnpm upload:local -- --mode=prod`                                      |

Pre-PR gates: `pnpm lint`, `pnpm format`, `pnpm test`, and the hash test. **Do not claim tests
passed if the required toolchain or environment was unavailable.**

PRs that modify `core/**` must add or extend a test where feasible; if not, the PR description must
explain why. (The mechanical "core changed && no test changed → fail" CI gate lands together with
the core smoke tests — see issue #30.)

## AI review of PRs

Per [ADR 0020](./docs/decisions/0020-local-agent-ai-review.md), AI review is a local, agent-run
step. When a PR is ready for review, the agent that created it runs `pnpm review:local`, assesses
each finding right / wrong / useless, and posts each accepted finding as its own
line-anchored,individually resolvable PR review thread (fallback: one `gh pr review <n> --comment`
body; never `gh pr comment`), resolving each thread as its fix lands and every remaining thread
before merging (main requires conversation resolution). Every agent-posted review begins with a
one-line 🤖 provenance marker (e.g.
`🤖 AI review triage (Codebuff agent — result of the CodeRabbit review:batch run)`) — reviews go out
under the user's own account, and the marker is what separates agent from human activity. The review
is not gated on CI — it can help debug failing checks. Add no CI/repo AI secret; CodeRabbit
`review:batch` remains an optional deep pass. Full protocol: the `ai-review` skill.

## Agent workflow

**Task worktrees:** use `<workspace>/worktrees/<slug>/` (one deletable folder per task) and remove
them before finishing (`git worktree remove`; retry the empty dir if a process still held it). Run
`pnpm install` in a fresh worktree; never link the parent's node_modules into it — details in the
`change-workflow` skill.

Before changing code:

1. Identify the affected subsystem.
2. Read the relevant `docs/`, and the decision log `docs/decisions/index.md`.
3. If a skill in `.agents/skills/` matches the task (review, publishing, generated files), load it.
4. Check whether the affected files are generated.
5. Make the smallest appropriate change.
6. Regenerate generated files on demand when their sources change (make / createZip /
   syncGeneratedFiles).
7. Run the relevant validation (matrix above).

Before finishing:

- generated files are regenerated on demand (Makefile / createZip / syncGeneratedFiles);
- no `.local` files were used as authoritative sources;
- no unrelated files were modified;
- if a code change invalidates any statement in AGENTS.md, skills, or docs/, update those documents
  in the same step. Do not leave stale instructions;
- failed/unavailable validation is reported;
- the task worktree is removed (`git worktree remove`; retry the empty directory if a process still
  held it).

## Roadmap tracking

- GitHub is the live tracker: the v1.0 milestone, phase issues #3 (Phase 4) / #4 (Phase 5) and the
  Post-v1.0 roadmap umbrella (#38) hold the checklists; `docs/roadmap.md` is the durable snapshot.
- Every PR links its issue (`Fixes #x` / `Part of #y`); tick the checklist item when the work
  merges.
- Update `docs/roadmap.md` only in the PR that changes scope — never per-commit.
- Never duplicate a checklist in both a doc and an issue: the doc links to the issues.

## Tooling

- **Node ≥ 20.19** (`--env-file-if-exists`; eslint 10 engines need `^20.19 || ^22.13 || >=24`),
  **pnpm** (lockfile v9), `"type": "module"` for all `tools/` scripts.
- **C toolchain:** MSYS2 UCRT64/mingw-w64 on Windows (`-mwindows` GUI subsystem); clang/gcc
  elsewhere; `clang-format` pinned via npm. All asset embedding is Node (`installer/embed.mjs`).
- **CI** runs from `.github/workflows/` (ci.yml, e2e.yml, pages.yml, url-watchdog.yml,
  skills-watchdog.yml). The installer + updater E2E jobs and the publish gate are **path-filtered on
  PRs**: they skip when no changed file can affect them (see `docs/DEVELOPING.md` → Continuous
  integration). Prod publish stays manual from `main`; all publish scripts require a clean worktree.
- **Interactive debugging of core files:** the MIT `debugging-firefox` RDP skill is `gh`-installed
  under `.agents/skills/` — see `docs/debugging-with-rdp.md` (never put it in the lint/format
  gates).

## Generated files

Four files are generated from sources, **gitignored and regenerated on demand** — never hand-edit
them: `core/chrome/utils/updater/updater-config.sys.mjs`, `tools/publish/remote-ui/updater.css`,
`installer/src/_config.h`, `installer/src/resources.h`. Edit the source and regenerate (the
installer Makefile does it on every build, `createZip.mjs` at publish time, or by hand via
`node tools/publish/syncGeneratedFiles.mjs`). Because they are not committed, the publish hashes
cover their **true sources** instead of the artifacts (see
`docs/decisions/0008-generated-files-untracked.md`); `installer.conf` is a base value — changing it
shifts package hashes, which is how updates propagate. Full sources→artifact table and the three
regeneration moments: the `generated-files` skill.

## Conventions

- **Firefox privileged modules:** `.sys.mjs` ESM via `ChromeUtils.importESModule` /
  `defineESModuleGetters` with full `chrome://` or `resource://` specifiers. Never bare paths.
- **Window-context legacy JS:** plain `.js` with `'use strict';` loaded via
  `Services.scriptloader.loadSubScript`. No `innerHTML` in the updater tab (XML-parsed XHTML; toggle
  via `hidden`).
- **C:** clang-format LLVM base; UTF-8 paths with wide/UTF-16 conversion on Windows;
  `installer_log()` logging; vendored miniz read-only (`-DMINIZ_NO_DEFLATE_APIS`).
- **JS formatting/lint** is enforced by prettier + eslint (configs in `config/`) — run
  `pnpm format:fix` / `pnpm lint` before finishing.
- **Error handling:** fail-fast with clear messages; elevation failures distinguish cancel (exit 2);
  network failures surface a banner in the UI, not a silent partial install.
- **Text files are LF**; a local working-tree copy can linger as CRLF, so when a tool parses a
  tracked text file, normalize `\r\n` → `\n` at read (`docs/DEVELOPING.md` → Continuous
  integration).
