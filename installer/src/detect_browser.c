#include "detect_browser.h"
#include "file_utils.h"
#include "obsolete_files.h"
#include "sha256.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdbool.h>
#include <fcntl.h>
#include <ctype.h>
#include <time.h>
#include <stdarg.h>

// Path concatenation buffers (MAX_PATH_LEN=1024) are more than sufficient for
// all real-world profile paths; suppress GCC's false-positive truncation warning.
#if defined(__GNUC__) && !defined(__clang__)
#pragma GCC diagnostic ignored "-Wformat-truncation"
#endif

#if defined(_WIN32)
#include <windows.h>
#include <tlhelp32.h>
#include <psapi.h>
#include <io.h>
#define LOCK_FILE "parent.lock"
#else
#include <dirent.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <pwd.h>
#include <strings.h>
#define LOCK_FILE ".parentlock"
#endif

#if defined(__APPLE__)
#include <sys/sysctl.h>
#include <libproc.h>
#endif
#include "detect_browser_internal.h"

/**
 * Helper struct to avoid passing four hash parameters around (Data Clumps).
 * Holds the published hashes for both utils and fx-folder packages.
 */

/* Forward declarations */
static void find_active_profile_readonly(const char *binary_path, char *out_profile_path);
#if defined(__APPLE__)
static void find_profile_from_macos_argv(pid_t pid, const char *binary_path,
                                         char *out, size_t out_size);
/* Defined below with the Linux helpers; shared by the macOS argv scan. */
static int lookup_profile_by_name(const char *base_dir, const char *profile_name,
                                  char *out_path, size_t out_size);
#endif

void read_application_version(const char *binary_path,
                              enum BrowserVariant variant,
                              char *out, size_t out_size);

/**
 * Print to the visible console (CONOUT$) even when compiled with -mwindows
 * (GUI subsystem).  Falls back to printf on other platforms.
 */
void console_printf(const char *fmt, ...) {
    va_list args;
    va_start(args, fmt);
    char buf[4096];
    int len = vsnprintf(buf, sizeof(buf), fmt, args);
    va_end(args);
    if (len < 0) return;
#if defined(_WIN32)
    HANDLE hCon = CreateFileA("CONOUT$", GENERIC_WRITE, FILE_SHARE_WRITE,
                              NULL, OPEN_EXISTING, 0, NULL);
    if (hCon != INVALID_HANDLE_VALUE) {
        DWORD written;
        WriteConsoleA(hCon, buf, (DWORD)len, &written, NULL);
        CloseHandle(hCon);
    } else {
        printf("%s", buf);
    }
#else
    printf("%s", buf);
#endif
}

/**
 * Flag set to 1 while scan_and_filter_browsers() is running its initial scan.
 * When set, check_package_status() skips the network-backed hash check and
 * falls through to the fast file-existence check so the initial browser
 * detection does not block on a slow/unreachable manifest host. The hash
 * check runs normally on subsequent status API polls.
 */
int g_is_initial_scan = 0;

/**
 * Full status refresh (file-existence AND hash-based up-to-date flags) for
 * one browser.  Unlike refresh_install_status(), this does not suppress the
 * hash comparison; call it after the manifest is ingested so the flags
 * reflect the published hashes.
 *
 * installed = file presence (a stale or partial install is still installed);
 * up_to_date = hash comparison against the ingested manifest.
 */
void config_dir_for_app_dir(const char *app_dir, char *out, size_t out_sz) {
    // Snap app dirs are read-only mounts; the browser reads config.js from
    // /etc/firefox instead (see detect_browser.h).
    if (app_dir && strstr(app_dir, "/snap/")) {
        snprintf(out, out_sz, "/etc/firefox");
        return;
    }
    // Guard the identity copy: with out == app_dir the snprintf below would
    // read and write the same object, which is undefined behavior in C.
    if (out == app_dir) return;
    snprintf(out, out_sz, "%s", app_dir ? app_dir : "");
}

void refresh_install_status_full(RunningBrowser *browser) {
    char app_dir[MAX_PATH_LEN];
    snprintf(app_dir, MAX_PATH_LEN, "%s", browser->binary_path);
    get_parent_dir(app_dir);
    char config_dir[MAX_PATH_LEN];
    config_dir_for_app_dir(app_dir, config_dir, sizeof(config_dir));
    char utils_dir[MAX_PATH_LEN];
    snprintf(utils_dir, sizeof(utils_dir), "%s%cchrome%cutils",
             browser->profile_path, PATH_SEPARATOR, PATH_SEPARATOR);

    int saved = g_is_initial_scan;
    g_is_initial_scan = 0;
    browser->config_installed = check_files_present(0, config_dir);
    browser->utils_installed = check_files_present(1, utils_dir);
    browser->config_up_to_date = check_package_status(0, config_dir);
    browser->utils_up_to_date = check_package_status(1, utils_dir);
    g_is_initial_scan = saved;
}

#if defined(_WIN32)
/**
 * Collect all locked+compatible profile paths from profiles.ini.
 * Returns the number of profiles found (max max_profiles).
 * Used on Windows where PID-based profile detection isn't available.
 */
static int collect_locked_profiles(const char *binary_path, char (*out_profiles)[MAX_PATH_LEN], int max_profiles);
#endif

static const char *TARGET_EXECUTABLES[] = {
    "firefox.exe", "waterfox.exe", "zen.exe", "librewolf.exe", "floorp.exe",
    "firefox", "waterfox", "zen", "librewolf", "floorp",
    "firefox-bin", "waterfox-bin", "zen-bin",
    NULL
};

/**
 * True if the process executable at `full_path` is one of the target browsers.
 *
 * Windows matches the process image name (`pe.szExeFile`); POSIX scans resolve
 * a full path (proc_pidpath / /proc/<pid>/exe) and MUST compare its basename,
 * not strstr on the whole path: the installer itself runs from
 * <repo>/firefox-scripts/... and a substring match would detect it (and its
 * empty profile) as a browser, stealing the UI tab from the real browser.
 */
static int is_target_executable(const char *full_path) {
    if (!full_path || full_path[0] == '\0') return 0;
    const char *base = strrchr(full_path, '/');
    base = base ? base + 1 : full_path;
#if defined(_WIN32)
    const char *wbase = strrchr(base, '\\');
    if (wbase) base = wbase + 1;
    for (int i = 0; TARGET_EXECUTABLES[i] != NULL; i++) {
        if (_stricmp(base, TARGET_EXECUTABLES[i]) == 0) return 1;
    }
#elif defined(__APPLE__)
    // macOS filesystems are case-insensitive by default.
    for (int i = 0; TARGET_EXECUTABLES[i] != NULL; i++) {
        if (strcasecmp(base, TARGET_EXECUTABLES[i]) == 0) return 1;
    }
#else
    // A running binary whose file was replaced by a package update shows up
    // as "<path> (deleted)" in /proc/<pid>/exe; strip only that recognized
    // suffix so the still-running browser keeps matching its basename.
    char name[MAX_PATH_LEN];
    size_t blen = strlen(base);
    static const char kDeletedSuffix[] = " (deleted)";
    const size_t dlen = sizeof(kDeletedSuffix) - 1;
    if (blen > dlen && memcmp(base + blen - dlen, kDeletedSuffix, dlen) == 0) {
        blen -= dlen;
    }
    if (blen >= sizeof(name)) blen = sizeof(name) - 1;
    memcpy(name, base, blen);
    name[blen] = '\0';
    for (int i = 0; TARGET_EXECUTABLES[i] != NULL; i++) {
        if (strcmp(name, TARGET_EXECUTABLES[i]) == 0) return 1;
    }
#endif
    return 0;
}

