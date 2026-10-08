// test/unit/tools/browserStore.test.mjs — the durable browser-installer
// store (#465): asset naming, the body ledger round-trip, and the seed/roll
// behavior (keep-1 per browser namespace, release creation on first use,
// non-fatal failure semantics). The `gh` CLI is stubbed at the function
// boundary — the same seam ciDownload.test.mjs / cleanupCiDownloads.test.mjs
// use.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BROWSER_STORE_TAG,
  storeAssetName,
  parseStoreLedger,
  renderStoreBody,
  seedBrowserStore,
  storeRelease,
} from '../../../tools/ci/browserStore.mjs';

/**
 * A stubbed `gh` over an in-memory release — `null` means "no release yet" (the
 * steady state before the first seed). Returns {gh, lines, state}; `state` is a
 * getter-backed object the stub mutates like the real release endpoint would,
 * `lines` collects every invocation.
 */
function stubGh(initial) {
  let release = initial; // {id, body, assets} | null
  const lines = [];
  const gh = args => {
    lines.push(args.join(' '));
    const [cmd, sub] = args;
    if (cmd !== 'release') throw new Error(`unexpected gh invocation: ${args.join(' ')}`);
    if (sub === 'view') {
      if (!release) throw new Error(`HTTP 404: no ${BROWSER_STORE_TAG} release`);
      return JSON.stringify(release);
    }
    if (sub === 'create') {
      if (release) throw new Error('release already exists');
      release = {id: 1, body: args[args.indexOf('--notes') + 1] ?? '', assets: []};
      return '';
    }
    if (sub === 'upload') {
      // gh release upload <tag> <file> — the file arg is index 3.
      const name = args[3].replace(/\\/g, '/').split('/').pop();
      release.assets = release.assets.filter(a => a.name !== name);
      release.assets.push({name, size: 900});
      return '';
    }
    if (sub === 'delete-asset') {
      // gh release delete-asset <tag> <name> — name at index 3.
      const name = args[3];
      if (!release.assets.some(a => a.name === name)) throw new Error(`no asset ${name}`);
      release.assets = release.assets.filter(a => a.name !== name);
      return '';
    }
    if (sub === 'edit') {
      release.body = args[args.indexOf('--notes') + 1] ?? release.body;
      return '';
    }
    throw new Error(`unexpected gh invocation: ${args.join(' ')}`);
  };
  return {gh, lines, state: () => release};
}

/** A real temp installer file, cleaned up via the returned callback. */
function tempInstaller(content = 'x'.repeat(1024)) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-store-test-'));
  const file = path.join(dir, 'firefox-157.0.1-setup.exe');
  fs.writeFileSync(file, content);
  return {file, cleanup: () => fs.rmSync(dir, {recursive: true, force: true})};
}

test('storeAssetName namespaces by browser with the `--` separator', () => {
  assert.equal(
    storeAssetName('firefox', 'firefox-157.0.1-setup.exe'),
    'firefox--firefox-157.0.1-setup-win64.exe'
  );
  // The separator is what keeps sibling browsers disjoint: firefox-dev and
  // the ESR keys both start `firefox-` but roll in their own namespace.
  assert.match(storeAssetName('firefox-dev', 'Firefox-Setup-158.0b5.exe'), /^firefox-dev--/);
  assert.match(
    storeAssetName('firefox-esr-140', 'firefox-140.3.1esr-setup.exe'),
    /^firefox-esr-140--/
  );
  assert.match(
    storeAssetName('librewolf', 'librewolf-157.0-1-windows-x86_64-setup.exe'),
    /^librewolf--/
  );
});

test('the ledger round-trips through the body renderer (sorted, stable)', () => {
  const ledger = new Map([
    ['zen--zen-1.23.1b-installer-win64.exe', 'aa'.repeat(32)],
    ['firefox--firefox-157.0.1-setup-win64.exe', 'bb'.repeat(32)],
  ]);
  const body = renderStoreBody(ledger);
  assert.deepEqual(
    [...parseStoreLedger(body).entries()],
    [...ledger].sort(([a], [b]) => (a < b ? -1 : 1))
  );
  // Stable diffs: re-rendering the parsed ledger is byte-identical.
  assert.equal(renderStoreBody(parseStoreLedger(body)), body);
});

test('seedBrowserStore: creates the release on first use and uploads the asset', async () => {
  const stub = stubGh(null);
  const {file, cleanup} = tempInstaller();
  try {
    const out = await seedBrowserStore({
      browser: 'firefox',
      file,
      installerName: 'firefox-157.0.1-setup.exe',
      sha256: 'ab'.repeat(32),
      gh: stub.gh,
      log: () => {},
    });
    assert.equal(out, 'firefox--firefox-157.0.1-setup-win64.exe');
    assert.ok(stub.lines.some(l => l.startsWith('release create')));
    assert.ok(stub.lines.some(l => l.startsWith('release upload')));
    assert.ok(stub.state().assets.some(a => a.name === out));
    // The ledger records the sha256 under the stored name.
    assert.equal(parseStoreLedger(stub.state().body).get(out), 'ab'.repeat(32));
  } finally {
    cleanup();
  }
});

test('seedBrowserStore: a new version rolls the same browser and only it', async () => {
  const old = 'firefox--firefox-157.0.1-setup-win64.exe';
  const sibling = 'firefox-dev--Firefox-Setup-158.0b5-win64.exe';
  const stub = stubGh({
    id: 1,
    body: renderStoreBody(new Map([[old, 'cd'.repeat(32)]])),
    assets: [
      {name: old, size: 1},
      {name: sibling, size: 2},
    ],
  });
  const {file, cleanup} = tempInstaller();
  try {
    const out = await seedBrowserStore({
      browser: 'firefox',
      file,
      installerName: 'firefox-158.0-setup.exe',
      sha256: 'ef'.repeat(32),
      gh: stub.gh,
      log: () => {},
    });
    assert.equal(out, 'firefox--firefox-158.0-setup-win64.exe');
    assert.ok(stub.lines.some(l => l.includes(`delete-asset ${BROWSER_STORE_TAG} ${old}`)));
    assert.ok(!stub.lines.some(l => l.includes(`delete-asset ${BROWSER_STORE_TAG} ${sibling}`)));
    assert.ok(stub.state().assets.some(a => a.name === sibling));
    assert.ok(!stub.state().assets.some(a => a.name === old));
    // The ledger in the body drops the rolled entry too.
    assert.ok(!stub.state().body.includes(old));
    assert.ok(stub.state().body.includes(out));
  } finally {
    cleanup();
  }
});

test('seedBrowserStore: failures are non-fatal (null, never throw)', async () => {
  const logs = [];
  const out = await seedBrowserStore({
    browser: 'firefox',
    file: path.join(os.tmpdir(), 'browser-store-test-missing-installer.exe'),
    installerName: 'firefox-157.0.1-setup.exe',
    gh: () => {
      throw new Error('gh exploded');
    },
    log: m => logs.push(String(m)),
  });
  assert.equal(out, null);
  assert.ok(logs.some(l => l.includes('non-fatal')));
});

test('storeRelease: null when the release does not exist (steady state)', () => {
  const missing = () => {
    throw new Error('HTTP 404: Not Found');
  };
  assert.equal(storeRelease({gh: missing}), null);
});
