// test/unit/e2e/processHygiene.test.mjs — unit tests for the E2E process
// hygiene helpers (issue #130). The OS-bound sweep itself is only smoke-checked
// here (no process-killing assertions in unit tests); the matcher, the
// compatibility.ini removal, and closeBrowser's exit-wait logic are tested
// directly.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const hygieneUrl = pathToFileURL(
  path.join(REPO_ROOT, 'test', 'e2e', 'shared', 'processHygiene.mjs')
).href;
const {
  closeBrowser,
  INSTALLER_ARGV0_ERE,
  INSTALLER_ARGV0_PS,
  isE2eProcess,
  killStrayProcesses,
  removeProfileCompatibilityIni,
} = await import(hygieneUrl);

// ── Engine-backed pattern validation (T5) ───────────────────────────────────
// The sweep's three regex dialects must all express the same matcher. The JS
// form is covered by isE2eProcess above; the PowerShell and pkill forms are
// validated here against their real engines when available (powershell.exe on
// Windows hosts, grep -E as the POSIX-ERE stand-in for pkill), and skipped
// elsewhere — a silent dialect drift must fail the gate on the host where the
// dialect runs, not vanish.

const ARGV0_POSITIVE = [
  'C:\\repo\\dist\\.build\\installer\\installer_win.exe --smoke-test',
  './dist/.build/installer/installer_linux --env-file x.json',
  'installer_win-dev.exe --env-file /tmp/fxs-e2e-1/env.json',
  '"C:\\repo with space\\dist\\installer_win.exe" --smoke-test',
  '/repo/dist/.build/installer/installer_linux_aarch64',
];
const ARGV0_NEGATIVE = [
  'bash -c "ls dist/installer_win.exe"',
  'ls dist/installer_win.exe',
  'grep installer_win /tmp/manifest.json',
  'node tools/check-bin.mjs installer_win.exe',
  'C:\\Windows\\system32\\cmd.exe /c dir dist\\installer_win.exe',
];

/** Full pkill-style alternation: fxs- markers anywhere OR installer argv[0]. */
function pkillPattern() {
  return `fxs-(e2e|installer-ui)|${INSTALLER_ARGV0_ERE}`;
}

if (process.platform === 'win32') {
  test('INSTALLER_ARGV0_PS: real PowerShell -match agrees with isE2eProcess', async () => {
    const {spawnSync} = await import('node:child_process');
    const cases = [
      ...ARGV0_POSITIVE.map(cmd => ({cmd, want: 'MATCH'})),
      ...ARGV0_NEGATIVE.map(cmd => ({cmd, want: 'NOMATCH'})),
    ];
    const ps =
      `$pat = '${INSTALLER_ARGV0_PS}'; ` +
      cases
        .map(
          c => `if ('${c.cmd.replaceAll("'", "''")}' -match $pat) { 'MATCH' } else { 'NOMATCH' }`
        )
        .join('; ');
    const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(res.status, 0, `powershell failed: ${res.stderr}`);
    const out = res.stdout.trim().split(/\r?\n/);
    assert.equal(out.length, cases.length, 'one verdict per case');
    cases.forEach((c, i) => {
      assert.equal(out[i], c.want, `PowerShell verdict for ${JSON.stringify(c.cmd)}`);
    });
  });
}

test('INSTALLER_ARGV0_ERE: real grep -E (POSIX ERE) agrees with isE2eProcess', async () => {
  const {execFileSync} = await import('node:child_process');
  const pattern = pkillPattern();
  /** Run grep -E with the case on stdin; returns true when it matches. */
  function grepMatch(cmd) {
    try {
      execFileSync('grep', ['-E', '-e', pattern, '-'], {input: `${cmd}\n`, encoding: 'utf8'});
      return true;
    } catch (e) {
      if (e.status !== 1) throw e; // 1 = no match — the informative exit
      return false;
    }
  }
  for (const cmd of ARGV0_POSITIVE) {
    assert.ok(grepMatch(cmd), `grep -E must match argv[0] case: ${JSON.stringify(cmd)}`);
  }
  for (const cmd of ARGV0_NEGATIVE) {
    assert.equal(grepMatch(cmd), false, `grep -E must NOT match: ${JSON.stringify(cmd)}`);
  }
});

// ── isE2eProcess: the argv matcher the sweep kills on ────────────────────────