enum BrowserVariant identify_variant_from_path(const char *path) {
    if (strstr(path, "Zen twilight") || strstr(path, "zen-twilight") || strstr(path, "Twilight")) {
        return BROWSER_ZEN_TWILIGHT;
    } else if (strstr(path, "Zen") || strstr(path, "zen")) {
        return BROWSER_ZEN;
    } else if (strstr(path, "Waterfox Beta") || strstr(path, "waterfox beta") || strstr(path, "waterfox-beta")) {
        return BROWSER_WATERFOX_BETA;
    } else if (strstr(path, "Waterfox") || strstr(path, "waterfox")) {
        return BROWSER_WATERFOX;
    } else if (strstr(path, "Firefox Developer Edition") || strstr(path, "devedition")) {
        return BROWSER_FIREFOX_DEVEDITION;
    } else if (strstr(path, "Nightly") || strstr(path, "nightly")) {
        return BROWSER_FIREFOX_NIGHTLY;
    } else if (strstr(path, "Beta") || strstr(path, "beta")) {
        return BROWSER_FIREFOX_BETA;
    } else if (strstr(path, "LibreWolf") || strstr(path, "librewolf")) {
        return BROWSER_LIBREWOLF;
    } else if (strstr(path, "Floorp") || strstr(path, "floorp")) {
        return BROWSER_FLOORP;
    } else {
        return BROWSER_FIREFOX_RELEASE;
    }
}

/**
 * Read a single Key=Value line from <binary_dir>/application.ini (matched in
 * any section).  SourceStamp/SourceRepository appear at most once each; a key
 * is matched by an exact "Key=" prefix so similarly-named keys (Version vs
 * MinVersion/MaxVersion) are not confused.  Leaves out empty when the file or
 * key is missing.  Unicode-safe on Windows.
 */
static void read_application_ini_value(const char *binary_path, const char *key,
                                       char *out, size_t out_size) {
    if (!binary_path || !key || !out || out_size == 0) return;
    out[0] = '\0';

    char ini_path[MAX_PATH_LEN];
    snprintf(ini_path, sizeof(ini_path), "%s", binary_path);
    get_parent_dir(ini_path);
    size_t len = strlen(ini_path);
    snprintf(ini_path + len, sizeof(ini_path) - len, "%sapplication.ini", PATH_SEP);

#ifdef _WIN32
    WCHAR *wini = utf8_to_wide(ini_path);
    FILE *f = wini ? _wfopen(wini, L"r") : NULL;
    free(wini);
#else
    FILE *f = fopen(ini_path, "r");
#endif
    if (!f) return;

    size_t key_len = strlen(key);
    char line[512];
    while (fgets(line, sizeof(line), f)) {
        // Strip trailing newline / CR
        size_t l = strlen(line);
        while (l > 0 && (line[l - 1] == '\n' || line[l - 1] == '\r')) line[--l] = '\0';

        if (strncmp(line, key, key_len) == 0 && line[key_len] == '=') {
            snprintf(out, out_size, "%s", line + key_len + 1);
            break;
        }
    }
    fclose(f);
}

/**
 * Read the SourceStamp= line (the hg commit the build was made from).  Firefox
 * places it under [Build] while Waterfox puts it under [App], so it is matched
 * in any section.  Waterfox ships it even though its [App] Version= reports the
 * Firefox-derived version, so the stamp can be matched against the
 * target_commitish of Waterfox's GitHub releases.  Leaves out empty when missing.
 */
void read_source_stamp(const char *binary_path, char *out, size_t out_size) {
    read_application_ini_value(binary_path, "SourceStamp", out, out_size);
}

/** Read the SourceRepository= line (the hg repo this build came from). */
void read_source_repository(const char *binary_path, char *out, size_t out_size) {
    read_application_ini_value(binary_path, "SourceRepository", out, out_size);
}

/**
 * Resolve the display name shown next to the version.  The name comes
 * exclusively from application.ini ([App] CodeName + Name) so it never
 * depends on where the user installed the browser — a renamed install folder
 * or a portable copy cannot change it, and it can never drift from the
 * updater's name (which reads the same keys).
 *
 * CodeName is normally the full brand name ("Firefox Developer Edition",
 * "Firefox Nightly", "Zen Browser") and Name its short form ("Firefox",
 * "Zen").  Prefer CodeName when it begins with Name; otherwise CodeName is a
 * bare channel word (Zen Twilight ships Name=Zen + CodeName=Twilight), so
 * combine the two ("Zen Twilight").  "Firefox" is shown only when
 * application.ini has neither key, which no real Gecko build ships without.
 */
static void resolve_browser_name(const char *binary_path, char *out, size_t out_size) {
    if (!binary_path || !out || out_size == 0) return;
    out[0] = '\0';

    char code_name[128], name[128];
    read_application_ini_value(binary_path, "CodeName", code_name, sizeof(code_name));
    read_application_ini_value(binary_path, "Name", name, sizeof(name));

    if (code_name[0] && name[0]) {
        size_t name_len = strlen(name);
        if (strncasecmp(code_name, name, name_len) == 0) {
            snprintf(out, out_size, "%s", code_name);
        } else {
            snprintf(out, out_size, "%s %s", name, code_name);
        }
    } else if (code_name[0]) {
        snprintf(out, out_size, "%s", code_name);
    } else if (name[0]) {
        snprintf(out, out_size, "%s", name);
    } else {
        snprintf(out, out_size, "Firefox");
    }
}

/**
 * Read the app version shown next to the display name.
 *
 * Baseline is <binary_dir>/application.ini ([App] Version=), which every
 * Gecko build ships next to the main executable.  Waterfox is the one
 * exception: its application.ini reports the Firefox-derived version (e.g.
 * "153.1.0") rather than the marketing version the browser shows, so for
 * Waterfox builds the version is resolved from the build's SourceStamp via
 * the Waterfox GitHub releases API instead (read_waterfox_version_from_github),
 * falling back to the application.ini value when the lookup fails.
 * On failure (file missing / unreadable / no Version line) out stays empty.
 * Unicode-safe on Windows (Hebrew / non-ASCII install dirs).
 */
void read_application_version(const char *binary_path,
                              enum BrowserVariant variant,
                              char *out, size_t out_size) {
    if (!binary_path || !out || out_size == 0) return;
    out[0] = '\0';

    char ini_path[MAX_PATH_LEN];
    snprintf(ini_path, sizeof(ini_path), "%s", binary_path);
    get_parent_dir(ini_path);
    size_t len = strlen(ini_path);
    snprintf(ini_path + len, sizeof(ini_path) - len, "%sapplication.ini", PATH_SEP);

#ifdef _WIN32
    WCHAR *wini = utf8_to_wide(ini_path);
    FILE *f = wini ? _wfopen(wini, L"r") : NULL;
    free(wini);
#else
    FILE *f = fopen(ini_path, "r");
#endif
    if (f) {
        char line[512];
        int in_app_section = 0;
        while (fgets(line, sizeof(line), f)) {
            // Strip trailing newline / CR
            size_t l = strlen(line);
            while (l > 0 && (line[l - 1] == '\n' || line[l - 1] == '\r')) line[--l] = '\0';

            if (line[0] == '[') {
                in_app_section = (strcmp(line, "[App]") == 0);
                continue;
            }
            if (in_app_section && strncmp(line, "Version=", 8) == 0) {
                snprintf(out, out_size, "%s", line + 8);
                break;
            }
        }
        fclose(f);
    }

    // Waterfox reports the Firefox-derived version in application.ini; resolve
    // its marketing version from the build's SourceStamp via the GitHub API.
    if (variant == BROWSER_WATERFOX || variant == BROWSER_WATERFOX_BETA) {
        char display[64];
        read_waterfox_version_from_github(binary_path, display, sizeof(display));
        if (display[0]) snprintf(out, out_size, "%s", display);
    }
}

