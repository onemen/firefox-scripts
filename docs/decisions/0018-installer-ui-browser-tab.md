# 0018: Installer UI stays an embedded browser tab (no desktop app)

- **Status:** accepted
- **Date:** 2026-08-27

## Context

The installer serves an embedded web UI over `http://127.0.0.1:8777` and opens it in the detected
browser's tab. A recurring proposal is to render that UI as a native desktop application instead.
The tab model exists because of earlier decisions: the C binary performs **zero network I/O** — the
tab fetches every payload from CORS-enabled hosts and POSTs the bytes back
([0005](./0005-installer-zero-network-io.md)) — and the local API is gated by a per-run session
token ([0010](./0010-session-token-no-cors.md)). The tab also shares its stylesheet with the updater
tab (`updater.css` is generated from `installer/web/style.css` at publish time, [0008]).

## Decision

The installer UI remains an **embedded browser tab** served by the C binary's local HTTP server. We
will not build a native desktop / webview app.

## Consequences

One HTML/JS/CSS UI works on every OS; a desktop app would need three native stacks or three webview
embeddings (WebView2, webkit2gtk, WKWebView), each with its own build, packaging and runtime
dependencies — more code and a larger test matrix, not less. It also preserves the security posture
of [0005]: C stays a small static binary with no HTTP client / TLS / JSON parser, whereas a webview
shell would reintroduce a network-capable runtime and the CORS-equivalent trust decisions that 0005
deliberately avoided. Testability stays with the existing harness: the tab is driven by the
Puppeteer-BiDi installer E2E ([#36](https://github.com/onemen/firefox-scripts/issues/36)), while
native/webview shells are notoriously hard to automate cross-platform. Costs that remain: the UI
depends on a running browser, must survive the restart flow
([0014](./0014-restart-session-restore.md)), and stale-tab handling on the fixed port stays in
scope. Revisit-if: an embeddable sandboxed webview becomes a dependency-free standard on all three
OSes, or the installer must work with no browser installed.
