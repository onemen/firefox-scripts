#!/usr/bin/env node

/**
 * syncGeneratedFiles.mjs — regenerate the generated files from their sources.
 * The files are NOT tracked (gitignored): they are produced on demand whenever
 * something needs them — the installer Makefile regenerates _config.h (+
 * resources.h via embed.mjs) on every build, createZip.mjs regenerates
 * updater-config.sys.mjs and updater.css at publish time, and this module is
 * the shared generator for all of them.
 *
 * Usage: node tools/publish/syncGeneratedFiles.mjs # write changed files node
 * tools/publish/syncGeneratedFiles.mjs --touch # also stamp _config.h's mtime
 * (installer Makefile)
 *
 * The generated files and their sources:
 * core/chrome/utils/updater/updater-config.sys.mjs <- config/installer.conf (+
 * dev-mode overrides) installer/src/_config.h <- config/installer.conf (same
 * transform; the installer Makefile calls this module with MODE=dev for dev
 * builds) installer/src/resources.h <- installer/web/* (embed.mjs)
 *
 * The updater tab stylesheet (tools/publish/remote-ui/updater.css) is NOT
 * tracked either: it is the concatenation of installer/web/style.css +
 * tools/publish/updater.css (buildRemoteUiCss below). createZip.mjs writes it
 * to disk at publish time so it ships inside updater-ui.zip (and is added back
 * to the zip/hash explicitly, like updater-config.sys.mjs).
 *
 * When run with --mode=dev (e.g. `node tools/publish/syncGeneratedFiles.mjs
 * --mode=dev`), the URL/name keys are rewritten for the dev-build-<id>
 * namespace.
 */

import {execFileSync} from 'child_process';
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
import {GENERATED_FILES, generatedPath} from './generatedRegistry.mjs';
import {
  effectiveConfig as effectiveUpdaterConfig,
  generateModule as generateUpdaterConfig,
  readConfig as readUpdaterConfig,
} from './generateUpdaterConfig.mjs';
import {DEV_BRANCH, LOCAL, MODE, localSnapshotDir} from './publishMode.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..', '..');

/**
 * Byte-identical transform of the C side's former installer/gen-config.awk
 * (removed — the Makefile now calls this module): each `KEY=VALUE` line of
 * config/installer.conf becomes `#define CFG_KEY "VALUE"`, with ${VAR}
 * references in a value expanded against keys defined earlier (e.g.
 * ZIP_BASE_URL references RELEASE_NAME), and wrapped in the same boilerplate.
 * `.*` in sed captures a trailing CR on CRLF files; JS `(.*)$` behaves the same
 * way, so CRLF is normalized to LF first (below).
 */
function configHeader(confText) {
  // Normalize CRLF → LF so a Windows-edited installer.conf cannot bake a
  // trailing `\r` into the generated `#define` values.
  confText = confText.replace(/\r\n/g, '\n');
  const out = [
    '// Auto-generated from config/installer.conf. Do not edit.',
    '#ifndef BUILD_CONFIG_H',
    '#define BUILD_CONFIG_H',
    '',
  ];
  // Mode-aware: dev mode rewrites the URL/name keys (jsDelivr base,
  // dev-build tag, ASSET_SUFFIX '-dev') via the same overrides the
  // updater-config generator uses — the C installer must bake the SAME dev
  // URLs as the JS engine, or installs would mix namespaces.
  const vars = {};
  for (const line of confText.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z_]*)=(.*)$/);
    if (!m) continue;
    vars[m[1]] = m[2].replace(/\$\{([A-Z_]+)\}/g, (_, name) => vars[name] ?? '');
  }
  // The C installer keeps localhost URLs in local mode (its tab is HTTP-served
  // and fetches from the installer's own server), unlike the in-browser
  // updater which reads the snapshot via file:// URLs.
  const eff = effectiveUpdaterConfig(vars, {installer: true});
  const orderedKeys = Object.keys(vars);
  for (const key of orderedKeys) {
    out.push(`#define CFG_${key} "${eff[key] ?? ''}"`);
  }
  // Local-test builds (upload:local) serve published files from the installer's
  // own directory and bake localhost URLs; the numeric flag lets the C code
  // enable that server fallback at compile time.  CFG_DEV / CFG_LOCAL_DIST_PATH
  // / CFG_DEV_BRANCH feed the web UI's "test build" banner (via
  // /api/build-info): a --local or --mode=dev build says so up front.
  const localDistPath = LOCAL ? localSnapshotDir().replace(/\\/g, '/') : '';
  out.push(
    '',
    `#define CFG_LOCAL ${LOCAL ? 1 : 0}`,
    `#define CFG_DEV ${MODE === 'dev' ? 1 : 0}`,
    `#define CFG_LOCAL_DIST_PATH "${localDistPath}"`,
    `#define CFG_DEV_BRANCH "${DEV_BRANCH}"`,
    '',
    '#endif /* BUILD_CONFIG_H */'
  );
  return out.join('\n') + '\n';
}