/**
 * Check if an entry with the same (binary_path, profile_path) pair already exists.
 * Both fields must match exactly for a duplicate.
 */
static bool is_duplicate_entry(RunningBrowser *results, int count,
                               const char *binary_path, const char *profile_path) {
    for (int i = 0; i < count; i++) {
#if defined(_WIN32)
        if (_stricmp(results[i].binary_path, binary_path) == 0 &&
            strcmp(results[i].profile_path, profile_path) == 0) {
            return true;
        }
#else
        if (strcmp(results[i].binary_path, binary_path) == 0 &&
            strcmp(results[i].profile_path, profile_path) == 0) {
            return true;
        }
#endif
    }
    return false;
}

#if defined(__APPLE__)
/**
 * Read a process's argv on macOS (no /proc) via sysctl KERN_PROCARGS2 and
 * extract the --profile/-P argument it was launched with, if any.  Used to
 * find a browser's active profile when it is a temp dir (e.g. a puppeteer
 * profile) that never appears in profiles.ini.
 */
static void find_profile_from_macos_argv(pid_t pid, const char *binary_path,
                                         char *out, size_t out_size) {
    out[0] = '\0';
    int mib[3] = { CTL_KERN, KERN_PROCARGS2, pid };
    size_t size = 0;
    if (sysctl(mib, 3, NULL, &size, NULL, 0) < 0 || size > 4 * 1024 * 1024) return;
    char *buf = malloc(size);
    if (!buf) return;
    if (sysctl(mib, 3, buf, &size, NULL, 0) == 0 && size > sizeof(int)) {
        int argc = 0;
        memcpy(&argc, buf, sizeof(argc));
        // After argc: executable path, then the NUL-separated argv, then an
        // empty string, then the environment.  Skip the executable and scan
        // argv for -profile/--profile/-P (the value is the NEXT argument).
        char *p = buf + sizeof(int);
        char *end = buf + size;
        // KERN_PROCARGS2 lays out: argc, argv[0] path string, then the argv
        // entries (an empty string separates them) — skip empty entries and
        // honor argc so we never wander into the environment block.
        p += strlen(p) + 1;  // skip argv[0] (the executable path)
        int idx = 1;
        while (idx < argc && p < end) {
            if (*p) {
                if (strcmp(p, "-profile") == 0 || strcmp(p, "--profile") == 0 ||
                    strcmp(p, "-P") == 0) {
                    const char *val = p + strlen(p) + 1;
                    if (val < end && *val) {
                        if (strcmp(p, "-P") == 0) {
                            char base_dir[MAX_PATH_LEN] = { 0 };
                            const char *home = getenv("HOME");
                            if (!home) {
                                struct passwd *pw = getpwuid(getuid());
                                if (pw) home = pw->pw_dir;
                            }
                            if (home) {
                                // macOS keeps browser profiles under
                                // ~/Library/Application Support (matching
                                // find_active_profile_readonly() below), not
                                // in the dot-directories Linux uses.
                                switch (identify_variant_from_path(binary_path)) {
                                    case BROWSER_ZEN:
                                    case BROWSER_ZEN_TWILIGHT:
                                        snprintf(base_dir, sizeof(base_dir), "%s/Library/Application Support/zen", home);
                                        break;
                                    case BROWSER_WATERFOX:
                                    case BROWSER_WATERFOX_BETA:
                                        snprintf(base_dir, sizeof(base_dir), "%s/Library/Application Support/Waterfox", home);
                                        break;
                                    case BROWSER_LIBREWOLF:
                                        snprintf(base_dir, sizeof(base_dir), "%s/Library/Application Support/LibreWolf", home);
                                        break;
                                    case BROWSER_FLOORP:
                                        snprintf(base_dir, sizeof(base_dir), "%s/Library/Application Support/Floorp", home);
                                        break;
                                    default:
                                        snprintf(base_dir, sizeof(base_dir), "%s/Library/Application Support/Firefox", home);
                                        break;
                                }
                                lookup_profile_by_name(base_dir, val, out, out_size);
                            }
                        } else {
                            snprintf(out, out_size, "%s", val);
                        }
                    }
                }
                idx++;
            }
            p += strlen(p) + 1;
        }
    }
    free(buf);
}
#endif

#if defined(__linux__) || defined(__APPLE__)
/**
 * Look up a profile name in profiles.ini and return its full path.
 * Returns 0 on success, -1 if not found.
 */
static int lookup_profile_by_name(const char *base_dir, const char *profile_name,
                                  char *out_path, size_t out_size) {
    char profiles_ini[MAX_PATH_LEN];
    snprintf(profiles_ini, sizeof(profiles_ini), "%s/profiles.ini", base_dir);

    FILE *f = fopen(profiles_ini, "r");
    if (!f) return -1;

    char line[512];
    int in_target = 0;
    int is_relative = 1;  // default
    char rel_path[MAX_PATH_LEN] = { 0 };

    while (fgets(line, sizeof(line), f)) {
        line[strcspn(line, "\r\n")] = 0;

        if (line[0] == '[') {
            if (in_target && strlen(rel_path) > 0) {
                // Found Path= in the target section
                break;
            }
            in_target = 0;
        } else if (strncasecmp(line, "Name=", 5) == 0) {
            in_target = (strcmp(line + 5, profile_name) == 0);
            if (!in_target) {
                rel_path[0] = '\0';
                is_relative = 1;
            }
        } else if (in_target && strncasecmp(line, "Path=", 5) == 0) {
            /* strlen-bounded copy: strncpy would read the whole 1023-byte
             * range of the 512-byte source buffer (gcc -fanalyzer
             * out-of-bounds read). */
            size_t p_len = strlen(line + 5);
            if (p_len >= sizeof(rel_path)) p_len = sizeof(rel_path) - 1;
            memcpy(rel_path, line + 5, p_len);
            rel_path[p_len] = '\0';
        } else if (in_target && strncasecmp(line, "IsRelative=", 11) == 0) {
            is_relative = atoi(line + 11);
        }
    }
    fclose(f);

    if (strlen(rel_path) == 0) return -1;

    if (is_relative) {
        snprintf(out_path, out_size, "%s/%s", base_dir, rel_path);
    } else {
        snprintf(out_path, out_size, "%s", rel_path);
    }

    // Normalize separators
    for (char *p = out_path; *p; p++) {
        if (*p == '\\') *p = '/';
    }

    return 0;
}
#endif /* __linux__ || __APPLE__ */

#if defined(__linux__)
/**
 * Read /proc/<pid>/cmdline to find the profile name/path this process was launched with.
 * Falls back to find_active_profile_readonly() if command line doesn't specify a profile.
 */