test('isE2eProcess: matches harness temp-dir prefixes in argv', () => {
  assert.ok(isE2eProcess('firefox -profile C:\\Users\\x\\AppData\\Local\\Temp\\fxs-e2e-abc123'));
  assert.ok(isE2eProcess('firefox --profile /tmp/fxs-e2e-xyz/-profile'));
  assert.ok(isE2eProcess('installer.exe --env-file /tmp/fxs-installer-ui-env-1/env.json'));
});

test('isE2eProcess: matches the harness-built installer binary as argv[0]', () => {
  assert.ok(isE2eProcess('C:\\repo\\dist\\.build\\installer\\installer_win.exe --smoke-test'));
  assert.ok(isE2eProcess('./dist/.build/installer/installer_linux --env-file x.json'));
  assert.ok(isE2eProcess('/repo/dist/.build/installer/installer_mac'));
  assert.ok(isE2eProcess('installer_win-dev.exe --env-file /tmp/fxs-e2e-1/env.json'));
  assert.ok(isE2eProcess('./dist/.build/installer/installer_linux_aarch64-dev --env-file x.json'));
  // Quoted argv[0] (Windows command lines quote paths with spaces).
  assert.ok(isE2eProcess('"C:\\repo\\dist\\.build\\installer\\installer_win.exe" --smoke-test'));
});

test('isE2eProcess: does NOT match commands that merely contain the name (T5)', () => {
  // The 2026-09-18 audit's T5: the old bare-substring form killed a calling
  // shell whose command line referenced the installer as an ARGUMENT. The
  // binary must now be argv[0] to match.
  assert.equal(isE2eProcess('bash -c "ls dist/installer_win.exe"'), false);
  assert.equal(isE2eProcess('ls dist/installer_win.exe'), false);
  assert.equal(isE2eProcess('grep installer_win /tmp/manifest.json'), false);
  assert.equal(isE2eProcess('node tools/check-bin.mjs installer_win.exe'), false);
  assert.equal(
    isE2eProcess('C:\\Windows\\system32\\cmd.exe /c dir dist\\installer_win.exe'),
    false
  );
});

test('isE2eProcess: rejects unrelated command lines', () => {
  assert.equal(isE2eProcess('firefox -profile /home/user/.mozilla/firefox/abc.default'), false);
  assert.equal(isE2eProcess('node test/e2e/updater/updater-e2e.mjs'), false);
  assert.equal(isE2eProcess(''), false);
  assert.equal(isE2eProcess(null), false);
  assert.equal(isE2eProcess(undefined), false);
  // An executable NAMED installer_win in another context is the accepted
  // false-positive risk (logged, best-effort): argv[0] is the installer even
  // if a user built a same-named binary elsewhere. What T5 removed is the
  // match when the name is only an ARGUMENT of some other command.
  assert.ok(isE2eProcess('/opt/installer_win.exe'));
});

// ── removeProfileCompatibilityIni ─────────────────────────────────────────────

