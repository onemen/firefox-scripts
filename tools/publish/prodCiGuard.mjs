// prodCiGuard.mjs — prod publishes run only inside CI (ADR 0026).
//
// A prod publish is correct only when the complete cross-OS installer set
// (4 installers + helpers, ADR 0024) is present — and that set is buildable
// only by the Pages publish workflow's per-OS matrix (or a future per-OS
// build vehicle, issue #33). A local machine can produce at most its own
// OS's binaries, so a local prod run is a mistake the user must not discover
// on the release page after the fact.
//
//   prod + real upload + not invoked by the Pages workflow → ABORT before
//   building, with the pointer to the workflow_dispatch. The `--ci` flag is
//   NOT an escape hatch: it only widens the platform set, so `--ci` from a
//   laptop would still publish a release missing the other OSes. The guard
//   accepts only IS_CI — the internal `FXS_INTERNAL_CI=1` that pages.yml
//   sets on every upload job; no other entry point may set it (a local
//   `FXS_INTERNAL_CI=1 node …` bypasses the guard only by forging the
//   workflow's own contract, which is out of scope). `--local` snapshots
//   are exempt (offline validation, touches no GitHub target). The
//   detection is workflow-agnostic: any future publish vehicle passes the
//   same internal marker (issue #33).
//
// Dev/test publishes are exempt: they are disposable by design (ADR 0026)
// and a developer legitimately publishes a dev build from one machine.

import {error} from './log.mjs';

/**
 * The internal marker pages.yml sets on every upload job (never documented as a
 * user-facing flag — see the module comment).
 */
export const CI_MARKER = 'FXS_INTERNAL_CI=1';

/**
 * @param {{mode: string; local: boolean; isCi: boolean}} p isCi is true only
 *   when the env marker CI_MARKER is set (workflow runs).
 * @returns {{aborted: boolean}} for tests; runProdCiGuard itself exits via a
 *   thrown error (fail-fast, same as runStagingGuard).
 */
export function runProdCiGuard({mode, local, isCi}) {
  if (mode !== 'prod' || local || isCi) return {aborted: false};
  error(
    'Prod publishes are CI-only (ADR 0026): a local machine can build only its own ' +
      "OS's binaries, but the `latest` release must always carry the complete " +
      'cross-OS set (all installers + helpers, ADR 0024). The --ci flag does not ' +
      'change this — it only widens the platform set and still yields a partial ' +
      'release from a laptop.\n' +
      '  → Dispatch the Pages publish workflow instead:\n' +
      '      gh workflow run pages.yml -f mode=prod\n' +
      '    (or use --local for an offline validation snapshot, which publishes nothing).'
  );
  throw new Error(
    'Prod publish aborted: not a CI run — use the Pages publish workflow (gh workflow run pages.yml -f mode=prod) or --local.'
  );
}

/**
 * True when this upload.mjs process was started by the Pages publish workflow
 * (marker env set) — the only real-upload prod entry point the guard admits.
 *
 * @param {NodeJS.ProcessEnv} env
 */
export function isWorkflowRun(env = process.env) {
  return env.FXS_INTERNAL_CI === '1';
}
