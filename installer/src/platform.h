#ifndef PLATFORM_H
#define PLATFORM_H

#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <time.h>
#include <stdarg.h>

#ifdef _WIN32
#include <winsock2.h>
#include <windows.h>
#include <shellapi.h>
#include <io.h>
#define strcasecmp _stricmp
#define strncasecmp _strnicmp
#define PATH_SEPARATOR '\\'
#define PATH_SEP "\\"
#else
#include <unistd.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <pwd.h>
#ifdef __APPLE__
#include <mach-o/dyld.h>
#endif
#define PATH_SEPARATOR '/'
#define PATH_SEP "/"
#endif

#define MAX_PATH_LEN 1024

#ifdef _WIN32
/**
 * Internal path encoding is UTF-8 (profiles.ini / PEB command line are read as
 * UTF-8 bytes), but the Win32 file APIs are UTF-16.  On a non-UTF-8 system
 * ANSI codepage (e.g. Hebrew CP1255) feeding UTF-8 bytes to the A-APIs
 * mangles every non-ASCII path, so all file operations go through these
 * conversions.  Caller frees the result; NULL on failure.
 */
static inline WCHAR *utf8_to_wide(const char *utf8) {
    if (!utf8) return NULL;
    int n = MultiByteToWideChar(CP_UTF8, 0, utf8, -1, NULL, 0);
    if (n <= 0) return NULL;
    WCHAR *w = (WCHAR *)malloc((size_t)n * sizeof(WCHAR));
    if (w) MultiByteToWideChar(CP_UTF8, 0, utf8, -1, w, n);
    return w;
}

static inline char *wide_to_utf8(const WCHAR *wide) {
    if (!wide) return NULL;
    int n = WideCharToMultiByte(CP_UTF8, 0, wide, -1, NULL, 0, NULL, NULL);
    if (n <= 0) return NULL;
    char *s = (char *)malloc((size_t)n);
    if (s) WideCharToMultiByte(CP_UTF8, 0, wide, -1, s, n, NULL, NULL);
    return s;
}
#endif

// Suppress -Wunused-result on write() calls in the HTTP server
#if defined(__GNUC__) && !defined(__clang__)
#pragma GCC diagnostic ignored "-Wunused-result"
#endif

// ===== Build-time configuration (from config/installer.conf) =====
#include "_config.h"

// ===== Configurable constants =====

/* Date-based self-update (ADR 0019 amendment): the build date is DERIVED
 * (issue #322) — _builddate.h (generated) carries per-binary dates from the
 * last commit touching each binary's inputs; the installer consumes its own.
 * Replaces the former INSTALLER_VERSION — the repo ships unversioned,
 * date-stamped artifacts, so a version constant could never converge with
 * the permanently-named `latest` tag. */
#include "_builddate.h"
#define INSTALLER_BUILD_DATE CFG_BUILD_DATE_INSTALLER

/* Local test builds (upload:local snapshots) never offer a self-update: the
 * snapshot exists to test THIS build, the banner would only confuse, and a
 * just-built binary always carries today's date anyway.  Consumed by the web
 * UI via /api/build-info (isLocal). */
#define INSTALLER_SELF_UPDATE_DISABLED (INSTALLER_LOCAL || INSTALLER_DEV)
#define INSTALLER_REPO_OWNER CFG_REPO_OWNER
#define INSTALLER_REPO_NAME CFG_REPO_NAME
/* The installer itself performs no network I/O: the browser tab fetches the
 * zips and posts the bytes to the local server.  The fetch source must be a
 * CORS-enabled host, so the zips are published to GitHub Pages
 * (ZIP_PAGES_URL) in addition to the release assets (ZIP_BASE_URL, still used
 * by the privileged in-browser updater). */
#ifdef CFG_ZIP_PAGES_URL
#define INSTALLER_ZIP_URL CFG_ZIP_PAGES_URL
#else
#define INSTALLER_ZIP_URL CFG_ZIP_BASE_URL
#endif
#define INSTALLER_HASHES_URL CFG_HASHES_URL
/* Managed self-update payload file name on the artifact branch (issue #341):
 * self-update.json sits next to hashes.json; the tab combines it with
 * INSTALLER_ZIP_PAGES_URL (so a local snapshot serves it from the installer's
 * own directory like every other Pages artifact). */
#ifdef CFG_SELF_UPDATE_FILE
#define INSTALLER_SELF_UPDATE_FILE CFG_SELF_UPDATE_FILE
#else
#define INSTALLER_SELF_UPDATE_FILE "self-update.json"
#endif
#define DEFAULT_PORT 8777  // fixed so restored stale tabs hit the live server
/* Name suffix appended to published artifacts ('' in prod, '-dev' in dev
 * mode, from installer.conf ASSET_SUFFIX).  Adjacent string-literal
 * concatenation: "installer_win" "-dev" ".exe" -> "installer_win-dev.exe". */
