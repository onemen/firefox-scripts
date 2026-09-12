#!/usr/bin/env node
/**
 * test/e2e/shared/localManifestServer.mjs — tiny HTTP server that serves a
 * pre-baked hashes.json for fast, deterministic "no update" E2E scenarios.
 *
 * The updater scheduler fetches HASHES_URL on every check. For scenarios where
 * we assert the tab does NOT open (both packages up to date, skip prefs set),
 * the real network fetch is unnecessary latency + a source of CI variance. This
 * server lets the test serve a known-good manifest from localhost so the
 * scheduler's check completes in ~1ms instead of network time.
 *
 * Usage (inside a test scenario): const server = await
 * startLocalManifestServer(snapshotDir, profileDir); // server.port,
 * server.url, server.hash are available // ... launch Firefox with HASHES_URL
 * override pointing at server.url ... // ... run assertions ... await
 * server.close();
 *
 * The server is single-request by default (it serves one manifest then stops)
 * unless multiRequest: true is passed — most scenarios only need one fetch.
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import crypto from 'node:crypto';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

const OVERRIDE_PREFIX = 'extensions.firefox-scripts.override.';

/** Find the utils zip in a snapshot dir. */
function findUtilsZip(snapshotDir) {
  for (const name of ['utils-dev.zip', 'utils.zip']) {
    const p = path.join(snapshotDir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** Extract a zip (flat) into destDir. */
function extractZip(zipPath, destDir) {
  const buf = fs.readFileSync(zipPath);
  fs.mkdirSync(destDir, {recursive: true});
  const root = path.resolve(destDir);
  for (const entry of listZipEntries(buf)) {
    if (entry.name.endsWith('/')) continue;
    const parts = entry.name.split('/');
    if (parts.some(p => p === '..' || p === '.' || p === '')) continue;
    const destPath = path.resolve(root, ...parts);
    if (destPath !== root && !destPath.startsWith(root + path.sep)) continue;
    fs.mkdirSync(path.dirname(destPath), {recursive: true});
    fs.writeFileSync(destPath, readZipEntry(buf, entry));
  }
  return destDir;
}

/** Minimal zip listing — reads central directory entries. */
function listZipEntries(buf) {
  const entries = [];
  // Find end of central directory
  const eocdPos = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocdPos === -1) return entries;

  const centralDirOffset = buf.readUInt32LE(eocdPos + 16);
  const centralDirSize = buf.readUInt32LE(eocdPos + 12);

  let pos = centralDirOffset;
  const end = centralDirOffset + centralDirSize;
  while (pos < end) {
    const sig = buf.readUInt32LE(pos);
    if (sig !== 0x02014b50) break;
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLenEntry = buf.readUInt16LE(pos + 32);
    const compSize = buf.readUInt32LE(pos + 20);
    const uncompSize = buf.readUInt32LE(pos + 24);
    const name = buf.slice(pos + 46, pos + 46 + nameLen).toString('utf-8');
    entries.push({
      name,
      compressedSize: compSize,
      uncompressedSize: uncompSize,
    });
    pos += 46 + nameLen + extraLen + commentLenEntry;
  }
  return entries;
}

/** Read a zip entry's bytes from the buffer. */
function readZipEntry(buf, entry) {
  const eocdPos = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const centralDirOffset = buf.readUInt32LE(eocdPos + 16);

  let pos = centralDirOffset;
  const end = centralDirOffset + buf.readUInt32LE(eocdPos + 12);
  while (pos < end) {
    const sig = buf.readUInt32LE(pos);
    if (sig !== 0x02014b50) break;
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const name = buf.slice(pos + 46, pos + 46 + nameLen).toString('utf-8');
    if (name === entry.name) {
      const localHeaderOffset = buf.readUInt32LE(pos + 42);
      // Local file header
      const lhPos = localHeaderOffset;
      const lhNameLen = buf.readUInt16LE(lhPos + 26);
      const lhExtraLen = buf.readUInt16LE(lhPos + 28);
      const dataStart = lhPos + 30 + lhNameLen + lhExtraLen;
      return buf.slice(dataStart, dataStart + entry.compressedSize);
    }
    pos += 46 + nameLen + extraLen + buf.readUInt16LE(pos + 32);
  }
  return Buffer.alloc(0);
}

/** Build a manifest that matches the files in chromeUtils dir. */
function buildMatchingManifest(chromeUtilsDir, snapshotDir) {
  const manifestPath = path.join(snapshotDir, 'hashes.json');
  if (fs.existsSync(manifestPath)) {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  }
  // Fallback: build from what's on disk (for cases where we want a manifest
  // that matches the seeded files exactly).
  const utilsDir = chromeUtilsDir;
  const files = [];
  if (fs.existsSync(utilsDir)) {
    for (const entry of fs.readdirSync(utilsDir, {recursive: true})) {
      const abs = path.join(utilsDir, entry);
      if (fs.statSync(abs).isFile()) {
        files.push(entry.replace(/\\/g, '/'));
      }
    }
  }
  files.sort((a, b) => a.localeCompare(b));
  const hash = crypto.createHash('sha256');
  for (const rel of files) {
    hash.update(rel + '\n');
    hash.update(fs.readFileSync(path.join(utilsDir, rel)));
  }
  return {
    'utils': {
      hash: hash.digest('hex'),
      files,
      date: new Date().toISOString().slice(0, 10),
    },
    'fx-folder': {hash: '', files: [], date: ''},
    'updater-ui': {hash: '', files: [], date: ''},
  };
}

/** Find a free port. */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.listen(0, () => {
      const addr = s.address();
      s.close(() => resolve(addr.port));
    });
    s.on('error', reject);
  });
}

