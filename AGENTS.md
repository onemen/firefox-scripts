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
- **Do not publish or upload** unless the user explicitly asks. Use `snapshot:*` for offline
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
  The generated-file set itself is registered in `tools/publish/generatedRegistry.mjs` — the one
  list the generators, the publish hashes and the zip re-adds read; the registry ↔ hash-inputs tests
  (`test/unit/generatedRegistry.test.mjs`) fail when the wiring is missing (ADR 0008).
- **Hash-based detection.** Per-package SHA-256 manifest (`hashes.json`): for each file
  `sha256(rel_path + '\n') + sha256(file_bytes)`, files sorted case-insensitively; a missing file
  contributes only its path. Equal → Up to date; differs with at least one file present → Update
  available; zero files present → Not installed. JS ref `tools/publish/hashUtils.mjs`; C twin
  `compute_directory_sha256` in `installer/src/detect_browser.c`; cross-checked by
  `installer/test/test_hash.mjs`.
- **The C installer does zero network I/O** — the browser tab fetches the zips, manifest and release
  lists from CORS-enabled hosts and POSTs the bytes to the local server.
- **Updater flow:** daily check of utils + fx-folder → keep `updater-ui.zip` current → open one
  trusted tab → verify, extract, copy; admin-protected dirs use a freshly downloaded standalone
  helper binary (one elevation prompt; cancel is a distinct exit code). A **remote test/dev build**
  whose own manifest is unreachable falls back to the stable channel's manifest and auto-migrates;
  local snapshots keep the silent exit. Full flow: `docs/auto-updater.md`; status semantics:
  `docs/status-logic.md`; the dead-channel decision: ADR 0026.
- **Publishing:** `--mode=prod` → `latest` release + `gh-pages` (branch `main` only, CI-only — runs
  the full cross-OS binary matrix); `--mode=dev` → disposable `dev-build-<id>` branch (branch-only;
  `--note` adds an RC-style prerelease page), `-dev` artifact names, served via jsDelivr. Requires a
  clean worktree; real runs need `GITHUB_TOKEN_VAR`.
- **Gotchas:** the build date is DERIVED, not hand-stamped (ADR 0036): per-binary git dates from the
  same input set the publish hash uses; the conf has no date key anymore. Waterfox skips
  `BootstrapLoader.js` in `config.js`. Per-package skip prefs
  `extensions.firefox-scripts.skippedHash.<pkg>`; one daily gate pref `lastScriptsCheckDate` (ADR
  0012 — written by the up-to-date check and by the shown updater tab). `versionInfo.json` is
  obsolete (excluded from zips; installed copies cleaned by `installer/src/obsolete_files.h`).

## Decision records

Architecture decisions are recorded as ADRs (architecture decision records) in `docs/decisions/` —
the **steering veto list**: open [docs/decisions/index.md](./docs/decisions/index.md) before
proposing a new primitive, surface, storage home, or architecture change. A decision already made
usually covers the need.

- Template: `docs/decisions/0000-template.md` — copy to the next unused `NNNN` with a kebab-case
  slug; keep the record to roughly half a page (Context / Decision / Consequences).
- One decision per record. Supersede, don't edit: mark the old record `superseded by NNNN` and list
  it under the index's Historical section, and declare the reversal from the other end with a
  `Supersedes: [NNNN](...)` line on the replacing record (what it replaces, and what survives). An
  additive amendment keeps its record and is declared with `Amends:` / `Amended:` status lines
  (ADR 0029) — the pair must be reciprocal, which `pnpm check:decisions` enforces, along with the
  supersede pair and the Historical placement.

## Skills

Task-scoped instruction modules an agent loads on demand when the task matches them — deep dive
detail lives there so this file stays a checklist, not a manual. All skills are direct children of
`.agents/skills/<name>/` (flat, tracked; ADR 0022).

**Load one before you plan.** The table below is an index, not the instructions: when a row matches
the task, read `.agents/skills/<name>/SKILL.md` first — to the end — and build the todo from what it
says. Do not work the task from the row, and do not reconstruct the skill's content from the repo's
general rules. Dispatch is a host convenience, not a guarantee: on 2026-10-03 an agent given "do a
batch review on all PRs from today" announced it would check `cr-batch-review`, never opened it, and
improvised the protocol from ADR 0020 for 59s. Reading the file costs one command; improvising the
same content costs a review pass.