#define INSTALLER_ASSET_SUFFIX CFG_ASSET_SUFFIX
#define INSTALLER_RELEASE_NAME CFG_RELEASE_NAME

/* Local-test builds (upload:local): _config.h bakes localhost URLs and the
 * installer's HTTP server serves the published files (zips, hashes.json,
 * helper) from the directory containing the executable, so the built installer
 * runs fully offline against a dist/<mode>-<branch>-<hash>/ snapshot.
 */
#ifdef CFG_LOCAL
#define INSTALLER_LOCAL CFG_LOCAL
#else
#define INSTALLER_LOCAL 0
#endif

/* Test/dev identity, surfaced to the web UI via /api/build-info so a --local
 * or --mode=dev build shows a "test build" banner up front. */
#ifdef CFG_DEV
#define INSTALLER_DEV CFG_DEV
#else
#define INSTALLER_DEV 0
#endif

#ifdef CFG_LOCAL_DIST_PATH
#define INSTALLER_LOCAL_DIST_PATH CFG_LOCAL_DIST_PATH
#else
#define INSTALLER_LOCAL_DIST_PATH ""
#endif

/* Release identity string. CFG_DEV_BRANCH is baked NON-EMPTY only in dev/local
 * builds (see syncGeneratedFiles.mjs): its sole consumer is the "test build"
 * banner via /api/build-info, which early-returns unless isLocal||isDev. In a
 * prod build it is "" BY DESIGN — an embedded HEAD hash would re-roll the PE
 * bytes on every commit and invalidate WDSI hash submissions without any
 * installer-scoped change (2026-09-26 Phase 2R finding; ADR 0036 amendment).
 * Provenance in prod rides the release tag/manifest, not the binary. */
#ifdef CFG_DEV_BRANCH
#define INSTALLER_DEV_BRANCH CFG_DEV_BRANCH
#else
#define INSTALLER_DEV_BRANCH ""
#endif

/* Expected release-asset name of THIS platform's installer binary.  The
 * self-update flow picks the asset with this name from the dev-build/latest
 * release JSON (GitHub lists helper binaries and the installer zips in the
 * same assets array, so the first browser_download_url is not necessarily the
 * installer). */
#ifdef _WIN32
#define INSTALLER_BINARY_NAME "installer_win" INSTALLER_ASSET_SUFFIX ".exe"
#elif defined(__APPLE__)
#define INSTALLER_BINARY_NAME "installer_mac" INSTALLER_ASSET_SUFFIX
#elif defined(__aarch64__)
/* ARM64 Linux builds publish under their own asset name (the x86_64 installer
 * cannot run on an arm64 host); mirrors the updater's INSTALLER_FILENAMES. */
#define INSTALLER_BINARY_NAME "installer_linux_aarch64" INSTALLER_ASSET_SUFFIX
#else
#define INSTALLER_BINARY_NAME "installer_linux" INSTALLER_ASSET_SUFFIX
#endif

/* ===== Browser-uploaded package data (implemented in zip_store.c) =====
 * The web UI fetches the manifest and the package zips (CORS-enabled URLs)
 * and POSTs the raw bytes to the local server.  These accessors give the
 * hash/status code and the install state machine access to the uploaded
 * buffers.  is_utils: 1 = utils.zip, 0 = fx-folder.zip. */
const unsigned char *installer_uploaded_zip(int is_utils, size_t *out_len);
int installer_has_uploaded_zip(int is_utils);
int installer_set_uploaded_zip(int is_utils, const char *data, size_t len);

/* Manifest verification (implemented in manifest.c; P0-5 / #445).
 * Both return 0 when the bytes match the published hash — or when there is
 * nothing to verify yet (no manifest ingested / no zip stored), preserving
 * the documented no-manifest fallback — and -1 on a mismatch, which the
 * handler answers with HTTP 403. installer_verify_upload checks a CANDIDATE
 * zip against the ingested manifest (before it is stored);
 * installer_verify_stored_zips checks the STORED zips against a candidate
 * manifest body (before it is ingested). Together they cover both arrival
 * orders: the tab fetches the manifest and the zips in parallel. */
int installer_verify_upload(int is_utils, const char *data, size_t len);
int installer_verify_stored_zips(const char *manifest_json, size_t len);

/* updater-ui.zip rides along with utils (the update tab lives in the profile).
 * It is not hash-checked or shown in the UI: it is extracted silently and is
 * optional when the fetch failed. */
const unsigned char *installer_uploaded_ui_zip(size_t *out_len);
int installer_has_uploaded_ui_zip(void);
int installer_set_uploaded_ui_zip(const char *data, size_t len);

// ===== Platform helpers =====

