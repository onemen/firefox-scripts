# Firefox Scripts

[![CI](https://github.com/onemen/firefox-scripts/actions/workflows/ci.yml/badge.svg)](https://github.com/onemen/firefox-scripts/actions/workflows/ci.yml)
[![E2E](https://github.com/onemen/firefox-scripts/actions/workflows/e2e.yml/badge.svg)](https://github.com/onemen/firefox-scripts/actions/workflows/e2e.yml)

> **🚧 Under active development** — the **installer** and **in-browser updater** are new and being
> validated; the core scripts they install are the long-standing, stable ones. Found a problem?
> [Open an issue](https://github.com/onemen/firefox-scripts/issues) and include your browser version
> and OS.

Install and keep Firefox-family browser scripts up to date.

**firefox-scripts** installs and keeps up to date the helper scripts that let Firefox-family
browsers (Firefox stable/Nightly/Developer Edition, Waterfox, Zen, LibreWolf, Floorp) run legacy
(non-WebExtension) extensions such as **TabMixPlus** — a small native installer copies two packages
into the browser, and an in-browser updater keeps them current automatically as new versions are
released.

> **Official install documentation:** https://onemen.github.io/tabmixplus-docs/other/installation/

## How to install the installer

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

### Supported browsers

- Firefox (stable, Nightly, Developer Edition)
- Waterfox
- Zen Browser
- LibreWolf
- Floorp

A browser must be **running** to be detected (detection uses process scanning and lock-file
inspection).

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

Scripts update automatically; configuration-file updates and browser restarts are applied when you
choose to install them, keeping the process predictable.

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
