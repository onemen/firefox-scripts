# Stacked PR workflow

The remaining v1.0 E2E and release-gate work is developed as a GitHub stacked PR series. Use the
official [`gh stack`](https://github.github.com/gh-stack/) extension so each layer can be reviewed
independently while retaining a linear dependency chain.

## Current scope

The portable-browser layer focuses on **Firefox Release** for v1.0 (`#56`). Portable-layout coverage
for forks is deferred to the Post-v1.0 roadmap (`#38`) until their distribution formats can be
tested reliably without complicating the required Firefox Release legs.

## Local review

Before submitting a stack, run the repository's batched review command from a clean checkout:

```bash
pnpm review:batch -- --branch e2e/portable-firefox --branch docs/portable-firefox-tracker --agent
```

This creates a temporary worktree, combines the selected branches, runs one CodeRabbit CLI review,
and removes the temporary worktree afterward. It avoids spending one review quota slot per stacked
PR. Use `--dry-run` first to inspect the selected branches; use `--check` to inspect CLI usage.

After fixing findings, re-run the batch review locally before `gh stack submit`. Submit the stack
only after the local tests, lint/format checks, and batched review are clean.
