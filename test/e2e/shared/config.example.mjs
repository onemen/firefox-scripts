/**
 * Local E2E configuration — copy this file to `e2e.config.mjs` at the repo root
 * (gitignored) and adjust. All keys are optional; CLI flags win over
 * environment variables, which win over this file, which wins over
 * auto-detection.
 *
 * Example: export default { browsers: [ {name: 'firefox', binary: 'C:\Program
 * Files\Mozilla Firefox\firefox.exe'}, {name: 'waterfox', binary: 'C:\Program
 * Files\Waterfox\waterfox.exe'}, ], };
 */
export default {
  /**
   * Updater E2E: which browsers to test (name is only for output; `binary` can
   * be omitted to auto-detect that browser type).
   */
  browsers: [{name: 'firefox', binary: ''}],

  /**
   * Installer E2E: browsers to LAUNCH with fresh temp profiles before the
   * installer starts, so its browser detection finds them. One card is rendered
   * per unique binary; pass two different binaries to test the multi-card UI.
   * Same shape as `browsers`.
   */
  installerBrowsers: [{name: 'firefox', binary: ''}],

  /**
   * Snapshot policy:
   *
   * - 'strict' (default): the newest dist/dev-* snapshot must match the current
   *   git branch + HEAD short sha (i.e. it was built by `pnpm upload:local
   *   --mode=dev` on this branch/commit), otherwise the run fails with a hint.
   * - 'off': use the newest snapshot regardless of branch.
   */
  branchCheck: 'strict',

  /** Absolute path to a snapshot dir; overrides branchCheck entirely. */
  snapshotDir: '',

  /** Launch Firefox headless (Linux CI uses xvfb instead; local ok). */
  headless: false,

  /** Keep temp profiles after a run for debugging (default: delete). */
  keepProfile: false,

  /** Installer binary override (else auto-detected from the snapshot). */
  installerBin: '',

  /** Tune timeouts if a machine is slow. */
  timeouts: {
    updaterTabMs: 90_000,
    renderMs: 60_000,
    installMs: 120_000,
  },
};
