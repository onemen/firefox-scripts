# 0006: Updater tab UI hosted as a remote page

- **Status:** superseded by [0007](./0007-updater-ui-ships-as-package.md)
- **Date:** 2026-08-09

## Context

The updater tab should render the installer's card design without shipping UI markup inside
`utils.zip`. The first attempt hosted the page: a privileged shell tab (`scriptsUpdater.xhtml`) with
a bare iframe navigated to a published `REMOTE_UI_URL`, the client talking to the engine over
`postMessage` (`283a27b`, 2026-08-09). Fetching the page straight into the iframe hit host quirks —
jsDelivr serves `.html` as `text/plain` + `nosniff` and raw.githubusercontent sends
`X-Frame-Options: deny` — so the next iteration fetched the page as text and injected it into the
iframe as a `data:` document (`38ab7aa`, 2026-08-10), later as direct iframe navigation (`80ef442`).

## Decision

Host the updater tab UI as a remote stateless page (GitHub Pages in prod, `dev-build-<id>` in dev)
fetched by the privileged shell and rendered in an iframe, with a `postMessage` bridge carrying
state/commands and the session token.

## Consequences

The UI could be updated without shipping it, and `utils.zip` stayed small. But the bridge needed
frame-identity and token validation, the hosts imposed nosniff / X-Frame-Options workarounds, and
Firefox 155 hardened frame-principal inheritance in system-principal chrome documents, breaking
srcdoc/data:/blob: frames entirely. Superseded by [0007](./0007-updater-ui-ships-as-package.md)
(2026-08-11). Revisit-if: Firefox restores frame embedding of external content in chrome documents.
