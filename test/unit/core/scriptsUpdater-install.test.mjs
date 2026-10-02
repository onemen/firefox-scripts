// test/unit/core/scriptsUpdater-install.test.mjs — unit tests for the install
// side of core/chrome/utils/updater/scriptsUpdater.sys.mjs.
//
// Why this file exists: `copyFileList` writes into the LIVE browser's own
// chrome tree (ProfD/chrome/utils) while the tab is open, so on Windows a
// target can be held for a moment by Defender, the indexer, or the browser
// still reading the module being replaced. There is no test harness that can
// provoke a real sharing violation, and the E2E legs cannot either — so the
// retry is pinned here against injected IOUtils failures, and the code path
// that reports the final failure is pinned with it (a partially updated tree
// whose error names no file is unactionable).
//
// Technique: the real .sys.mjs is evaluated in a vm sandbox with stubbed
// Firefox services (same spirit as scriptsUpdater-hash / -channel: every export
// is a function declaration, so stripping `export ` exposes the API on the
// sandbox object). Only `copyFileList` is driven; the zip/DOM machinery is not
// exercised here.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import {comparePlatformVersions, resolveSandboxLazyModule} from '../../shared/sandboxServices.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const MODULE_PATH = path.join(
  REPO_ROOT,
  'core',
  'chrome',
  'utils',
  'updater',
  'scriptsUpdater.sys.mjs'
);

/** Minimal generated config: nothing here is read by copyFileList. */
const CONFIG = {
  HASHES_URL: 'https://example.test/hashes.json',
  ZIP_BASE_URL: 'https://example.test',
  UI_BASE_URL: 'https://example.test',
  HELPER_BASE_URL: 'https://example.test',
  ASSET_SUFFIX: '',
  IS_DEV: false,
  IS_LOCAL: true,
};

/**
 * A Gecko-style file error. IOUtils rejects with a named result
 * (NS_ERROR_FILE_IS_LOCKED / NS_ERROR_FILE_ACCESS_DENIED / …) and no numeric
 * table this scope can rely on, which is exactly how the predicate sees it.
 *
 * @param {string} name
 * @returns {Error}
 */
function fileError(name) {
  return Object.assign(new Error(name), {name, result: 0x80520015});
}

/**
 * Evaluate the module in a fresh sandbox with a scripted IOUtils.
 *
 * @param {{onCopy?: (src: string, dst: string) => void}} [opts] `onCopy` is
 *   called for every copy attempt and may throw to script a failure
 * @returns {{api: object; copied: string[]; retries: number}}
 */
function loadModule({onCopy} = {}) {
  const source = fs
    .readFileSync(MODULE_PATH, 'utf-8')
    .replace(/\r\n/g, '\n')
    .replace(/^export /gm, '');
  const copied = [];
  const sandbox = {
    ChromeUtils: {
      importESModule(spec) {
        if (spec.includes('updater-config')) return {CONFIG};
        throw new Error(`unexpected importESModule(${spec})`);
      },
      defineESModuleGetters(target, getters) {
        for (const [name, spec] of Object.entries(getters)) {
          target[name] =
            String(spec).includes('Timer.sys.mjs') ?
              cb => setTimeout(cb, 0)
            : resolveSandboxLazyModule(name, spec);
        }
      },
    },
    Services: {
      appinfo: {platformVersion: '140.0'},
      vc: {compare: comparePlatformVersions},
      prefs: {getStringPref: (_k, d = '') => d},
      dirsvc: {get: () => ({path: '/tmp'})},
    },
    PathUtils: {
      profileDir: '/profile',
      tempDir: '/tmp',
      join: (...parts) => parts.join('/'),
      parent: p => p.slice(0, p.lastIndexOf('/')) || '/',
    },
    IOUtils: {
      makeDirectory: async () => {},
      copy: async (src, dst) => {
        copied.push(dst);
        onCopy?.(src, dst);
      },
    },
    Ci: new Proxy({}, {get: () => ({})}),
    console,
    TextEncoder,
    atob,
    queueMicrotask,
  };
  vm.runInContext(source, vm.createContext(sandbox), {filename: 'scriptsUpdater.sys.mjs'});
  return {api: sandbox, copied};
}

const FILES = ['updater/scriptsUpdater.sys.mjs', 'chrome.manifest'];

test('copyFileList: rides out a transient file hold and finishes the install', async () => {
  let attempts = 0;
  const {api, copied} = loadModule({
    onCopy: (_src, dst) => {
      // The first file is held twice (Defender/indexer), then released.
      if (dst.endsWith('scriptsUpdater.sys.mjs') && (attempts += 1) <= 2) {
        throw fileError('NS_ERROR_FILE_IS_LOCKED');
      }
    },
  });

  await api.copyFileList(FILES, '/staging', '/profile/chrome/utils');

  assert.equal(attempts, 3, 'two holds then the successful third attempt');
  assert.deepEqual(copied, [
    '/profile/chrome/utils/updater/scriptsUpdater.sys.mjs',
    '/profile/chrome/utils/updater/scriptsUpdater.sys.mjs',
    '/profile/chrome/utils/updater/scriptsUpdater.sys.mjs',
    '/profile/chrome/utils/chrome.manifest',
  ]);
});

test('copyFileList: an access denial is a hold too (the C installer classifies it as locked)', async () => {
  let attempts = 0;
  const {api} = loadModule({
    onCopy: (_src, dst) => {
      if (dst.includes('scriptsUpdater') && (attempts += 1) === 1) {
        throw fileError('NS_ERROR_FILE_ACCESS_DENIED');
      }
    },
  });

  await api.copyFileList(FILES, '/staging', '/profile/chrome/utils');
  assert.equal(attempts, 2, 'retried once, then the write went through');
});

test('copyFileList: a non-hold failure propagates immediately, unretried', async () => {
  let attempts = 0;
  const {api} = loadModule({
    onCopy: () => {
      attempts += 1;
      throw fileError('NS_ERROR_FILE_NOT_FOUND'); // a missing source is terminal
    },
  });

  await assert.rejects(
    () => api.copyFileList(FILES, '/staging', '/profile/chrome/utils'),
    /Could not install updater\/scriptsUpdater\.sys\.mjs/
  );
  assert.equal(attempts, 1, 'no retry for a non-hold error');
});

test('copyFileList: a hold that outlives the retry budget fails, naming the file', async () => {
  let attempts = 0;
  const {api} = loadModule({
    onCopy: () => {
      attempts += 1;
      throw fileError('NS_ERROR_FILE_IS_LOCKED');
    },
  });

  await assert.rejects(
    () => api.copyFileList(FILES, '/staging', '/profile/chrome/utils'),
    err => {
      assert.match(err.message, /Could not install updater\/scriptsUpdater\.sys\.mjs/);
      assert.match(err.message, /\/profile\/chrome\/utils/, 'the destination is named');
      assert.match(err.message, /NS_ERROR_FILE_IS_LOCKED/, 'the underlying cause survives');
      return true;
    }
  );
  assert.equal(attempts, 4, 'the full attempt budget is used before failing');
});

test('copyFileList: an unsafe manifest path is rejected before any write', async () => {
  const {api, copied} = loadModule();
  await assert.rejects(
    () => api.copyFileList(['../escape.js'], '/staging', '/profile/chrome/utils'),
    /Unsafe manifest path/
  );
  assert.deepEqual(copied, [], 'nothing was written');
});
