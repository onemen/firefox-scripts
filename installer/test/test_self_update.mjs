#!/usr/bin/env node

/**
 * test_self_update.mjs — Unit tests for the installer's self-update logic
 * (installer/src/self_update.c) driven through the hidden `--test-self-update
 * <json-file> <current-build-date> <asset>` CLI mode.
 *
 * The C side ingests a release JSON and runs check_self_update(): the managed
 * installerDate/download block (embedded JSON-escaped in a release body by
 * tools/publish/componentReleases.mjs) is parsed, the date compared with the
 * binary's baked build date (YYYY-MM-DD — lexicographic == chronological), and
 * the platform's download URL extracted. The harness writes fixture JSON files
 * and asserts the parsed output. Runs as part of `pnpm test:hash` (after the
 * publish gate builds the installer binary, exactly like test_hash.mjs).
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
  else name = process.arch === 'arm64' ? 'installer_linux_aarch64' : 'installer_linux';
  const plain = path.join(snapshotDir, `${name}${ext}`);
  if (fs.existsSync(plain)) return plain;
  const dev = path.join(snapshotDir, `${name}-dev${ext}`);
  if (fs.existsSync(dev)) return dev;
  return null;
}

/** Run the installer's --test-self-update mode; returns {status, latest, url}. */
function runSelfUpdate(installer, jsonPath, buildDate, asset) {
  const out = execFileSync(installer, ['--test-self-update', jsonPath, buildDate, asset], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Windows (msvcrt/mingw) text mode converts \n to \r\n on stdout.
  const text = out.replace(/\r/g, '');
  const result = {status: NaN, latest: '', url: ''};
  for (const line of text.split('\n')) {
    if (line.startsWith('status=')) result.status = Number(line.slice(7));
    else if (line.startsWith('latest_date=')) result.latest = line.slice(12);
    else if (line.startsWith('download_url=')) result.url = line.slice(13);
  }
  return result;
}

/**
 * A release JSON the way the installer tab actually POSTs it: the managed
 * self-update block sits JSON-escaped inside the release body's ```json fence
 * (and /releases responses wrap the body in an assets-bearing release object —
 * the parser must never take a URL from those assets).
 */
function releaseWithBody(bodyBlock, assets = []) {
  const body =
    bodyBlock ?
      'Installer binaries — see below.\n\n```json\n' + bodyBlock + '\n```\n'
    : 'No managed block here.';
  return JSON.stringify({
    tag_name: 'latest',
    body,
    assets: assets.map(([name, url]) => ({name, browser_download_url: url})),
  });
}

/**
 * The managed block, both unescaped (top-level, future-proofing) and escaped
 * (release body).
 */
function managedBlock(date, downloads) {
  return JSON.stringify({installerDate: date, download: downloads});
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
  // ship installer_<os>[-arch]-dev[.exe], prod keeps the plain name.  The
  // fixture must use the same suffix the snapshot binary carries — including
  // the Linux arm64 twin, whose asset name spells installer_linux_aarch64.
  const plainBase =
    process.platform === 'win32' ? 'installer_win'
    : process.platform === 'darwin' ? 'installer_mac'
    : process.arch === 'arm64' ? 'installer_linux_aarch64'
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
    // ── date comparison (the ADR 0019-amendment contract) ──────────────────
    {
      name: 'same build date → up to date',
      json: releaseWithBody(managedBlock('2026-09-13', {[asset]: 'https://x/new'})),
      build: '2026-09-13',
      expect: {status: 0, latest: '2026-09-13', url: ''},
    },
    {
      name: 'newer build date → update + managed download URL',
      json: releaseWithBody(
        managedBlock('2026-09-13', {
          [otherAsset]: 'https://x/other',
          [asset]: 'https://x/installer-download',
        })
      ),
      build: '2026-09-01',
      expect: {status: 1, latest: '2026-09-13', url: 'https://x/installer-download'},
    },
    {
      name: 'older published date → up to date (build ahead of latest)',
      json: releaseWithBody(managedBlock('2026-08-01', {[asset]: 'https://x/old'})),
      build: '2026-09-13',
      expect: {status: 0, latest: '2026-08-01', url: ''},
    },
    {
      name: 'date compare is chronological across month/year boundaries',
      json: releaseWithBody(managedBlock('2027-01-02', {[asset]: 'https://x/future'})),
      build: '2026-12-31',
      expect: {status: 1, latest: '2027-01-02', url: 'https://x/future'},
    },
    {
      name: 'newer date but no managed URL for this platform → still flags (releases-page fallback)',
      json: releaseWithBody(managedBlock('2026-09-14', {})),
      build: '2026-09-01',
      expect: {status: 1, latest: '2026-09-14', url: ''},
    },
    {
      name: 'substring guard: installer_linux must not match installer_linux_aarch64',
      json: releaseWithBody(managedBlock('2026-09-14', {installer_linux_aarch64: 'https://x/arm'})),
      build: '2026-09-01',
      asset: plainBase === 'installer_linux' ? 'installer_linux' : asset,
      expect: {status: 1, latest: '2026-09-14', url: ''},
      skipFor:
        process.platform === 'linux' && process.arch !== 'arm64' ?
          null
        : 'only meaningful on x64 linux runs',
    },
    {
      // The real /releases?per_page=10 shape: several releases, each with an
      // assets array.  The managed block is in the NEWEST release's body; the
      // parser must never take a URL from any assets[] entry.
      name: 'releases listing: decoy browser_download_url entries are ignored',
      json: JSON.stringify([
        {
          tag_name: 'installer-2026-09-14',
          body: '```json\n' + managedBlock('2026-09-14', {[asset]: 'https://x/managed'}) + '\n```',
          assets: [{name: otherAsset, browser_download_url: 'https://DECOY-ASSETS/other'}],
        },
        {
          tag_name: 'installer-2026-09-01',
          body: '```json\n' + managedBlock('2026-09-01', {[asset]: 'https://x/stale'}) + '\n```',
          assets: [{name: asset, browser_download_url: 'https://DECOY-STALE/installer'}],
        },
        {tag_name: 'scripts-2026-09-01', body: 'no block', assets: []},
      ]),
      build: '2026-09-01',
      expect: {status: 1, latest: '2026-09-14', url: 'https://x/managed'},
    },
    {
      name: 'unescaped top-level block (direct /releases/tags/latest shape) also parses',
      json: JSON.stringify({
        tag_name: 'latest',
        installerDate: '2026-09-14',
        download: {[asset]: 'https://x/toplevel'},
        assets: [],
      }),
      build: '2026-09-01',
      expect: {status: 1, latest: '2026-09-14', url: 'https://x/toplevel'},
    },
    // ── graceful degradation ────────────────────────────────────────────────
    {
      name: 'body without a managed block → silently no update',
      json: releaseWithBody(null, [[asset, 'https://x/decoy']]),
      build: '2026-09-01',
      expect: {status: 0, latest: '', url: ''},
    },
    {
      name: 'malformed managed date (not YYYY-MM-DD) → silently no update',
      json: releaseWithBody(managedBlock('v1.2.3', {[asset]: 'https://x/junk'})),
      build: '2026-09-01',
      expect: {status: 0, latest: '', url: ''},
    },
    // (status=-1, no JSON ingested, is exercised by the endpoint-level
    // installer E2E Test 6 — the file-based harness cannot express it:
    // --test-self-update exits 2 on an unreadable fixture file.)
  ];

  for (const [i, c] of cases.entries()) {
    if (c.skipFor) continue;
    const jsonPath = path.join(tmpDir, `case-${i}.json`);
    if (c.json !== null) fs.writeFileSync(jsonPath, c.json);
    let got;
    try {
      got = runSelfUpdate(installer, jsonPath, c.build, c.asset ?? asset);
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
