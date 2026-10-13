# 0046: The docs site is published to the Pages branch root, beside the artifacts

- **Status:** accepted
- **Date:** 2026-10-04
- **Amends:** [0031](./0031-gh-pages-orphan-artifact-branch.md): the branch is no longer
  artifact-only: its root also carries the built docs site (`index.html`, `404.html`, `_astro/`,
  `pagefind/`, the page directories). Everything else in 0031 stands: still a true orphan, still
  never seeded from the default branch, still publish commits only.
- **Refs:** issue [#28](https://github.com/onemen/firefox-scripts/issues/28),
  [#202](https://github.com/onemen/firefox-scripts/issues/202)

## Context

`onemen.github.io/firefox-scripts/` is not a documentation site today, it is the **live artifact
CDN**: `config/installer.conf` points `HASHES_URL`, `ZIP_BASE_URL`, `HELPER_BASE_URL` and
`SELF_UPDATE_URL` at that host, and every installed browser's daily updater fetches `hashes.json`
and the package zips from it (0003). Its root `index.html` was the repo README rendered by GitHub,
rewritten by `pagesIndex()` on every publish.

The user-facing half of the documentation, meanwhile, lives where it cannot be maintained: the
README, and the TabMixPlus docs site's installation page
(`https://onemen.github.io/tabmixplus-docs/other/installation/`), which is about a different
project. Issue #28 asks for a real docs site for this repository; #202 asks for the download page in
particular. The site must therefore coexist with the artifacts on the same host, and the landing
page question ("docs at `/`, or docs under a subpath?") has a hard answer: **the root**, because the
artifact URLs are the root's paths, so any subpath scheme would have put the docs one click away
from the files the updater fetches, for no benefit.

Two writers on one branch is the real cost. `pages.yml` is a deliberate **single-writer** design
(pass-2 stage/publish architecture, #353); a second workflow committing to the same branch would put
a lost update (a silently reverted release, or a stale site) on the table.

## Decision

The docs site is built from `docs-site/` (Astro + Starlight, its own pnpm workspace and lockfile)
and published to the **root** of the `gh-pages` branch by `.github/workflows/docs-deploy.yml`,
through the same git-data API path the publish tooling uses (`uploadToPages.mjs`, extended with
`deletePaths`).

- **Path-disjoint writers.** Publish owns the artifact paths and the branch `README.md`; the docs
  deploy owns the site paths plus `.docs-site-files.json`, the manifest of exactly those paths.
  Neither can touch the other's files, because each only ever writes the paths it built.
- **Serialized writers.** Both workflows take the repo-wide concurrency group `gh-pages-write`
  (`cancel-in-progress: false`), so their read-head-then-commit cycles cannot interleave. This
  replaces pages.yml's former `pages-publish` group; the group name appears in exactly two files and
  changing one without the other breaks the invariant.
- **Full replace, not an overlay.** The docs deploy deletes anything its previous manifest listed
  and the new build no longer produces, in the same commit: a deleted or renamed page cannot survive
  as a stale file. Deleting a path that is also being written is a hard error.
- **The root `index.html` is the docs landing page.** `pagesIndex()` and its unit test are gone;
  publish no longer writes `index.html`, and `release:verify` no longer expects it.
- **Pages serving is unchanged**: "Deploy from a branch: `gh-pages` / (root)" with `.nojekyll`. This
  record does **not** adopt the actions-pages deployment model. Full-site replacement via
  `deploy-pages` stays available as a follow-up if the two-writer arrangement proves fragile: the
  branch shape would not change, only who assembles it.
- **The docs source is in-repo and validated in CI.** `docs-site/` is its own pnpm workspace for
  installs, but ALL of its lint and formatting runs from the root toolchain in one pass: root eslint
  covers plain scripts, `.md`, `.mdx` pages and `.astro` components, and root prettier formats the
  tree with `prettier-plugin-astro` (`.mdx` pages stay excluded: prettier's MDX formatter breaks the
  Astro build). An advisory (never required) `docs` job in `ci.yml` builds the site on docs-only
  changes (the only cover for `.ts` types, via `astro check`), so a broken page fails on the PR
  rather than in the deploy workflow. The merged toolchain costs three things: the Astro compiler
  enters the root install as a lint dependency, both `typescript` installs ride the 6.x line
  (`typescript-eslint` refuses TS 7, so the repo's `tsc` is the stable 6.0.2, not the 7 preview),
  and the root `prettier-plugin-astro` version must track the site's Astro by hand across two
  lockfiles. Nested-tree `--ignore-path` patterns need the `**/` prefix: a custom ignore path
  anchors slash patterns at `config/`, so a bare `docs-site/...` pattern silently matches nothing.

## Consequences

Users get one URL (<https://onemen.github.io/firefox-scripts/>) that is both the documentation and
the artifact host, and the README can shrink to links. Two workflows, two path sets, one serialized
branch: a docs deploy cannot break a release, and a publish cannot break the docs, because each
writes only what it built. The cost is the coordination itself: the shared concurrency group and the
manifest are load-bearing, so 0031's "append-only, artifacts at the root" reading has to be amended
rather than assumed, and `pnpm release:verify` no longer proves the site root renders. Revisit-if:
the artifact URLs ever move off this host (then the docs take the root by default and this record's
path split disappears), or the docs site outgrows a branch commit per deploy (then move to
`deploy-pages` and assemble the whole site in one workflow).