/** Concatenated updater tab stylesheet (design system + updater-only tail). */
export function buildRemoteUiCss() {
  const designCss = path.join(ROOT, 'installer', 'web', 'style.css');
  const tailCss = path.join(ROOT, 'tools', 'publish', 'updater.css');
  return (
    fs.readFileSync(designCss, 'utf-8').replace(/\n+$/, '') +
    '\n\n' +
    fs.readFileSync(tailCss, 'utf-8')
  );
}

// The generated-file list is owned by generatedRegistry.mjs (the same list the
// publish hashes consult); only the generators live here. A new generated file
// is added ONCE, in the registry, and every consumer (regeneration, clean, zip
// re-add, hash extraFiles, scan excludes) follows — ADR 0008's trap is closed
// mechanically by test/unit/generatedRegistry.test.mjs.
const GENERATORS = {
  'core/chrome/utils/updater/updater-config.sys.mjs': () =>
    generateUpdaterConfig(readUpdaterConfig()),
  'installer/src/_config.h': () =>
    configHeader(fs.readFileSync(path.join(ROOT, 'config', 'installer.conf'), 'utf-8')),
  'installer/src/resources.h': () => {
    // Node version of embed.py — byte-identical output, no Python needed.
    return execFileSync('node', [path.join(ROOT, 'installer', 'embed.mjs'), '--stdout'], {
      encoding: 'utf-8',
      maxBuffer: 16 * 1024 * 1024,
    });
  },
};
const GENERATED = GENERATED_FILES.filter(f => f.rel in GENERATORS).map(f => ({
  rel: f.rel,
  generate: GENERATORS[f.rel],
}));

// Gitignored updater-tab stylesheet — written to disk by createZip.mjs at
// publish time so it ships inside updater-ui.zip.  Never tracked or committed:
// it is regenerated on demand from the shared design system + updater tail.
// Also registry-driven (the one PREVIEW member). Fail fast at load: every
// registry file must have exactly one generator (GENERATORS above, or the
// PREVIEW one below) — a future registry entry without one must surface as a
// clear load-time error, not a TypeError inside regenerate() (ai-review
// finding on this PR).
const PREVIEW = GENERATED_FILES.filter(f => !(f.rel in GENERATORS)).map(f => {
  if (f.rel !== 'tools/publish/remote-ui/updater.css') {
    throw new Error(
      `syncGeneratedFiles.mjs: registry file '${f.rel}' has no generator — add it to GENERATORS ` +
        `here (or teach PREVIEW how to build it)`
    );
  }
  return {rel: f.rel, generate: buildRemoteUiCss};
});

/** Absolute path of a generated file. Re-exported from generatedRegistry.mjs. */
export {generatedPath};

/**
 * Remove the generated files (and the gitignored updater css) from disk.
 * Post-publish cleanup: upload.mjs calls this in its `finally`, so the working
 * tree always ends up matching a fresh clone — no mode-baked files (localhost /
 * dev URLs) are left behind. All of them are regenerated on demand by the
 * installer Makefile / createZip.mjs, so removing them is always safe.
 */
export function cleanGenerated() {
  for (const g of [...GENERATED, ...PREVIEW]) {
    fs.rmSync(generatedPath(g.rel), {force: true});
  }
}

/** Regenerate any stale file; returns the list of files that changed. */
export function regenerate() {
  const changed = [];
  for (const g of [...GENERATED, ...PREVIEW]) {
    const p = generatedPath(g.rel);
    const current = fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null;
    const fresh = g.generate();
    if (current !== fresh) {
      fs.mkdirSync(path.dirname(p), {recursive: true});
      fs.writeFileSync(p, fresh);
      changed.push(g.rel);
    }
  }
  return changed;
}

const isMainModule =
  process.argv[1] === __filename || process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  const changed = regenerate();
  if (changed.length > 0) {
    for (const c of changed) console.log(`✓ Regenerated ${c}`);
  } else {
    console.log('✓ All generated files are in sync');
  }
  // --touch (used by installer/Makefile): bump _config.h's mtime so make
  // always relinks the installer binary with the current MODE, even when the
  // content is unchanged (e.g. a prod→prod rebuild).  The Makefile can't use
  // `touch $@` — neither touch(1) nor $@ shell expansion exists when make
  // runs its recipes under cmd.exe — and inline `node -e "..."` scripts are
  // mangled by cmd's quote handling, so the stamp lives here in node instead.
  if (process.argv.includes('--touch')) {
    const stamp = generatedPath('installer/src/_config.h');
    const now = new Date();
    fs.utimesSync(stamp, now, now);
  }
}
