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
    // A repo URL that does not match the package's own prefix is the classic
    // copy-paste slip in a pinned manifest (msys packages live under /msys).
    if (
      repos?.[pkg.repo] &&
      pkg.arch &&
      !packageFileName(pkg).endsWith(`-${pkg.arch}.pkg.tar.zst`)
    ) {
      problems.push(`${label}: arch '${pkg.arch}' does not match the file name`);
    }
    if (pkg.repo === 'ucrt64' && !pkg.name.startsWith('mingw-w64-ucrt-x86_64-')) {
      problems.push(`${label}: ucrt64 packages are named mingw-w64-ucrt-x86_64-*`);
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
  const normRoots = roots.map(normalizeToolPath).map(r => r.replace(/^\/+/, ''));

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
 * Observe the live toolchain: resolve each tool through PATH (`which -a`) and
 * ask it for its version. Thin by design — provenanceReport holds the logic.
 */
export function collectProvenance({tools = PINNED_TOOLS, run = defaultRunner} = {}) {
  return tools.map(name => {
    const candidates = parseWhich(run('which', ['-a', name]));
    const version = (run(name, ['--version']) || '').split(/\r?\n/)[0].trim();
    return {name, path: candidates[0] || '', version, candidates};
  });
}

/** Default process runner for collectProvenance: never throws, returns stdout. */
function defaultRunner(cmd, args) {
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

/** pacman binary: MSYS2 puts it on PATH for the workflow steps and dev shells. */
function pacman(args, opts = {}) {
  return spawnSync('pacman', args, {encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], ...opts});
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
 * Extract the mingw packages into a project-local prefix (dev machines without
 * an MSYS2 install, or a developer reproducing CI bytes). MSYS2 ningw package
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
    const res = spawnSync('tar', ['-xf', file, '-C', prefix], {encoding: 'utf-8'});
    if (res.status !== 0) {
      throw new Error(`tar failed for ${base} (exit ${res.status}): ${res.stderr || ''}`);
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
  const argOf = name => {
    const i = argv.indexOf(name);
    return i === -1 ? null : (argv[i + 1] ?? true);
  };
  const manifest = readManifest();
  const problems = validateManifest(manifest);
  if (problems.length > 0) {
    console.error(`config/msys2-toolchain.json is invalid:\n  ${problems.join('\n  ')}`);
    process.exit(2);
  }
  const cache = argOf('--dir') === null ? DEFAULT_CACHE : String(argOf('--dir'));
  const prefix = argOf('--prefix') === null ? DEFAULT_PREFIX : String(argOf('--prefix'));

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
      for (let i = 0; i < argv.length - 1; i++) {
        if (argv[i] === '--require-root') roots.push(argv[i + 1]);
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
