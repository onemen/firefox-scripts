# Source Components (`core/`)

This directory contains the runtime files, loader configurations, and scripts for Firefox.

## Overview & Scope

- **Maintainer & Developer since August 2024:** ONEMEN (<tabmix.onemen@gmail.com>)

### Modifications

All modifications made in this repository are intended to maintain compatibility with modern Firefox
releases published since August 2024.

---

## Directory Structure & Licensing

### 1. Upstream Components (MPL 2.0)

- **Paths:**
  - `core/chrome/utils/` (except `core/chrome/utils/updater/`)
  - `core/fx-folder/`
- **Upstream Source:** Derived from
  [xiaoxiaoflood/firefox-scripts](https://github.com/xiaoxiaoflood/firefox-scripts) (Upstream commit
  [`eb11298`](https://github.com/xiaoxiaoflood/firefox-scripts/commit/eb11298bfacc609b8fd67850295256cd6b621d0f),
  Aug 20, 2024).
- **License:** [Mozilla Public License 2.0 (MPL 2.0)](./LICENSE)

---

### 2. Custom Components (MIT License)

- **Paths:**
  - `core/chrome/utils/updater/`
  - `tools/publish/remote-ui/`
- **Description:** In-browser updater: `scriptsUpdater.sys.mjs` (daily check + updater-ui
  self-update, ships in utils.zip) and the updater tab UI/engine shipped in `updater-ui.zip`
  (`updater.html`, `updater.js`, `updater-ui.js`, the generated `updater.css`, brand logos), served
  as a chrome-privileged page at `chrome://firefox-scripts/content/ui/updater.html`.
- **Author & Copyright:** Copyright (c) 2026 ONEMEN (<tabmix.onemen@gmail.com>)
- **License:** [MIT License](../LICENSE)
