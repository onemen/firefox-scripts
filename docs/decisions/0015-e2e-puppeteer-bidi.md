# 0015: E2E tests use Puppeteer-core + WebDriver BiDi

- **Status:** accepted
- **Date:** 2026-08-21

## Context

The E2E matrix must run against the user's actual Firefox-family browsers (Firefox
stable/Nightly/Developer Edition, Waterfox, Zen, LibreWolf, Floorp). Playwright pins specific
Firefox revisions and cannot attach to arbitrary installed builds; Marionette, the older protocol,
is deprecated in Firefox 135+ and scheduled for removal.

## Decision

The E2E harness drives browsers with **puppeteer-core over WebDriver BiDi** (geckodriver), attaching
to whatever Firefox-family build is installed on the machine — including forked builds with no
stable CI download URL. Firefox stable × 3 OSes plus Developer Edition on Windows are hard gates;
fork legs run as advisory (`continue-on-error`) until stable download URLs exist (plan `9024339`;
hard gates `dd2c3b1` / `db217ef`, 2026-08-24).

## Consequences

Tests exercise exactly what users run, and new fork browsers join the matrix without toolchain
changes. The harness must download and launch real browsers in CI and clean up fresh temp profiles
per run. Revisit-if: Playwright adds support for arbitrary Firefox builds, or Marionette's removal
changes the protocol math.