test('removeProfileCompatibilityIni: deletes the ini, keeps the rest', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fxs-e2e-hygiene-'));
  try {
    const ini = path.join(dir, 'compatibility.ini');
    fs.writeFileSync(ini, '[Compatibility]\nLastVersion=155.0.1_20260901/en-US\n');
    const prefs = path.join(dir, 'prefs.js');
    fs.writeFileSync(prefs, 'user_pref("x", true);\n');
    removeProfileCompatibilityIni(dir, {log: () => {}});
    assert.equal(fs.existsSync(ini), false);
    assert.equal(fs.existsSync(prefs), true, 'prefs.js untouched');
    assert.equal(fs.readFileSync(prefs, 'utf8'), 'user_pref("x", true);\n');
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('removeProfileCompatibilityIni: no-op (no throw) when absent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fxs-e2e-hygiene-'));
  try {
    removeProfileCompatibilityIni(dir, {log: () => {}});
    assert.ok(fs.existsSync(dir));
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

// ── closeBrowser: close + OS-process exit wait ───────────────────────────────

test('closeBrowser: waits for the process to exit after close', async () => {
  let closed = false;
  const proc = {exitCode: null, signalCode: null, kill: () => {}};
  const browser = {
    close: async () => {
      closed = true;
      // Simulate the OS process exiting shortly after the BiDi close.
      setTimeout(() => (proc.exitCode = 0), 20);
    },
    process: () => proc,
  };
  const started = Date.now();
  await closeBrowser(browser, {timeoutMs: 2000});
  assert.ok(closed, 'close() was called');
  assert.ok(Date.now() - started >= 15, 'waited for the exit instead of resolving early');
});

test('closeBrowser: resolves immediately when the process already exited', async () => {
  const browser = {
    close: async () => {},
    process: () => ({exitCode: 0, signalCode: null, kill: () => assert.fail('no kill')}),
  };
  await closeBrowser(browser, {timeoutMs: 2000});
});

test('closeBrowser: kills a browser whose process never exits', async () => {
  let killed = false;
  const browser = {
    close: async () => {},
    process: () => ({
      exitCode: null,
      signalCode: null,
      kill: () => {
        killed = true;
      },
    }),
  };
  await closeBrowser(browser, {timeoutMs: 150});
  assert.ok(killed, 'fallback kill fired after the timeout');
});

test('closeBrowser: null/undefined and close()-throwing browsers are safe', async () => {
  await closeBrowser(null, {timeoutMs: 100});
  await closeBrowser(undefined, {timeoutMs: 100});
  await closeBrowser(
    {
      close: async () => {
        throw new Error('already disconnected');
      },
      process: () => null,
    },
    {timeoutMs: 100}
  );
});

// ── killStrayProcesses: the sweep with a STUBBED OS runner ─────────────────
// The real sweep kills matching processes — unit tests must never execute it
// (a live E2E on the same machine would be terminated). The runner is
// injected, so the win32 and POSIX branches are both tested on any host.

test('killStrayProcesses: win32 branch counts the PowerShell PID lines', async () => {
  const seen = [];
  const killed = await killStrayProcesses({
    platform: 'win32',
    run: (cmd, args) => {
      seen.push({cmd, args: [...args]});
      return {status: 0, stdout: '123:firefox.exe\n456:installer_win.exe\n'};
    },
  });
  assert.equal(killed, 2);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].cmd, 'powershell.exe');
  // Two -match clauses: the fxs- markers anywhere, plus the argv[0]-anchored
  // installer branch (same matcher as isE2eProcess).
  assert.match(seen[0].args.at(-1), /fxs-\(e2e\|installer-ui\)/);
  assert.match(seen[0].args.at(-1), /\^\(\?:/);
  assert.match(seen[0].args.at(-1), /installer_\(win\|linux\|mac\)/);
});

test('killStrayProcesses: win32 branch with nothing matched', async () => {
  const logs = [];
  const killed = await killStrayProcesses({
    log: m => logs.push(m),
    platform: 'win32',
    run: () => ({status: 0, stdout: ''}),
  });
  assert.equal(killed, 0);
  assert.match(logs[0], /no stray processes/);
});

test('killStrayProcesses: POSIX match reports ≥1 without a count (pkill prints nothing)', async () => {
  const logs = [];
  const killed = await killStrayProcesses({
    log: m => logs.push(m),
    platform: 'linux',
    run: () => ({status: 0, stdout: ''}),
  });
  assert.equal(killed, 1);
  assert.match(logs[0], /killed ≥1/);
});

test('killStrayProcesses: POSIX no-match (pkill exit 1) is the steady state', async () => {
  const logs = [];
  const killed = await killStrayProcesses({
    log: m => logs.push(m),
    platform: 'linux',
    run: () => ({status: 1, stdout: ''}),
  });
  assert.equal(killed, 0);
  assert.match(logs[0], /no stray processes/);
});

test('killStrayProcesses: sweep tooling failure is reported, not thrown', async () => {
  const logs = [];
  const killed = await killStrayProcesses({
    log: m => logs.push(m),
    platform: 'linux',
    run: () => ({status: 2, stdout: ''}),
  });
  assert.equal(killed, 0);
  assert.match(logs[0], /failed/);
});

test('killStrayProcesses: missing OS tooling is reported, not thrown', async () => {
  const logs = [];
  const killed = await killStrayProcesses({
    log: m => logs.push(m),
    platform: 'linux',
    run: () => {
      const e = new Error('spawn pkill ENOENT');
      return {error: e, status: null, stdout: ''};
    },
  });
  assert.equal(killed, 0);
  assert.match(logs[0], /unavailable/);
});