- **Third-party** (`metadata.github-repo` in `SKILL.md`): installed and updated only via
  `gh skill install` / `gh skill update`; kept byte-identical to upstream — never linted or
  formatted (excluded from the gates; see `eslint.config.js` / `.prettierignore`). Drift is surfaced
  by the weekly watchdog as a tracking issue; updates land as reviewed PRs. `pnpm lint` gates on
  frontmatter validity and runs the vendored skills' own tests; `pnpm test:skills` performs static
  frontmatter validation only. Vendor text stays pristine (ADR 0022: "gates that validate apply to
  everything"). Vendored skills are host-dependent: their commands assume this repo's toolchain
  (pnpm, the C toolchain, `gh`) and may not translate to other projects.
- **Authored here**: fully covered by the lint/format gates; updates are normal PRs.

| Skill               | Class       | Load when the task involves                                             |
| ------------------- | ----------- | ----------------------------------------------------------------------- |
| `ai-review`         | authored    | Reviewing a PR — the ADR 0020 local review step                         |
| `batch-loop`        | authored    | Working a batch of tasks — one PR per task, never idle-wait             |
| `change-workflow`   | authored    | Making code changes — subsystem, docs, validation order                 |
| `cr-batch-review`   | authored    | Operator-requested CodeRabbit batch pass — ADR 0020 posting, quota gate |
| `generated-files`   | authored    | Regenerating or reasoning about the untracked build files               |
| `publishing`        | authored    | Releasing — `publish:*` / `snapshot:*`, prod/dev modes                  |
| `cavecrew`          | third-party | Delegating locate / small-edit / diff-review subtasks to subagents      |
| `code-review`       | third-party | Reviewing a diff against the repo's standards and originating spec      |
| `debugging-firefox` | third-party | Debugging live Firefox via DevTools RDP (`docs/debugging-with-rdp.md`)  |
| `grill-me`          | third-party | Stress-testing a plan or design before committing to it                 |
| `lavish`            | third-party | Turning complex/visual agent output into annotatable HTML artifacts     |

All paths are `<root>/.agents/skills/<name>/SKILL.md`.

## Commands

Package manager is **pnpm** (root-only workspace, `"type": "module"`). Git hooks are opt-in only
(`pnpm hooks:install`: pre-push gate + worktree post-checkout) and never generate files — generated
files are produced on demand by the build/publish tooling.

Full command reference with flags and examples: **`docs/DEVELOPING.md` → Run**. The checklist:

- **Gates:** `pnpm lint` (strict fail-fast aggregate = what CI + the pre-push hook enforce),
  `pnpm format`, `pnpm test`, `pnpm test:hash`. Granular stages: see package.json (`pnpm lint`
  composes them); `pnpm lint:all` is the dev-only report-all view.
- **Core-test gate:** `pnpm check:core-tests` — fails when `core/**` changed with no `test/**`
  change (runs in the `checks` CI job on PRs). Waive with `#no-core-test-gate` in the PR body.
- **Publish (only when the user explicitly asks):**
  `pnpm publish:all|packages|updater-ui|installer|helper`, `pnpm release:stage`,
  `pnpm release:verify`, `pnpm fetch:release`; offline: `pnpm snapshot:prod|dev`. Scope
  (`--include=…`, ADR 0030) and `--mode=prod|dev` semantics: `docs/DEVELOPING.md` → §Publish (the
  preset list and the flag table). There is no bare `pnpm publish` script; the wrapper itself is
  `node tools/publish/release.mjs`.
- **Installer build:** `make dist_win|dist_linux|dist_mac`, `helper_*`, `resources`, `config`,
  `verify` (Windows: MSYS2 UCRT64 `mingw32-make`).

## Testing & QA

Match the change to its validation — the full matrix is the `change-workflow` skill; the rules:

- Pre-PR gates: `pnpm lint`, `pnpm format`, `pnpm test`, and the hash test (`pnpm test:hash`).
- **Do not claim tests passed if the required toolchain or environment was unavailable.**
- PRs that modify `core/**` must add or extend a test where feasible; if not, the PR description
  must explain why. This is enforced mechanically: `pnpm check:core-tests` fails a PR that changes
  `core/**` with no `test/**` change. A `#no-core-test-gate` line in the PR body waives it, for
  changes that provably cannot be covered (a comment, a rename) — say why in the body.

## AI review of PRs

Per [ADR 0020](./docs/decisions/0020-local-agent-ai-review.md), AI review is a local, agent-run
step. When a PR is ready for review, the agent that created it runs `pnpm review:local`, assesses
each finding right / wrong / useless — quoting the disputed line, on the PR's own head, before
rejecting one (an unquoted "wrong" is unverified, not disproved) — and posts each accepted finding
as its own line-anchored,individually resolvable PR review thread (fallback: one
`gh pr review <n> --comment` body; never `gh pr comment`), resolving each thread as its fix lands
and every remaining thread before merging (main requires conversation resolution). Every
agent-posted review begins with a one-line 🤖 provenance marker (e.g.
`🤖 AI review triage (Codebuff agent — result of the CodeRabbit review:batch run)`) — reviews go out
under the user's own account, and the marker is what separates agent from human activity. The review
is not gated on CI — it can help debug failing checks. Add no CI/repo AI secret. External review
triggers — CodeRabbit `@coderabbitai review` and `pnpm review:batch` — are **operator-initiated
only**: the agent never invokes them unprompted. When the operator runs `review:batch`, the agent
triages its findings and posts accepted ones per the protocol above — and then **stops**: the batch
pass reviews PRs it does not own, including other agents' PRs, so it writes **no fixes and resolves
no threads**. The owning agent re-assesses each open thread, fixes what it accepts, and resolves
what it fixed. Full protocol: the `ai-review` skill; the ownership rule: the `cr-batch-review` skill
and ADR 0020.

## Agent workflow

**Task worktrees:** use `<workspace>/worktrees/<slug>/` (one deletable folder per task), remove them
before finishing, and verify the directory is really gone afterwards — on Windows the removal can
silently leave an orphaned `node_modules` husk behind. The failure mode, the exact rm-then-prune
recipe, and worktree install rules: the `change-workflow` skill.

Run `pnpm install` in a fresh worktree; never link the parent's node_modules into it.

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
- **Never edit files in the main worktree.** All task changes — however small, docs included —
  happen in a task worktree; the shared checkout stays clean.
- the task worktree is removed and the directory verified gone (see the `change-workflow` skill).

## Roadmap tracking

- GitHub is the only roadmap: the v1.0 milestone, phase issues #3 (Phase 4) / #4 (Phase 5, closed
  2026-09-28) and the Post-v1.0 umbrella (#38) hold the checklists; milestone views
  ([v1.0](https://github.com/onemen/firefox-scripts/milestone/1) /
  [Post v1.0](https://github.com/onemen/firefox-scripts/milestone/2)) are the overview.
- Every PR links its issue (`Fixes #x` / `Part of #y`); tick the checklist item when the work
  merges.
- Never duplicate a checklist in both a doc and an issue: docs link to the issues, never restate
  them.

## Tooling

- **Node ≥ 24** (`--env-file-if-exists`; CI and the repo `engines` pin `>=24`), **pnpm** (lockfile
  v9), `"type": "module"` for all `tools/` scripts.
- **C toolchain:** MSYS2 UCRT64/mingw-w64 on Windows (`-mwindows` GUI subsystem); clang/gcc
  elsewhere; `clang-format` pinned via npm. All asset embedding is Node (`installer/embed.mjs`).
- **CI** runs from `.github/workflows/` (ci.yml, e2e.yml, pages.yml, build-and-upload.yml,
  url-watchdog.yml, skills-watchdog.yml, runner-watchdog.yml, av-watchdog.yml, cache-cleanup.yml).
  The installer + updater E2E jobs and the publish gate are **path-filtered on PRs**: they skip when
  no changed file can affect them (see `docs/continuous-integration.md`). Prod publish stays manual
  from `main`; all publish scripts require a clean worktree.
- **Interactive debugging of core files:** the MIT `debugging-firefox` RDP skill is `gh`-installed
  under `.agents/skills/` — see `docs/debugging-with-rdp.md` (never put it in the lint/format
  gates).

## Generated files

Six files are generated from sources, **gitignored and regenerated on demand** — never hand-edit
them. The full sources→artifact table, the three regeneration moments, and the hash-propagation
logic: the `generated-files` skill + `docs/DEVELOPING.md` + ADR
[0008](./docs/decisions/0008-generated-files-untracked.md).

## Conventions

- **Firefox privileged modules:** `.sys.mjs` ESM via `ChromeUtils.importESModule` /
  `defineESModuleGetters` with full `chrome://` or `resource://` specifiers. Never bare paths. One
  `defineESModuleGetters(lazy, …)` block per module carries every lazily-imported module — including
  the version-conditional ones (`SessionStore`: `moz-src://` from 156.0a1, `resource:///modules`
  before it); `importESModule` is only for a module read in module scope (the generated config). The
  vm test suites resolve those getters through `test/shared/sandboxServices.mjs`, the single place
  that knows the set.
- **Window-context legacy JS:** plain `.js` with `'use strict';` loaded via
  `Services.scriptloader.loadSubScript`. No `innerHTML` in the updater tab (XML-parsed XHTML; toggle
  via `hidden`). Tab-script logging convention (2026-09-21): errors keep `console.error`;
  informational traces use `console.debug` so the user's Browser Console stays clean by default.
  ConsoleAPI output never reaches `nsIConsoleService` observers (#292 root-cause), so updater-tab
  `logError` additionally routes the same text through `Services.console.logStringMessage` — that
  routed line (stable `Firefox Scripts updater: ` prefix) is what the E2E console mirror and its net
  (`assertNoUpdaterConsoleErrors`) see; informational traces are mirror-invisible by design.
- **C:** clang-format LLVM base; UTF-8 paths with wide/UTF-16 conversion on Windows;
  `installer_log()` logging; vendored miniz read-only (`-DMINIZ_NO_DEFLATE_APIS`).
- **JS formatting/lint** is enforced by prettier + eslint (configs in `config/`) — run
  `pnpm format:fix` / `pnpm lint` before finishing.
- **Error handling:** fail-fast with clear messages; elevation failures distinguish cancel (exit 2);
  network failures surface a banner in the UI, not a silent partial install.
- **Text files are LF**; a local working-tree copy can linger as CRLF, so when a tool parses a
  tracked text file, normalize `\r\n` → `\n` at read (`docs/continuous-integration.md`).