static void find_profile_for_pid(unsigned long pid, const char *binary_path,
                                 char *out_profile_path) {
    out_profile_path[0] = '\0';
    char cmdline_path[64];
    snprintf(cmdline_path, sizeof(cmdline_path), "/proc/%lu/cmdline", pid);

    FILE *f = fopen(cmdline_path, "r");
    if (!f) {
        find_active_profile_readonly(binary_path, out_profile_path);
        return;
    }

    char cmdline[4096];
    size_t n = fread(cmdline, 1, sizeof(cmdline) - 1, f);
    fclose(f);
    cmdline[n] = '\0';

    // Parse null-separated arguments from /proc/pid/cmdline
    char *profile_name = NULL;
    char *profile_path_arg = NULL;
    char *p = cmdline;

    while (p < cmdline + n && *p) {
        if (strcmp(p, "-P") == 0) {
            p += strlen(p) + 1;
            if (p < cmdline + n && *p) {
                profile_name = p;
                break;
            }
        } else if (strcmp(p, "--profile") == 0) {
            p += strlen(p) + 1;
            if (p < cmdline + n && *p) {
                profile_path_arg = p;
                break;
            }
        }
        p += strlen(p) + 1;
    }

    if (profile_path_arg && strlen(profile_path_arg) > 0) {
        snprintf(out_profile_path, MAX_PATH_LEN, "%s", profile_path_arg);
    } else if (profile_name && strlen(profile_name) > 0) {
        // Look up profile name in profiles.ini
        char base_dir[MAX_PATH_LEN] = { 0 };
        const char *home = getenv("HOME");
        if (!home) {
            struct passwd *pw = getpwuid(getuid());
            if (pw) home = pw->pw_dir;
        }
        if (home) {
            enum BrowserVariant variant = identify_variant_from_path(binary_path);
            switch (variant) {
                case BROWSER_ZEN:
                case BROWSER_ZEN_TWILIGHT:
                    snprintf(base_dir, sizeof(base_dir), "%s/.zen", home);
                    break;
                case BROWSER_WATERFOX:
                case BROWSER_WATERFOX_BETA:
                    snprintf(base_dir, sizeof(base_dir), "%s/.waterfox", home);
                    break;
                case BROWSER_LIBREWOLF:
                    snprintf(base_dir, sizeof(base_dir), "%s/.librewolf", home);
                    break;
                case BROWSER_FLOORP:
                    snprintf(base_dir, sizeof(base_dir), "%s/.floorp", home);
                    break;
                default:
                    snprintf(base_dir, sizeof(base_dir), "%s/.mozilla/firefox", home);
                    break;
            }
            lookup_profile_by_name(base_dir, profile_name, out_profile_path, MAX_PATH_LEN);
        }
    }

    // If cmdline parsing didn't yield a profile, fall back
    if (strlen(out_profile_path) == 0) {
        find_active_profile_readonly(binary_path, out_profile_path);
    }
}

#endif /* __linux__ */