/**
 * Sleep for the specified number of milliseconds
 */
static inline void sleep_ms(int ms) {
#ifdef _WIN32
    Sleep(ms);
#else
    struct timespec ts;
    ts.tv_sec = ms / 1000;
    ts.tv_nsec = (long)(ms % 1000) * 1000000L;
    nanosleep(&ts, NULL);
#endif
}

/** Rotate the log once past this size, so a long-lived %TEMP% copy cannot
 *  grow without bound (the OS only prunes files after ~30 days). */
#define INSTALLER_LOG_MAX_BYTES (256 * 1024)

/** Size of `path` in bytes, or -1 when it does not exist / cannot be read. */
static inline long installer_log_size(const char *path) {
    FILE *f = fopen(path, "rb");
    if (!f)
        return -1;
    if (fseek(f, 0, SEEK_END) != 0) {
        fclose(f);
        return -1;
    }
    long size = ftell(f);
    fclose(f);
    return size;
}

/**
 * Minimal file logging (Windows): appends to %TEMP%\installer_win.log.
 * Each translation unit keeps its own handle; appends are flushed per line.
 * The first open of a too-large log rotates it to installer_win.log.1 (one
 * generation — the previous .1 is replaced), then starts a fresh log.
 */
static inline FILE *installer_log(void) {
#ifdef _WIN32
    static FILE *f = NULL;
    if (!f) {
        char path[MAX_PATH_LEN];
        if (GetTempPathA(MAX_PATH_LEN, path) > 0 &&
            strlen(path) < MAX_PATH_LEN - 32) {
            strcat(path, "installer_win.log");
            if (installer_log_size(path) > INSTALLER_LOG_MAX_BYTES) {
                char rotated[MAX_PATH_LEN];
                snprintf(rotated, sizeof(rotated), "%s.1", path);
                DeleteFileA(rotated);
                MoveFileA(path, rotated);
            }
            f = fopen(path, "a");
        }
    }
    return f;
#else
    return NULL;
#endif
}

/** Verbose diagnostic printf — enabled by --verbose / --log-console
 *  (installer_main.c sets installer_verbose_flag). Shared with restart.c. */
extern int installer_verbose_flag;
#define verbose_printf(...)                              \
    do {                                                 \
        if (installer_verbose_flag) printf(__VA_ARGS__); \
    } while (0)

static inline void log_msg(const char *fmt, ...) {
    FILE *f = installer_log();
    if (!f) return;
    va_list ap;
    va_start(ap, fmt);
    vfprintf(f, fmt, ap);
    va_end(ap);
    fflush(f);
}

#if !defined(_WIN32)
#include <spawn.h>
#include <fcntl.h>
#include <sys/wait.h>
extern char **environ;

/**
 * Spawn argv[0] with argv through posix_spawnp — PATH-searched ("open",
 * "xdg-open" and bare browser names resolve like the old system() shell
 * did), argument-array based (no shell, audit 2026-10-06 #432).
 *
 * wait_child: when nonzero, wait and return the child's exit status
 * (0 = success, -1 on spawn/wait failure). When zero, return 0 once the
 * child is running — for GUI programs that outlive the caller, the old
 * system("… &") behavior; the child is reaped when this process exits.
 * err_to_devnull: point the child's stderr at /dev/null, restoring the old
 * shell redirect for xdg-open's noise.
 */
static inline int spawn_argv_ex(char *const argv[], int wait_child, int err_to_devnull) {
    posix_spawn_file_actions_t fa;
    posix_spawn_file_actions_t *fap = NULL;
    if (err_to_devnull) {
        if (posix_spawn_file_actions_init(&fa) != 0) return -1;
        posix_spawn_file_actions_addopen(&fa, STDERR_FILENO, "/dev/null", O_WRONLY, 0);
        fap = &fa;
    }
    pid_t pid = (pid_t)-1;
    int rc = posix_spawnp(&pid, argv[0], fap, NULL, argv, environ);
    if (fap) posix_spawn_file_actions_destroy(fap);
    if (rc != 0) return -1;
    if (!wait_child) return 0;
    int status = 0;
    if (waitpid(pid, &status, 0) < 0) return -1;
    return WIFEXITED(status) ? WEXITSTATUS(status) : -1;
}

/** Spawn argv and wait for its exit status (short-lived children). */
static inline int spawn_argv(char *const argv[]) {
    return spawn_argv_ex(argv, 1, 0);
}
#endif

/**
 * Open a URL in a browser.
 * When browser_exe is not NULL, use it to open the URL in that specific browser.
 * When NULL, fall back to the operating system's default browser.
 * Returns 0 on success, -1 on failure
 */
