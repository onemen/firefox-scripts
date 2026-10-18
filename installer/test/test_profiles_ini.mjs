#!/usr/bin/env node

/**
 * test_profiles_ini.mjs: pins the profiles.ini path resolution the browser
 * detection loops use, driven through the installer's hidden
 * `--test-profiles-ini <base-dir>` CLI mode.
 *
 * Issue #555: both Windows detection paths built every candidate as
 * `<profiles.ini dir>\<Path=>`, never reading `IsRelative=`, so a portable
 * install's absolute profile path collapsed into a `...\Mozilla\Firefox\E:\...`
 * string that is not a directory: the profile showed "(not detected)", the
 * installer tab opened in the default browser, and with two instances running
 * the round-robin handed a card another install's profile.
 *
 * The walker cannot be unit-tested without a locked profile, so the fixture
 * only pins path resolution: absolute (IsRelative=0) versus relative joins, a
 * default relative join when the section has no IsRelative key, section-
 * buffered key order, and an [Install...] section being ignored (Firefox
 * records only Default= and Locked= there; neither is a profile path). The lock
 * and compatibility.ini filtering on top of those paths is exercised by the
 * detection code and the installer E2E.
 *
 * Runs as part of `pnpm test:hash` (needs a built binary, exactly like
 * test_hash.mjs).
 *
 * Exit code: 0 if all checks pass, 1 if any fail.
 */

import {execFileSync} from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {fileURLToPath} from 'url';

// paths.js/publishMode.mjs call requireMode() at import time, same
// arrangement as test_self_update.mjs. Import-time only; nothing here
// publishes, and the spawned installer gets its own argv.
process.argv.push('--mode=prod');

const {requireFreshSnapshot} = await import('./snapshotProvenance.mjs');

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Newest prod- or dev- snapshot dir (the installer binary lives there). */
function findSnapshot() {
  const distRoot = path.join(REPO_ROOT, 'dist');
  if (!fs.existsSync(distRoot)) return null;
  let best = null;
  let bestMtime = 0;
  for (const entry of fs.readdirSync(distRoot, {withFileTypes: true})) {
    if (!entry.isDirectory() || !/^(prod|dev)-/.test(entry.name)) continue;
    const mtime = fs.statSync(path.join(distRoot, entry.name)).mtimeMs;
    if (mtime > bestMtime) {
      bestMtime = mtime;
      best = entry.name;
    }
  }
  return best ? path.join(distRoot, best) : null;
}

function getInstallerPath(snapshotDir) {
  const ext = process.platform === 'win32' ? '.exe' : '';
  let name;
  if (process.platform === 'win32') name = 'installer_win';
  else if (process.platform === 'darwin') name = 'installer_mac';
  else name = process.arch === 'arm64' ? 'installer_linux_aarch64' : 'installer_linux';
  const plain = path.join(snapshotDir, `${name}${ext}`);
  if (fs.existsSync(plain)) return plain;
  const dev = path.join(snapshotDir, `${name}-dev${ext}`);
  if (fs.existsSync(dev)) return dev;
  return null;
}

