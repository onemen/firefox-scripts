#!/usr/bin/env node

// tools/ci/msys2Toolchain.mjs — the pinned MSYS2 toolchain behind
// config/msys2-toolchain.json.
//
// Why this exists: the published Windows binaries are unsigned PEs whose AV
// verdict is per-hash (issue #157), so the bytes CI ships must be the bytes a
// developer can rebuild. `msys2/setup-msys2` with `update: false` only skips
// `pacman -Syu` — it still installs whatever versions the runner's package DB
// offers, so binutils/crt/headers floated under a pinned gcc and local builds
// differed from the CI artifact by ~4 KB of code and a whole import-table
// entry count (docs/DEVELOPING.md → "Why a clean local scan does not clear a CI
// build"). The manifest pins the WHOLE set, captured from a real CI run, with
// per-file SHA-256 so a rotted or tampered mirror fails loudly instead of
// silently changing shipped bytes.
//
// Three consumers, one manifest:
//
//   --install   (CI, Windows runner, after the msys2 bootstrap)  `pacman -U`
//               the pinned files, then assert every pinned version is the
//               installed one — the step that makes "pinned" true rather than
//               aspirational.
//   --verify    assert the installed versions match without changing anything.
//   --provenance  print (and assert) which gcc/ld/windres the shell actually
//               resolves, with the version each reports. `pacman -Q` says what
//               is installed; this says what compiles. The two can disagree
//               (an image toolchain earlier on PATH, a mixed compiler/linker
//               pair), which is how a "pinned" build still produced bytes the
//               pin could not reproduce.
//   --prefix    (local dev) extract the mingw packages into a project-local
//               prefix and print the PATH export: `make -C installer dist_win`
//               then builds with CI's exact gcc/binutils/crt/headers.
//   --print-bin  print the located install's `ucrt64/bin` + `usr/bin`, one per
//               line — what the CI action appends to $GITHUB_PATH so the pinned
//               toolchain outranks the runner image's for every later step.
//   --fetch     download (sha256-verified) into the cache; used by both paths,
//               and `--print-manifest` emits a refreshed manifest body.
//
// Dependency-free (Node's crypto + child_process only) so it runs on a bare
// runner and inside an MSYS2 shell.

import {spawnSync} from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {fileURLToPath, pathToFileURL} from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const REPO_ROOT = path.resolve(__dirname, '..', '..');
export const MANIFEST_PATH = path.join(REPO_ROOT, 'config', 'msys2-toolchain.json');
export const DEFAULT_CACHE = path.join(REPO_ROOT, 'dist', '.toolchain-cache');
export const DEFAULT_PREFIX = path.join(REPO_ROOT, 'dist', '.toolchain');

/** Packages a Windows build cannot work without (guards a truncated manifest). */
export const REQUIRED_PACKAGES = [
  'mingw-w64-ucrt-x86_64-gcc',
  'mingw-w64-ucrt-x86_64-gcc-libs',
  'mingw-w64-ucrt-x86_64-binutils',
  'mingw-w64-ucrt-x86_64-crt',
  'mingw-w64-ucrt-x86_64-headers',
];

/** Read + parse the pinned manifest. */
export function readManifest(manifestPath = MANIFEST_PATH) {
  return JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
}

/** Package file name on the MSYS2 repo: `<name>-<version>-<arch>.pkg.tar.zst`. */
export function packageFileName(pkg) {
  return `${pkg.name}-${pkg.version}-${pkg.arch}.pkg.tar.zst`;
}

/** Full download URL for a pinned package. */
export function packageUrl(pkg, repos) {
  const base = repos[pkg.repo];
  if (!base)
    throw new Error(`unknown repo '${pkg.repo}' (known: ${Object.keys(repos).join(', ')})`);
  return `${base}/${packageFileName(pkg)}`;
}

/**
 * Structural validation of a manifest. Returns an array of problem strings
 * (empty = valid) so callers can fail with every issue at once — and so the
 * unit test can assert on specific rejections.
 */
