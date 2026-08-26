# 0006: Updater tab UI hosted as a remote page

- **Status:** superseded by [0007](./0007-updater-ui-ships-as-package.md)
- **Date:** 2026-08-09

## Context

The updater tab should render the installer's card design without shipping UI markup inside
`utils.zip`. The first attempt hosted the page: a privileged shell tab (`scriptsUpdater.xhtml`) with
an iframe navigated to a published `REMOTE_UI_URL` (GitHub Pages), the client talking to the engine
over `postMessage` (`283a27b`, 2026-08-09). Direct framing hit host quirks — jsDelivr serves `.html`
as `text/plain` + `nosniff` and raw.githubusercontent sends `X-Frame-Options: deny` — so the next
iteration fetched the page as text and injected it into the iframe as a `data:` document (`38ab7aa`,
2026-08-10). A parallel branch later experimented with direct iframe navigation plus a 404 fail-fast
probe (`9fcca69` / `80ef442`, 2026-08-18). Firefox 155 then hardened frame-principal inheritance in
system-principal chrome documents, breaking srcdoc/data:/blob: frames entirely — the remote approach
could not survive it.

## Decision

Host the updater tab UI as a remote stateless page (GitHub Pages in prod, `dev-build-<id>` in dev)
fetched by the privileged shell and rendered in an iframe, with a `postMessage` bridge carrying
state/commands and the session token.

## Consequences

The UI could be updated without shipping it, and `utils.zip` stayed small. But the bridge needed
frame-identity and token validation, the hosts imposed nosniff / X-Frame-Options workarounds, and
Firefox 155's frame-principal hardening made the approach untenable. Superseded by
[0007](./0007-updater-ui-ships-as-package.md): the mainline branch abandoned remote hosting for a
shipped package on 2026-08-11 (`da24dc0`), and the parallel remote-UI branch converged on the same
approach (`83fefd6`, 2026-08-19). Revisit-if: Firefox restores frame embedding of external content
in chrome documents.