/** Run --test-profiles-ini; returns {paths, status, stderr}. */
function runProfilesIni(installer, baseDir) {
  try {
    // Windows (msvcrt/mingw) text mode converts \n to \r\n on stdout.
    const out = execFileSync(installer, ['--test-profiles-ini', baseDir], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return {paths: out.replace(/\r/g, '').split('\n').filter(Boolean), status: 0, stderr: ''};
  } catch (err) {
    return {
      paths: [],
      status: err.status ?? 1,
      stderr: String(err.stderr ?? ''),
    };
  }
}

function main() {
  const snapshotDir = findSnapshot();
  if (!snapshotDir) {
    console.error('No snapshot found. Run `pnpm snapshot:dev` first.');
    process.exit(1);
  }
  const installer = getInstallerPath(snapshotDir);
  if (!installer) {
    console.error(`Installer binary not found in ${snapshotDir}`);
    process.exit(1);
  }

  // ── staleness guard (shared helper) ──────────────────────────────────────
  requireFreshSnapshot({snapshotDir});

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fxs-profiles-ini-'));
  let failures = 0;
  const check = (name, cond, detail = '') => {
    if (cond) {
      console.log(`  ✓ ${name}`);
    } else {
      failures++;
      console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
    }
  };

  // The absolute fixture path mirrors the #555 repro entry (a profile on
  // another drive, registered with IsRelative=0). On POSIX an absolute path
  // never needs a drive, so keep it native there.
  const absProfile =
    process.platform === 'win32' ? 'E:\\x2wg22ar.test_scripts' : '/opt/firefox-portable';
  // Firefox writes forward slashes in profiles.ini on every platform; the
  // C side normalizes them to the platform separator when joining.
  const relativeJoined = path.join(tmpDir, 'Profiles', 'aaa.default-release');
  const devJoined = path.join(tmpDir, 'Profiles', 'bbb.dev-edition');

  const ini = [
    '[General]',
    'StartWithLastProfile=1',
    '',
    '[Profile0]',
    'Name=default-release',
    'IsRelative=1',
    'Path=Profiles/aaa.default-release',
    '',
    '[Profile1]',
    'Name=test_scripts',
    // Path before IsRelative on purpose: real files order it the other way,
    // and a line-streaming parser that resolves on sight breaks here.
    `Path=${absProfile}`,
    'IsRelative=0',
    '',
    '[Profile2]',
    'Name=dev-edition-default',
    // No IsRelative key: Firefox omits it for relative entries, so the path
    // must still join onto the profiles.ini directory.
    'Path=Profiles/bbb.dev-edition',
    '',
    // Firefox records the default profile per install with Default= (a path)
    // and Locked=, never Path=; a parser that reads any *path* key would emit
    // a second, colliding entry for the default profile here.
    '[Install9C7F3C4ED82D4C5A9B0C]',
    'Default=Profiles/aaa.default-release',
    'Locked=1',
    '',
  ].join('\r\n');
  fs.writeFileSync(path.join(tmpDir, 'profiles.ini'), ini);

  const {paths, status, stderr} = runProfilesIni(installer, tmpDir);

  check('installer exits 0', status === 0, `status=${status} stderr=${stderr.trim()}`);
  check(
    'IsRelative=1 joins onto the profiles.ini directory',
    paths[0] === relativeJoined,
    `got=${paths[0]} want=${relativeJoined}`
  );
  check(
    'IsRelative=0 keeps the absolute path verbatim (#555 repro)',
    paths[1] === absProfile,
    `got=${paths[1]} want=${absProfile}`
  );
  check(
    'a section without IsRelative joins onto the profiles.ini directory',
    paths[2] === devJoined,
    `got=${paths[2]} want=${devJoined}`
  );
  check(
    'an [Install...] Default= is not a profile path and is ignored',
    !paths.includes(relativeJoined, 1) && paths.length === 3,
    `got ${paths.length} paths: ${paths.join(', ')}`
  );

  // Missing ini: fail with the documented exit code instead of a bare 0
  // (an empty result would read as "no profiles, detection is fine").
  const missing = runProfilesIni(installer, path.join(tmpDir, 'does-not-exist'));
  check(
    'a missing profiles.ini exits 2',
    missing.status === 2,
    `status=${missing.status} stderr=${missing.stderr.trim()}`
  );

  // A Path= longer than the line buffer is dropped, not resolved truncated: a
  // cut value names a directory that does not exist, and its tail must not be
  // parsed as a fresh key either. The section after it still resolves.
  const longDir = path.join(tmpDir, 'long');
  fs.mkdirSync(longDir, {recursive: true});
  fs.writeFileSync(
    path.join(longDir, 'profiles.ini'),
    [
      '[Profile0]',
      'Name=long',
      `Path=Profiles/${'a'.repeat(600)}`,
      '',
      '[Profile1]',
      'Name=after',
      'Path=Profiles/ccc.dev-edition',
      '',
    ].join('\r\n')
  );
  const longResult = runProfilesIni(installer, longDir);
  const afterLong = path.join(longDir, 'Profiles', 'ccc.dev-edition');
  check(
    'an over-long Path= is dropped and the next section still resolves',
    longResult.paths.length === 1 && longResult.paths[0] === afterLong,
    `got ${longResult.paths.length} paths: ${longResult.paths.join(', ')}`
  );

  fs.rmSync(tmpDir, {recursive: true, force: true});

  if (failures > 0) {
    console.error(`\n${failures} profiles.ini check(s) failed`);
    process.exit(1);
  }
  console.log('\n✓ all profiles.ini checks passed');
}

main();
