# Firefox Scripts

[![CI](https://github.com/onemen/firefox-scripts/actions/workflows/ci.yml/badge.svg)](https://github.com/onemen/firefox-scripts/actions/workflows/ci.yml)
[![E2E](https://github.com/onemen/firefox-scripts/actions/workflows/e2e.yml/badge.svg)](https://github.com/onemen/firefox-scripts/actions/workflows/e2e.yml)

Install and keep Firefox-family browser scripts up to date.

**firefox-scripts** installs and keeps up to date the helper scripts that let Firefox-family
browsers (Firefox stable/Nightly/Developer Edition, Waterfox, Zen, LibreWolf, Floorp) run legacy
(non-WebExtension) extensions such as **TabMixPlus**. A small native installer copies two packages
into the browser, and an in-browser updater keeps them current automatically as new versions are
released.

## Supported browsers

- Firefox (stable, Nightly, Developer Edition)
- Waterfox
- Zen Browser
- LibreWolf
- Floorp

A browser must be **running** to be detected (detection uses process scanning and lock-file
inspection).

Download the installer for your OS from the
[Latest release](https://github.com/onemen/firefox-scripts/releases/tag/latest), run it with a
Firefox-family browser open, pick the browser and components in the tab it opens, and restart the
browser when prompted. The installer is a one-shot setup tool: nothing is left behind but the files
you chose.

## Documentation

- **[Installation](https://onemen.github.io/firefox-scripts/installation/)**: step-by-step setup
  with screenshots, per-OS paths, the updater and its choices, and hand installation.
- **[Download](https://onemen.github.io/firefox-scripts/download/)**: installer binaries and script
  packages, current and past builds.
- **[How it works](https://onemen.github.io/firefox-scripts/how-it-works/installer-updater/)**: the
  installer and auto-updater, the configuration files, the script loaders.
- **[Why we need it](https://onemen.github.io/firefox-scripts/introduction/)**: why legacy
  extensions need these helper scripts.
- **[FAQ](https://onemen.github.io/firefox-scripts/faq/)**: safe mode, profiles, forks, security.
- **[Troubleshooting](https://onemen.github.io/firefox-scripts/troubleshooting/)**: what to check
  when something does not load.

The installed scripts build on
[xiaoxiaoflood/firefox-scripts](https://github.com/xiaoxiaoflood/firefox-scripts)
([MPL-2.0](https://www.mozilla.org/en-US/MPL/2.0/)); this repository's own installer and updater are
[MIT](LICENSE.md).

## For developers

- **[Developer guide](docs/DEVELOPING.md)**: building the installer, the publish/release workflow,
  the generated files, and how the installer works under the hood.
- **[Contributing](CONTRIBUTING.md)**: how to set up the repo, run checks, and submit changes.
- **Roadmap**: GitHub is the single source of truth: the
  [v1.0](https://github.com/onemen/firefox-scripts/milestone/1) and
  [Post v1.0](https://github.com/onemen/firefox-scripts/milestone/2) milestone views plus the
  phase/umbrella issues they collect.

### Contributing

Contributions are welcome. Bug reports, fixes, and improvements all help. Read
[CONTRIBUTING.md](CONTRIBUTING.md) for setup and workflow guidance, then open a pull request. The
project's source of truth for scripts is `core/`, plus the C installer under `installer/` and the
publish scripts under `tools/publish/`.

### Problems?

Start with **[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)**. It maps the common symptoms
(installer not opening, updater stuck, publish refusing) to fixes. If nothing there fits, file an
**issue** on [the GitHub repository](https://github.com/onemen/firefox-scripts/issues). Please
search existing issues first. Your problem may already be reported.

### License

[MIT](LICENSE.md) © 2026 ONEMEN <tabmix.onemen@gmail.com> (`SPDX-License-Identifier: MIT`)

Applies to the whole repository **except** the upstream-derived `core/` tree (files outside
`core/chrome/utils/updater/`), which is
[Mozilla Public License 2.0](https://www.mozilla.org/en-US/MPL/2.0/) per
[`core/LICENSE`](core/LICENSE) (`SPDX-License-Identifier: MPL-2.0`). The custom in-browser updater
(`core/chrome/utils/updater/`) is MIT like the rest of the repo. See
[Documentation](#documentation).
