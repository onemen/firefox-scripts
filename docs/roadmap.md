# Roadmap

Durable snapshot of the release plan and how it is tracked. **The live state lives on GitHub**: the
[v1.0](https://github.com/onemen/firefox-scripts/milestone/1) milestone, the phase issues (#3 Phase
4 — E2E matrix, #4 Phase 5 — release gate) and the
[Post-v1.0 roadmap](https://github.com/onemen/firefox-scripts/issues/38) umbrella (milestone "Post
v1.0"). This file is updated only when scope changes — see AGENTS.md "Roadmap tracking".

## Current: v1.0 — first public release

Order matters: installer / updater / tests / CI first, core-file PRs last.

- **P1-1** Port `docs/e2e-matrix-plan.md` as historical context; retire `feat/e2e-orig`.
- **P0-1** `upload --mode=prod` moves the `latest` tag to the uploaded commit.
- **P0-2** `pnpm dev-clean` removes old `dev-build-*` branches + tags.
- **P0-3** E2E speed: browser download map (`tools/test/e2e/downloads.mjs`) + shorter waits.
- **P1-2** Docs restructure (developer/maintainer vs user docs) + `future-work.md` sync.
- **P2-1** `userChrome.js` `createElement`: `toggleAttribute` for Firefox 149+ (bug 2008041).
- **P2-2** `BootstrapLoader`: release the spin wait on load errors (#25, PR #26 — merge pending
  approval).
- **Release gate (#4)** — remove README banner, v1.0 tag, milestone close, env protection for prod
  uploads, zip-the-installer-exe decision, tag move (P0-1).

Remaining Phase 4 gaps are tracked by child issues #35–#37 (Dev Edition leg, installer UI layer,
install-applies path).

## Post v1.0 (umbrella #38, milestone "Post v1.0")

- Astro user-docs site + gh-pages via GitHub Actions (#28).
- Utils flavor selection — scripts / extensions / both (#29).
- Core code test coverage — stub smoke tests + Nightly leg + test-required rule (#30).
- Browser-matrix expansion — Waterfox / Zen / Nightly (#31).
- UAC/admin-rights automation (#32), publish-pipeline automation (#33), UI/UX polish (#34).
- Detailed backlog: `docs/future-work.md`.

## How to update

- Prefer issues: every PR links its issue (`Fixes #x` / `Part of #y`); tick the phase/umbrella
  checklist when the work merges.
- Update this file only in the PR that changes scope, so it cannot rot.
