# Firefox Scripts

[![CI](https://github.com/onemen/firefox-scripts/actions/workflows/ci.yml/badge.svg)](https://github.com/onemen/firefox-scripts/actions/workflows/ci.yml)
[![E2E](https://github.com/onemen/firefox-scripts/actions/workflows/e2e.yml/badge.svg)](https://github.com/onemen/firefox-scripts/actions/workflows/e2e.yml)

> **🚧 Under active development.** The **installer** and **in-browser updater** are new and being
> validated. The core scripts they install are long-standing and stable, but because the updater
> ships inside `utils.zip`, installing a fresh `utils.zip` starts the update checks — so the
> repository as a whole is under active development for now. Found a problem?
> [Open an issue](https://github.com/onemen/firefox-scripts/issues) and include your browser version
> and OS.

Install and keep Firefox-family browser scripts up to date.

**firefox-scripts** installs and keeps up to date the helper scripts that let Firefox-family
browsers (Firefox stable/Nightly/Developer Edition, Waterfox, Zen, LibreWolf, Floorp) run legacy
(non-WebExtension) extensions such as **TabMixPlus** — a small native installer copies two packages
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

## How to use the installer

1. **Download** the installer for your OS from the
   [releases page](https://github.com/onemen/firefox-scripts/releases):
   - `installer_win.exe` — Windows
   - `installer_linux` — Linux
   - `installer_mac` — macOS
2. **Run** the downloaded installer. It connects to a running Firefox-family browser (Firefox,
   Waterfox, Zen Browser, LibreWolf, or Floorp), opens an install screen in a browser tab, and lets
   you pick which browser to set up.
3. **Choose the components** to install:
   - **Configuration files** (`config.js`, `config-prefs.js`) — copied to the browser's installation
     directory
   - **Utils** (the chrome scripts) — copied to your profile's `chrome/utils/` directory
4. Click **Install**, wait for completion, then **Restart the browser** when prompted.

> The install tab always opens. It is the piece that downloads the packages from the network; if
> they cannot be reached, the tab shows a network-error banner instead of the install screen.

The installer itself is a one-shot setup tool: it installs only the components you pick above and
**does not** leave behind any other files, background processes, or scheduled tasks. After the
install completes you can delete the downloaded executable — nothing else was installed besides the
configuration files and scripts you chose.

Prefer to install by hand? Follow the
[manual installation guide](https://onemen.github.io/tabmixplus-docs/other/installation/).

## How the updater keeps your scripts up to date

Once installed, the scripts keep themselves current without you re-running the installer:

- **Daily check.** The updater (a small privileged script that lives inside the browser) checks once
  a day whether a newer version of the scripts or configuration files has been published.
- **Notification tab.** When an update is available, the updater opens a tab showing what would
  change. You can install the update right there, skip it for the day, or permanently ignore a
  specific update.
- **In-tab install.** Applying an update downloads the new packages and copies them into place
  inside the browser — no installer download needed. Updating the configuration files, which live in
  admin-protected folders (e.g. Program Files on Windows), triggers a single elevation prompt via a
  small helper that ships with the update.
- **Manual update.** You can always open the updater manually from the browser menu, or download the
  `utils.zip` / `fx-folder.zip` packages directly from the update tab.

Updater UI scripts update automatically, as a background service of Firefox. Configuration-file
updates and browser restarts are applied only when you choose to install them, keeping the process
predictable and under your control.

## Original Scripts and Core Folders

The scripts this project installs are the long-standing ones from
[xiaoxiaoflood/firefox-scripts](https://github.com/xiaoxiaoflood/firefox-scripts) — the original
project that lets Firefox-family browsers run legacy (non-WebExtension) extensions. In this
repository they are bundled into two packages:

- **`utils.zip`** — the chrome scripts (the userChromeJS loader, the legacy-extension shim, and the
  in-browser updater), installed to your profile's `chrome/utils/` directory.
- **`fx-folder.zip`** — the configuration files (`config.js`, `config-prefs.js`), installed to the
  browser's installation directory.

Both packages are also available for download from the
[releases page](https://github.com/onemen/firefox-scripts/releases) — you can install or update them
by hand. After your first install from this repository, the browser will notify you when a new
version is available (see
[How the updater keeps your scripts up to date](#how-the-updater-keeps-your-scripts-up-to-date)).

The original scripts are governed by the
[Mozilla Public License 2.0](https://www.mozilla.org/en-US/MPL/2.0/); the in-browser updater
(`core/chrome/utils/updater/`) is custom to this project and licensed under the
[MIT License](LICENSE.md).

## For developers

- **[Developer guide](docs/DEVELOPING.md)** — building the installer, the publish/release workflow,
  the generated files, and how the installer works under the hood.
- **[Contributing](CONTRIBUTING.md)** — how to set up the repo, run checks, and submit changes.

---

### Contributing

Contributions are welcome — bug reports, fixes, and improvements all help. Read
[CONTRIBUTING.md](CONTRIBUTING.md) for setup and workflow guidance, then open a pull request. The
project's source of truth for scripts is `core/`, plus the C installer under `installer/` and the
publish scripts under `tools/publish/`.

### Problems?

File an **issue** on [the GitHub repository](https://github.com/onemen/firefox-scripts/issues).
Please search existing issues first — your problem may already be reported.

### License

[MIT](LICENSE.md) © 2026 ONEMEN <tabmix.onemen@gmail.com>
