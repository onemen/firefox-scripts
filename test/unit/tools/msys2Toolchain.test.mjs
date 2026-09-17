// test/unit/tools/msys2Toolchain.test.mjs — the pinned Windows toolchain
// (config/msys2-toolchain.json + tools/ci/msys2Toolchain.mjs).
//
// The pin is what makes the published Windows bytes reproducible (issue #157:
// unsigned PEs with a per-hash AV verdict), and the runner installs it with
// `pacman -U` + a version check. A malformed manifest would silently downgrade
// to "whatever MSYS2 has today", so the manifest is validated here — including
// against the live file, so a hand-edit that drops a package or a hash fails
// `pnpm test` instead of the next publish. The provenance assertions cover the
// other half: an installed-but-shadowed toolchain compiles different bytes, so
// "pinned" only means something once the build shell is checked too.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';

const {
  MANIFEST_PATH,
  REPO_ROOT,
  PINNED_TOOLS,
  REQUIRED_PACKAGES,
  TOOL_PACKAGE,
  expectedToolVersions,
  expectedVersionFor,
  findMsys2Install,
  msys2BinDirs,
  msys2RootCandidates,
  normalizeToolPath,
  optionValue,
  packageFileName,
  packageUrl,
  pacmanBin,
  parsePacmanQuery,
  parseWhich,
  prefixInstructions,
  tarArgs,
  provenanceReport,
  readManifest,
  runtimeVersions,
  validateManifest,
} = await import('../../../tools/ci/msys2Toolchain.mjs');

/** A minimal valid manifest, for mutation tests. */
function manifest(overrides = {}) {
  return {
    repos: {
      ucrt64: 'https://repo.msys2.org/mingw/ucrt64',
      msys: 'https://repo.msys2.org/msys/x86_64',
    },
    packages: REQUIRED_PACKAGES.map(name => ({
      name,
      version: '16.1.0-5',
      repo: 'ucrt64',
      arch: 'any',
      role: 'mingw',
      sha256: 'a'.repeat(64),
    })),
    ...overrides,
  };
}

test('the shipped manifest is valid', () => {
  assert.deepEqual(validateManifest(readManifest()), []);
});

test('the shipped manifest pins every required package at an exact version', () => {
  const {packages} = readManifest();
  const names = packages.map(p => p.name);
  for (const required of REQUIRED_PACKAGES) assert.ok(names.includes(required), required);
  // A version that is not pkgver-pkgrel is not a pin.
  for (const pkg of packages) assert.match(pkg.version, /^[0-9][\w.+-]*-[0-9]+$/, pkg.name);
  // The manifest is the only place the toolchain is described — a stale file
  // (no capture provenance) means nobody knows what it reproduces.
  assert.ok(readManifest().capturedFrom);
});

test('validateManifest rejects a duplicate package', () => {
  const m = manifest();
  m.packages.push({...m.packages[0]});
  assert.match(validateManifest(m).join('\n'), /duplicate package/);
});

test('validateManifest rejects a bad or missing sha256', () => {
  assert.match(validateManifest(manifest({packages: undefined})).join('\n'), /missing packages/);
  const m = manifest();
  m.packages[0].sha256 = 'nothex';
  assert.match(validateManifest(m).join('\n'), /sha256 must be 64 lowercase hex/);
});

test('validateManifest rejects a missing required package', () => {
  const m = manifest();
  m.packages = m.packages.filter(p => p.name !== 'mingw-w64-ucrt-x86_64-binutils');
  assert.match(validateManifest(m).join('\n'), /missing required package: .*binutils/);
});

test('validateManifest rejects a non-exact version, bad role and wrong repo prefix', () => {
  const m = manifest();
  m.packages[0].version = 'latest';
  m.packages[1].role = 'anything';
  m.packages[2].name = 'gcc';
  m.packages[2].repo = 'ucrt64';
  const problems = validateManifest(m).join('\n');
  assert.match(problems, /is not an exact MSYS2 pkgver-pkgrel/);
  assert.match(problems, /role must be 'mingw' or 'system'/);
  assert.match(problems, /ucrt64 packages are named mingw-w64-ucrt-x86_64-/);
});

test('validateManifest rejects an undeclared repo, a missing arch and a mingw package outside ucrt64', () => {
  const m = manifest();
  m.packages[0].repo = 'mingw64';
  m.packages[1].arch = undefined;
  m.packages[2].repo = 'msys';
  const problems = validateManifest(m).join('\n');
  assert.match(problems, /unknown repo 'mingw64' \(declared: ucrt64, msys\)/);
  assert.match(problems, /arch is required/);
  assert.match(problems, /mingw-w64-\* packages belong to the ucrt64 repo/);
});

