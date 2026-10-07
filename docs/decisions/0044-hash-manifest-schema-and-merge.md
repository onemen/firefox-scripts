# 0044: Hash-manifest schema and its single-writer merge

- **Status:** accepted
- **Date:** 2026-10-07
- **Amends:** [0002](./0002-hash-based-update-detection.md) — 0002 fixed the algorithm and the
  canonical `files` list; the manifest's exact schema and who may write it are recorded here

## Context

`hashes.json` is the trust root for update detection (0002), install verification, and the
up-to-date check — yet 0002 records the hash algorithm and the authority of the `files` array, not
the document's schema or its write path. The schema is de-facto everywhere: consumers parse a fixed
shape (per package: `hash`, `date`, `files[]`), and the C twin's ingest treats a manifest as
authoritative only when it carries **both** hashes and a non-empty `files` array per package,
falling back to the uploaded packages otherwise. The write path grew with two-pass publishing
(0042): parallel staging legs compute hash _updates_, and nothing in the log said that only the
single writer may apply them to the published manifest — a second writer would interleave commits on
`gh-pages` (an orphan, artifact-only branch per 0031) and could publish a manifest describing bytes
that were never uploaded (0030's strand scenario).

## Decision

The manifest's schema is part of the contract: one entry per package — `hash` (64 hex), `date`
(display-only), `files[]` (the canonical list, 0002) — and a manifest missing any of those for any
package is invalid rather than partially trusted. Writes follow the single-writer rule: the pre-run
baseline is captured once before staging, per-platform hash updates ride the staging artifacts
(`build-manifest.<platform>.json`), and only pass 2's writer merges the staged set into the
published `hashes.json` — staging legs never write it. Partial publishes freeze the entries of
excluded roles ([0030](./0030-partial-publishes.md)); the published set must equal the staged set.

## Consequences

Every consumer — the browser updater, the installer's strstr-based parse, the publish diff — reads
one stable shape from one writer, so manifest history on `gh-pages` is linear and every revision
names bytes that exist. The cost: the schema is now a cross-language compatibility surface —
changing a field amends this record and both twins (JS reference and C ingest) in the same PR, and
the "both hashes + non-empty files" validity rule means old-format manifests stay in the documented
fallback path rather than being partially honored. Revisit-if: a second publish surface needs to
write the manifest, or a consumer requires a field the schema does not carry.
