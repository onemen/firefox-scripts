#!/usr/bin/env node

/**
 * test_profile_argv.mjs: the profile-argument resolution the Windows browser
 * scan relies on (installer/src/detect_browser.c), driven through the hidden
 * `--test-profile-argv <base-dir> <cmdline>` CLI mode.
 *
 * Windows keeps browser profiles in `%APPDATA%\<vendor>\profiles.ini`, and a
 * shortcut can start a browser with either `--profile <dir>` (a directory) or
 * `-P <name>` (a profile NAME that only profiles.ini resolves). Only the first
 * was parsed, so a `-P <name>` launch matched no profile and the card fell back
 * to a round-robin guess over the locked profiles.
 *
 * The harness runs the same resolver (`resolve_profile_from_cmdline()`) the
 * scan's pass 2 calls, against a fixture profiles.ini: no running browser, no
 * locked profile, no Windows-only API. Runs as part of `pnpm test:installer`
 * (after the publish gate builds the installer binary, like test_hash.mjs).
 */

import {spawnSync} from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {fileURLToPath} from 'url';

// snapshotProvenance.mjs imports the publish tooling, which calls requireMode()
// at import time; same arrangement as test_hash.mjs / test_self_update.mjs.
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

/** The installer binary of the newest snapshot, verified fresh. */
function snapshotInstaller() {
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
  requireFreshSnapshot({snapshotDir});
  return installer;
}

/** Run --test-profile-argv; the resolved path is printed on success. */
function resolve(installer, baseDir, cmdline) {
  const res = spawnSync(installer, ['--test-profile-argv', baseDir, cmdline], {
    encoding: 'utf8',
  });
  return {
    status: res.status,
    out: (res.stdout || '').replace(/\r/g, '').trim(),
    err: res.stderr || '',
  };
}

function main() {
  // A plain `make -C installer` build (no snapshot) is enough for this loop:
  // point INSTALLER_TEST_BIN at it. The snapshot path is what CI uses.
  const installer = process.env.INSTALLER_TEST_BIN ?? snapshotInstaller();

  if (!fs.existsSync(installer)) {
    console.error(`Installer binary not found: ${installer}`);
    process.exit(1);
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fxs-profile-argv-'));
  const baseDir = path.join(tmpRoot, 'Firefox');
  fs.mkdirSync(baseDir);
  // Outside baseDir: an IsRelative=0 entry must be kept verbatim, not joined.
  const absoluteProfile = path.join(tmpRoot, 'portable-profile');

  // Section key order deliberately varies ([Profile1] lists IsRelative= before
  // Name=): Firefox writes IsRelative= before Path=, but nothing may depend on
  // the order inside a section.
  const ini = [
    '[General]',
    'StartWithLastProfile=1',
    'Version=2',
    '',
    '[Profile0]',
    'Name=default',
    'IsRelative=1',
    'Path=Profiles/abc.default',
    'Default=1',
    '',
    '[Profile1]',
    'IsRelative=0',
    'Path=' + absoluteProfile,
    'Name=Work Profile',
    '',
    '[Install4F96D1932A9F858E]',
    'Default=Profiles/abc.default',
    'Locked=1',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(baseDir, 'profiles.ini'), ini);

  const exe = process.platform === 'win32' ? 'firefox.exe' : 'firefox';
  const exePath = `"${path.join(baseDir, exe)}"`;
  const relativeProfile = path.join(baseDir, 'Profiles', 'abc.default');

  let failures = 0;
  const check = (name, actual, expected) => {
    const ok = actual === expected;
    if (ok) {
      console.log(`  ✓ ${name}`);
    } else {
      failures++;
      console.error(
        `  ✗ ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
      );
    }
  };

  // ── -P <name>: the gap this test exists for ──────────────────────────────
  let r = resolve(installer, baseDir, `${exePath} -P default`);
  check('-P <name> resolves a relative profiles.ini entry', r.out, relativeProfile);
  check('-P <name> exits 0', r.status, 0);

  r = resolve(installer, baseDir, `${exePath} -P "Work Profile"`);
  check('-P "<name with space>" resolves', r.out, absoluteProfile);

  r = resolve(installer, baseDir, `${exePath} -private-window -P default`);
  check('-P wins next to unrelated switches', r.out, relativeProfile);

  r = resolve(installer, baseDir, `${exePath} -P default -private-window`);
  check('-P before a trailing switch resolves', r.out, relativeProfile);

  // ── unresolved / non-matching arguments ─────────────────────────────────
  r = resolve(installer, baseDir, `${exePath} -P MissingProfile`);
  check('unknown -P name resolves nothing', r.out, '');
  check('unknown -P name exits 1', r.status, 1);

  r = resolve(installer, baseDir, `${exePath} -P`);
  check('-P without a value resolves nothing', r.out, '');
  check('-P without a value exits 1', r.status, 1);

  r = resolve(installer, baseDir, `${exePath} -private-window`);
  check('other -p switches are not read as -P', r.out, '');
  check('other -p switches exit 1', r.status, 1);

  r = resolve(installer, baseDir, `${exePath} -profilemanager`);
  check('-profilemanager is not a profile path', r.out, '');
  check('-profilemanager exits 1', r.status, 1);

  // ── --profile <dir> keeps winning and stays verbatim ────────────────────
  const tempProfile = path.join(tmpRoot, 'temp-profile');
  r = resolve(installer, baseDir, `${exePath} --profile "${tempProfile}"`);
  check('--profile is used verbatim (not in profiles.ini)', r.out, tempProfile);

  r = resolve(installer, baseDir, `${exePath} -profile "${tempProfile}"`);
  check('-profile is used verbatim', r.out, tempProfile);

  r = resolve(installer, baseDir, `${exePath} --profile "${tempProfile}" -P default`);
  check('--profile outranks -P', r.out, tempProfile);

  // ── a base dir without profiles.ini cannot resolve a name ───────────────
  const emptyDir = path.join(tmpRoot, 'empty');
  fs.mkdirSync(emptyDir);
  r = resolve(installer, emptyDir, `${exePath} -P default`);
  check('missing profiles.ini resolves nothing', r.out, '');
  check('missing profiles.ini exits 1', r.status, 1);

  fs.rmSync(tmpRoot, {recursive: true, force: true});

  if (failures > 0) {
    console.error(`\n${failures} profile-argv check(s) failed`);
    process.exit(1);
  }
  console.log('\nprofile-argv: all checks passed');
}

main();
