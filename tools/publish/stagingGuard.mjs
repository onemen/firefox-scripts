// stagingGuard.mjs — prod-publish safety guard for env-overridden targets (#33).
//
// paths.js gives environment variables precedence over config/installer.conf
// (env-over-conf), so a stray `REPO_OWNER=...` / `HASHES_URL=...` in the shell
// or CI environment silently redirects a prod publish to an unintended release,
// Pages branch, or manifest host. This guard makes that loud instead of silent:
//
//   prod → ABORT with a STAGING banner before anything is built or uploaded.
//          Escape hatch for an intentional staging rehearsal:
//          FIREFOX_SCRIPTS_ALLOW_STAGING=1 prints the banner and continues.
//   dev  → warn-only for repo-identity overrides (dev artifacts are disposable
//          and normally live in the dev-build-<id> namespace anyway).
//   --local → never runs: an offline snapshot touches no GitHub target.
//
// The baseline for "unintended" is config/installer.conf itself (single source
// of truth, ADR 0013): an env var whose value equals the conf value is still
// reported — publishing must not depend on ambient shell state.

import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
import {error, info, warn, yellow} from './log.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONF_PATH = path.resolve(__dirname, '..', '..', 'config', 'installer.conf');

/** Env vars that redirect a publish target when set. */
export const TARGET_KEYS = [
  'REPO_OWNER',
  'REPO_NAME',
  'RELEASE_NAME',
  'ZIP_PAGES_REPO',
  'ZIP_PAGES_BRANCH',
  'HASHES_URL',
  'ZIP_BASE_URL',
  'ZIP_PAGES_URL',
  'HELPER_BASE_URL',
  'UI_BASE_URL',
];

/** In dev mode only these matter: a redirect to somebody else's repository. */
const DEV_KEYS = ['REPO_OWNER', 'REPO_NAME', 'ZIP_PAGES_REPO'];

/** Escape hatch for intentional staging rehearsals (documented in .env-example). */
const ALLOW_STAGING_VAR = 'FIREFOX_SCRIPTS_ALLOW_STAGING';

/** Parse config/installer.conf (same tiny parser as paths.js) → {KEY: value}. */
export function readInstallerConf(confPath = CONF_PATH) {
  const conf = {};
  try {
    const text = fs.readFileSync(confPath, 'utf-8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
      const eq = trimmed.indexOf('=');
      conf[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
  } catch {
    // Missing conf: env-presence detection still works, just without a baseline.
  }
  return conf;
}

/**
 * Overrides present in `env` for the keys that matter in `mode`. Returns [{key,
 * value, conf}] — conf is the installer.conf baseline (or undefined when the
 * key is not in the conf).
 */
export function collectOverrides(env, mode, conf = readInstallerConf()) {
  const keys = mode === 'dev' ? DEV_KEYS : TARGET_KEYS;
  const overrides = [];
  for (const key of keys) {
    const value = env[key];
    if (value === undefined || value === '') continue;
    overrides.push({key, value, conf: conf[key]});
  }
  return overrides;
}

/** The loud multi-line banner text (also the thrown error message in prod). */
export function stagingBanner(overrides, {mode}) {
  const lines = [
    '============================================================',
    '  STAGING PUBLISH TARGET — env overrides are active',
    '============================================================',
    `Environment variables are redirecting this ${mode} publish:`,
    '',
  ];
  for (const {key, value, conf} of overrides) {
    const base = conf === undefined ? '(not in installer.conf)' : `installer.conf: ${conf}`;
    lines.push(`  ${key.padEnd(18)} = ${value}    [${base}]`);
  }
  lines.push(
    '',
    'Production targets come from config/installer.conf. Unset these',
    'variables unless this is an intentional staging rehearsal —',
    `or export ${ALLOW_STAGING_VAR}=1 to acknowledge and continue.`,
    '============================================================'
  );
  return lines.join('\n');
}

/**
 * Run the guard for a publish CLI (upload.mjs). Never runs for --local
 * snapshots. Throws in prod when target overrides are present and
 * FIREFOX_SCRIPTS_ALLOW_STAGING is not set; warns in dev.
 *
 * @returns {{overrides: Array; allowed: boolean}} what was found.
 */
export function runStagingGuard({mode, local = false, env = process.env} = {}) {
  if (local) return {overrides: [], allowed: false};
  const overrides = collectOverrides(env, mode);
  if (overrides.length === 0) return {overrides: [], allowed: false};

  const allowed = env[ALLOW_STAGING_VAR] === '1';
  const banner = stagingBanner(overrides, {mode});

  if (mode === 'dev') {
    warn(banner);
    warn(`${ALLOW_STAGING_VAR} is not needed in dev mode — artifacts go to the dev-build branch.`);
    return {overrides, allowed: true};
  }
  if (allowed) {
    info(yellow(`${banner}\n${ALLOW_STAGING_VAR}=1 — continuing this STAGING publish on purpose.`));
    return {overrides, allowed: true};
  }
  error(banner);
  throw new Error(
    'Prod publish aborted: environment variables override publish targets ' +
      `(see the STAGING banner above). Set ${ALLOW_STAGING_VAR}=1 to override.`
  );
}