static bool is_file_locked(const char *filepath) {
#if defined(_WIN32)
    WCHAR *wpath = utf8_to_wide(filepath);
    if (!wpath) return false;
    HANDLE hFile = CreateFileW(
        wpath, GENERIC_READ,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    free(wpath);

    if (hFile == INVALID_HANDLE_VALUE) {
        DWORD err = GetLastError();
        if (err == ERROR_SHARING_VIOLATION || err == ERROR_ACCESS_DENIED) return true;
    } else {
        CloseHandle(hFile);
    }
    return false;
#else
    int fd = open(filepath, O_RDWR);
    if (fd == -1) return false;

    struct flock fl;
    memset(&fl, 0, sizeof(fl));
    fl.l_type = F_WRLCK;
    fl.l_whence = SEEK_SET;

    int ret = fcntl(fd, F_GETLK, &fl);
    close(fd);
    return (ret == 0 && fl.l_type != F_UNLCK);
#endif
}

static bool check_compatibility_ini(const char *profile_dir, const char *binary_path) {
    char compat_ini_path[MAX_PATH_LEN];
    snprintf(compat_ini_path, sizeof(compat_ini_path), "%s%ccompatibility.ini", profile_dir, PATH_SEPARATOR);

    FILE *f = fopen(compat_ini_path, "r");
    if (!f) return false;

    char line[512];
    char last_platform_dir[MAX_PATH_LEN] = { 0 };

    while (fgets(line, sizeof(line), f)) {
        line[strcspn(line, "\r\n")] = 0;

        if (strncasecmp(line, "LastPlatformDir=", 16) == 0) {
            /* Copy only up to the string end: strncpy would read the whole
             * 1023-byte range of a 512-byte source buffer (gcc -fanalyzer
             * out-of-bounds read). `line` is NUL-terminated by strcspn above
             * and the prefix match guarantees index 16 exists. */
            size_t pdir_len = strlen(line + 16);
            if (pdir_len >= sizeof(last_platform_dir)) pdir_len = sizeof(last_platform_dir) - 1;
            memcpy(last_platform_dir, line + 16, pdir_len);
            last_platform_dir[pdir_len] = '\0';
            break;
        }
    }
    fclose(f);

    if (strlen(last_platform_dir) == 0) return false;

    // Normalize path separators
    for (char *p = last_platform_dir; *p; p++) {
#if defined(_WIN32)
        if (*p == '/') *p = '\\';
#else
        if (*p == '\\') *p = '/';
#endif
    }

    // Extract installation directory from binary_path
    char binary_dir[MAX_PATH_LEN];
    snprintf(binary_dir, sizeof(binary_dir), "%s", binary_path);
    char *last_slash = strrchr(binary_dir, PATH_SEPARATOR);
    if (last_slash) *last_slash = '\0';

    if (strcasecmp(last_platform_dir, binary_dir) == 0) return true;
    if (strstr(binary_path, last_platform_dir) != NULL || strstr(last_platform_dir, binary_dir) != NULL) return true;

    return false;
}

static void find_active_profile_readonly(const char *binary_path, char *out_profile_path) {
    out_profile_path[0] = '\0';
    char base_dir[MAX_PATH_LEN] = { 0 };
    char profiles_ini_path[MAX_PATH_LEN] = { 0 };

    enum BrowserVariant variant = identify_variant_from_path(binary_path);

#if defined(_WIN32)
    const char *appdata = getenv("APPDATA");
    if (!appdata) return;

    switch (variant) {
        case BROWSER_ZEN:
        case BROWSER_ZEN_TWILIGHT:
            snprintf(base_dir, sizeof(base_dir), "%s\\zen", appdata);
            break;
        case BROWSER_WATERFOX:
        case BROWSER_WATERFOX_BETA:
            snprintf(base_dir, sizeof(base_dir), "%s\\Waterfox", appdata);
            break;
        case BROWSER_LIBREWOLF:
            snprintf(base_dir, sizeof(base_dir), "%s\\LibreWolf", appdata);
            break;
        case BROWSER_FLOORP:
            snprintf(base_dir, sizeof(base_dir), "%s\\Floorp", appdata);
            break;
        default:
            snprintf(base_dir, sizeof(base_dir), "%s\\Mozilla\\Firefox", appdata);
            break;
    }
    snprintf(profiles_ini_path, sizeof(profiles_ini_path), "%s\\profiles.ini", base_dir);
#else
    const char *home = getenv("HOME");
    if (!home) {
        struct passwd *pw = getpwuid(getuid());
        if (pw) home = pw->pw_dir;
    }
    if (!home) return;

#if defined(__APPLE__)
    switch (variant) {
        case BROWSER_ZEN:
        case BROWSER_ZEN_TWILIGHT:
            snprintf(base_dir, sizeof(base_dir), "%s/Library/Application Support/zen", home);
            break;
        case BROWSER_WATERFOX:
        case BROWSER_WATERFOX_BETA:
            snprintf(base_dir, sizeof(base_dir), "%s/Library/Application Support/Waterfox", home);
            break;
        case BROWSER_LIBREWOLF:
            snprintf(base_dir, sizeof(base_dir), "%s/Library/Application Support/LibreWolf", home);
            break;
        case BROWSER_FLOORP:
            snprintf(base_dir, sizeof(base_dir), "%s/Library/Application Support/Floorp", home);
            break;
        default:
            snprintf(base_dir, sizeof(base_dir), "%s/Library/Application Support/Firefox", home);
            break;
    }
#else
    switch (variant) {
        case BROWSER_ZEN:
        case BROWSER_ZEN_TWILIGHT:
            snprintf(base_dir, sizeof(base_dir), "%s/.zen", home);
            break;
        case BROWSER_WATERFOX:
        case BROWSER_WATERFOX_BETA:
            snprintf(base_dir, sizeof(base_dir), "%s/.waterfox", home);
            break;
        case BROWSER_LIBREWOLF:
            snprintf(base_dir, sizeof(base_dir), "%s/.librewolf", home);
            break;
        case BROWSER_FLOORP:
            snprintf(base_dir, sizeof(base_dir), "%s/.floorp", home);
            break;
        default:
            snprintf(base_dir, sizeof(base_dir), "%s/.mozilla/firefox", home);
            break;
    }
#endif
    snprintf(profiles_ini_path, sizeof(profiles_ini_path), "%s/profiles.ini", base_dir);
#endif

    FILE *f = fopen(profiles_ini_path, "r");
    if (!f) return;

    char line[512];
    char candidate_path[MAX_PATH_LEN] = { 0 };

    while (fgets(line, sizeof(line), f)) {
        line[strcspn(line, "\r\n")] = 0;

        if (strncasecmp(line, "Path=", 5) == 0) {
            char *rel_path = line + 5;

            snprintf(candidate_path, sizeof(candidate_path), "%s%c%s", base_dir, PATH_SEPARATOR, rel_path);

            for (char *p = candidate_path; *p; p++) {
#if defined(_WIN32)
                if (*p == '/') *p = '\\';
#else
                if (*p == '\\') *p = '/';
#endif
            }

            char lock_file[MAX_PATH_LEN];
            snprintf(lock_file, sizeof(lock_file), "%s%c%s", candidate_path, PATH_SEPARATOR, LOCK_FILE);

            if (is_file_locked(lock_file)) {
                snprintf(out_profile_path, MAX_PATH_LEN, "%s", candidate_path);
                break;
            }
        }
    }
    fclose(f);
}

int check_config_status(const char *binary_path) {
    // Presence-only: config.js (or the canonical file list) exists in the
    // config dir.  The up-to-date verdict comes from check_package_status()
    // via refresh_install_status_full().
    char config_dir[MAX_PATH_LEN];
    config_dir_for_app_dir(binary_path, config_dir, sizeof(config_dir));
    return check_files_present(0, config_dir);
}

int check_utils_status(const char *profile_path) {
    char utils_dir[MAX_PATH_LEN];
    snprintf(utils_dir, sizeof(utils_dir), "%s%cchrome%cutils",
             profile_path, PATH_SEPARATOR, PATH_SEPARATOR);

    // Presence-only, see check_config_status().
    return check_files_present(1, utils_dir);
}

#if defined(_WIN32)
/**
 * Collect all locked+compatible profile paths from profiles.ini for a given binary.
 * This is used on Windows where we need to assign unique profiles to multiple
 * Firefox instances that share the same binary.
 */
static int collect_locked_profiles(const char *binary_path, char (*out_profiles)[MAX_PATH_LEN], int max_profiles) {
    int count = 0;
    char base_dir[MAX_PATH_LEN] = { 0 };
    char profiles_ini_path[MAX_PATH_LEN] = { 0 };

    enum BrowserVariant variant = identify_variant_from_path(binary_path);

    const char *appdata = getenv("APPDATA");
    if (!appdata) return 0;

    switch (variant) {
        case BROWSER_ZEN:
        case BROWSER_ZEN_TWILIGHT:
            snprintf(base_dir, sizeof(base_dir), "%s\\zen", appdata);
            break;
        case BROWSER_WATERFOX:
        case BROWSER_WATERFOX_BETA:
            snprintf(base_dir, sizeof(base_dir), "%s\\Waterfox", appdata);
            break;
        case BROWSER_LIBREWOLF:
            snprintf(base_dir, sizeof(base_dir), "%s\\LibreWolf", appdata);
            break;
        case BROWSER_FLOORP:
            snprintf(base_dir, sizeof(base_dir), "%s\\Floorp", appdata);
            break;
        default:
            snprintf(base_dir, sizeof(base_dir), "%s\\Mozilla\\Firefox", appdata);
            break;
    }
    snprintf(profiles_ini_path, sizeof(profiles_ini_path), "%s\\profiles.ini", base_dir);

    FILE *f = fopen(profiles_ini_path, "r");
    if (!f) return 0;

    char line[512];
    char candidate_path[MAX_PATH_LEN] = { 0 };

    while (fgets(line, sizeof(line), f) && count < max_profiles) {
        line[strcspn(line, "\r\n")] = 0;

        if (strncasecmp(line, "Path=", 5) == 0) {
            char *rel_path = line + 5;

            snprintf(candidate_path, sizeof(candidate_path), "%s\\%s", base_dir, rel_path);

            for (char *p = candidate_path; *p; p++) {
                if (*p == '/') *p = '\\';
            }

            char lock_file[MAX_PATH_LEN];
            snprintf(lock_file, sizeof(lock_file), "%s\\%s", candidate_path, LOCK_FILE);

            if (is_file_locked(lock_file)) {
                if (check_compatibility_ini(candidate_path, binary_path)) {
                    snprintf(out_profiles[count], MAX_PATH_LEN, "%s", candidate_path);
                    count++;
                }
            }
        }
    }
    fclose(f);

    return count;
}
#endif

#if defined(_WIN32)
typedef struct {
    PVOID Reserved1;
    PVOID PebBaseAddress;
    PVOID Reserved2[2];
    ULONG_PTR UniqueProcessId;
    PVOID Reserved3;
} FSH_PROCESS_BASIC_INFORMATION;

typedef LONG(NTAPI *FSH_NtQueryInformationProcess)(HANDLE, ULONG, PVOID, ULONG, PULONG);

/**
 * Read a process's full command line by walking its PEB.
 * Undocumented but stable across modern Windows versions; this is how we can
 * tell the main browser process of a profile apart from Firefox's content,
 * GPU and utility child processes, and read which profile each instance runs.
 * Returns 0 on success, -1 on failure (out is left empty).
 */
static int get_process_command_line(unsigned long pid, char *out, size_t out_size) {
    out[0] = '\0';
    if (out_size < 2) return -1;
    HANDLE h = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, FALSE, pid);
    if (!h) return -1;

    static FSH_NtQueryInformationProcess pNtQip = NULL;
    if (!pNtQip) {
        HMODULE ntdll = GetModuleHandleA("ntdll.dll");
        if (ntdll) pNtQip = (FSH_NtQueryInformationProcess)GetProcAddress(ntdll, "NtQueryInformationProcess");
    }

    int ret = -1;
    if (pNtQip) {
        FSH_PROCESS_BASIC_INFORMATION pbi;
        ULONG got = 0;
        if (pNtQip(h, 0, &pbi, sizeof(pbi), &got) == 0 && pbi.PebBaseAddress) {
            BYTE peb[256] = { 0 };
            SIZE_T rd = 0;
            if (ReadProcessMemory(h, pbi.PebBaseAddress, peb, sizeof(peb), &rd) && rd >= 0x40) {
                PVOID params = NULL;
#ifdef _WIN64
                memcpy(&params, peb + 0x20, sizeof(PVOID));  // PEB.ProcessParameters
#else
                memcpy(&params, peb + 0x10, sizeof(PVOID));
#endif
                if (params) {
                    BYTE rupp[512] = { 0 };
                    if (ReadProcessMemory(h, params, rupp, sizeof(rupp), &rd) && rd >= 0x80) {
                        USHORT len = 0;
                        PVOID buf = NULL;
#ifdef _WIN64
                        memcpy(&len, rupp + 0x70, sizeof(len));  // RTL_USER_PROCESS_PARAMETERS.CommandLine
                        memcpy(&buf, rupp + 0x78, sizeof(buf));
#else
                        memcpy(&len, rupp + 0x40, sizeof(len));
                        memcpy(&buf, rupp + 0x44, sizeof(buf));
#endif
                        if (len > 0 && len < 32768 && buf) {
                            WCHAR *wide = (WCHAR *)malloc((size_t)len + 2);
                            if (wide) {
                                if (ReadProcessMemory(h, buf, wide, len, &rd) && rd >= 2) {
                                    wide[len / 2] = L'\0';
                                    int conv = WideCharToMultiByte(CP_UTF8, 0, wide, -1,
                                                                   out, (int)out_size, NULL, NULL);
                                    if (conv > 0) ret = 0;
                                }
                                free(wide);
                            }
                        }
                    }
                }
            }
        }
    }
    CloseHandle(h);
    return ret;
}