test('validateManifest accepts an msys package that is not a mingw-w64-* one', () => {
  const m = manifest();
  m.packages.push({
    name: 'make',
    version: '4.4.1-3',
    repo: 'msys',
    arch: 'x86_64',
    role: 'system',
    sha256: 'b'.repeat(64),
  });
  assert.deepEqual(validateManifest(m), []);
});

test('packageFileName and packageUrl follow the MSYS2 naming rules', () => {
  const ucrt = {
    name: 'mingw-w64-ucrt-x86_64-gcc',
    version: '16.1.0-5',
    repo: 'ucrt64',
    arch: 'any',
  };
  assert.equal(packageFileName(ucrt), 'mingw-w64-ucrt-x86_64-gcc-16.1.0-5-any.pkg.tar.zst');
  assert.equal(
    packageUrl(ucrt, {ucrt64: 'https://repo.msys2.org/mingw/ucrt64'}),
    'https://repo.msys2.org/mingw/ucrt64/mingw-w64-ucrt-x86_64-gcc-16.1.0-5-any.pkg.tar.zst'
  );
  const msysMake = {name: 'make', version: '4.4.1-3', repo: 'msys', arch: 'x86_64'};
  assert.equal(packageFileName(msysMake), 'make-4.4.1-3-x86_64.pkg.tar.zst');
  assert.throws(() => packageUrl(msysMake, {}), /unknown repo 'msys'/);
});

test('parsePacmanQuery reads the installed version and tolerates absence', () => {
  const out = 'mingw-w64-ucrt-x86_64-gcc 16.1.0-5\nmingw-w64-ucrt-x86_64-binutils 2.46-4\n';
  assert.equal(parsePacmanQuery(out, 'mingw-w64-ucrt-x86_64-gcc'), '16.1.0-5');
  assert.equal(parsePacmanQuery(out, 'mingw-w64-ucrt-x86_64-gcc-libs'), null);
  assert.equal(parsePacmanQuery('error: package not found', 'make'), null);
});

test('prefixInstructions points at the extracted prefix and the installer Makefile', () => {
  // Derived from REPO_ROOT: an absolute fake path would make the expectation
  // depend on where the repo happens to be checked out.
  const lines = prefixInstructions(path.join(REPO_ROOT, 'dist', '.toolchain', 'ucrt64', 'bin'));
  assert.match(lines[0], /^export PATH="\$PWD\/dist\/\.toolchain\/ucrt64\/bin:\$PATH"$/);
  assert.match(lines[1], /make -C installer dist_win/);
});

test('the action writes $MINGW_PREFIX/bin to GITHUB_PATH last, so it wins', () => {
  // GITHUB_PATH lines take effect in REVERSE write order: the runner collects
  // them in file order (FileCommandManager.AddPathFileCommand) and joins the
  // list reversed before prepending it to PATH
  // (Handler.AddPrependPathToEnvironment), so the last write has the highest
  // precedence. MSYS2 also ships ld/as/windres in /usr/bin once its binutils is
  // installed, so writing the pinned dir first would let the MSYS copies shadow
  // the pinned ones — the whole point of the pin.
  const action = readFileSync(
    path.join(REPO_ROOT, '.github', 'actions', 'pinned-msys2', 'action.yml'),
    'utf8'
  );
  const writes = action
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('cygpath -w') && line.includes('$GITHUB_PATH'))
    .map(line => line.replace(/^cygpath -w /, '').replace(/ >> .*$/, ''));
  assert.deepEqual(writes, ['/usr/bin', '"$MINGW_PREFIX/bin"']);
});

test('the manifest path is the one the workflows install from', () => {
  assert.match(MANIFEST_PATH.replace(/\\/g, '/'), /config\/msys2-toolchain\.json$/);
});

// ── Provenance: is the pinned toolchain the one that actually builds? ───────
// Pinning installs files; provenance is what proves those files compile. The
// checks below are what the CI action runs against the build shell.

test('every tool the provenance check inspects maps to a pinned package', () => {
  const manifest = readManifest();
  const names = manifest.packages.map(p => p.name);
  for (const tool of PINNED_TOOLS) {
    assert.ok(TOOL_PACKAGE[tool], `${tool} has no package mapping`);
    assert.ok(names.includes(TOOL_PACKAGE[tool]), `${tool} → ${TOOL_PACKAGE[tool]} not pinned`);
  }
});

test('expectedToolVersions derives the reported versions from the pin', () => {
  const expected = expectedToolVersions(readManifest());
  // Versions come out of the manifest, so a bump cannot leave a stale assertion
  // behind: `16.1.0-5` → `16.1.0`, `2.46-4` → `2.46` (pkgrel dropped).
  assert.match(expected.gcc, /^\d+\.\d+\.\d+$/);
  assert.match(expected.binutils, /^[0-9.]+$/);
  assert.ok(expected.binutils.includes('.'), 'binutils version is x.y');
  assert.ok(expected.make, 'make must be pinned for `make --version` to be checked');
  assert.equal(expectedVersionFor('as', expected), expected.binutils);
  assert.equal(expectedVersionFor('windres', expected), expected.binutils);
  assert.equal(expectedVersionFor('gcc', expected), expected.gcc);
});