static inline int open_browser(const char *url, const char *browser_exe) {
#ifdef _WIN32
    if (browser_exe) {
        ShellExecuteA(NULL, "open", browser_exe, url, NULL, SW_SHOWNORMAL);
        return 0;
    } else {
        HINSTANCE result = ShellExecuteA(NULL, "open", url, NULL, NULL, SW_SHOWNORMAL);
        return ((intptr_t)result > 32) ? 0 : -1;
    }
#elif defined(__APPLE__)
    if (browser_exe) {
        char *argv[] = { "open", "-a", (char *)browser_exe, (char *)url, NULL };
        return spawn_argv(argv) == 0 ? 0 : -1;
    }
    char *argv[] = { "open", (char *)url, NULL };
    return spawn_argv(argv) == 0 ? 0 : -1;
#else
    if (browser_exe) {
        char *argv[] = { (char *)browser_exe, (char *)url, NULL };
        // The browser outlives this process; fire and forget like the old
        // system("\"browser\" \"url\" &") did — never wait for a session.
        return spawn_argv_ex(argv, 0, 0) == 0 ? 0 : -1;
    }
    char *argv[] = { "xdg-open", (char *)url, NULL };
    return spawn_argv(argv) == 0 ? 0 : -1;
#endif
}

/**
 * Open a local folder in the operating system's file manager.
 * Returns 0 on success, -1 on failure.
 */
static inline int open_folder(const char *path) {
    if (!path || strlen(path) == 0) return -1;
#ifdef _WIN32
    WCHAR *wpath = utf8_to_wide(path);
    if (!wpath) return -1;
    HINSTANCE result = ShellExecuteW(NULL, L"open", wpath, NULL, NULL, SW_SHOWNORMAL);
    free(wpath);
    return ((intptr_t)result > 32) ? 0 : -1;
#elif defined(__APPLE__)
    char *argv[] = { "open", (char *)path, NULL };
    return spawn_argv(argv) == 0 ? 0 : -1;
#else
    /* xdg-open has no meaningful exit status here; silence its stderr the
     * way the old shell redirect did. */
    char *argv[] = { "xdg-open", (char *)path, NULL };
    return spawn_argv_ex(argv, 1, 1) == 0 ? 0 : -1;
#endif
}

/**
 * Get a temp directory path
 * Returns 0 on success, -1 on failure
 */
static inline int get_temp_dir(char *out, size_t size) {
#ifdef _WIN32
    DWORD ret = GetTempPathA((DWORD)size, out);
    return (ret > 0 && ret < size) ? 0 : -1;
#else
    const char *tmp = getenv("TMPDIR");
    if (!tmp) tmp = getenv("TMP");
    if (!tmp) tmp = "/tmp";
    if (strlen(tmp) < size) {
        snprintf(out, size, "%s", tmp);
        return 0;
    }
    return -1;
#endif
}

/**
 * Path manipulation: get the parent directory of a path
 * Modifies path in-place, returns length of parent dir
 */
static inline size_t get_parent_dir(char *path) {
    size_t len = strlen(path);
    while (len > 0 && path[len - 1] == PATH_SEPARATOR) len--;
    while (len > 0 && path[len - 1] != PATH_SEPARATOR) len--;
    path[len] = '\0';
    return len;
}

/**
 * Join two path components
 */
static inline void path_join(const char *a, const char *b, char *out, size_t out_size) {
    size_t alen = strlen(a);
    if (alen > 0 && a[alen - 1] == PATH_SEPARATOR) {
        snprintf(out, out_size, "%s%s", a, b);
    } else {
        snprintf(out, out_size, "%s%c%s", a, PATH_SEPARATOR, b);
    }
}

/**
 * Directory containing the running installer executable.  Local-test builds
 * serve the published snapshot from here (upload:local writes the files next
 * to the exe).  Returns 0 on success, -1 on failure.
 */
static inline int installer_own_dir(char *out, size_t size) {
    if (!out || size == 0) return -1;
#ifdef _WIN32
    WCHAR wexe[MAX_PATH_LEN];
    DWORD n = GetModuleFileNameW(NULL, wexe, MAX_PATH_LEN);
    if (n == 0 || n >= MAX_PATH_LEN) return -1;
    char *exe = wide_to_utf8(wexe);
    if (!exe) return -1;
    size_t len = strlen(exe);
    if (len >= size) {
        free(exe);
        return -1;
    }
    memcpy(out, exe, len + 1);
    free(exe);
    get_parent_dir(out);
    return 0;
#elif defined(__APPLE__)
    uint32_t esize = (uint32_t)size;
    if (_NSGetExecutablePath(out, &esize) != 0) return -1;
    get_parent_dir(out);
    return 0;
#else
    ssize_t n = readlink("/proc/self/exe", out, size - 1);
    if (n < 0) return -1;
    out[n] = '\0';
    get_parent_dir(out);
    return 0;
#endif
}

#endif /* PLATFORM_H */
