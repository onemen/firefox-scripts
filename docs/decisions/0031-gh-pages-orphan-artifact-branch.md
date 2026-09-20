# 0031: gh-pages is an orphan, artifact-only publish branch

- **Status:** accepted
- **Date:** 2026-09-20
- **Amends:** [0003](./0003-hash-manifest-on-gh-pages.md) — the branch hosting the manifest gets a
  defined history shape: publish commits only, artifacts at the root, never seeded from the default
  branch

## Context

`gh-pages` was created on 2026-08-22 by `uploadToPages.mjs` as a ref pointing at the default-branch
**tip** — contradicting the module's own header comment ("orphaned"). The branch therefore carried
the repository's full source tree and 2017-era history beneath the publish commits, and `main`
commits after the seeding (e.g. the commit a `latest` tag pointed at) could never appear in its
history. The confusion surfaced when the branch page showed publish commits stacked on "random"
history. A one-time reset (2026-09-20, `dc090f0`) rewrote the branch as a true orphan holding
exactly the serving artifacts; serving is path-based
([0027](./0027-machine-fetches-on-publish-branch.md)), so nothing functional changed and the live
update surface stayed byte-identical (issue #261).

## Decision

The publish branch is a **true orphan**: its history contains only publish commits, and its tree
contains only the pushed artifacts (`.nojekyll`, the zips, the helper binaries and sidecars,
`hashes.json`, `index.html`). When the branch is missing, `uploadToPages.mjs` creates it from the
files being pushed — a files-only root commit with no parents — and never seeds it from the default
branch or merges `main` into it. Publishing stays append-only: each run commits its changed
artifacts on top of the branch head (an idle run still creates no commit).

## Consequences

The branch page reads as a publish log instead of a copy of the repository's history, and the source
tree is no longer duplicated onto the Pages branch. The one-time reset is irreversible but loses
only publish noise; the commit messages are the history (scope/platform labels land with #261).
GitHub still records one deployment per publish job — those records are informational and cleaned
manually. Revisit-if: Pages moves to the Actions deployment model (#28) and the branch disappears
entirely.