/**
 * Extract the profile path argument ("--profile <path>" / "-profile <path>")
 * from a process command line.  Returns 1 with the path in out, 0 otherwise.
 */
static int extract_profile_from_cmdline(const char *cmdline, char *out, size_t out_size) {
    out[0] = '\0';
    if (!cmdline) return 0;
    const char *p = cmdline;
    while ((p = strstr(p, "profile")) != NULL) {
        const char *after = p + 7; /* strlen("profile") */
        /* The token must start with "-" or "--" preceded by a space (or string start). */
        const char *t = p;
        int dashes = 0;
        while (t > cmdline && t[-1] == '-') {
            t--;
            dashes++;
        }
        if (dashes < 1 || dashes > 2 || (t > cmdline && t[-1] != ' ')) {
            p = after;
            continue;
        }
        /* Reject lookalikes such as -profilemanager. */
        if (*after != ' ' && *after != '\t' && *after != '=' && *after != '\0') {
            p = after;
            continue;
        }
        const char *v = after;
        while (*v == ' ' || *v == '\t') v++;
        if (*v == '\0') return 0;
        const char *start = v, *end;
        if (*v == '"') {
            start = ++v;
            end = strchr(v, '"');
            if (!end) return 0;
        } else {
            end = v;
            while (*end && *end != ' ') end++;
        }
        size_t len = (size_t)(end - start);
        if (len == 0 || len >= out_size) return 0;
        memcpy(out, start, len);
        out[len] = '\0';
        return 1;
    }
    return 0;
}
#endif /* _WIN32 */

/**
 * Refresh install status flags after an install completes.
 * Installed flags use file-existence checks only (fast, no network).
 *
 * The up-to-date flags are intentionally left untouched here: after a
 * successful install the just-extracted content IS the published content,
 * so the caller marks the affected components up-to-date directly (see
 * handle_api_status in main.c).  Re-hashing here would spawn one certutil
 * per file while the single-threaded HTTP server is trying to answer the
 * UI's status/browsers polls, stalling the page for seconds.
 */
void refresh_install_status(RunningBrowser *browser) {
    int saved = g_is_initial_scan;
    g_is_initial_scan = 1;
    char app_dir[MAX_PATH_LEN];
    snprintf(app_dir, MAX_PATH_LEN, "%s", browser->binary_path);
    get_parent_dir(app_dir);
    browser->config_installed = check_config_status(app_dir);
    browser->utils_installed = check_utils_status(browser->profile_path);
    g_is_initial_scan = saved;
}