export function validateManifest(manifest) {
  const problems = [];
  if (!manifest || typeof manifest !== 'object') return ['manifest is not an object'];
  const {packages, repos} = manifest;
  if (!repos || typeof repos !== 'object' || Object.keys(repos).length === 0) {
    problems.push('missing repos map');
  }
  if (!Array.isArray(packages) || packages.length === 0) return [...problems, 'missing packages'];

  const seen = new Set();
  for (const pkg of packages) {
    const label = pkg?.name || '(unnamed)';
    if (!pkg?.name || !pkg?.version || !pkg?.repo) {
      problems.push(`${label}: name, version and repo are required`);
      continue;
    }
    if (seen.has(pkg.name)) problems.push(`${label}: duplicate package`);
    seen.add(pkg.name);
    if (!/^[0-9a-f]{64}$/.test(pkg.sha256 || '')) {
      problems.push(`${label}: sha256 must be 64 lowercase hex chars`);
    }
    if (pkg.role !== 'mingw' && pkg.role !== 'system') {
      problems.push(`${label}: role must be 'mingw' or 'system'`);
    }
    // Fail closed on the structural slips a hand-edited pin invites: a repo the
    // manifest does not declare, a package without an arch (its download URL
    // would silently become `…-undefined.pkg.tar.zst`), and either direction of
    // a name/repo mismatch — MSYS packages live under /msys and mingw-w64-*
    // packages in a mingw repo, so a copy-paste between them is a real slip.
    // (A `packageFileName(pkg).endsWith(...)` check used to sit here; it could
    // never fire, because packageFileName builds that exact suffix.)
    if (!repos?.[pkg.repo]) {
      const declared = Object.keys(repos ?? {}).join(', ') || 'none';
      problems.push(`${label}: unknown repo '${pkg.repo}' (declared: ${declared})`);
    }
    if (!pkg.arch) {
      problems.push(`${label}: arch is required`);
    }
    if (pkg.repo === 'ucrt64' && !pkg.name.startsWith('mingw-w64-ucrt-x86_64-')) {
      problems.push(`${label}: ucrt64 packages are named mingw-w64-ucrt-x86_64-*`);
    }
    if (pkg.repo !== 'ucrt64' && pkg.name.startsWith('mingw-w64-')) {
      problems.push(`${label}: mingw-w64-* packages belong to the ucrt64 repo`);
    }
  }
  for (const required of REQUIRED_PACKAGES) {
    if (!seen.has(required)) problems.push(`missing required package: ${required}`);
  }
  // A pin is only a pin if versions are exact: MSYS2 versions are
  // `[epoch:]pkgrel` strings, and a floating suffix would defeat the point.
  for (const pkg of packages) {
    if (pkg?.version && !/^[0-9][\w.+-]*-[0-9]+$/.test(pkg.version)) {
      problems.push(`${pkg.name}: version '${pkg.version}' is not an exact MSYS2 pkgver-pkgrel`);
    }
  }
  return problems;
}

/** SHA-256 of a file, lowercase hex. */
export function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * Download every pinned package into `dir` (cached), verifying SHA-256. Returns
 * the local file paths in manifest order. A checksum mismatch or a missing file
 * throws — never a "close enough" toolchain.
 */
export async function fetchPackages({manifest, dir = DEFAULT_CACHE, log = console.log} = {}) {
  fs.mkdirSync(dir, {recursive: true});
  const files = [];
  for (const pkg of manifest.packages) {
    const file = path.join(dir, packageFileName(pkg));
    if (fs.existsSync(file) && sha256File(file) === pkg.sha256) {
      log(`  cached  ${packageFileName(pkg)}`);
      files.push(file);
      continue;
    }
    const url = packageUrl(pkg, manifest.repos);
    log(`  fetch   ${packageFileName(pkg)}`);
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(
        `download failed for ${packageFileName(pkg)}: HTTP ${res.status} — ${url}\n` +
          `  A pinned package can disappear from the MSYS2 repos. Refresh the pin ` +
          `deliberately (config/msys2-toolchain.json) and re-verify the AV/VT gates.`
      );
    }
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    const actual = sha256File(file);
    if (actual !== pkg.sha256) {
      fs.rmSync(file, {force: true});
      throw new Error(
        `sha256 mismatch for ${packageFileName(pkg)}: expected ${pkg.sha256}, got ${actual}`
      );
    }
    files.push(file);
  }
  return files;
}

/** True on a Windows host (the pin exists for the Windows build only). */
export function isWindows(platform = process.platform) {
  return platform === 'win32';
}

/**
 * Parse `pacman -Q <name>` output (`<name> <version>`) for one package. Returns
 * the installed version, or null when the package is not installed.
 */
