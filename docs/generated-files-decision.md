# Generated Files — Keep vs. Untrack (decision record)

> **Moved.** This decision is recorded as an architecture decision record (ADR):
> [0008 — Generated files untracked, regenerated on demand](./decisions/0008-generated-files-untracked.md)
> (see the [decision log index](./decisions/index.md)).

Summary: the generated files (`updater-config.sys.mjs`, `updater.css`, `_config.h`, `resources.h`)
are **not committed**. They are gitignored and regenerated on demand by the build/publish tooling;
publish hashes cover their **true sources** so a source change still bumps the package hashes. The
superseded approach (committed files + git-hook sync) is ADR
[0004](./decisions/0004-commit-generated-files.md).