test('normalizeToolPath folds MSYS, Git-Bash and native Windows spellings', () => {
  const native = normalizeToolPath('C:\\msys64\\ucrt64\\bin');
  assert.equal(native, 'c:/msys64/ucrt64/bin');
  assert.equal(normalizeToolPath('c:/MSYS64/ucrt64/bin'), native);
  assert.equal(normalizeToolPath('/c/msys64/ucrt64/bin'), native);
});

test('parseWhich keeps paths and drops which diagnostics', () => {
  const output =
    '/c/msys64/ucrt64/bin/gcc\n/c/Program Files/mingw64/bin/gcc\n' +
    'which: no gcc2 in (/c/msys64/ucrt64/bin)\n\n';
  assert.deepEqual(parseWhich(output), [
    '/c/msys64/ucrt64/bin/gcc',
    '/c/Program Files/mingw64/bin/gcc',
  ]);
  assert.deepEqual(parseWhich(''), []);
});

/** The observation set a clean run produces, for mutation tests. */
function observed(overrides = {}) {
  const expected = {gcc: '16.1.0', binutils: '2.46', make: '4.4.1'};
  return {
    expected,
    roots: ['C:\\msys64\\ucrt64\\bin'],
    tools: [
      {
        name: 'gcc',
        path: '/c/msys64/ucrt64/bin/gcc',
        version: 'gcc.exe (Rev5, Built by MSYS2 project) 16.1.0',
        candidates: ['/c/msys64/ucrt64/bin/gcc'],
      },
      {
        name: 'ld',
        path: '/c/msys64/ucrt64/bin/ld',
        version: 'GNU ld (GNU Binutils) 2.46',
        candidates: ['/c/msys64/ucrt64/bin/ld'],
      },
      {
        name: 'windres',
        path: '/c/msys64/ucrt64/bin/windres',
        version: 'GNU windres (GNU Binutils) 2.46',
        candidates: ['/c/msys64/ucrt64/bin/windres'],
      },
      {
        name: 'make',
        path: '/c/msys64/usr/bin/make',
        version: 'GNU Make 4.4.1',
        candidates: ['/c/msys64/usr/bin/make'],
      },
    ],
    ...overrides,
  };
}

test('provenanceReport accepts a toolchain that is entirely the pinned one', () => {
  const report = provenanceReport(
    observed({roots: ['C:\\msys64\\ucrt64\\bin', 'C:\\msys64\\usr\\bin']})
  );
  assert.deepEqual(report.problems, []);
  assert.equal(report.ok, true);
  assert.equal(report.rows.find(r => r.name === 'gcc').ok, true);
});

test('provenanceReport rejects a tool from another toolchain', () => {
  // The failure mode that produced unreproducible bytes: an image mingw ahead
  // of MSYS2 on PATH. Same name, different version.
  const report = provenanceReport(
    observed({
      tools: observed().tools.map(t =>
        t.name === 'gcc' ?
          {
            ...t,
            path: '/c/Program Files/mingw64/bin/gcc',
            version: 'gcc.exe (MinGW-W64 x86_64-ucrt-posix-seh) 14.2.0',
          }
        : t
      ),
    })
  );
  assert.equal(report.ok, false);
  assert.match(report.problems.join('\n'), /gcc: reports '.*14\.2\.0', pinned 16\.1\.0/);
});

test('provenanceReport rejects a mixed compiler/linker pair', () => {
  const tools = observed().tools.map(t =>
    t.name === 'ld' ?
      {...t, path: '/c/Program Files/mingw64/bin/ld', version: 'GNU ld (GNU Binutils) 2.46'}
    : t
  );
  const report = provenanceReport(observed({tools}));
  assert.equal(report.ok, false);
  assert.match(report.problems.join('\n'), /resolve from 2 different directories/);
});

// ── Locating the install: the pin must not depend on the bootstrap's PATH ────
// `msys2/setup-msys2` defaults to `path-type: minimal` and installs through a
// private msys2.cmd, so the build steps can see neither pacman nor ucrt64/bin on
// PATH. These helpers locate the install instead of trusting it.

test('findMsys2Install accepts only a root that really holds the toolchain', () => {
  const present = new Set(['c:/msys64/ucrt64/bin/gcc.exe']);
  const exists = p => present.has(p);
  assert.equal(findMsys2Install({candidates: ['C:\\msys64'], exists}), 'c:/msys64');
  assert.equal(findMsys2Install({candidates: ['C:\\empty'], exists}), null);
  // Trailing separators and Git-Bash spellings of the same root both work.
  assert.equal(findMsys2Install({candidates: ['/c/msys64/'], exists}), 'c:/msys64');
});

