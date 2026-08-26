# 0007: Updater tab UI ships as a chrome-privileged package

- **Status:** accepted
- **Date:** 2026-08-11

## Context

Firefox 155 removed the ability to embed srcdoc/data:/blob: frames in a system-principal chrome
document, which killed the hosted-remote-UI approach ([0006](./0006-hosted-remote-updater-ui.md))
for good. Probes for every embedding variant failed — the frame just stayed `about:blank`, with no
`load` event and no security policy violation. The UI must ship with the product instead of being
fetched.

## Decision

The updater tab UI is a **third package**, `updater-ui.zip` — `updater.html` + `updater.js`
(privileged engine) + `updater-ui.js` (client) + generated `updater.css` + brand logos — installed
to `ProfD/chrome/utils/updater/ui/` and served as `chrome://firefox-scripts/content/ui/*`. There is
no remote page, no iframe, no postMessage. `scriptsUpdater.sys.mjs` (in utils.zip) downloads,
verifies and extracts `updater-ui.zip` before opening the tab, so the UI self-updates without a
restart (`da24dc0`, 2026-08-11; the parallel remote-UI branch converged on the same package in
`83fefd6`, 2026-08-19).

## Consequences

One more package to hash, ship and self-update, and the UI can only change when utils pushes it —
but there is no remote code, no frame-principal dependency, and the tab works offline. The CSS is
generated from `installer/web/style.css` + `tools/publish/updater.css` at publish time (0008).
Revisit-if: Firefox restores frame embedding or a sandboxed webview becomes available for chrome
documents.