export function parsePacmanQuery(output, name) {
  for (const line of String(output || '').split(/\r?\n/)) {
    const [pkgName, version] = line.trim().split(/\s+/);
    if (pkgName === name) return version;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Provenance: which toolchain does this shell actually build with?
//
// Pinning installs the right files; provenance proves they are the ones that
// run. The published Windows binaries are unsigned PEs judged per-hash
// (issue #157), so "the pinned gcc built this" has to be a fact in the CI log,
// not an assumption about PATH. run 34935654811 is the cautionary tale: its
// installed package set and its artifacts disagreed, and nothing in the log
// could say which compiler produced the uploaded bytes.
// ---------------------------------------------------------------------------

/** The tools a Windows installer build resolves through PATH. */
export const PINNED_TOOLS = ['gcc', 'ld', 'as', 'windres', 'make'];

/**
 * The tools that must form ONE toolchain: a compiler paired with another
 * install's linker/assembler/resource-compiler is the mix that silently changes
 * bytes. `make` is deliberately excluded — it is an MSYS package and lives in
 * `/usr/bin`, not beside the mingw tools in `/ucrt64/bin`.
 */
export const TOOLCHAIN_CORE = ['gcc', 'ld', 'as', 'windres'];

/** Which manifest package's version each tool must report. */
export const TOOL_PACKAGE = {
  gcc: 'mingw-w64-ucrt-x86_64-gcc',
  ld: 'mingw-w64-ucrt-x86_64-binutils',
  as: 'mingw-w64-ucrt-x86_64-binutils',
  windres: 'mingw-w64-ucrt-x86_64-binutils',
  make: 'make',
};

/**
 * Normalize a toolchain path so MSYS, Git-Bash and native Windows spellings of
 * the same directory compare equal: `C:\\msys64\\ucrt64\\bin`,
 * `c:/msys64/ucrt64/bin` and `/ucrt64/bin` are all recognized (the last one
 * only as a suffix, see provenanceReport). Lowercased, forward slashes.
 */
export function normalizeToolPath(p) {
  return String(p || '')
    .replace(/\\/g, '/')
    .replace(/^\/([a-zA-Z])\//, '$1:/')
    .toLowerCase();
}

/** Split `which -a <tool>` output into absolute candidate paths. */
export function parseWhich(output) {
  return String(output || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !/^which:/.test(line) && line.includes('/'));
}

/**
 * The version each tool must report, taken from the manifest (pkgrel dropped:
 * `16.1.0-5` → `16.1.0`, `2.46-4` → `2.46`). Deriving it from the manifest
 * keeps the assertion in step with the pin instead of hardcoding versions.
 */
export function expectedToolVersions(manifest) {
  const versionOf = name => {
    const version = manifest.packages.find(p => p.name === name)?.version || '';
    return version.replace(/^[^:]*:/, '').replace(/-[0-9]+$/, '');
  };
  return {
    gcc: versionOf(TOOL_PACKAGE.gcc),
    binutils: versionOf(TOOL_PACKAGE.ld),
    make: versionOf(TOOL_PACKAGE.make),
  };
}

/** The expected family version for one tool, or null when nothing is pinned. */
export function expectedVersionFor(tool, expected) {
  const family =
    tool === 'gcc' ? 'gcc'
    : tool === 'make' ? 'make'
    : 'binutils';
  return expected?.[family] || null;
}

/**
 * Judge what a shell resolved. Pure: takes the observations, returns a report.
 *
 * Each tool is `{name, path, version, candidates}` (path = first hit from
 * `which -a`, version = first line of `<tool> --version`). A toolchain is
 * provenance-clean when every tool exists, reports the pinned family version,
 * and the core tools (`TOOLCHAIN_CORE` — compiler, linker, assembler, windres)
 * all come from ONE bin directory that `roots`, when given, recognizes. `make`
 * is version-checked but may live elsewhere (it ships as an MSYS package).
 */
export function provenanceReport({tools, expected = {}, roots = []} = {}) {
  const problems = [];
  const rows = [];
  const dirs = new Map();
  const normRoots = roots
    .map(normalizeToolPath)
    .map(r => r.replace(/^\/+/, ''))
    .filter(Boolean);

  for (const tool of tools) {
    const {name, path: toolPath, version = '', candidates = []} = tool;
    if (!toolPath) {
      problems.push(`${name}: not found on PATH`);
      rows.push({name, path: '(not found)', version: '', ok: false});
      continue;
    }
    const norm = normalizeToolPath(toolPath);
    const dir = norm.replace(/\/[^/]*$/, '');
    if (TOOLCHAIN_CORE.includes(name)) {
      if (!dirs.has(dir)) dirs.set(dir, []);
      dirs.get(dir).push(name);
    }

    const want = expectedVersionFor(name, expected);
    // A missing version for a core tool would otherwise pass as "nothing pinned".
    if (TOOLCHAIN_CORE.includes(name) && !want) {
      problems.push(`${name}: no pinned version in the manifest to check against`);
    }
    const versionOk = !want || version.includes(want);
    if (!versionOk) {
      problems.push(
        `${name}: reports '${version || '(no version)'}', pinned ${want} — not the pinned ` +
          `toolchain (an image toolchain earlier on PATH, or an unpinned MSYS2 install)`
      );
    }
    rows.push({name, path: toolPath, version, ok: versionOk, candidates});
  }

  // One bin directory for the core toolchain: a mixed pair (compiler from one
  // install, linker from another) is how reproducible pinning quietly fails.
  if (dirs.size > 1) {
    problems.push(
      `the compiler/linker/assembler resolve from ${dirs.size} different directories: ` +
        [...dirs].map(([d, names]) => `${d} (${names.join(', ')})`).join('; ')
    );
  }

  const rootDir = dirs.size === 1 ? [...dirs.keys()][0] : '';
  if (rootDir && normRoots.length > 0) {
    const recognized = normRoots.some(root => rootDir.endsWith(root));
    if (!recognized) {
      problems.push(
        `the toolchain lives in ${rootDir}, outside the pinned prefix (${normRoots.join(', ')})`
      );
    }
  }

  return {ok: problems.length === 0, dir: rootDir, rows, problems};
}

/**
 * Observe the live toolchain: resolve each tool through PATH and ask it for its
 * version. Thin by design — provenanceReport holds the logic. `resolvePath` is
 * injectable so the version lookup itself is the only PATH-dependent part.
 */
export function collectProvenance({
  tools = PINNED_TOOLS,
  resolvePath = whichAllTool,
  run = defaultRunner,
} = {}) {
  return tools.map(name => {
    const candidates = resolvePath(name);
    const version = (run(name, ['--version']) || '').split(/\r?\n/)[0].trim();
    return {name, path: candidates[0] || '', version, candidates};
  });
}

/** Default process runner for collectProvenance: never throws, returns stdout. */
function defaultRunner(cmd, args) {
  // Guard against command injection: only ever spawn one of the pinned,
  // hard-coded toolchain binaries — never an arbitrary/user-influenced string.
  if (!PINNED_TOOLS.includes(cmd)) {
    return '';
  }
  const res = spawnSync(cmd, args, {encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe']});
  return res.stdout || '';
}

/**
 * The Node runtime behind the build. Not part of the MSYS2 pin, but a byte
 * input all the same: `installer/embed.mjs` gzip-compresses the embedded web
 * assets with `zlib.gzipSync`, so a different Node (and therefore a different
 * bundled zlib) can change resources.h — and with it the installer bytes and
 * hashes — while every source file stays identical. CI pins the Node major
 * (`node-version: 24`); the log records the exact pair so a local rebuild can
 * match it.
 */
export function runtimeVersions(versions = process.versions) {
  return {node: versions.node || '', zlib: versions.zlib || ''};
}

/** SHA-256 of a resolved tool, or null when the path is not readable. */
export function toolDigest(toolPath, sha = sha256File) {
  try {
    return sha(toolPath);
  } catch {
    return null;
  }
}

/**
 * Locate the MSYS2 install. Deliberately independent of PATH:
 * `msys2/setup-msys2` defaults to `path-type: minimal` and does its own
 * installing through a private `msys2.cmd`, so a later `shell: bash` step can
 * see neither `pacman` nor `ucrt64/bin` on PATH — which is exactly how a
 * "pinned" build silently compiles with the runner image's toolchain. A
 * candidate root counts only when it really holds the mingw toolchain
 * (`ucrt64/bin/gcc.exe`).
 *
 * Returns the root with forward slashes, or null when nothing matched.
 */
export function findMsys2Install({candidates = [], exists = fs.existsSync} = {}) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const root = normalizeToolPath(candidate).replace(/\/+$/, '');
    if (exists(`${root}/ucrt64/bin/gcc.exe`)) return root;
  }
  return null;
}

/** The two PATH directories of an MSYS2 install, highest priority first. */
export function msys2BinDirs(root) {
  const base = String(root).replace(/\/+$/, '');
  return [`${base}/ucrt64/bin`, `${base}/usr/bin`];
}

/** Candidate MSYS2 roots, best evidence first (pure: caller supplies the probe). */
export function msys2RootCandidates({env = process.env, pacman = ''} = {}) {
  const candidates = [];
  if (env.MSYS2_LOCATION) candidates.push(env.MSYS2_LOCATION);
  if (env.MSYS2_ROOT) candidates.push(env.MSYS2_ROOT);
  if (env.RUNNER_TOOL_CACHE) {
    candidates.push(`${env.RUNNER_TOOL_CACHE}/msys2-installer/msys64`);
  }
  // <root>/usr/bin/pacman[.exe] sits two levels below the root.
  if (pacman && /[/\\]/.test(pacman)) {
    const dir = normalizeToolPath(pacman).replace(/\/[^/]*$/, '');
    if (dir.endsWith('/usr/bin')) candidates.push(dir.slice(0, -'/usr/bin'.length));
  }
  candidates.push('C:/msys64', 'C:/msys2');
  // Note for the CI action: the bootstrap does NOT install to C:\msys64 (it
  // extracts into the tool cache / a temp dir), so the msys2 shell — which
  // knows its own root — exports MSYS2_LOCATION for the tool to read.
  return candidates;
}

/** Absolute pacman path inside a located install (falls back to PATH). */
export function pacmanBin(root) {
  if (!root) return 'pacman';
  for (const candidate of [`${root}/usr/bin/pacman.exe`, `${root}/usr/bin/pacman`]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'pacman';
}

/**
 * Every PATH match for a tool, preferring Windows' `where -a` and falling back
 * to `which -a` (which every Git-Bash/MSYS2 shell provides).
 */
function whichAllTool(name) {
  const where = spawnSync('where', ['-a', name], {encoding: 'utf-8'});
  const fromWhere = parseWhich(String(where.stdout || '').replace(/\\/g, '/'));
  if (fromWhere.length > 0) return fromWhere;
  const which = spawnSync('which', ['-a', name], {encoding: 'utf-8'});
  return parseWhich(which.stdout);
}

/** First PATH match for a tool, or '' when absent. */
function whichTool(name) {
  return whichAllTool(name)[0] || '';
}

/**
 * pacman invocation against a located install. Fails with the candidates it
 * tried rather than a bare "exit null": a runner whose MSYS2 lives somewhere
 * unexpected must say so, not look like a pacman crash.
 */
function pacman(args, opts = {}) {
  const candidates = msys2RootCandidates({pacman: whichTool('pacman')});
  const root = findMsys2Install({candidates});
  if (!root) {
    const envs = ['MSYS2_LOCATION', 'MSYS2_ROOT', 'RUNNER_TOOL_CACHE'].filter(k => process.env[k]);
    throw new Error(
      `could not locate the MSYS2 install — no ucrt64/bin/gcc.exe under: ${candidates.join(', ')}\n` +
        `  export MSYS2_LOCATION with the install root (the msys2 shell's \`cygpath -m /\`)` +
        (envs.length > 0 ? `; seen: ${envs.map(k => `${k}=${process.env[k]}`).join(', ')}` : '')
    );
  }
  const res = spawnSync(pacmanBin(root), args, {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  });
  if (res.error) {
    throw new Error(`could not run ${pacmanBin(root)} (${res.error.message})`);
  }
  return res;
}

/**
 * Install the pinned packages over whatever the runner installed (a downgrade
 * is expected and fine: `pacman -U` accepts an older file), then assert every
 * pinned version is the installed one.
 */
export function installPinned({manifest, files, verify = true, log = console.log} = {}) {
  log(`  pacman -U ${files.length} pinned package(s)`);
  const up = pacman(['-U', '--noconfirm', ...files]);
  if (up.status !== 0) {
    throw new Error(`pacman -U failed (exit ${up.status}):\n${up.stdout || ''}${up.stderr || ''}`);
  }
  if (verify) verifyInstalled({manifest, log});
}

/** Assert every pinned package is installed at exactly its pinned version. */
export function verifyInstalled({manifest, log = console.log} = {}) {
  const drifts = [];
  for (const pkg of manifest.packages) {
    const res = pacman(['-Q', pkg.name]);
    const installed = parsePacmanQuery(res.stdout, pkg.name);
    if (installed !== pkg.version) {
      drifts.push(`  ${pkg.name}: pinned ${pkg.version}, installed ${installed ?? '(missing)'}`);
    }
  }
  if (drifts.length > 0) {
    throw new Error(
      `installed MSYS2 toolchain does not match config/msys2-toolchain.json:\n${drifts.join('\n')}\n` +
        `  A published build with an unpinned toolchain is exactly the AV lottery the pin exists to stop.`
    );
  }
  log(`  verified ${manifest.packages.length} pinned package version(s)`);
}

/**
 * The tar invocation for one package archive. Split out because the argument
 * shape is load-bearing, not cosmetic: GNU tar (what an MSYS2 shell provides,
 * and the CI action now puts that shell's tools first on PATH) treats a
 * `host:path` file argument as an rsh target — `-f D:/a/…` fails with "Cannot
 * connect to D: resolve failed". Passing the bare file name with the cache dir
 * as cwd keeps the file argument colon-free for every tar flavour (bsdtar,
 * which Git-Bash ships, would accept either, so only CI caught this).
 */
export function tarArgs({file, prefix}) {
  // Forward slashes for the destination too: MSYS2/Git GNU tar escapes a
  // backslashy `-C C:\dir` into a literal name and reports it as unopenable.
  const dest = String(prefix).replace(/\\/g, '/');
  return {args: ['-xf', path.basename(file), '-C', dest], cwd: path.dirname(file)};
}

/**
 * Read an option that is meaningful BOTH bare and with a value: `--prefix`
 * extracts to the default prefix, `--prefix <dir>` to a chosen one. Returns the
 * value, '' when the flag was given bare, or null when it is absent. A
 * following `--flag` is never swallowed as the value — `--prefix` bare used to
 * become the string 'true' and extracted into a directory called `true`.
 */
export function optionValue(argv, name) {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  const next = argv[i + 1];
  return next === undefined || next.startsWith('--') ? '' : next;
}

/**
 * Extract the mingw packages into a project-local prefix (dev machines without
 * an MSYS2 install, or a developer reproducing CI bytes). MSYS2 mingw package
 * archives carry a `ucrt64/` tree, so the prefix ends up
 * `<prefix>/ucrt64/bin/gcc` — put that bin dir first on PATH and the Makefile's
 * `CC ?= gcc` / `WINDRES ?= windres` resolve to the pinned ones.
 */
export function extractPrefix({manifest, files, prefix = DEFAULT_PREFIX, log = console.log} = {}) {
  const mingw = manifest.packages.filter(p => p.role === 'mingw');
  fs.mkdirSync(prefix, {recursive: true});
  for (const pkg of mingw) {
    const base = packageFileName(pkg);
    const file = files.find(f => path.basename(f) === base);
    if (!file) throw new Error(`missing downloaded file for ${base}`);
    const {args, cwd} = tarArgs({file, prefix});
    const res = spawnSync('tar', args, {encoding: 'utf-8', cwd});
    if (res.status !== 0) {
      throw new Error(
        `tar failed for ${base} in ${cwd} (exit ${res.status}): ${res.stderr || res.error?.message || ''}`
      );
    }
    log(`  extract ${base}`);
  }
  return path.join(prefix, 'ucrt64', 'bin');
}

/** The exact env lines a developer needs after extractPrefix(). */
export function prefixInstructions(binDir) {
  const rel = path.relative(REPO_ROOT, binDir).split(path.sep).join('/');
  return [
    `export PATH="$PWD/${rel}:$PATH"`,
    'make -C installer dist_win   # or: pnpm upload:local -- --mode=dev',
  ];
}

/** Manifest body for `--print-manifest`: same versions, freshly computed hashes. */
export function renderManifestBody(manifest, files) {
  const packages = manifest.packages.map(pkg => {
    const file = files.find(f => path.basename(f) === packageFileName(pkg));
    if (!file) throw new Error(`missing downloaded file for ${packageFileName(pkg)}`);
    return {...pkg, sha256: sha256File(file)};
  });
  return JSON.stringify({...manifest, packages}, null, 2);
}

const isCli =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isCli) {
  const argv = process.argv.slice(2);
  // --print-bin only locates the MSYS2 install, so it must work even when the
  // manifest cannot be read: the action sets PATH with it, and a broken pin
  // should fail on its own terms (--install/--verify), not by hiding PATH here.
  if (argv.includes('--print-bin')) {
    const candidates = msys2RootCandidates({pacman: whichTool('pacman')});
    const root = findMsys2Install({candidates});
    if (!root) {
      console.error(
        `✗ could not locate an MSYS2 install — no ucrt64/bin/gcc.exe under: ${candidates.join(', ')}`
      );
      process.exit(1);
    }
    for (const dir of msys2BinDirs(root)) console.log(dir);
    process.exit(0);
  }

  const manifest = readManifest();
  const problems = validateManifest(manifest);
  if (problems.length > 0) {
    console.error(`config/msys2-toolchain.json is invalid:\n  ${problems.join('\n  ')}`);
    process.exit(2);
  }
  const cache = optionValue(argv, '--dir') || DEFAULT_CACHE;
  const prefix = optionValue(argv, '--prefix') || DEFAULT_PREFIX;

  const run = async () => {
    console.log(
      `pinned MSYS2 toolchain — ${manifest.packages.length} package(s), captured from ${manifest.capturedFrom}`
    );
    if (argv.includes('--check')) {
      console.log('✓ manifest valid');
      return;
    }
    if (argv.includes('--provenance')) {
      // No downloads: this inspects the shell that is about to build.
      const roots = [];
      for (let i = 0; i < argv.length; i++) {
        if (argv[i] !== '--require-root') continue;
        const value = argv[i + 1];
        // A valueless --require-root would silently disable the check (an
        // empty root matches every directory).
        if (!value || value.startsWith('--')) {
          throw new Error('--require-root needs a directory (the pinned toolchain bin dir)');
        }
        roots.push(value);
      }
      const tools = collectProvenance();
      const expected = expectedToolVersions(manifest);
      const report = provenanceReport({tools, expected, roots});
      const runtime = runtimeVersions();
      console.log(
        `  pinned: gcc ${expected.gcc}, binutils ${expected.binutils}, make ${expected.make}`
      );
      console.log(
        `  runtime: node ${runtime.node}, zlib ${runtime.zlib} (gzip inputs of resources.h)`
      );
      for (const row of report.rows) {
        const digest = toolDigest(row.path);
        const short = digest ? ` sha256:${digest.slice(0, 12)}` : '';
        console.log(`  ${row.ok ? '✓' : '✗'} ${row.name.padEnd(7)} ${row.path}${short}`);
        if (row.version) console.log(`      ${row.version}`);
        if (row.candidates.length > 1) {
          console.log(`      also on PATH: ${row.candidates.slice(1).join(', ')}`);
        }
      }
      if (!report.ok) {
        throw new Error(`toolchain provenance check failed:\n  ${report.problems.join('\n  ')}`);
      }
      console.log(`✓ ${tools.length} tools from ${report.dir} report the pinned versions`);
      return;
    }
    const files = await fetchPackages({manifest, dir: cache});
    if (argv.includes('--fetch')) {
      if (argv.includes('--print-manifest')) console.log(renderManifestBody(manifest, files));
      else console.log(`✓ ${files.length} package(s) cached in ${path.relative(REPO_ROOT, cache)}`);
      return;
    }
    if (argv.includes('--install')) {
      if (!isWindows()) throw new Error('--install targets a Windows runner (MSYS2 pacman)');
      installPinned({manifest, files});
      console.log('✓ pinned toolchain installed');
      return;
    }
    if (argv.includes('--verify')) {
      verifyInstalled({manifest});
      console.log('✓ installed toolchain matches the pin');
      return;
    }
    if (argv.includes('--prefix')) {
      const binDir = extractPrefix({manifest, files, prefix});
      console.log(
        `\n✓ pinned toolchain extracted → ${path.relative(REPO_ROOT, path.dirname(binDir))}`
      );
      for (const line of prefixInstructions(binDir)) console.log(`  ${line}`);
      return;
    }
    console.log(
      'nothing to do — pass --check | --provenance | --fetch [--print-manifest] | --install | --verify | --prefix'
    );
  };

  run().catch(err => {
    console.error(`✗ ${err.message}`);
    process.exit(1);
  });
}
