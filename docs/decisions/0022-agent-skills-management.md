# 0022: Agent skills are `gh`-installed and pristine — no `skills-lock.json`, no second root

- **Status:** accepted
- **Date:** 2026-09-05

_Problem surface:_ agent skills tooling (`.agents/skills/`, installers, drift detection)

## Context

Skills reached this repo through three incompatible paths: four third-party skills copied by hand
plus a root `skills-lock.json` v1 (2026-08-21), and one vendored skill walled off under
`.agent/skills/` (PR #73). The lint/format gates then **reformatted the third-party copies**
(prettier rewrote their frontmatter and prose), which staled every lockfile hash on day one and
makes every upstream re-sync a formatting conflict.

A 2026-09-05 live audit measured four of those skills 2–189 lines behind upstream — while
`gh skill update --dry-run` reported **"All skills are up to date" (exit 0)** in the same tree. The
gap is mechanical: `gh skill update` only detects skills carrying the frontmatter metadata its own
`gh skill install` injects (`metadata.github-repo/-ref/-tree-sha`); manually copied or
`skills`-CLI-installed skills have none and are skipped with a prose notice CI cannot see. The
Vercel CLI writes only a lockfile, never frontmatter — so its installs are invisible to `gh` tooling
and vice versa. Two ecosystems, no common detector.

## Decision

One tool, one classification, one root:

1. **Install third-party skills only with `gh skill install`** — its frontmatter metadata is the
   provenance record and the update detector in one. We do **not** use the Vercel `skills` CLI; the
   root `skills-lock.json` is retired.
2. **Classification is metadata, not location or naming**: a skill with `metadata.github-repo` in
   `SKILL.md` is third-party; without it, authored here. No `vendor-*` prefixes, no nested discovery
   layouts.3. **Third-party skills stay pristine** — never linted, never formatted. The gate ignores
   derive from the frontmatter metadata itself: eslint computes its ignore list at config-load from
   `metadata.github-repo` (`config/eslint.config.js`), and `.prettierignore` carries a generated
   block (`tools/sync-skill-gates.mjs`, run by the format scripts) that ignores every skill and
   un-ignores the authored ones — so a newly installed third-party skill is ignored automatically
   and only authored skills are ever gated. Gates that mutate apply to things we author; gates that
   validate apply to everything.
3. **One root**: `.agents/skills/<skill-name>/`, flat, tracked. The `.agent/` root is retired; its
   vendored skill moves under the common root (still pristine, still MIT-attributed).
4. **Updates are `gh skill update`** — `--dry-run` in a weekly advisory CI check that opens/updates
   a tracking issue; locally `--all`. Drift becomes a **deliberate human-reviewed PR per batch** —
   never auto-merged: upstream skill text is a prompt-injection surface.
5. **Scope split**: repo-shared skills are committed here; personal skills live in user scope
   (`~/.agents/skills/`), installed with the same tool, never committed.

## Consequences

Every third-party skill becomes detectable by `gh skill update --dry-run` (the exit-0 blindness
above becomes fixable rather than structural), provenance lives in the tracked diff itself, and a
re-sync is a clean re-download instead of a formatting conflict. One-time migration cost: the four
gate-mangled skills are re-imported pristine, the lockfile deleted, `.agent/` folded in, and the
gates/AGENTS.md re-pointed — all in one implementation PR.

What gets harder: `gh skill` is preview (its metadata format is a dependency we accept), and it
detects drift against the **recorded ref**, not upstream latest — so pin-aware installs plus the
watchdog diffing against the default branch remain necessary for true "upstream moved" signal.
Authored skills, by design, have no upstream and no auto-update story.

Revisit-if: the `gh skill` metadata format breaks on graduation from preview, or a non-GitHub skill
source becomes a real requirement — that would reopen the lockfile question.
