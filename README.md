# Firefox Scripts

[![CI](https://github.com/onemen/firefox-scripts/actions/workflows/ci.yml/badge.svg)](https://github.com/onemen/firefox-scripts/actions/workflows/ci.yml)
[![E2E](https://github.com/onemen/firefox-scripts/actions/workflows/e2e.yml/badge.svg)](https://github.com/onemen/firefox-scripts/actions/workflows/e2e.yml)

Install and keep Firefox-family browser scripts up to date.

**firefox-scripts** installs and keeps up to date the helper scripts that let Firefox-family
browsers (Firefox stable/Nightly/Developer Edition, Waterfox, Zen, LibreWolf, Floorp) run legacy
(non-WebExtension) extensions such as **TabMixPlus** — a small native installer copies two packages
into the browser, and an in-browser updater keeps them current automatically as new versions are
released.

Full documentation (installation, download, how it works, troubleshooting):
**<https://onemen.github.io/firefox-scripts/>**

## Supported browsers

- Firefox (stable, Nightly, Developer Edition)
- Waterfox
- Zen Browser
- LibreWolf
- Floorp

A browser must be **running** to be detected (detection uses process scanning and lock-file
inspection).

## How to use the installer

1. **Download** the installer for your OS from the
   [Latest release](https://github.com/onemen/firefox-scripts/releases/tag/latest):
   - `installer_win.exe` — Windows
   - `installer_linux` — Linux (x86_64) · `installer_linux_aarch64` — Linux (ARM64)
   - `installer_mac` — macOS (universal: Intel + Apple Silicon)

2. **Run** it with a Firefox-family browser open. It opens an install screen in a browser tab where
   you pick the browser and the components (configuration files, utils).
3. Click **Install**, then **restart the browser** when prompted.

Full walkthrough with screenshots, per-OS paths, and hand installation:
[Installation](https://onemen.github.io/firefox-scripts/installation/). The installer is a one-shot
setup tool: nothing is left behind but the files you chose.

## How the updater keeps your scripts up to date

Once installed, a small in-browser updater checks once a day for new `firefox-scripts` packages and
offers them in a tab (install, remind tomorrow, or skip per package). No re-install needed. Details
and the update choices:
[Installation](https://onemen.github.io/firefox-scripts/installation/#the-updater) and
[Installer and auto-updater](https://onemen.github.io/firefox-scripts/how-it-works/installer-updater/).

## Original Scripts and Core Folders

The installed scripts build on
[xiaoxiaoflood/firefox-scripts](https://github.com/xiaoxiaoflood/firefox-scripts) (MPL-2.0), bundled
here as `utils.zip` (chrome scripts, per profile) and `fx-folder.zip` (configuration files, browser
directory), plus this repository's own installer and updater (MIT). Package dates, downloads, and
past releases: [Download](https://onemen.github.io/firefox-scripts/download/).

The original scripts are governed by the
[Mozilla Public License 2.0](https://www.mozilla.org/en-US/MPL/2.0/); the in-browser updater
(`core/chrome/utils/updater/`) is custom to this project and licensed under the
[MIT License](LICENSE.md).

## For developers

- **[Developer guide](docs/DEVELOPING.md)** — building the installer, the publish/release workflow,
  the generated files, and how the installer works under the hood.
- **[Contributing](CONTRIBUTING.md)** — how to set up the repo, run checks, and submit changes.
- **Roadmap** — GitHub is the single source of truth: the
  [v1.0](https://github.com/onemen/firefox-scripts/milestone/1) and
  [Post v1.0](https://github.com/onemen/firefox-scripts/milestone/2) milestone views plus the
  phase/umbrella issues they collect.

### Documentation index

| Document                                                    | What it covers                                                                |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [DEVELOPING.md](docs/DEVELOPING.md)                         | Setup, build, test, publish/release workflow, installer architecture, tooling |
| [TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)               | Symptom → fix for installer, updater and publish failures                     |
| [auto-updater.md](docs/auto-updater.md)                     | The in-browser updater: daily check, verification, extraction, install flow   |
| [status-logic.md](docs/status-logic.md)                     | What “Up to date / Update available / Not installed / Skipped” mean and why   |
| [security.md](docs/security.md)                             | Threat model: session token, localhost request model, upload verification     |
| [continuous-integration.md](docs/continuous-integration.md) | The CI jobs, path filters and gates                                           |
| [ci-inventory.md](docs/ci-inventory.md)                     | Generated inventory of workflows, triggers, path filters and required checks  |
| [e2e-tests.md](docs/e2e-tests.md)                           | How the installer/updater E2E suites run                                      |
| [e2e-legs.md](docs/e2e-legs.md)                             | Generated table of E2E legs (browsers × OS)                                   |
| [e2e-matrix-plan.md](docs/e2e-matrix-plan.md)               | The E2E matrix design/plan                                                    |
| [unit-test-sandboxes.md](docs/unit-test-sandboxes.md)       | The vm-sandbox technique used by the unit suites                              |
| [debugging-with-rdp.md](docs/debugging-with-rdp.md)         | Live Firefox debugging over RDP (the `debugging-firefox` skill)               |
| [restart-ui-tab.md](docs/restart-ui-tab.md)                 | Restarting the updater UI tab during development                              |
| [decisions/index.md](docs/decisions/index.md)               | Architecture decision records (ADR log) — read before design changes          |

---

### Contributing

Contributions are welcome — bug reports, fixes, and improvements all help. Read
[CONTRIBUTING.md](CONTRIBUTING.md) for setup and workflow guidance, then open a pull request. The
project's source of truth for scripts is `core/`, plus the C installer under `installer/` and the
publish scripts under `tools/publish/`.

### Problems?

Start with **[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)** — it maps the common symptoms
(installer not opening, updater stuck, publish refusing) to fixes. If nothing there fits, file an
**issue** on [the GitHub repository](https://github.com/onemen/firefox-scripts/issues). Please
search existing issues first — your problem may already be reported.

### License

[MIT](LICENSE.md) © 2026 ONEMEN <tabmix.onemen@gmail.com> — `SPDX-License-Identifier: MIT`

Applies to the whole repository **except** the upstream-derived `core/` tree (files outside
`core/chrome/utils/updater/`), which is
[Mozilla Public License 2.0](https://www.mozilla.org/en-US/MPL/2.0/) per
[`core/LICENSE`](core/LICENSE) — `SPDX-License-Identifier: MPL-2.0`. The custom in-browser updater
(`core/chrome/utils/updater/`) is MIT like the rest of the repo. See
[Original Scripts and Core Folders](#original-scripts-and-core-folders).
