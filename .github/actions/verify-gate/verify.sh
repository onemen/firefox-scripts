#!/usr/bin/env bash
# Shared gate engine for ci-gate / e2e-gate (see action.yml for the inputs).
# Run by the composite action; never invoke directly.
set -euo pipefail

# Optional inputs — the composite action always passes them (defaults ''),
# but default them here so the script also runs safely outside Actions.
: "${REQUIRED:=}" "${ADVISORY:=}" "${SKIP_GUARD:=}" "${ALWAYS_REPORT:=}" "${ALWAYS_VERIFY:=}"

fail() { echo "::error::$1: $2"; exit 1; }
ok()   { echo "$1: $2 (OK)"; }
verify() { case "$2" in success) ok "$1" "$2" ;; *) fail "$1" "$2" ;; esac; }

# name:result lookup table (missing = the job never existed).
declare -A RESULT
for spec in $RESULTS; do
  RESULT["${spec%%:*}"]="${spec#*:}"
done
lookup() { echo "${RESULT[$1]:-missing}"; }

verify 'changes' "$CHANGES_RESULT"
# Always-run jobs (e.g. the lint/format `checks`) are verified in BOTH
# branches — a failure must not slip through when the gated branch is off.
for name in $ALWAYS_VERIFY; do
  verify "$name" "$(lookup "$name")"
done

if [ "$BRANCH" = "true" ]; then
  for name in $REQUIRED; do
    verify "$name" "$(lookup "$name")"
  done
  # Advisory jobs warn instead of failing the gate (fork-browser legs).
  for name in $ADVISORY; do
    r="$(lookup "$name")"
    case "$r" in
      success) ok "$name" "$r" ;;
      *) echo "::warning::$name $r (advisory)" ;;
    esac
  done
  echo "All gated jobs verified ($BRANCH_LABEL present)"
else
  echo "gated jobs skipped — no $BRANCH_LABEL (OK)"
  # Guard: a gated job that ran despite no relevant changes lost its
  # changed-paths `if:` — fail loudly instead of silently burning
  # runner-minutes on every docs-only PR again.
  for name in $SKIP_GUARD; do
    r="$(lookup "$name")"
    if [ "$r" != "skipped" ]; then
      echo "::error::$name ran despite no $BRANCH_LABEL (result: $r) — changed-paths gate removed?"
      exit 1
    fi
  done
  # Guard: an always-report job (the publish gate) that did not report success
  # gained a job-level `if:` — the required check would go missing and block
  # strict branch protection. Fail loudly if that design is undone.
  for name in $ALWAYS_REPORT; do
    r="$(lookup "$name")"
    if [ "$r" != "success" ]; then
      echo "::error::$name did not report success despite no $BRANCH_LABEL (result: $r) — always-report design undone?"
      exit 1
    fi
  done
  echo 'skipped / always-report checks OK'
fi
