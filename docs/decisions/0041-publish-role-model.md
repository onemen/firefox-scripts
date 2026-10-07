# 0041: Publish role model — four roles, one vocabulary, no implicit scope

- **Status:** accepted
- **Date:** 2026-10-07
- **Amends:** [0030](./0030-partial-publishes.md) — the roles 0030 introduced as its holdback
  mechanism are the canonical vocabulary here, including channel × role legality

## Context

Every publish surface speaks in artifact roles: `tools/publish/publishScope.mjs` (`scopeFor()`,
`INCLUDE_ROLES`) is the de-facto spec, `upload.mjs` scopes builds/hashes/scans/uploads by it, the
`publish-upload` composite action takes it as an `include` input, and `docs/DEVELOPING.md` documents
it for operators. But 0030 introduced the four roles purely as an AV-holdback escape hatch, so the
vocabulary itself — what a role owns, that there is no implicit default, and which role combinations
each channel may run — was never recorded. The 2026-10-02 addition of `updater-ui` as a fourth role
was amended onto 0030 in place, evidence that the role set outgrew its origin story.

## Decision

Every publish runs under an explicit, validated scope drawn from exactly four roles — `packages`
(all three package zips: `utils`, `fx-folder`, `updater-ui`), `updater-ui` (the tab alone),
`installer`, `helper` — and a missing, empty or unknown scope fails the run loudly instead of
guessing. Channel × role: the vocabulary is the same on both channels; what differs is who may
initiate (prod is CI-only, dev is operator-initiated) and the manifest-birth hazard 0030 records — a
binary-only scope may not _create_ a dev branch, because the branch would be born carrying a
manifest that names zips it does not contain. Roles are independent: a scope that names some roles
never builds, hashes, scans or publishes the others, and their manifest entries stay frozen
([0030](./0030-partial-publishes.md)).

## Consequences

Partial publishes, the staged matrix's skip rules, AV scoping and the operator docs all read one
vocabulary, so a new consumer (code signing, a new artifact) extends this record instead of
inventing flags. The cost: the role set is now a compatibility surface — renaming or splitting a
role touches workflows, the composite action, the scope validator and both channel docs at once.
Adding a fifth role is an amendment to this record (the `updater-ui` precedent). Revisit-if: the
channels ever need different role sets, or a publish target cannot be expressed as a role.
