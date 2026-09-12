// prodCiGuard.mjs — prod publishes run only inside CI (ADR 0026).
//
// A real (non-`--local`) `--mode=prod` run from a developer machine publishes
// an incomplete release: only the current OS's binaries exist locally, while
// the release contract (ADR 0024) is the full cross-OS set — 4 installers +
// helpers. The complete set is buildable only by the Pages publish workflow
// (or a future per-OS build matrix, issue #33), so any other prod run is a
// mistake the user must not discover on the release page after the fact.
//
//   prod + real upload + not invoked by CI → ABORT before building, with the
//   pointer to the workflow_dispatch. `--local` snapshots are exempt (offline
//   validation, touches no GitHub target). The detection is
//   workflow-agnostic: a run is "in CI" when the Pages workflow (or any future
//   publish vehicle, #33) passes --ci — upload.mjs's explicit flag, never
//   ambient CI env vars, which local shells often export.
//
// Dev/test publishes are exempt: they are disposable by design (ADR 0026) and
// a developer legitimately publishes a dev build from one machine.

import {error} from './log.mjs';

/**
 * @param {{mode: string; local: boolean; isCi: boolean}} p
 * @returns {{aborted: boolean}} for tests; runProdCiGuard itself exits via a
 *   thrown error (fail-fast, same as runStagingGuard).
 */
export function runProdCiGuard({mode, local, isCi}) {
  if (mode !== 'prod' || local || isCi) return {aborted: false};
  error(
    'Prod publishes are CI-only (ADR 0026): a local machine can build only its own ' +
      "OS's binaries, but the `latest` release must always carry the complete " +
      'cross-OS set (all installers + helpers, ADR 0024).\n' +
      '  → Dispatch the Pages publish workflow instead:\n' +
      '      gh workflow run pages.yml -f mode=prod\n' +
      '    (or use --local for an offline validation snapshot, which publishes nothing).'
  );
  throw new Error(
    'Prod publish aborted: not a CI run — use the Pages publish workflow (gh workflow run pages.yml -f mode=prod) or --local.'
  );
}
