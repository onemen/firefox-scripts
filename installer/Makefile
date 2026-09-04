CC ?= gcc
# Size-optimized: -Os, strip symbols, and emit each function into its own
# section so the linker's section GC (GC_FLAGS below) can drop dead code.
# Note: -fdata-sections is deliberately NOT used — with it, mingw-w64 gcc
# moves the runtime's ~5 MB zero-initialized buffer from .bss into .data,
# bloating the executable by ~5 MB.
CFLAGS = -Os -s -ffunction-sections

# miniz trim: the installer only READS zips (never compresses/writes), so the
# deflate/compression side and the zlib-compat wrappers are dead code.
# MINIZ_NO_DEFLATE_APIS also implies MINIZ_NO_ARCHIVE_WRITING_APIS.  Saves
# ~32 KB per binary (measured: 237 KB -> 200 KB on Windows).
MINIZ_TRIM = -DMINIZ_NO_DEFLATE_APIS -DMINIZ_NO_ZLIB_APIS

SRC_DIR = src
# Unified build-output root: all build artifacts land in dist/installer at the
# repo top level.  Make is always run from the installer/ dir (either `cd
# installer && make` or `make -C installer ...`), so the relative path
# ../dist/installer resolves to the repo-root dist/installer regardless of how
# make was invoked.
# upload.mjs overrides DIST_DIR (to the transient dist/.build/installer staging
# tree) so a publish run never leaves a persistent dist/installer behind; this
# default remains for manual `make dist_win`/`dist_linux`/`dist_mac` builds.
DIST_DIR = ../dist/installer
WEB_DIR = web

