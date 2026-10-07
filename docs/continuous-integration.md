# Continuous integration

Part of the [Developer guide](./DEVELOPING.md). This file was split out of the guide to keep it a
checklist that points; the content is authoritative here.

## Workflow inventory, path filters and gates

**The `$/` local-action form is load-bearing — never "clean it up" to `./`.** `uses: $/.github/...`
(19 uses across 4 workflows) tells the runner to materialize the local action from the triggering
commit without a checkout step — that is what lets shared prologue jobs like
`.github/actions/setup-repo` run as the _first_ step of a job. A `./` local action can only resolve
after `actions/checkout`, so swapping the prefix silently breaks the very jobs the form enables, and
only on a runner. Local actions are composite actions under `.github/actions/`; third-party actions
stay SHA-pinned (`.github/dependabot.yml`).

### Workflow inventory

`.github/workflows/ci.yml` runs on every PR and on `main` pushes:

- **checks** (Linux) — `pnpm lint` (ESLint incl. `eslint-plugin-security`, markdownlint — MD056
  table-column-count catches merged table rows that prettier cannot see (#147) — the fused-list
  marker gate on changed markdown (#307), the YAML/frontmatter parse gate on the YAML a change
  touches (#413), clang-format, `gcc -fanalyzer`), `pnpm format`, `pnpm test`, and a separate
  `node --test --experimental-test-coverage "test/unit/**/*.test.mjs"` pass whose report goes to the
  log — informational only, no threshold gate.
- **lint stages** (#230) — `pnpm lint` is a strict fail-fast `&&` chain composed from granular
  `pnpm lint:*` scripts (`lint:js`, `lint:ncpy`, `lint:types`, `lint:c`, `lint:analyze`, `lint:md`,
  `lint:md-markers`, `lint:yaml`, `lint:skills`, `lint:skill-cmds`) — CI and the pre-push hook
  enforce only the aggregate, so the granular views cannot drift from what CI gates. For local
  iteration, `pnpm lint:all` (npm-run-all2 `run-s --continue-on-error --print-label`) runs every
  stage and reports all findings at once; it is a developer convenience and never used by CI or
  hooks.
- **publish gate** (Windows / Linux / macOS) — `pnpm snapshot:dev` rebuilds every package zip and
  the native binaries for the runner's OS, so regressions in generated files, hashes or the Makefile
  fail the PR before they reach a release.
- **Security smoke test** (Windows) — `test/e2e/installer/smoke-security.mjs` launches the built
  installer headless and verifies every state-changing `/api` route rejects a missing/wrong session
  token, valid tokens pass the gate, and no response carries `Access-Control-Allow-Origin`.
- **Hash parity** (Windows) — `pnpm test:hash` verifies the JS and C installer hashes match, using
  the dev snapshot built by the publish gate (no second build).
- **URL watchdog** (`.github/workflows/url-watchdog.yml`, daily 22:00 UTC — the repo's ONLY cron,
  plus PRs touching the download map) — re-resolves the latest version of every browser the E2E map
  installs (Firefox, Dev Edition, LibreWolf, Floorp, Zen; Waterfox tracked by version only) from its
  vendor API and verifies the download endpoint with a 1 KB ranged GET. Each new release is
  downloaded once, SHA-256'd and folded into the `[url-watchdog] status` meta issue (per-browser
  status table + version history — the dashboard and the SHA-256 ledger in one place). Opens issues
  on rot (404, HTML error page, changed API shape) and same-version binary size changes — except
  nightly, whose vendor replaces the binary within one N.0a1 window by design (#276): there the
  watchdog re-verifies the replacement with a full download + SHA-256 instead. Each run logs the
  baseline's cache-hit status and age, so a silently evicted Actions cache is visible instead of
  masquerading as a first run. The PR mode (`--pr`) is stateless, always green, and surfaces
  findings as annotations. Run manually via `workflow_dispatch`, or locally with
  `node tools/check-browser-downloads.mjs --dry-run`. Its pure reporting layer — the domain
  constants, drift classification, the E2E dispatch planner, and all GitHub-visible rendering
  (status table, version history, issue titles/bodies) — lives in `tools/ci/watchdog-report.mjs`,
  unit-testable without network access; the watchdog re-exports it for its importers.

  **Nightly revalidation driver (#380)** — after the baseline save, the scheduled run dispatches the
  nightly E2E surface from a plan file the check step wrote (`.watchdog/dispatch-plan.json`): one
  FULL `e2e.yml` run (deduped against any finding-driven dispatch — two full runs share a
  concurrency group and would cancel each other) plus `core-smoke-nightly.yml` (its build-ID cache
  marker skips nights without a new build). The dispatch moved after the baseline save deliberately:
  the dispatched runs read that baseline. e2e.yml has NO `push: [main]` and NO `schedule:` of its
  own any more — the nightly is the only E2E run `main` gets — and its `e2e-triage` job files a
  deduped failure issue (hash of the sorted failed-leg names) closed again on a green night.

- **Skills watchdog** (`.github/workflows/skills-watchdog.yml`, weekly + on PRs touching the
  watchdog) — detects drift in the five third-party skills in `.agents/skills/` (ADR 0022): the
  gh-injected frontmatter metadata is the baseline (no cache, stateless in every mode), and each
  skill's recorded tree SHA is compared against its upstream via the GitHub API — both at the
  recorded ref (`content-drift`, what `gh skill update` applies) and on the default branch
  (`ref-behind`: a static tag left behind; fixed by a forced reinstall). A newer-release scan
  (`newer-tag`) covers the blind spot both checks share — upstream publishing a newer tag while the
  pinned content is intact (a CLI-only release): the newest in-series tag (namespace-aware, so
  `bin-v*` never competes with `v*`) becomes actionable once it is at least 7 days old, and stays an
  informational log line before that — the weekly cadence is the cooldown. Opens ONE rolling
  tracking issue (`label:skills-watchdog`) with the exact update command per skill, closed
  automatically when a later run finds everything current. Updates land as human-reviewed PRs —
  never pushed: upstream skill text is a prompt-injection surface. PR mode (`--pr`) is stateless,
  always green, and surfaces findings as annotations. Local run:
  `node tools/skills-watchdog.mjs --dry-run`.

- **Skills checker** (`tools/check-skills.mjs`, wired into `pnpm lint`; static-only alias
  `pnpm test:skills`) — gates on SKILL.md frontmatter validity (name/description presence, name =
  directory, full or absent gh metadata) and runs the vendored skills' own `*.test.mjs` files with
  `node --test`. Validation only: per ADR 0022 vendor text is never linted or formatted.

**PR path filtering** — every E2E job (`.github/workflows/e2e.yml`: the `snapshot` build, the
installer/updater matrices, the `helper` elevated-copy test, and the `browser-matrix` fork legs) and
the publish gate (`build` in `.github/workflows/ci.yml`) run only when a changed file can affect
them (`core/**`, `config/installer.conf`, `installer/**`, `tools/publish/**`, `tools/scan-av.mjs`,
`tools/scan-vt.mjs`, `test/e2e/**`, `package.json`, `pnpm-lock.yaml`, the workflows/actions).
Docs-only / tooling-only PRs skip all of them; `changes`, `checks`, `ci-gate` and `e2e-gate` always
run, so the required checks keep reporting. The aggregate gates share one engine —
`.github/actions/verify-gate` (required / advisory / skip-guard / always-report checks) — and
`pnpm check:gates` statically enforces the contract: every workflow job is listed in its gate's
`needs:`, path-filter `if:`s stay in place, and always-report jobs carry no job-level `if:`. The
`browser-matrix` fork legs (LibreWolf, Floorp, Zen — downloaded from third-party hosts:
librewolf.dev's package registry and GitHub release assets) are advisory when they run: failures
warn in the gate instead of failing the PR. Firefox Developer Edition is first-party Mozilla, so it
runs as a required leg of the `updater` job (#35), not in the advisory matrix. Waterfox graduated
from the advisory matrix to its own required `updater-waterfox` leg (Windows-only, ADR 0025) after
its soak; its current version must also be covered by the validated-versions record before a prod
publish, and the pin-first break-glass runbook for vendor-flake days lives in that ADR.

**The validated-versions record keys on the updater legs alone (ADR 0039)** — `record-validation`
runs when `needs.updater.result == 'success'`, not when the whole gate is green: the gate summarizes
every leg, and one red unrelated required leg or one red advisory must not freeze the record (and
with it the publish drift gate) for a day. The recorder's own contract still refuses a record with
holes, so the widening cannot weaken what lands in the file. ADR 0021's partial-dispatch skip is
untouched: a single-browser escape never records; a FULL dispatch — the nightly revalidation — does,
which is what keeps the record fresh without a main-push run.

**Agent file-change hooks (recommended, per-workstation)** — agent clients (Codebuff, Claude Code,
…) can run a command after each file edit and feed the output back to the agent in the same turn.
They are client config, not repo config — nothing runs for plain git users, and CI stays the
enforcement layer. Keep the set minimal and **read-only** (checks, not mutations); the repo's own
generation/build steps are deliberately _not_ hook material — generated files are produced on demand
by the Makefile and publish scripts (ADR 0008), never per-edit. A mapping that matches the Testing &
QA matrix:

| Changed file                   | Hook                                                                                                 | Cost  |
| ------------------------------ | ---------------------------------------------------------------------------------------------------- | ----- |
| `**/*.md`, `**/*.{js,mjs,cjs}` | `prettier --check <file>`                                                                            | ~0.5s |
| `docs/decisions/**`            | `pnpm check:decisions` (duplicate numbers, stale links, `Amends:`/`Amended:` reciprocity — ADR 0029) | <1s   |

Skip in hooks: `pnpm test:hash` (may build a full snapshot), full `pnpm lint` (needs a C toolchain
for `make analyze`), `syncGeneratedFiles.mjs` (on-demand only), anything that writes. Formatting
drift in agent-edited files is the failure this catches: editor on-save tooling only helps when the
editor is open — agents edit files on disk directly.

**LF, CRLF and `pnpm check:gates`** — the tree is normalized to LF (`.gitattributes` has
`* text=auto eol=lf`), so a CRLF file saved by a Windows editor is committed as LF and CI always
checks an LF checkout. But git will not rewrite an already-CRLF working-tree copy (it deems it
"equal after normalization" — `git checkout -- <file>` will not restore it either), so a local file
can linger as CRLF and break the line-sensitive gates: `pnpm check:gates` reports 20+ false
gate-contract violations and `pnpm format` flags the file. Detect with
`file .github/workflows/*.yml` (look for "CRLF line terminators"); fix by physically rewriting the
bytes to LF (e.g.
`node -e "const fs=require('fs');const p='.github/workflows/e2e.yml';fs.writeFileSync(p,fs.readFileSync(p,'utf8').replace(/\r\n/g,'\n'))"`).
The parsers `tools/check-gate-coverage.mjs`, `tools/check-decisions.mjs` and
`tools/publish/syncGeneratedFiles.mjs` normalize `\r\n` → `\n` at read so this never false-fails;
new tools that parse tracked text files should do the same.

**Merge queue** — the workflows trigger on `merge_group` in addition to `pull_request`, so the
required checks also run on the merge queue's temporary merge-group branch. Enabling the queue
(Settings → General → merge queue, with branch protection requiring it) makes the queue keep each PR
up to date with main and validate it before landing (the final merge uses the repo's configured
merge method). Because the "Update branch" step is never used, the ADR 0017 over-trigger caveat —
main changes merged into a PR counting as PR changes for the path filters — does not arise for
queued PRs.

Run the smoke test locally (Windows, from the repo root):

```bash
pnpm snapshot:dev
node test/e2e/installer/smoke-security.mjs
```

The installer's `--smoke-test` flag makes the headless run possible: it skips the
no-browser-detected abort and the browser-tab open, and prints the session token to stdout.
