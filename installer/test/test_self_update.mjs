#!/usr/bin/env node

/**
 * test_self_update.mjs — Unit tests for the installer's self-update logic
 * (installer/src/self_update.c) driven through the hidden `--test-self-update
 * <json-file> <version> <asset>` CLI mode.
 *
 * The C side ingests a release JSON and runs check_self_update(): version
 * comparison (leading 'v' normalized), asset-name matching, and download-URL
 * extraction. The harness writes fixture JSON files and asserts the parsed
 * output. Runs as part of `pnpm test:hash` (after the publish gate builds the
 * installer binary, exactly like test_hash.mjs).
 *
 * Exit code: 0 if all tests pass, 1 if any fail.
 */

import {execFileSync} from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {fileURLToPath} from 'url';

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
  else name = 'installer_linux';
  const plain = path.join(snapshotDir, `${name}${ext}`);
  if (fs.existsSync(plain)) return plain;
  const dev = path.join(snapshotDir, `${name}-dev${ext}`);
  if (fs.existsSync(dev)) return dev;
  return null;
}

/** Run the installer's --test-self-update mode; returns {status, latest, url}. */
function runSelfUpdate(installer, jsonPath, version, asset) {
  const out = execFileSync(installer, ['--test-self-update', jsonPath, version, asset], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Windows (msvcrt/mingw) text mode converts \n to \r\n on stdout.
  const text = out.replace(/\r/g, '');
  const result = {status: NaN, latest: '', url: ''};
  for (const line of text.split('\n')) {
    if (line.startsWith('status=')) result.status = Number(line.slice(7));
    else if (line.startsWith('latest_version=')) result.latest = line.slice(15);
    else if (line.startsWith('download_url=')) result.url = line.slice(13);
  }
  return result;
}

function releaseJson(tag, assets) {
  return JSON.stringify({
    tag_name: tag,
    assets: assets.map(([name, url]) => ({name, browser_download_url: url})),
  });
}

function main() {
  const snapshotDir = findSnapshot();
  if (!snapshotDir) {
    console.error('No snapshot found. Run `pnpm upload:local --mode=dev` first.');
    process.exit(1);
  }
  const installer = getInstallerPath(snapshotDir);
  if (!installer) {
    console.error(`Installer binary not found in ${snapshotDir}`);
    process.exit(1);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fxs-self-update-'));
  // The installer matches the asset named after ITS OWN binary: dev snapshots
  // ship installer_<os>-dev[.exe], prod keeps the plain name.  The fixture
  // must use the same suffix the snapshot binary carries.
  const plainBase =
    process.platform === 'win32' ? 'installer_win'
    : process.platform === 'darwin' ? 'installer_mac'
    : 'installer_linux';
  const isDev = path.basename(installer).includes('-dev');
  const asset = plainBase + (isDev ? '-dev' : '') + (process.platform === 'win32' ? '.exe' : '');
  const otherAsset = plainBase === 'installer_win' ? 'installer_linux' : 'installer_win.exe';

  let failures = 0;
  const check = (name, cond, detail = '') => {
    if (cond) {
      console.log(`  ✓ ${name}`);
    } else {
      failures++;
      console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
    }
  };

  const cases = [
    {
      name: 'same version → up to date',
      json: releaseJson('v1.0.0', [[asset, 'https://x/installer']]),
      version: '1.0.0',
      expect: {status: 0, url: ''},
    },
    {
      name: 'newer version → update + matching asset URL',
      json: releaseJson('1.0.1', [
        [otherAsset, 'https://x/other'],
        [asset, 'https://x/installer-download'],
      ]),
      version: '1.0.0',
      expect: {status: 1, latest: '1.0.1', url: 'https://x/installer-download'},
    },
    {
      name: 'newer version, no matching asset → no update offered',
      json: releaseJson('1.0.1', [[otherAsset, 'https://x/other']]),
      version: '1.0.0',
      expect: {status: 0, latest: '1.0.1', url: ''},
    },
    {
      name: 'raw tag passed through to latest_version (the UI prepends v)',
      json: releaseJson('v1.0.1', [[asset, 'https://x/installer-download']]),
      version: '1.0.0',
      expect: {status: 1, latest: 'v1.0.1', url: 'https://x/installer-download'},
    },
    {
      name: 'missing tag_name → error',
      json: JSON.stringify({assets: [{name: asset, browser_download_url: 'https://x/i'}]}),
      version: '1.0.0',
      expect: {status: -1, latest: '', url: ''},
    },
    {
      name: 'leading v normalized on both sides',
      json: releaseJson('1.0.0', [[asset, 'https://x/installer']]),
      version: 'v1.0.0',
      expect: {status: 0, url: ''},
    },
  ];

  for (const [i, c] of cases.entries()) {
    const jsonPath = path.join(tmpDir, `case-${i}.json`);
    fs.writeFileSync(jsonPath, c.json);
    let got;
    try {
      got = runSelfUpdate(installer, jsonPath, c.version, asset);
    } catch (err) {
      check(c.name, false, `command failed: ${err.message}`);
      continue;
    }
    check(c.name, got.status === c.expect.status, `status=${got.status} want ${c.expect.status}`);
    if (c.expect.latest !== undefined) {
      check(
        c.name + ' (latest)',
        got.latest === c.expect.latest,
        `latest=${got.latest} want ${c.expect.latest}`
      );
    }
    if (c.expect.url !== undefined) {
      check(c.name + ' (url)', got.url === c.expect.url, `url=${got.url} want ${c.expect.url}`);
    }
  }

  fs.rmSync(tmpDir, {recursive: true, force: true});

  if (failures > 0) {
    console.error(`\n${failures} self-update check(s) failed`);
    process.exit(1);
  }
  console.log('\n✓ all self-update checks passed');
}

main();
