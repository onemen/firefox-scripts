# 0030: Partial publishes — publish only the named artifact roles (the AV holdback)

- **Status:** accepted
- **Date:** 2026-09-17
- **Amends:** [0024](./0024-release-asset-set.md) — its "the `latest` release carries exactly …"
  asset set now has a declared exception: a run may publish a subset when a role is deliberately
  held back

## Context

The Windows binaries are unsigned, stripped MinGW PEs whose AV verdict is effectively per-hash
(issue [#157](https://github.com/onemen/firefox-scripts/issues/157)): the same source rebuilt with a
different toolchain package set can land in Microsoft's `!ml` detection pocket, while the package
zips — plain JS/text, hashed the same way — never do. The publish gate (host AV + the VirusTotal
veto) correctly refuses to ship a flagged binary, but until now that refusal froze **every**
artifact in the run: the zips carry the script updates installed browsers consume (and their
`hashes.json` entries), so one flagged `installer_win.exe` also stopped script delivery. The
alternatives were worse — publish the flagged binary and hand users a Defender popup, or publish
nothing at all.

## Decision

`tools/publish/upload.mjs` requires `--include=packages|installer|helper` (repeatable or
comma-separated, or `all` for the full set), and the CI dispatches (`pages.yml`,
`build-and-upload.yml`) take the same list in an `include` input. The scope is opt-in and validated:
a missing, empty or unknown role fails the run loudly instead of guessing — there is no implicit
default. A role left out is **not built, not hashed, not scanned and not uploaded**, and its
`hashes.json` entry stays frozen at the last published value: the manifest keeps describing what is
actually on the branch, so no installed copy is ever pointed at bytes that were never published (a
bumped hash with no uploaded artifact would strand the installer/updater in a permanent "update
available" that can never converge). The run prints a PARTIAL PUBLISH banner naming the held-back
roles, and the AV/VT gates report that they had nothing in scope — every gate still covers exactly
the bytes that ship. The roles are independent: withholding the installer can still ship a clean
helper, which is what the in-browser updater needs for elevated copies to admin-protected install
dirs.

## Consequences

Script delivery survives an AV holdback, and the withheld binary keeps serving its last published
(accepted) bytes instead of regressing to nothing. A held-back role also skips its rebuild, so
whenever its sources really did change the frozen entry stays stale until the next full publish of
that role — exactly one revision when the very next run is full, longer under repeated holdbacks of
the same role (the withheld state is self-healing, and an idle "nothing to rebuild" verdict
correctly means the published binary already matches the sources). One shape needs care: an
installer/helper-only dev publish that _creates_ its dev-build branch births the manifest without
the zips it names (permanent "update available" + zip 404s on that branch). The tooling probes
whether the branch exists and warns loudly before building — prefer holding packages back only in
prod, or on an existing dev branch whose zips keep serving. Partial publishes are deliberate,
operator-initiated acts — prod stays CI-only, the workflow input is explicit, and the log says
PARTIAL — and the flag exists for the case where a flag is a false positive the maintainer has
decided to route around; WDSI per-hash submissions and SignPath code signing remain the durable
fixes. Revisit-if: signing lands and rebuild verdicts stop being a lottery — then this escape hatch
can be retired.