# Sources
SRCS = $(wildcard $(SRC_DIR)/*.c)

# Vendored miniz (zip extraction for ALL targets — no external unzip/curl
# dependency, and no PowerShell Expand-Archive on Windows).  miniz.c lives in
# a subdirectory, which $(wildcard $(SRC_DIR)/*.c) does not match, hence the
# explicit source.
MINIZ_SRC = $(SRC_DIR)/vendor/miniz/miniz.c

# OS detection for native build
ifeq ($(OS),Windows_NT)
  TARGET = $(DIST_DIR)/installer_win.exe
  # NOTE -mwindows: The all target (via $(TARGET)) inherits WIN_LIBS which includes -mwindows,
  # so running 'make' on Windows produces a GUI-subsystem .exe that does NOT open a terminal
  # when launched from Explorer. The --verbose / --log-console flag re-attaches to the parent
  # console when run from a terminal for diagnostic output.
  # The all target also depends on 'config' which generates _config.h from installer.conf.
  WIN_LIBS = -lws2_32 -lshell32 -luser32 -lcrypt32 -lbcrypt -static -static-libgcc -mwindows
  # Section GC: drop unreferenced functions/data emitted by -ffunction-sections.
  GC_FLAGS = -Wl,--gc-sections
else
  WIN_LIBS =
  UNAME_S := $(shell uname -s)
  ifeq ($(UNAME_S),Darwin)
    TARGET = $(DIST_DIR)/installer_mac
    # macOS ld uses -dead_strip instead of --gc-sections.
    GC_FLAGS = -Wl,-dead_strip
  else
    TARGET = $(DIST_DIR)/installer_linux
    GC_FLAGS = -Wl,--gc-sections
  endif
endif

# mkdir that works under whichever shell make runs recipes with.
# mingw32-make without sh.exe on PATH executes recipes via cmd.exe, whose
# builtin mkdir has no -p and errors when the directory already exists;
# a POSIX sh's mkdir -p is idempotent.  $(shell) runs under the same shell as
# recipes, so probe it once: cmd echoes "$0" literally, sh expands it.
SHELL_PROBE := $(shell echo $$0)
ifeq ($(SHELL_PROBE),$$0)
  MKDIR = @-mkdir $(DIST_DIR) 2>NUL
else
  MKDIR = @mkdir -p $(DIST_DIR) 2>/dev/null || true
endif

.PHONY: all resources config clean dist_win dist_linux dist_mac verify helper_win helper_linux helper_mac helper_all

all: resources config $(TARGET)

# Native target rule - maps $(TARGET) to the actual build command
$(TARGET): $(SRC_DIR)/resources.h $(SRC_DIR)/_config.h
	$(MKDIR)
	$(CC) $(SRC_DIR)/*.c $(MINIZ_SRC) -o $(TARGET) $(CFLAGS) $(MINIZ_TRIM) $(GC_FLAGS) $(WIN_LIBS)

# Publish mode for the generated config: see tools/publish/publishMode.mjs.
# Empty (default) = prod; MODE=dev rewrites _config.h / updater-config.sys.mjs
# for the dev-build-<id> namespace (dev URLs + ASSET_SUFFIX '-dev').
# LOCAL=1 (upload:local) additionally bakes localhost URLs and enables the
# installer's own-dir file server so the built exe runs fully offline.
MODE ?=
LOCAL ?=

# Dev-mode artifact suffix: mirrors ASSET_SUFFIX in tools/publish/paths.js
# ('-dev' in dev mode, empty in prod).  Naming the LOCAL binary exactly like
# the REMOTE release asset means upload.mjs's upload step finds
# whatever make produced — no rename step.
ASSET_SUFFIX = $(if $(filter dev,$(MODE)),-dev,)

# Generate shared config from config/installer.conf via the canonical JS
# generator (tools/publish/syncGeneratedFiles.mjs).  The output (_config.h) is
# untracked/gitignored — generated on demand, never committed.
# FORCE makes the rule run on EVERY make invocation: the generator is
# idempotent (content-compare, no-op when unchanged) and this guarantees the
# compiled binary always bakes the CURRENT mode — a dev build (MODE=dev) can
# never silently reuse a stale prod _config.h, and vice versa.
.PHONY: FORCE config
FORCE:

config: $(SRC_DIR)/_config.h

# Repo-root generator path. upload.mjs passes CONFIG_GENERATOR as a
# command-line make variable (deterministic under any spawn shell); this
# fallback covers manual `make dist_win` invocations.  $(abspath) resolves to a
# native Windows path (D:/...), unlike the old `$(shell pwd)` which returned a
# POSIX path (/d/...) that Git's sh.exe mangled to D:\d\... when invoking
# native node — breaking manual builds from PowerShell/cmd.
CONFIG_GENERATOR ?= $(abspath $(dir $(lastword $(MAKEFILE_LIST)))../tools/publish/syncGeneratedFiles.mjs)

# touch(1) is unavailable when make runs recipes under cmd.exe (no POSIX sh on
# PATH), and neither `#` comment lines nor inline `node -e "..."` scripts survive
# cmd.exe (cmd would execute the comment as a command and mangle the quoted -e
# script).  So the recipe body is a single node call: the generator regenerates
# the file and --touch stamps its mtime, guaranteeing the binary always relinks
# with the current MODE even when the content is unchanged.  Keep commentary
# ABOVE the recipe — never inside it, or cmd.exe will try to run it.
$(SRC_DIR)/_config.h: ../config/installer.conf FORCE
	@node $(CONFIG_GENERATOR) $(if $(MODE),--mode=$(MODE),) $(if $(LOCAL),--local,) --touch

# Generate embedded resources from web/ files
resources: $(SRC_DIR)/resources.h

$(SRC_DIR)/resources.h: embed.mjs $(WEB_DIR)/index.html $(WEB_DIR)/style.css $(WEB_DIR)/script.js
	node embed.mjs

# Windows build (cross-compile or native on Windows)
# -mwindows: link as GUI subsystem so double-click from Explorer doesn't open a terminal
# --verbose / --log-console flag re-attaches to parent console when run from terminal
dist_win: resources config
	$(MKDIR)
	$(CC) $(SRC_DIR)/*.c $(MINIZ_SRC) -o $(DIST_DIR)/installer_win$(ASSET_SUFFIX).exe $(CFLAGS) $(MINIZ_TRIM) $(GC_FLAGS) \
		-lws2_32 -lshell32 -luser32 -lcrypt32 -lbcrypt -static -static-libgcc \
		-mwindows

# Static analysis: gcc -fanalyzer over the installer sources (excludes the
# vendored miniz).  Run with `make analyze` from installer/ — part of
# `pnpm lint` (see tools/analyze-c.mjs).  The Node script orchestrates one gcc
# per source file IN PARALLEL (the serial pipe was the slowest leg of
# `pnpm lint`), filters for analyzer-class diagnostics (use-after-free,
# leaks, NULL deref, overflow, uninit) and propagates gcc hard errors — the
# old single-pipe form could lose them.  Exits 0 only when every gcc run
# succeeded and no analyzer-class diagnostics are found.
.PHONY: analyze
analyze: resources config
	node ../tools/analyze-c.mjs

# Linux build
# No external libraries: zip extraction uses the vendored miniz, and all
# network I/O happens in the browser tab (the C server only receives
# uploads over localhost).
dist_linux: resources config
	$(MKDIR)
	$(CC) $(SRC_DIR)/*.c $(MINIZ_SRC) -o $(DIST_DIR)/installer_linux$(ASSET_SUFFIX) $(CFLAGS) $(MINIZ_TRIM) $(GC_FLAGS)

# macOS build (requires macOS with clang)
dist_mac: resources config
	$(MKDIR)
	$(CC) $(SRC_DIR)/*.c $(MINIZ_SRC) -o $(DIST_DIR)/installer_mac$(ASSET_SUFFIX) $(CFLAGS) $(MINIZ_TRIM) $(GC_FLAGS)

# Build all platforms (requires cross-compilation toolchain)
dist_all: dist_win dist_linux dist_mac

# ---- Standalone admin-copy helper (merged from onemen/admin-copy) ----
# A tiny elevated-copy binary downloaded by the in-browser updater when the
# browser install dir is admin-protected.  Kept separate from $(SRC_DIR)/*.c
# so it is NOT compiled into the installer.
helper_win: $(SRC_DIR)/helper/helper_win.c $(SRC_DIR)/helper/version.rc | $(DIST_DIR)
	windres $(SRC_DIR)/helper/version.rc -O coff -o $(SRC_DIR)/helper/version.res
	$(CC) $(SRC_DIR)/helper/helper_win.c $(SRC_DIR)/helper/version.res -o $(DIST_DIR)/helper_win$(ASSET_SUFFIX).exe $(CFLAGS) -static -static-libgcc -luser32 -lshell32 "-Wl,--gc-sections" "-Wl,--strip-all" "-Wl,--subsystem,windows"

helper_linux: $(SRC_DIR)/helper/helper_linux.c $(SRC_DIR)/helper/common_posix.c | $(DIST_DIR)
	$(CC) $(SRC_DIR)/helper/helper_linux.c $(SRC_DIR)/helper/common_posix.c -o $(DIST_DIR)/helper_linux$(ASSET_SUFFIX) $(CFLAGS) $(GC_FLAGS)

helper_mac: $(SRC_DIR)/helper/helper_mac.c $(SRC_DIR)/helper/common_posix.c $(SRC_DIR)/helper/Info.plist | $(DIST_DIR)
	clang -arch x86_64 -arch arm64 $(SRC_DIR)/helper/helper_mac.c $(SRC_DIR)/helper/common_posix.c -o $(DIST_DIR)/helper_mac$(ASSET_SUFFIX) -Oz -s -flto -Wl,-dead_strip -Wl,-sectcreate,__TEXT,__info_plist,$(SRC_DIR)/helper/Info.plist

# Build all helper platforms (requires cross-compilation toolchain)
helper_all: helper_win helper_linux helper_mac

# Verify the built Windows executable has GUI subsystem (no terminal on double-click)
# On Windows: dumpbin /headers installer_win.exe | findstr Subsystem should show 2 (GUI)
# With objdump (MinGW/MSYS2): objdump -p installer_win.exe | grep Subsystem should show 2
verify: $(TARGET)
	@if command -v objdump >/dev/null 2>&1; then \
		if objdump -p "$(TARGET)" 2>/dev/null | grep -q 'Subsystem.*2$$'; then \
			echo "✓ GUI subsystem confirmed (subsystem=2, no terminal on double-click)"; \
		else \
			echo "✗ Binary may have console subsystem — check with: objdump -p $(TARGET) | grep Subsystem"; \
		fi \
	elif command -v dumpbin >/dev/null 2>&1; then \
		if dumpbin /headers "$(TARGET)" 2>/dev/null | grep -q 'subsystem.*Windows'; then \
			echo "✓ GUI subsystem confirmed (no terminal on double-click)"; \
		else \
			echo "✗ Binary may have console subsystem — check with: dumpbin /headers $(TARGET)"; \
		fi \
	else \
		echo "Note: objdump/dumpbin not available. To verify: objdump -p $(TARGET) | grep Subsystem should show 2 (GUI)"; \
	fi

# Clean build artifacts
clean:
	rm -f $(SRC_DIR)/resources.h $(SRC_DIR)/_config.h
	rm -f $(SRC_DIR)/helper/version.res
	rm -rf $(DIST_DIR)