/** Serve a hashes.json from memory. */
export async function startLocalManifestServer(snapshotDir, chromeUtilsDir, opts = {}) {
  const {multiRequest = false, manifestOverride = null} = opts;

  const utilsZip = findUtilsZip(snapshotDir);
  if (!utilsZip) {
    throw new Error(`no utils zip found in ${snapshotDir}`);
  }

  // Extract utils to a temp dir to compute the matching hash
  const staging = fs.mkdtempSync(path.join(REPO_ROOT, 'dist', 'fxs-manifest-server-'));
  let manifest = manifestOverride;
  if (!manifest) {
    extractZip(utilsZip, staging);
    manifest = buildMatchingManifest(staging, snapshotDir);
  }
  const body = JSON.stringify(manifest, null, 2);

  const port = await findFreePort();
  const url = `http://127.0.0.1:${port}/hashes.json`;

  let served = 0;
  const maxServes = multiRequest ? Infinity : 1;

  const server = http.createServer((req, res) => {
    if (req.url === '/hashes.json' || req.url === '/hashes.json/') {
      if (served >= maxServes) {
        res.writeHead(503);
        res.end(JSON.stringify({error: 'manifest server exhausted'}));
        return;
      }
      served++;
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
      });
      res.end(body);
    } else {
      res.writeHead(404);
      res.end('not found');
    }
  });

  await new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => resolve());
    server.on('error', reject);
  });

  // Keep staging alive until the server is closed so the manifest body stays valid.
  let closed = false;
  const close = () => {
    if (closed) return Promise.resolve();
    closed = true;
    return new Promise(resolve =>
      server.close(() => {
        fs.rmSync(staging, {recursive: true, force: true});
        resolve();
      })
    );
  };

  return {
    port,
    url,
    hash: manifest.utils?.hash || '',
    files: manifest.utils?.files || [],
    close,
    servedCount: () => served,
  };
}

/** Get the override prefs to point the updater at the local server. */
export function serverOverridePrefs(serverUrl) {
  return {
    [OVERRIDE_PREFIX + 'HASHES_URL']: serverUrl,
    // Keep ZIP_BASE_URL, UI_BASE_URL, HELPER_BASE_URL pointing at the real
    // snapshot — only HASHES_URL is overridden for the "no update" check.
    // The scheduler only fetches HASHES_URL for the update decision.
  };
}
