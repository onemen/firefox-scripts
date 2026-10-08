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
  killProcessesByCmdline,
  killStrayProcesses,
  removeProfileCompatibilityIni,
  waitForProcessesGone,
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

test('INSTALLER_ARGV0_ERE: real grep -E (POSIX ERE) agrees with isE2eProcess', async t => {
  const {spawnSync, execFileSync} = await import('node:child_process');
  // Windows does not ship grep (the pkill branch of the sweep is dead code
  // there); skip rather than fail with ENOENT on hosts without one. Hosts with
  // a POSIX layer (Git Bash, WSL) still run the real check.
  const probe = spawnSync('grep', ['--version'], {encoding: 'utf8', timeout: 10_000});
  if (probe.error)
    return t.skip(`grep not available on this host (${probe.error.code ?? 'ENOENT'})`);
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

test('isE2eProcess: does NOT match commands that merely contain the name', () => {
  // A command that merely references the installer as an ARGUMENT must not
  // match: the binary has to be argv[0].
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

// ── killProcessesByCmdline (#384) ───────────────────────────────────────────
// Same seam contract as killStrayProcesses: the real sweep kills matching
// processes, so the runner is injected and both platform branches are tested
// on any host.

test('killProcessesByCmdline: win32 branch matches the needle via .Contains and counts kills', () => {
  const seen = [];
  const killed = killProcessesByCmdline('C:\\temp\\fxs-e2e-ABC123', {
    platform: 'win32',
    run: (cmd, args) => {
      seen.push({cmd, args: [...args]});
      return {status: 0, stdout: '123:firefox.exe\n456:firefox.exe\n'};
    },
  });
  assert.equal(killed, 2);
  assert.equal(seen[0].cmd, 'powershell.exe');
  const ps = seen[0].args.at(-1);
  // Plain containment (.Contains), no wildcard semantics, and the needle is
  // embedded.
  assert.match(ps, /\.Contains\('/);
  assert.ok(ps.includes('C:\\temp\\fxs-e2e-ABC123'));
});

test('killProcessesByCmdline: an apostrophe in the needle is doubled for PowerShell', () => {
  // A path like C:\Users\O'Brien\... would otherwise close the single-quoted
  // PowerShell string early; the command fails to parse and the sweep reads the
  // silence as "nothing matched". PowerShell escapes a quote by doubling it.
  const seen = [];
  killProcessesByCmdline("C:\\Users\\O'Brien\\fxs-e2e-ABC", {
    platform: 'win32',
    run: (cmd, args) => {
      seen.push({cmd, args: [...args]});
      return {status: 0, stdout: ''};
    },
  });
  const ps = seen[0].args.at(-1);
  assert.ok(ps.includes("O''Brien"), 'the apostrophe is doubled for PowerShell');
  assert.ok(!ps.includes("O'Brien"), 'the raw apostrophe never reaches the command');
});

test('killProcessesByCmdline: POSIX branch escapes regex specials in the needle', () => {
  const seen = [];
  const killed = killProcessesByCmdline('/tmp/fxs-e2e-ABC (1)', {
    platform: 'linux',
    run: (cmd, args) => {
      seen.push({cmd, args: [...args]});
      return {status: 0, stdout: ''};
    },
  });
  assert.equal(killed, 1);
  assert.equal(seen[0].cmd, 'pkill');
  assert.equal(seen[0].args[0], '-f');
  // Parentheses and the dot must be escaped for the ERE.
  assert.equal(seen[0].args[1], '/tmp/fxs-e2e-ABC \\(1\\)');
});

test('killProcessesByCmdline: a POSIX needle starting with a dash cannot be read as an option', () => {
  // pkill parses argv with getopt: `pkill -f --fxs-e2e-puppeteer-123` printed
  // usage and exited 2 (logged as "cmdline sweep failed (pkill exit 2)"), so
  // the launch-retry kill silently did NOTHING — every tag sweep on the macOS
  // and Ubuntu legs, while the Windows branch (PowerShell .Contains) worked.
  const seen = [];
  killProcessesByCmdline('--fxs-e2e-puppeteer-1790932692920', {
    platform: 'darwin',
    run: (cmd, args) => {
      seen.push({cmd, args: [...args]});
      return {status: 0, stdout: ''};
    },
  });
  assert.equal(seen[0].cmd, 'pkill');
  assert.equal(seen[0].args[0], '-f');
  // Same match, group-wrapped so the FIRST character is not a dash.
  assert.equal(seen[0].args[1], '(--fxs-e2e-puppeteer-1790932692920)');
  assert.ok(!seen[0].args[1].startsWith('-'), 'the pattern must not look like an option');
});

test('killProcessesByCmdline: POSIX no-match (exit 1) kills nothing and logs nothing', () => {
  const logs = [];
  const killed = killProcessesByCmdline('/tmp/fxs-e2e-NONE', {
    log: m => logs.push(m),
    platform: 'linux',
    run: () => ({status: 1, stdout: ''}),
  });
  assert.equal(killed, 0);
  assert.equal(logs.length, 0);
});

test('killProcessesByCmdline: empty needle is a no-op (refuses to match everything)', () => {
  const killed = killProcessesByCmdline('', {
    platform: 'win32',
    run: () => {
      throw new Error('must not spawn');
    },
  });
  assert.equal(killed, 0);
});

// ── waitForProcessesGone (#384 launch retry) ────────────────────────────────
// The retry must not start against a profile the killed browser still holds;
// the wait is the bounded gate that makes "the sweep did not work" visible
// instead of turning into a second 20 s wedge (macOS nightly, 2026-10-02).

test('waitForProcessesGone: POSIX reports gone as soon as pgrep stops matching', async () => {
  const seen = [];
  let calls = 0;
  const gone = await waitForProcessesGone('/tmp/fxs-e2e-ABC', {
    platform: 'linux',
    timeoutMs: 1000,
    intervalMs: 1,
    run: (cmd, args) => {
      seen.push({cmd, args: [...args]});
      calls++;
      // Matched once (exit 0 = still running), then gone (exit 1 = no match).
      return {status: calls === 1 ? 0 : 1, stdout: ''};
    },
  });
  assert.equal(gone, true);
  assert.equal(seen[0].cmd, 'pgrep');
  assert.deepEqual(seen[0].args, ['-f', '/tmp/fxs-e2e-ABC']);
  assert.equal(calls, 2, 'the wait polls until the needle stops matching');
});

test('waitForProcessesGone: a dash-leading needle is group-wrapped for pgrep too', async () => {
  const seen = [];
  await waitForProcessesGone('--fxs-e2e-puppeteer-123', {
    platform: 'darwin',
    timeoutMs: 100,
    intervalMs: 1,
    run: (cmd, args) => {
      seen.push({cmd, args: [...args]});
      return {status: 1, stdout: ''};
    },
  });
  assert.deepEqual(seen[0].args, ['-f', '(--fxs-e2e-puppeteer-123)']);
});

test('waitForProcessesGone: times out with a loud log when the tree never dies', async () => {
  const logs = [];
  const gone = await waitForProcessesGone('/tmp/fxs-e2e-STUCK', {
    platform: 'linux',
    timeoutMs: 20,
    intervalMs: 1,
    log: m => logs.push(m),
    label: 'wedged browser still holding the profile',
    run: () => ({status: 0, stdout: ''}),
  });
  assert.equal(gone, false);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /wedged browser still holding the profile/);
  assert.match(logs[0], /\/tmp\/fxs-e2e-STUCK/);
});

test('waitForProcessesGone: win32 branch counts the matching processes', async () => {
  const seen = [];
  let calls = 0;
  const gone = await waitForProcessesGone('C:\\Temp\\fxs-e2e-ABC', {
    platform: 'win32',
    timeoutMs: 1000,
    intervalMs: 1,
    run: (cmd, args) => {
      seen.push({cmd, args: [...args]});
      calls++;
      return {status: 0, stdout: calls === 1 ? '2\n' : '0\n'};
    },
  });
  assert.equal(gone, true);
  assert.equal(seen[0].cmd, 'powershell.exe');
  assert.match(seen[0].args.at(-1), /Measure-Object/);
  assert.ok(seen[0].args.at(-1).includes('C:\\Temp\\fxs-e2e-ABC'));
});

test('waitForProcessesGone: a failed probe is not "gone" on either platform', async () => {
  // A probe that could not answer must keep waiting: reading it as gone lets
  // the retry relaunch against a profile the killed browser still owns.
  const logs = [];
  const goneWin = await waitForProcessesGone('C:\\Temp\\fxs-e2e-ABC', {
    platform: 'win32',
    timeoutMs: 20,
    intervalMs: 1,
    log: m => logs.push(m),
    run: () => ({status: 1, stdout: ''}), // PowerShell errored: count unparseable
  });
  assert.equal(goneWin, false, 'a failed win32 probe times out instead of reporting gone');
  const gonePosix = await waitForProcessesGone('/tmp/fxs-e2e-ABC', {
    platform: 'linux',
    timeoutMs: 20,
    intervalMs: 1,
    log: m => logs.push(m),
    run: () => ({status: 2, stdout: ''}), // pgrep error (1 is the no-match exit)
  });
  assert.equal(gonePosix, false, 'a failed pgrep probe times out instead of reporting gone');
  assert.equal(logs.length, 2, 'both failures are logged loudly');
});

test('waitForProcessesGone: an empty needle is trivially gone (no spawn)', async () => {
  const gone = await waitForProcessesGone('', {
    run: () => {
      throw new Error('must not spawn');
    },
  });
  assert.equal(gone, true);
});
