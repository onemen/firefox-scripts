# Decision records

An architecture decision log (ADL) in the
[ADR](https://github.com/architecture-decision-record/architecture-decision-record) format. Open the
list below before proposing a new primitive, surface, storage home, or architecture change — a
decision already made usually covers the need. Architecture docs and code describe how the system
works today; this folder records the decisions that shaped it, usually a **no** with a revisit-if.

Linked from AGENTS.md for that check — not as homework and not as a museum.

A good record is half a page: context, the decision, consequences. See
[0002](./0002-hash-based-update-detection.md) for the shape that actually steers.

Decision records are point-in-time documents written after the fact — they describe what was
decided, not what the code does today.

**History & provenance:** the 2026 installer/updater rewrite reached `main` as a single commit
(`854dfad`, 2026-08-21) — the public boundary of this repository's history. Dates in the records
that predate the rewrite are best-effort provenance for when a decision was made, not entries in
`main`'s history. The pre-merge feature branches (`wip/*`, `buffy/*`, `main-backup`, …) that hold
those commits live only in the maintainer's local clone — they are not ancestors of `main` and
cannot be fetched by other developers; anchor any public reference to `854dfad`.

## When to add a record

Write one after you have already decided not to build something the next agent or contributor will
otherwise re-propose, or when an architectural change lands that later maintainers will need the
"why" of. Copy [0000-template.md](./0000-template.md) to the next unused number (read this index on
main first) with a kebab-case slug. Keep it to roughly half a page.

Do not write an ADR on every PR. Number collisions are the failure mode of that habit; if a number
collides, renumber the later record — never leave duplicates.

Do not record layout or UI tweaks, mode assignments, or "we use library X" unless that pick is a no
that will otherwise be re-litigated.

When a later record changes a decision, mark the old one `superseded by NNNN` rather than editing or
deleting it, and list it under Historical. History stays; it is not silently deleted.

## Steering list

Open these before proposing a new primitive, surface, or storage home.

- [0002](./0002-hash-based-update-detection.md) — Hash-based update detection; no versionInfo.json;
  canonical `files` list comes from the manifest
- [0003](./0003-hash-manifest-on-gh-pages.md) — Hash manifest published to the gh-pages branch
  (CORS-enabled), not a Gist
- [0005](./0005-installer-zero-network-io.md) — The C installer performs zero network I/O; the
  browser tab fetches and POSTs
- [0007](./0007-updater-ui-ships-as-package.md) — Updater tab UI ships as a chrome-privileged
  package; no remote page/iframe/postMessage
- [0008](./0008-generated-files-untracked.md) — Generated files untracked; regenerated on demand;
  hashes cover true sources
- [0009](./0009-unified-publish-modes.md) — Unified publish `upload`/`upload:local` with required
  `--mode=prod|dev`; prod gated to `main`
- [0010](./0010-session-token-no-cors.md) — Local installer server gated by a per-run session token;
  no CORS
- [0011](./0011-admin-copy-helper.md) — Admin-rights copy via a standalone self-elevating helper; no
  profile cache
- [0012](./0012-new-tab-daily-notification.md) — Update notification = new tab; daily check only; no
  OS notification, no check-now
- [0013](./0013-installer-conf-source-of-truth.md) — `config/installer.conf` is the single source of
  truth
- [0014](./0014-restart-session-restore.md) — Browser restart via
  `browser.sessionstore.resume_session_once` + explicit `--profile`
- [0015](./0015-e2e-puppeteer-bidi.md) — E2E tests use Puppeteer-core + WebDriver BiDi
- [0016](./0016-chrome-namespace.md) — Dedicated `chrome://firefox-scripts` namespace; not
  `content userchromejs`
- [0017](./0017-ci-validation-contract.md) — CI validation contract: path-filtered gates, advisory
  fork legs, download map as source of truth
- [0018](./0018-installer-ui-browser-tab.md) — Installer UI stays an embedded browser tab; no
  desktop/webview app
- [0019](./0019-release-versioning.md) — Stable unversioned artifact names + date-stamped component
  tags + moving `latest`
- [0020](./0020-local-agent-ai-review.md) — AI review is a local, agent-run step (the PR-opening
  agent reviews, assesses, and posts via `gh`); CI Groq bot retired
- [0021](./0021-tiered-publish-gating-shared-resolver.md) — Tiered publish gating + shared browser
  resolver (retry + mirror chains, fail-closed watchdog) + temporary `ci-downloads` manual escape
- [0022](./0022-agent-skills-management.md) — Agent skills are `gh`-installed and pristine; no
  `skills-lock.json`, no second `.agent/` root; drift = watchdog issue → reviewed PR

## Historical

Accepted or superseded records that do not change the next proposal. History stays; it is not
silently deleted.

- [0001](./0001-versioninfo-and-gist.md) — `versionInfo.json` + a GitHub Gist were the
  update-version mechanism — superseded by [0002](./0002-hash-based-update-detection.md)
- [0004](./0004-commit-generated-files.md) — Generated files committed, synced by git hooks +
  publish gate — superseded by [0008](./0008-generated-files-untracked.md)
- [0006](./0006-hosted-remote-updater-ui.md) — Updater tab UI hosted as a remote page (iframe /
  data: / postMessage) — superseded by [0007](./0007-updater-ui-ships-as-package.md)

## Not recorded

Micro-decisions deliberately left out of the log so nobody re-adds them:

- strstr-based JSON manifest parsing in the C installer (fragile but sufficient; a full JSON parser
  in C is out of scope) — see the `docs/DEVELOPING.md` appendix.
- Manual package download via same-origin blob links (plain `<a download>`, no programmatic
  download) — an installer/updater UI detail.

- Browser download map mechanics (winget → direct downloads; vendor version APIs for "latest") —
  test harness, see `test/e2e/shared/downloads.mjs` and ADR 0017.
- URL watchdog internals (weekly + PR modes, per-release SHA-256 ledger in issues, baseline in the
  Actions cache) — monitoring tooling, see `.github/workflows/url-watchdog.yml` and ADR 0017.
