# Contributing

Thanks for contributing to **Firefox Scripts**! This project installs and updates Firefox-family
browser scripts (e.g. to run legacy extensions like TabMixPlus) via a native C installer and an
in-browser updater.

## How to contribute

- **Report bugs / request features** — open an issue on
  [GitHub](https://github.com/onemen/firefox-scripts/issues). Search existing issues first.
- **Fix bugs / add features** — fork the repo, make your changes on a branch, and open a pull
  request back to `main`. Keep each PR focused on a single change and describe the reasoning.
- **Architecture changes** — consult the decision log first (`docs/decisions/index.md`): a decision
  already made usually covers the need. New decisions use the ADR template
  (`docs/decisions/0000-template.md`).

## Setup

```bash
pnpm install
```

## Making changes

- **Chrome scripts** live under `core/chrome/utils/`. Edit, then verify the chrome manifest loads
  (see the [developer guide](docs/DEVELOPING.md#test-the-auto-updater)).
- **Installer** (`installer/src/`): C code; regenerate `resources.h` with `make resources` when web
  assets change.
- **Web UI** (`installer/web/`): `index.html`, `style.css`, `script.js` are the single design
  source. Run `node installer/embed.mjs` to update the embedded installer assets. The updater tab
  reuses the same CSS (see the developer guide on generated files).

### Docs

A docs file over 100 lines gets a contents list at the top when next touched (TOC-on-touch) — no
sweeping the files that lack one today. Keep entries as anchor links to the `##` sections so the
list cannot drift from the headings.

### Generated files

The generated files (`installer/src/_config.h`, `installer/src/_builddate.h`,
`installer/src/resources.h`, `installer/src/script.built.js`,
`core/chrome/utils/updater/updater-config.sys.mjs` and `tools/publish/remote-ui/updater.css`) are
**not committed** — they are gitignored and regenerated on demand: the installer Makefile produces
the C headers on every build, `syncGeneratedFiles.mjs` rebuilds the script concat sidecar, and
`createZip.mjs` produces the updater config and stylesheet at publish time (see `docs/DEVELOPING.md`
and ADR `docs/decisions/0008-generated-files-untracked.md`). Edit the sources
(`config/installer.conf`, `installer/web/*`) and let the tooling regenerate.

## Verification

Before opening a PR, run the local checks:

```bash
pnpm lint          # the full gate (13 stages, fail-fast): eslint, check-strncpy,
                   # check-apt-get, tsc, C format check, gcc -fanalyzer, markdownlint,
                   # md-list markers, check-docs-mdx, YAML frontmatter, check-skills,
                   # skill commands/links, hygiene (needs the C toolchain, see
                   # docs/DEVELOPING.md → Prerequisites)
pnpm format        # sync-skill-gates + prettier + C format check (read-only)
pnpm test          # unit tests (pure Node, no build needed)
pnpm test:hash     # the four binary-in-the-loop installer suites: hash parity,
                   # self-update, profiles.ini, profile argv (installer/test/README.md).
                   # Needs a compiled installer, so it uses the newest dist/ snapshot,
                   # generating a prod one via snapshot:prod when none exists; a stale
                   # snapshot is a hard fail rather than a misreported regression
pnpm snapshot:dev                 # build a dev snapshot
pnpm test:e2e      # installer HTTP + updater scenarios (needs that snapshot)
```

Uploads are gated to `main` and require a GitHub token (see
`docs/DEVELOPING.md#publishing-a-release`); the offline check needs no token:

```bash
pnpm snapshot:prod
```

## License

By contributing you agree that your contributions are licensed under the project's
[MIT license](LICENSE.md).
