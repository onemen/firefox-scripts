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

#define INSTALLER_VERSION CFG_VERSION
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
#else
#define INSTALLER_BINARY_NAME "installer_linux" INSTALLER_ASSET_SUFFIX
#endif

/* ===== Browser-uploaded package data (implemented in main.c) =====
 * The web UI fetches the manifest and the package zips (CORS-enabled URLs)
 * and POSTs the raw bytes to the local server.  These accessors give the
 * hash/status code and the install state machine access to the uploaded
 * buffers.  is_utils: 1 = utils.zip, 0 = fx-folder.zip. */
const unsigned char *installer_uploaded_zip(int is_utils, size_t *out_len);
int installer_has_uploaded_zip(int is_utils);
int installer_set_uploaded_zip(int is_utils, const char *data, size_t len);

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

/**
 * Minimal file logging (Windows): appends to %TEMP%\installer_win.log.
 * Each translation unit keeps its own handle; appends are flushed per line.
 */
static inline FILE *installer_log(void) {
#ifdef _WIN32
    static FILE *f = NULL;
    if (!f) {
        char path[MAX_PATH_LEN];
        if (GetTempPathA(MAX_PATH_LEN, path) > 0 &&
            strlen(path) < MAX_PATH_LEN - 32) {
            strcat(path, "installer_win.log");
            f = fopen(path, "a");
        }
    }
    return f;
#else
    return NULL;
#endif
}

static inline void log_msg(const char *fmt, ...) {
    FILE *f = installer_log();
    if (!f) return;
    va_list ap;
    va_start(ap, fmt);
    vfprintf(f, fmt, ap);
    va_end(ap);
    fflush(f);
}

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
        char cmd[MAX_PATH_LEN + 32];
        snprintf(cmd, sizeof(cmd), "open -a \"%s\" \"%s\"", browser_exe, url);
        return system(cmd);
    } else {
        char cmd[MAX_PATH_LEN + 32];
        snprintf(cmd, sizeof(cmd), "open \"%s\"", url);
        return system(cmd);
    }
#else
    if (browser_exe) {
        char cmd[MAX_PATH_LEN * 2 + 64];
        snprintf(cmd, sizeof(cmd), "\"%s\" \"%s\" &", browser_exe, url);
        return system(cmd);
    } else {
        char cmd[MAX_PATH_LEN + 32];
        snprintf(cmd, sizeof(cmd), "xdg-open \"%s\"", url);
        return system(cmd);
    }
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
    char cmd[MAX_PATH_LEN + 32];
    snprintf(cmd, sizeof(cmd), "open \"%s\"", path);
    return system(cmd);
#else
    char cmd[MAX_PATH_LEN + 32];
    snprintf(cmd, sizeof(cmd), "xdg-open \"%s\" >/dev/null 2>&1", path);
    return system(cmd);
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
        strncpy(out, tmp, size);
        out[size - 1] = '\0';
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