int scan_and_filter_browsers(RunningBrowser *results, int max_results) {
    int count = 0;
    g_is_initial_scan = 1; /* Skip network hash checks during initial scan */

#if defined(_WIN32)
    // ===== Windows multi-profile detection =====
    // Firefox is multi-process: one MAIN process per profile plus many content /
    // GPU / utility children, all sharing the same executable name.  A plain
    // process snapshot mixes them up, so we read each process's command line to
    // (a) keep only MAIN processes (children carry "-contentproc-" / "-utility"
    //     / "-gpu-process" markers) and
    // (b) match each main process to its REAL profile via "--profile <path>".
    // Processes without an explicit profile argument fall back to round-robin
    // over the locked profiles (common when launched from a plain shortcut).

#define MAX_PER_BINARY 4
#define MAX_RAW_PROCS (MAX_BROWSERS * 8)
    typedef struct {
        char exe_name[64];
        char binary_path[MAX_PATH_LEN];
        unsigned long pid;
        unsigned long parent_pid;
        int parent_is_target;
        char cmdline[2048];
        char cmdline_profile[MAX_PATH_LEN];
        char assigned_profile[MAX_PATH_LEN];
    } ProcessEntry;

    // Static (not stack) so the ~1MB of entries stays out of the 1MB default
    // stack; scan runs once at startup so reentrancy is not a concern.
    static ProcessEntry raw_procs[MAX_RAW_PROCS];
    static ProcessEntry proc_list[MAX_BROWSERS];
    int raw_count = 0;

    // Pass 1: collect every target-exe process (main + children) with cmdline.
    {
        HANDLE hSnapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (hSnapshot == INVALID_HANDLE_VALUE) return 0;

        PROCESSENTRY32 pe;
        pe.dwSize = sizeof(PROCESSENTRY32);

        if (Process32First(hSnapshot, &pe)) {
            do {
                for (int i = 0; TARGET_EXECUTABLES[i] != NULL && raw_count < MAX_RAW_PROCS; i++) {
                    if (_stricmp(pe.szExeFile, TARGET_EXECUTABLES[i]) == 0) {
                        char full_path[MAX_PATH_LEN] = { 0 };
                        HANDLE hProcess = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, FALSE, pe.th32ProcessID);
                        if (hProcess) {
                            GetModuleFileNameExA(hProcess, NULL, full_path, MAX_PATH_LEN);
                            CloseHandle(hProcess);
                        }
                        if (strlen(full_path) == 0) continue;

                        ProcessEntry *rp = &raw_procs[raw_count];
                        snprintf(rp->exe_name, sizeof(rp->exe_name), "%s", pe.szExeFile);
                        snprintf(rp->binary_path, MAX_PATH_LEN, "%s", full_path);
                        rp->pid = pe.th32ProcessID;
                        rp->parent_pid = pe.th32ParentProcessID;
                        rp->cmdline[0] = '\0';
                        rp->cmdline_profile[0] = '\0';
                        rp->assigned_profile[0] = '\0';
                        get_process_command_line(rp->pid, rp->cmdline, sizeof(rp->cmdline));
                        raw_count++;
                    }
                }
            } while (Process32Next(hSnapshot, &pe));
        }
        CloseHandle(hSnapshot);
    }

    // Pass 1b: keep only MAIN processes.  Firefox child processes (content,
    // gpu, socket, utility, rdd) all carry "-parentPid <main>" and a role
    // marker ("-contentproc", "-N gpu", ...) in their command line; main and
    // launcher processes carry neither.
    int proc_count = 0;
    for (int r = 0; r < raw_count; r++) {
        int has_cmdline = raw_procs[r].cmdline[0] != '\0';
        int skip = 0;
        if (has_cmdline) {
            if (strstr(raw_procs[r].cmdline, "-parentPid")) skip = 1;
            if (strstr(raw_procs[r].cmdline, "-contentproc")) skip = 1;
            if (strstr(raw_procs[r].cmdline, "-gpu-process")) skip = 1;
            if (strstr(raw_procs[r].cmdline, "-socket-process")) skip = 1;
            if (strstr(raw_procs[r].cmdline, "-utility-process")) skip = 1;
            if (strstr(raw_procs[r].cmdline, "-rdd-process")) skip = 1;
        } else {
            // Command line unreadable (e.g. protected process): fall back to the
            // process tree — children of another target process are not mains.
            for (int q = 0; q < raw_count; q++) {
                if (raw_procs[q].pid == raw_procs[r].parent_pid) {
                    skip = 1;
                    break;
                }
            }
        }
        if (skip) continue;

        // Record whether the parent is another target process.  Used later to
        // prefer the root-most process per instance (launcher vs. main child).
        raw_procs[r].parent_is_target = 0;
        for (int q = 0; q < raw_count; q++) {
            if (raw_procs[q].pid == raw_procs[r].parent_pid) {
                raw_procs[r].parent_is_target = 1;
                break;
            }
        }

        // Cap entries per unique binary.
        int count_for_binary = 0;
        for (int j = 0; j < proc_count; j++) {
            if (_stricmp(proc_list[j].binary_path, raw_procs[r].binary_path) == 0) {
                count_for_binary++;
            }
        }
        if (count_for_binary >= MAX_PER_BINARY) continue;

        proc_list[proc_count++] = raw_procs[r];
    }

    // Pass 2: extract the real profile from each main process's command line.
    for (int p = 0; p < proc_count; p++) {
        char profile[MAX_PATH_LEN];
        if (extract_profile_from_cmdline(proc_list[p].cmdline, profile, sizeof(profile)) &&
            path_is_dir(profile)) {
            snprintf(proc_list[p].cmdline_profile, MAX_PATH_LEN, "%s", profile);
        }
    }

    // Stable selection sort: strong (cmdline-matched) entries first, and among
    // them the root-most (parent is NOT another target process).  This makes the
    // dedup below keep the launcher's PID in the modern launcher model, so a
    // tree-kill (/t) takes down the whole instance — killing only the child main
    // process would let the launcher relaunch a new window, which reads to the
    // user as "Restart opened a new window instead of closing".
    for (int i = 0; i < proc_count; i++) {
        int best = i;
        for (int j = i + 1; j < proc_count; j++) {
            int best_strong = proc_list[best].cmdline_profile[0] != '\0';
            int best_root = !proc_list[best].parent_is_target;
            int j_strong = proc_list[j].cmdline_profile[0] != '\0';
            int j_root = !proc_list[j].parent_is_target;
            if (j_strong > best_strong || (j_strong == best_strong && j_root > best_root)) {
                best = j;
            }
        }
        if (best != i) {
            ProcessEntry tmp = proc_list[i];
            proc_list[i] = proc_list[best];
            proc_list[best] = tmp;
        }
    }

    // Pass 3: assign locked profiles.  Processes whose command line names a
    // running profile get a strong match; the rest get the remaining locked
    // profiles round-robin.
    static char cached_binary[MAX_BROWSERS][MAX_PATH_LEN];
    static char cached_pools[MAX_BROWSERS][MAX_BROWSERS][MAX_PATH_LEN];
    static int cached_pool_sizes[MAX_BROWSERS];
    static int cached_pool_count = 0;
    static int pool_assigned[MAX_BROWSERS][MAX_BROWSERS];
    cached_pool_count = 0;

    // Profiles named on a process command line are definitely in use by that
    // exact browser.  A round-robin guess must never be handed one of those to
    // a DIFFERENT binary, or a single profile would appear on two cards (e.g.
    // a Firefox Beta card showing a profile that Nightly actually opened).
    static char claimed_profiles[MAX_RAW_PROCS][MAX_PATH_LEN];
    static int claimed_count = 0;
    claimed_count = 0;
    for (int q = 0; q < proc_count && claimed_count < MAX_RAW_PROCS; q++) {
        if (proc_list[q].cmdline_profile[0] == '\0') continue;
        int dup = 0;
        for (int c = 0; c < claimed_count; c++) {
            if (strcmp(claimed_profiles[c], proc_list[q].cmdline_profile) == 0) {
                dup = 1;
                break;
            }
        }
        if (!dup) {
            snprintf(claimed_profiles[claimed_count], MAX_PATH_LEN, "%s", proc_list[q].cmdline_profile);
            claimed_count++;
        }
    }

    for (int p = 0; p < proc_count; p++) {
        int pool_idx = -1;

        // Check if this binary already has a profile pool
        for (int c = 0; c < cached_pool_count; c++) {
            if (strcmp(cached_binary[c], proc_list[p].binary_path) == 0) {
                pool_idx = c;
                break;
            }
        }

        if (pool_idx < 0) {
            // New binary: collect profiles for it
            pool_idx = cached_pool_count;
            snprintf(cached_binary[pool_idx], MAX_PATH_LEN, "%s", proc_list[p].binary_path);

            int n = collect_locked_profiles(proc_list[p].binary_path, cached_pools[pool_idx], MAX_BROWSERS);
            cached_pool_sizes[pool_idx] = n;
            for (int a = 0; a < n; a++) {
                pool_assigned[pool_idx][a] = 0;
            }
            cached_pool_count++;
        }

        // Strong match from the command line
        if (strlen(proc_list[p].cmdline_profile) > 0) {
            snprintf(proc_list[p].assigned_profile, MAX_PATH_LEN, "%s", proc_list[p].cmdline_profile);
            for (int a = 0; a < cached_pool_sizes[pool_idx]; a++) {
                if (strcmp(cached_pools[pool_idx][a], proc_list[p].cmdline_profile) == 0)
                    pool_assigned[pool_idx][a] = 1;
            }
            continue;
        }

        // Assign first unused profile from this pool, skipping any profile a
        // different browser claimed via --profile (see claimed_profiles above).
        int assigned = 0;
        for (int a = 0; a < cached_pool_sizes[pool_idx]; a++) {
            if (pool_assigned[pool_idx][a]) continue;
            int claimed = 0;
            for (int c = 0; c < claimed_count; c++) {
                if (strcmp(claimed_profiles[c], cached_pools[pool_idx][a]) == 0) {
                    claimed = 1;
                    break;
                }
            }
            if (claimed) continue;
            snprintf(proc_list[p].assigned_profile, MAX_PATH_LEN, "%s", cached_pools[pool_idx][a]);
            pool_assigned[pool_idx][a] = 1;
            assigned = 1;
            break;
        }

        if (!assigned) {
            // More processes than profiles, or collect_locked_profiles returned 0
            // (compatibility.ini check too strict).
            if (cached_pool_sizes[pool_idx] > 0) {
                snprintf(proc_list[p].assigned_profile, MAX_PATH_LEN, "%s", cached_pools[pool_idx][0]);
            } else {
                // Fall back to find_active_profile_readonly when the strict
                // collect_locked_profiles couldn't find any compatible profile.
                find_active_profile_readonly(proc_list[p].binary_path, proc_list[p].assigned_profile);
            }
        }
    }

    // Fourth pass: build results from proc_list with dedup
    for (int p = 0; p < proc_count && count < max_results; p++) {
        if (!is_duplicate_entry(results, count,
                                proc_list[p].binary_path,
                                proc_list[p].assigned_profile)) {
            snprintf(results[count].exe_name, sizeof(results[count].exe_name), "%s", proc_list[p].exe_name);
            snprintf(results[count].binary_path, MAX_PATH_LEN, "%s", proc_list[p].binary_path);
            snprintf(results[count].profile_path, MAX_PATH_LEN, "%s", proc_list[p].assigned_profile);
            results[count].pid = proc_list[p].pid;

            resolve_browser_name(proc_list[p].binary_path, results[count].identified_browser,
                                 sizeof(results[count].identified_browser));
            read_application_version(proc_list[p].binary_path,
                                     identify_variant_from_path(proc_list[p].binary_path),
                                     results[count].version, sizeof(results[count].version));

            if (strlen(results[count].profile_path) > 0) {
                char binary_dir[MAX_PATH_LEN];
                snprintf(binary_dir, MAX_PATH_LEN, "%s", proc_list[p].binary_path);
                get_parent_dir(binary_dir);

                results[count].config_installed = check_config_status(binary_dir);
                results[count].utils_installed = check_utils_status(results[count].profile_path);
            }

            count++;
        }
    }

