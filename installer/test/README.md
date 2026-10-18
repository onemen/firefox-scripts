# Why these tests live here, not in `test/`

The repo splits tests by dependency class:

| Location                     | Runs via         | Needs a build?                    | Scope                                                           |
| ---------------------------- | ---------------- | --------------------------------- | --------------------------------------------------------------- |
| `test/unit/`                 | `pnpm test`      | No — pure Node                    | Publish helpers, hashing (JS), updater logic, tooling contracts |
| `installer/test/` (this dir) | `pnpm test:hash` | Yes — a compiled installer binary | The C installer's behavior                                      |

The tests here are **binary-in-the-loop**:

- **`test_hash.mjs`** — hash parity: cross-checks the C installer's `compute_directory_sha256` (in
  `installer/src/detect_browser.c`) against the JS reference (`tools/publish/hashUtils.mjs`). It
  invokes the real installer binary from the newest `dist/prod-*` / `dist/dev-*` snapshot
  (generating one via `pnpm snapshot:prod` when none exists), so it cannot run until the C toolchain
  has built that binary — which `test/unit/` must never require (it gates every pre-push).
- **`test_self_update.mjs`** — drives the C `check_self_update()` self-update logic
  (`installer/src/self_update.c`) through the installer's hidden `--test-self-update` CLI mode, with
  fixture JSON files. Also needs the built binary.
- **`test_profiles_ini.mjs`**: pins the profiles.ini path resolution the Windows/POSIX detection
  loops share (`resolve_profile_path()` / `profiles_ini_foreach()` in
  `installer/src/detect_browser.c`) through the hidden `--test-profiles-ini` CLI mode, notably the
  `IsRelative=0` absolute-path entries that #555 regressed on. Fixture-only, no locked profile
  needed; also needs the built binary.
- **`test_profile_argv.mjs`**: pins the profile-argument resolution the browser scan shares
  (`resolve_profile_from_cmdline()` / `lookup_profile_by_name()` in
  `installer/src/detect_browser.c`) through the hidden `--test-profile-argv` CLI mode:
  `--profile <dir>` stays verbatim, `-P <name>` resolves through a fixture `profiles.ini` (portable
  `IsRelative=0` entries included). Fixture-only, no running browser and no locked profile;
  `INSTALLER_TEST_BIN=<binary>` runs it against a plain `make -C installer` build.

Where they run:

- **CI**: `ci.yml`'s publish job runs `pnpm test:hash` on Windows, right after `pnpm snapshot:dev`
  has built the binaries.
- **Locally**: `pnpm test:hash` (hash / file-list changes — see the Testing & QA matrix in
  `AGENTS.md`).

If you add a test that needs the compiled installer, put it here and wire it into `pnpm test:hash`.
If it runs on plain Node against source files only, it belongs in `test/unit/`.