test('msys2RootCandidates prefers the recorded location over a guess', () => {
  const roots = msys2RootCandidates({
    env: {MSYS2_LOCATION: 'D:\\tools\\msys64', RUNNER_TOOL_CACHE: 'C:\\hostedtoolcache'},
    pacman: '/c/msys64/usr/bin/pacman',
  });
  assert.equal(roots[0], 'D:\\tools\\msys64', 'the recorded location wins, unslugified');
  const normalized = roots.map(normalizeToolPath);
  assert.ok(normalized.includes('c:/hostedtoolcache/msys2-installer/msys64'));
  assert.ok(normalized.includes('c:/msys64'), 'the pacman location yields the install root');
  assert.ok(
    normalized.includes('c:/msys64') && roots.includes('C:/msys64'),
    'the default location stays as a last resort'
  );
  // A bare `pacman` (or a which failure) contributes no candidate.
  assert.deepEqual(msys2RootCandidates({env: {}, pacman: 'pacman'}), ['C:/msys64', 'C:/msys2']);
});

test('optionValue distinguishes a bare flag from a value and a following flag', () => {
  // `pnpm toolchain:local` passes --prefix bare; reading the next argument
  // blindly made that the string 'true' and extracted into a `true` directory.
  assert.equal(optionValue(['--prefix'], '--prefix'), '');
  assert.equal(optionValue(['--prefix', 'dist/pin'], '--prefix'), 'dist/pin');
  assert.equal(optionValue(['--prefix', '--provenance'], '--prefix'), '');
  assert.equal(optionValue(['--fetch'], '--prefix'), null);
  assert.equal(optionValue(['--prefix', 'C:\\msys64\\ucrt64'], '--prefix'), 'C:\\msys64\\ucrt64');
});

test('tarArgs never hands tar a drive-lettered file argument', () => {
  // GNU tar reads `D:/a/cache/x.pkg.tar.zst` as host `D` and fails with
  // "Cannot connect to D: resolve failed" — the exact CI failure that a local
  // bsdtar (Git-Bash) cannot reproduce, so it is pinned here instead.
  const root = path.join(REPO_ROOT, 'dist', '.toolchain-cache');
  const file = path.join(root, 'mingw-w64-ucrt-x86_64-binutils-2.46-4-any.pkg.tar.zst');
  const {args, cwd} = tarArgs({file, prefix: 'D:\\pin'});
  assert.deepEqual(args, [
    '-xf',
    'mingw-w64-ucrt-x86_64-binutils-2.46-4-any.pkg.tar.zst',
    '-C',
    'D:/pin',
  ]);
  assert.equal(cwd, root);
  assert.ok(!args[1].includes(':'), 'the file argument must stay colon-free');
  assert.ok(!args[3].includes('\\'), 'the destination must be forward-slashed for GNU tar');
});

test('msys2BinDirs lists the mingw dir before the msys dir', () => {
  assert.deepEqual(msys2BinDirs('c:/msys64/'), ['c:/msys64/ucrt64/bin', 'c:/msys64/usr/bin']);
});

test('pacmanBin falls back to PATH only when the install is unknown', () => {
  assert.equal(pacmanBin(null), 'pacman');
  assert.equal(pacmanBin('c:/definitely-not-here-12345'), 'pacman');
});

test('runtimeVersions reports the Node/zlib pair that shapes resources.h', () => {
  // resources.h is gzip-compressed by Node at build time, so the runtime is a
  // build input the MSYS2 pin does not cover — it is reported, never assumed.
  assert.deepEqual(runtimeVersions({node: '24.9.0', zlib: '1.3.1'}), {
    node: '24.9.0',
    zlib: '1.3.1',
  });
  const live = runtimeVersions();
  assert.ok(live.node, 'the running Node version is reported');
  assert.ok(live.zlib, 'the bundled zlib version is reported');
});

test('provenanceReport rejects a missing tool and a foreign prefix', () => {
  const missing = observed({
    tools: observed().tools.map(t => ({...t, path: t.name === 'make' ? '' : t.path})),
  });
  assert.match(provenanceReport(missing).problems.join('\n'), /make: not found on PATH/);

  const foreign = provenanceReport(
    observed({
      roots: ['C:\\msys64\\ucrt64\\bin'],
      tools: observed().tools.map(t => ({
        ...t,
        path: t.path.replace('/c/msys64/', '/d/toolchain/'),
      })),
    })
  );
  assert.match(foreign.problems.join('\n'), /outside the pinned prefix/);
});