#elif defined(__linux__)
    DIR *proc = opendir("/proc");
    if (!proc) return 0;

    struct dirent *entry;
    while ((entry = readdir(proc)) != NULL) {
        int pid = atoi(entry->d_name);
        if (pid > 0) {
            char exe_link[MAX_PATH_LEN], full_path[MAX_PATH_LEN] = { 0 };
            snprintf(exe_link, sizeof(exe_link), "/proc/%d/exe", pid);

            ssize_t len = readlink(exe_link, full_path, sizeof(full_path) - 1);
            if (len != -1) {
                full_path[len] = '\0';

                // A package update may have unlinked the running binary; the
                // kernel then reports "<path> (deleted)".  Strip that suffix
                // so the stored binary_path stays valid (it is later passed
                // to execl() on relaunch).  is_target_executable() keeps its
                // own stripping as a defensive fallback.
                static const char kDeletedSuffix[] = " (deleted)";
                const size_t dlen = sizeof(kDeletedSuffix) - 1;
                if (len > (ssize_t)dlen &&
                    memcmp(full_path + len - dlen, kDeletedSuffix, dlen) == 0) {
                    len -= (ssize_t)dlen;
                    full_path[len] = '\0';
                }

                if (is_target_executable(full_path)) {
                    // Detect profile BEFORE dedup check (PID-aware on Linux)
                    char profile_path[MAX_PATH_LEN] = { 0 };
                    find_profile_for_pid((unsigned long)pid, full_path, profile_path);

                    // Dedup by (binary_path + profile_path) so different profiles are distinct
                    if (!is_duplicate_entry(results, count, full_path, profile_path) && count < max_results) {
                        const char *exe_name = strrchr(full_path, '/');
                        exe_name = exe_name ? exe_name + 1 : full_path;
                        snprintf(results[count].exe_name, sizeof(results[count].exe_name), "%s", exe_name);
                        snprintf(results[count].binary_path, MAX_PATH_LEN, "%s", full_path);
                        snprintf(results[count].profile_path, MAX_PATH_LEN, "%s", profile_path);
                        results[count].pid = (unsigned long)pid;

                        resolve_browser_name(full_path, results[count].identified_browser, sizeof(results[count].identified_browser));
                        read_application_version(full_path,
                                                 identify_variant_from_path(full_path),
                                                 results[count].version, sizeof(results[count].version));

                        if (strlen(results[count].profile_path) > 0) {
                            char binary_dir[MAX_PATH_LEN];
                            snprintf(binary_dir, MAX_PATH_LEN, "%s", full_path);
                            get_parent_dir(binary_dir);

                            results[count].config_installed = check_config_status(binary_dir);
                            results[count].utils_installed = check_utils_status(results[count].profile_path);
                        }

                        count++;
                    }
                }
            }
        }
    }
    closedir(proc);

#elif defined(__APPLE__)
    int mib[4] = { CTL_KERN, KERN_PROC, KERN_PROC_ALL, 0 };
    size_t size;
    if (sysctl(mib, 4, NULL, &size, NULL, 0) < 0) return 0;

    struct kinfo_proc *procs = malloc(size);
    if (!procs) return 0;

    if (sysctl(mib, 4, procs, &size, NULL, 0) == 0) {
        int proc_count = (int)(size / sizeof(struct kinfo_proc));
        for (int i = 0; i < proc_count; i++) {
            pid_t pid = procs[i].kp_proc.p_pid;
            char full_path[MAX_PATH_LEN] = { 0 };

            if (proc_pidpath(pid, full_path, sizeof(full_path)) > 0 &&
                is_target_executable(full_path)) {
                // Detect profile BEFORE dedup check. macOS has no /proc, so
                // read the process argv (KERN_PROCARGS2) to find the explicit
                // --profile/-P the browser was launched with — a temp profile
                // (e.g. puppeteer's) is not in profiles.ini and would
                // otherwise resolve to nothing, sending the UI tab elsewhere.
                char profile_path[MAX_PATH_LEN] = { 0 };
                find_profile_from_macos_argv(pid, full_path, profile_path, sizeof(profile_path));
                if (strlen(profile_path) == 0) {
                    find_active_profile_readonly(full_path, profile_path);
                }

                // Dedup by (binary_path + profile_path) so different profiles are distinct
                if (!is_duplicate_entry(results, count, full_path, profile_path) && count < max_results) {
                    const char *exe_name = strrchr(full_path, '/');
                    exe_name = exe_name ? exe_name + 1 : full_path;
                    snprintf(results[count].exe_name, sizeof(results[count].exe_name), "%s", exe_name);
                    snprintf(results[count].binary_path, MAX_PATH_LEN, "%s", full_path);
                    snprintf(results[count].profile_path, MAX_PATH_LEN, "%s", profile_path);
                    results[count].pid = (unsigned long)pid;

                    resolve_browser_name(full_path, results[count].identified_browser,
                                         sizeof(results[count].identified_browser));
                    read_application_version(full_path,
                                             identify_variant_from_path(full_path),
                                             results[count].version, sizeof(results[count].version));

                    if (strlen(results[count].profile_path) > 0) {
                        char binary_dir[MAX_PATH_LEN];
                        snprintf(binary_dir, MAX_PATH_LEN, "%s", full_path);
                        get_parent_dir(binary_dir);

                        results[count].config_installed = check_config_status(binary_dir);
                        results[count].utils_installed = check_utils_status(results[count].profile_path);
                    }

                    count++;
                }
            }
        }
    }
    free(procs);
#endif

    g_is_initial_scan = 0; /* Hash checks enabled for subsequent status polls */

    return count;
}
