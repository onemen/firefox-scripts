#include "detect_browser.h"
#include "file_utils.h"
#include "obsolete_files.h"
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

/**
 * Helper struct to avoid passing four hash parameters around (Data Clumps).
 * Holds the published hashes for both utils and fx-folder packages.
 */
typedef struct {
    char utils[65];
    char fx[65];
} PackageHashes;

/* Forward declarations */
static void find_active_profile_readonly(const char *binary_path, char *out_profile_path);
#if defined(__APPLE__)
static void find_profile_from_macos_argv(pid_t pid, const char *binary_path,
                                         char *out, size_t out_size);
/* Defined below with the Linux helpers; shared by the macOS argv scan. */
static int lookup_profile_by_name(const char *base_dir, const char *profile_name,
                                  char *out_path, size_t out_size);
#endif
static int hash_uploaded_zip(int is_utils, char *out_hash, size_t hash_size,
                             char ***out_list, int *out_count);
static void free_file_list(char ***list, int *count);
static void set_package_files(int is_utils, char **list, int count);
static int get_package_files(int is_utils, const char ***list, int *count);
static int parse_manifest_files(const char *json, const char *section,
                                char ***out_list, int *out_count);
static void read_application_version(const char *binary_path,
                                     enum BrowserVariant variant,
                                     char *out, size_t out_size);
static void reset_waterfox_version_cache(void);

/**
 * Print to the visible console (CONOUT$) even when compiled with -mwindows
 * (GUI subsystem).  Falls back to printf on other platforms.
 */
static void console_printf(const char *fmt, ...) {
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

/* ===== Hash-based status check infrastructure ===== */

/**
 * Global flag: zero until the remote hash manifest has been ingested and
 * parsed successfully.  Reset to 1 by ingest_remote_manifest() on success.
 * Exposed via get_hash_check_available() so the UI can surface the status.
 */
int g_hash_check_available = 0;

/**
 * Flag set to 1 while scan_and_filter_browsers() is running its initial scan.
 * When set, check_package_status() skips the network-backed hash check and
 * falls through to the fast file-existence check so the initial browser
 * detection does not block on a slow/unreachable Gist. The hash check runs
 * normally on subsequent status API polls.
 */
static int g_is_initial_scan = 0;

/* Hash-related diagnostics always print: the whole point of the status flag is
   to surface remote-hash failures instead of silently falling back. */

/**
 * Static cache for remote hashes from the Gist.
 * Cache TTL prevents re-downloading on every status poll.
 */
static char g_cached_utils_hash[65] = "";
static char g_cached_fx_folder_hash[65] = "";
static time_t g_hash_cache_time = 0;
#define HASH_CACHE_TTL_SEC 300 /* 5 minutes */

/* Cached canonical file lists (relative paths, '/' separators), one entry per
/* Canonical shipped file lists, per package.  Each entry is a malloc'd
   string.  Populated by ingest_remote_manifest() from the manifest's `files`
   arrays. */
static char **g_utils_files = NULL;
static int g_utils_files_count = 0;
static char **g_fx_files = NULL;
static int g_fx_files_count = 0;

/* Cached last-update dates ("YYYY-MM-DD") from the manifest, for the web
   UI's manual-download links.  Empty when the manifest was unreachable or
   predates the `date` field. */
static char g_cached_utils_date[32] = "";
static char g_cached_fx_folder_date[32] = "";

/* The browser tab fetches the hash manifest and the Waterfox releases list
   (CORS-enabled URLs) and POSTs the raw bytes to the local server.  These
   hold that ingested payload so the C code never performs network I/O. */
static char *g_manifest_json = NULL;
static size_t g_manifest_len = 0;
static char *g_waterfox_releases_json = NULL;
static size_t g_waterfox_releases_len = 0;

/**
 * Parse a `"key":"value"` string field inside a JSON section (strstr-based,
 * same style as the hash parsing above).  Never fails: leaves out empty.
 */
static void parse_json_string_field(const char *section, const char *key,
                                    char *out, size_t out_size) {
    out[0] = '\0';
    if (!section || !key || !out || out_size == 0) return;
    const char *key_pos = strstr(section, key);
    if (!key_pos) return;
    const char *val_start = strchr(key_pos + strlen(key), '"');
    if (!val_start) return;
    val_start++; /* skip opening quote */
    const char *val_end = strchr(val_start, '"');
    if (!val_end) return;
    size_t len = (size_t)(val_end - val_start);
    if (len >= out_size) len = out_size - 1;
    memcpy(out, val_start, len);
    out[len] = '\0';
}

/**
 * Compute SHA256 hash of a file using platform tools.
 * On Linux: uses sha256sum via popen.
 * On Windows: uses certutil -hashfile via CreateProcessA (CREATE_NO_WINDOW).
 * Returns 0 on success with 64-char hex hash (+ null) in out_hash.
 */
static int compute_file_sha256(const char *filepath, char *out_hash, size_t hash_size) {
    if (!filepath || !out_hash || hash_size < 65) return -1;

#ifdef _WIN32
    // Use CreateProcessW with CREATE_NO_WINDOW to avoid terminal flashing.
    // The command line is built in UTF-8 (internal encoding) and converted in
    // full, so a non-ASCII file path reaches certutil intact.
    char cmd[4096];
    snprintf(cmd, sizeof(cmd), "certutil -hashfile \"%s\" SHA256", filepath);
    WCHAR *wcmd = utf8_to_wide(cmd);
    if (!wcmd) return -1;

    char temp_dir[MAX_PATH_LEN];
    char temp_out_path[MAX_PATH_LEN];
    if (GetTempPathA(MAX_PATH_LEN, temp_dir) == 0 ||
        GetTempFileNameA(temp_dir, "fsh", 0, temp_out_path) == 0) {
        free(wcmd);
        return -1;
    }

    STARTUPINFOW si = { sizeof(si) };
    PROCESS_INFORMATION pi;
    SECURITY_ATTRIBUTES sa = { sizeof(sa), NULL, TRUE };
    HANDLE hOut = CreateFileA(temp_out_path, GENERIC_WRITE, FILE_SHARE_READ, &sa,
                              CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (hOut == INVALID_HANDLE_VALUE) {
        free(wcmd);
        return -1;
    }
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdOutput = hOut;
    si.hStdError = hOut;

    if (!CreateProcessW(NULL, wcmd, NULL, NULL, TRUE, CREATE_NO_WINDOW,
                        NULL, NULL, &si, &pi)) {
        free(wcmd);
        CloseHandle(hOut);
        return -1;
    }
    free(wcmd);
    WaitForSingleObject(pi.hProcess, INFINITE);
    DWORD exit_code;
    GetExitCodeProcess(pi.hProcess, &exit_code);
    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);
    CloseHandle(hOut);

    if (exit_code != 0) {
        remove(temp_out_path);
        return -1;
    }

    // Read the output file — certutil output looks like:
    //   SHA256 hash of <path>:
    //   <64 hex chars>
    //   CertUtil: -hashfile command completed successfully.
    FILE *f = fopen(temp_out_path, "r");
    if (!f) {
        remove(temp_out_path);
        return -1;
    }
    char line[256];
    int found = 0;
    while (fgets(line, sizeof(line), f)) {
        size_t len = strlen(line);
        while (len > 0 && (line[len - 1] == '\n' || line[len - 1] == '\r' || line[len - 1] == ' '))
            line[--len] = '\0';
        if (len == 64) {
            int all_hex = 1;
            for (size_t i = 0; i < len; i++) {
                if (!isxdigit((unsigned char)line[i])) {
                    all_hex = 0;
                    break;
                }
            }
            if (all_hex) {
                strncpy(out_hash, line, hash_size - 1);
                out_hash[hash_size - 1] = '\0';
                found = 1;
                break;
            }
        }
    }
    fclose(f);
    remove(temp_out_path);
    return found ? 0 : -1;
#else
    char cmd[MAX_PATH_LEN + 32];
    snprintf(cmd, sizeof(cmd), "sha256sum \"%s\" 2>/dev/null", filepath);
    FILE *fp = popen(cmd, "r");
    if (!fp) return -1;

    if (!fgets(out_hash, (int)hash_size, fp)) {
        pclose(fp);
        return -1;
    }
    pclose(fp);

    // Output is "hash  filename" — extract just the hash (hex chars before first space)
    char *space = strchr(out_hash, ' ');
    if (space) *space = '\0';

    // Validate it's a 64-char hex hash
    size_t len = strlen(out_hash);
    if (len != 64) return -1;
    for (size_t i = 0; i < len; i++) {
        if (!isxdigit((unsigned char)out_hash[i])) return -1;
    }

    return 0;
#endif
}

/**
 * Compute the SHA256 hash over the package's canonical file list:
 * For each file (sorted by relative path):
 *   hash.update(relative_path + "\n")
 *   hash.update(file_contents)
 *
 * Files are resolved relative to base_dir. Uses a temp file to replicate
 * the continuous hash stream, then hashes that temp file.
 *
 * Missing files are treated as empty content: the relative path + "\n" is
 * still written, but no file bytes follow.  This keeps the hash well-defined
 * for partial installs.
 *
 * The file list must exactly match the published set: the publish hash
 * (hashUtils.mjs computeDirectoryHash) only hashes files that exist and emits
 * no entry for a listed-but-missing file, so an extra list entry would make
 * local and published hashes diverge.  Keeping the publish scripts and the
 * manifest's canonical `files` list in sync is what creates agreement.
 *
 * If out_files_found is non-NULL it receives the number of listed files
 * that actually exist on disk (drives Installed vs Not Installed).
 *
 * Returns 0 on success with 64-char hex digest in out_hash.
 */
int compute_directory_sha256(const char *base_dir,
                             const char **rel_paths, int num_files,
                             int *out_files_found,
                             char *out_hash, size_t hash_size) {
    if (!base_dir || !rel_paths || num_files <= 0 || !out_hash || hash_size < 65)
        return -1;

    // Create a temp file to accumulate the hash stream
    char tmp_path[MAX_PATH_LEN];
    FILE *tmp_file = NULL;

#ifdef _WIN32
    char tmp_dir[MAX_PATH_LEN];
    if (GetTempPathA(MAX_PATH_LEN, tmp_dir) == 0) return -1;
    char tmp_name[MAX_PATH_LEN];
    if (GetTempFileNameA(tmp_dir, "fsh", 0, tmp_name) == 0) return -1;
    strncpy(tmp_path, tmp_name, sizeof(tmp_path) - 1);
    tmp_path[sizeof(tmp_path) - 1] = '\0';
    tmp_file = fopen(tmp_path, "wb");
    if (!tmp_file) {
        remove(tmp_path);
        return -1;
    }
#else
    const char *tmpdir = getenv("TMPDIR");
    if (!tmpdir) tmpdir = "/tmp";
    snprintf(tmp_path, sizeof(tmp_path), "%s/fs_dirhash_XXXXXX", tmpdir);
    int tmp_fd = mkstemp(tmp_path);
    if (tmp_fd < 0) return -1;
    tmp_file = fdopen(tmp_fd, "wb");
    if (!tmp_file) {
        close(tmp_fd);
        remove(tmp_path);
        return -1;
    }
#endif

    // Allocate and initialize sorted index array
    int *sorted = (int *)malloc((size_t)num_files * sizeof(int));
    if (!sorted) {
        fclose(tmp_file);
        remove(tmp_path);
        return -1;
    }
    for (int i = 0; i < num_files; i++) sorted[i] = i;

    // Sort indexes by strcmp on relative paths
    for (int i = 1; i < num_files; i++) {
        int key = sorted[i];
        int j = i - 1;
        while (j >= 0 && strcasecmp(rel_paths[sorted[j]], rel_paths[key]) > 0) {
            sorted[j + 1] = sorted[j];
            j--;
        }
        sorted[j + 1] = key;
    }

    int ret = 0;
    int files_found = 0;
    for (int i = 0; i < num_files; i++) {
        const char *rel = rel_paths[sorted[i]];
        size_t rel_len = strlen(rel);

        // Write relative path + "\n" (single byte 0x0A, never CRLF)
        if (fwrite(rel, 1, rel_len, tmp_file) != rel_len ||
            fwrite("\n", 1, 1, tmp_file) != 1) {
            ret = -1;
            break;
        }

        // Build full path and write raw file contents.
        // Missing file → contributes path + "\n" with no bytes (empty content).
        char full_path[MAX_PATH_LEN];
        snprintf(full_path, sizeof(full_path), "%s%c%s", base_dir, PATH_SEPARATOR, rel);

#ifdef _WIN32
        WCHAR *wfull = utf8_to_wide(full_path);
        FILE *in = wfull ? _wfopen(wfull, L"rb") : NULL;
        free(wfull);
#else
        FILE *in = fopen(full_path, "rb");
#endif
        if (!in) {
            continue;
        }
        files_found++;

        char buf[65536];
        size_t n;
        while ((n = fread(buf, 1, sizeof(buf), in)) > 0) {
            if (fwrite(buf, 1, n, tmp_file) != n) {
                ret = -1;
                break;
            }
        }
        if (ferror(in)) ret = -1;
        fclose(in);
        if (ret != 0) break;
    }

    fclose(tmp_file);

    if (out_files_found) *out_files_found = files_found;

    if (ret == 0) {
        ret = compute_file_sha256(tmp_path, out_hash, hash_size);
    }

    remove(tmp_path);
    free(sorted);
    return ret;
}

/**
 * Return the published hashes for a package install.
 * The C code performs no network I/O: the manifest to compare against is the
 * copy the web UI fetched and POSTed (ingest_remote_manifest).  A static
 * cache with TTL avoids re-parsing the ingested manifest on every poll.
 * Returns 0 on success with hashes filled in, -1 if unavailable or parse fails.
 */
static int fetch_remote_hashes(char *utils_hash, size_t utils_hash_size,
                               char *fx_folder_hash, size_t fx_hash_size) {
    time_t now = time(NULL);

    // Check static cache
    if (g_hash_cache_time > 0 && (now - g_hash_cache_time) < HASH_CACHE_TTL_SEC &&
        g_utils_files_count > 0 && g_fx_files_count > 0) {
        if (strlen(g_cached_utils_hash) > 0) {
            strncpy(utils_hash, g_cached_utils_hash, utils_hash_size);
            utils_hash[utils_hash_size - 1] = '\0';
        }
        if (strlen(g_cached_fx_folder_hash) > 0) {
            strncpy(fx_folder_hash, g_cached_fx_folder_hash, fx_hash_size);
            fx_folder_hash[fx_hash_size - 1] = '\0';
        }
        return 0;
    }

    // No manifest ingested yet (the tab has not POSTed it).  Fall back to
    // the uploaded packages themselves: the zip IS the published artifact,
    // so hashes computed from it are authoritative for the up-to-date check.
    // The tab always uploads the zips before the manifest, so this covers
    // the case where the manifest fetch failed.
    if (!g_manifest_json) {
        char **uf = NULL;
        int uc = 0;
        char **xf = NULL;
        int xc = 0;
        int ok = hash_uploaded_zip(1, g_cached_utils_hash, sizeof(g_cached_utils_hash),
                                   &uf, &uc) == 0;
        if (ok) ok = hash_uploaded_zip(0, g_cached_fx_folder_hash, sizeof(g_cached_fx_folder_hash),
                                       &xf, &xc) == 0;
        if (ok) {
            set_package_files(1, uf, uc);
            set_package_files(0, xf, xc);
            g_hash_cache_time = time(NULL);
            g_hash_check_available = 1;
        } else {
            free_file_list(&uf, &uc);
            free_file_list(&xf, &xc);
            return -1;
        }
    } else {
        // Cache expired: re-parse the ingested manifest (updates the cache
        // time; an invalid manifest re-runs the zip fallback).
        if (ingest_remote_manifest(g_manifest_json, g_manifest_len) != 0) return -1;
    }

    if (strlen(g_cached_utils_hash) > 0) {
        strncpy(utils_hash, g_cached_utils_hash, utils_hash_size);
        utils_hash[utils_hash_size - 1] = '\0';
    }
    if (strlen(g_cached_fx_folder_hash) > 0) {
        strncpy(fx_folder_hash, g_cached_fx_folder_hash, fx_hash_size);
        fx_folder_hash[fx_hash_size - 1] = '\0';
    }
    return (strlen(g_cached_utils_hash) > 0 && strlen(g_cached_fx_folder_hash) > 0) ? 0 : -1;
}

/**
 * Internal helper: fetch remote hashes into a PackageHashes struct.
 * Returns 0 on success, -1 on failure.
 */
static int fetch_remote_hashes_internal(PackageHashes *out) {
    return fetch_remote_hashes(out->utils, sizeof(out->utils),
                               out->fx, sizeof(out->fx));
}

/**
 * Returns 1 if the remote hash Gist was reachable and parsed successfully,
 * 0 if the last fetch failed (unreachable, download error, or parse failure).
 * The UI uses this to show a warning when update checks are unavailable.
 */
int get_hash_check_available(void) {
    return g_hash_check_available;
}

/**
 * Last-update date ("YYYY-MM-DD") of a package from the remote manifest.
 * Empty string when the manifest was unreachable or has no date field.
 * Used by the web UI to annotate the manual-download links.
 */
const char *get_package_date(int is_utils) {
    return is_utils ? g_cached_utils_date : g_cached_fx_folder_date;
}

/**
 * Shared status check for config (fx-folder) or utils packages.
 * Returns 1 = up-to-date/installed, 0 = update needed/not installed.
 */
static int check_package_status(int is_utils, const char *base_dir) {
    const char **files = NULL;
    int count = 0;
    if (get_package_files(is_utils, &files, &count) != 0) return 0;

    int files_found = 0;
    char local_hash[65] = "";
    if (compute_directory_sha256(base_dir, files, count,
                                 &files_found, local_hash, sizeof(local_hash)) != 0) {
        return (files_found > 0) ? 1 : 0;
    }

    // During the initial scan we avoid the network hash check so browser
    // detection does not block; report file presence only.
    if (g_is_initial_scan) {
        return (files_found > 0) ? 1 : 0;
    }

    // Hash-based check: compare local hash against the published hash.
    PackageHashes remote;
    if (fetch_remote_hashes_internal(&remote) == 0) {
        const char *remote_hash = is_utils ? remote.utils : remote.fx;
        if (strlen(remote_hash) > 0) {
            return (strcmp(local_hash, remote_hash) == 0) ? 1 : 0;
        }
    }

    // Gist unreachable → fall back to file presence.
    return (files_found > 0) ? 1 : 0;
}

/* ===== File-presence checks (the "installed" flags) =====
 * The `installed` flags mean "files exist" and the `up_to_date` flags mean
 * "files match the published hashes".  A stale or partial install must show
 * as Installed + Update Available, never as Not Installed.  The hash-based
 * check_package_status() above answers the up_to_date question; these
 * helpers answer the installed question.
 */

/** True if path exists (UTF-8). */
static int path_exists(const char *path) {
#if defined(_WIN32)
    WCHAR *w = utf8_to_wide(path);
    if (!w) return 0;
    DWORD attrs = GetFileAttributesW(w);
    free(w);
    return attrs != INVALID_FILE_ATTRIBUTES;
#else
    struct stat st;
    return stat(path, &st) == 0;
#endif
}

static int dir_count_visitor(const char *full_path, void *ctx) {
    (void)full_path;
    int *count = (int *)ctx;
    (*count)++;
    return 0;
}

/** True if dir exists and has at least one entry. */
static int dir_has_entries(const char *dir) {
    int count = 0;
    int ok = walk_dir_entries(dir, dir_count_visitor, &count);
    return ok == 0 && count > 0;
}

/**
 * Presence-only "is this package installed here?" check.  Uses the canonical
 * file list when one has been ingested; before the first manifest upload the
 * fallback is a sentinel check (config.js in the binary dir, non-empty
 * chrome/utils dir) so a previous install is still reported as Installed.
 */
static int check_files_present(int is_utils, const char *base_dir) {
    const char **files = NULL;
    int count = 0;
    if (get_package_files(is_utils, &files, &count) == 0) {
        int found = 0;
        for (int i = 0; i < count; i++) {
            char p[MAX_PATH_LEN];
            snprintf(p, sizeof(p), "%s%c%s", base_dir, PATH_SEPARATOR, files[i]);
            if (path_exists(p)) found++;
        }
        return found > 0;
    }

    // No canonical list yet (the tab has not uploaded the manifest): sentinel
    // fallback so a previous install reads as Installed immediately.
    if (is_utils) return dir_has_entries(base_dir);
    char cfg[MAX_PATH_LEN];
    snprintf(cfg, sizeof(cfg), "%s%cconfig.js", base_dir, PATH_SEPARATOR);
    return path_exists(cfg);
}

/* ===== Canonical shipped file lists =====
 * The installer does NOT hardcode which files each package ships.  The
 * canonical `files` arrays live in the published manifest
 * (hashes.json) and are parsed at runtime.  Keeping the
 * publish scripts (hashUtils.mjs / upload.mjs) and the manifest's
 * `files` arrays in sync is what makes local and published hashes agree —
 * the publish hash only covers files that exist, so an extra list entry
 * would make them diverge.
 */

/** Free a file list produced by the list-building helpers. */
static void free_file_list(char ***list, int *count) {
    if (*list) {
        for (int i = 0; i < *count; i++) free((*list)[i]);
        free(*list);
    }
    *list = NULL;
    *count = 0;
}

/** Replace the cached file list for a package (is_utils 1 = utils, 0 = config). */
static void set_package_files(int is_utils, char **list, int count) {
    if (is_utils) {
        free_file_list(&g_utils_files, &g_utils_files_count);
        g_utils_files = list;
        g_utils_files_count = count;
    } else {
        free_file_list(&g_fx_files, &g_fx_files_count);
        g_fx_files = list;
        g_fx_files_count = count;
    }
}

/** Return the cached file list for a package.  0 with *list/*count, -1 if none. */
static int get_package_files(int is_utils, const char ***list, int *count) {
    if (is_utils) {
        if (!g_utils_files || g_utils_files_count <= 0) return -1;
        *list = (const char **)g_utils_files;
        *count = g_utils_files_count;
    } else {
        if (!g_fx_files || g_fx_files_count <= 0) return -1;
        *list = (const char **)g_fx_files;
        *count = g_fx_files_count;
    }
    return 0;
}

/**
 * Parse a JSON array of strings under a top-level section of the manifest.
 * A section object is flat ({hash, files, date}), so the first '{'..'}' pair
 * bounds it.  On success *out_list (malloc'd array of malloc'd strings) and
 * *out_count are set; caller frees with free_file_list().  The list must be
 * non-empty for a parse to succeed.
 * Returns 0 on success, -1 on any parse failure.
 */
static int parse_manifest_files(const char *json, const char *section,
                                char ***out_list, int *out_count) {
    *out_list = NULL;
    *out_count = 0;

    const char *sec = strstr(json, section);
    if (!sec) return -1;
    const char *open = strchr(sec, '{');
    if (!open) return -1;
    const char *close = strchr(open, '}');
    if (!close) return -1;

    const char *key = strstr(open, "\"files\"");
    if (!key || key >= close) return -1;

    const char *p = strchr(key, '[');
    if (!p || p >= close) return -1;
    p++;

    char **list = NULL;
    int count = 0;
    int parsed_all = 0;

    while (p < close) {
        while (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r') p++;
        if (p >= close) break;
        if (*p == ']') {
            parsed_all = 1;
            break;
        }
        if (*p == ',') {
            p++;
            continue;
        }
        if (*p != '"') break;
        p++;
        const char *s = p;
        while (*p && *p != '"') p++;
        if (*p != '"') break;
        size_t len = (size_t)(p - s);
        p++;

        char *copy = (char *)malloc(len + 1);
        if (!copy) break;
        memcpy(copy, s, len);
        copy[len] = '\0';

        char **nl = (char **)realloc(list, (size_t)(count + 1) * sizeof(char *));
        if (!nl) {
            free(copy);
            break;
        }
        list = nl;
        list[count++] = copy;
    }

    if (parsed_all && count > 0) {
        *out_list = list;
        *out_count = count;
        return 0;
    }
    free_file_list(&list, &count);
    return -1;
}

/** Duplicate a string (avoids relying on strdup under MinGW). */
static char *dup_string(const char *s) {
    size_t len = strlen(s);
    char *copy = (char *)malloc(len + 1);
    if (!copy) return NULL;
    memcpy(copy, s, len + 1);
    return copy;
}

/** True if rel matches one of the obsolete files (shipped but not hashed). */
static int is_obsolete_file(const char *rel) {
    for (int i = 0; i < OBSOLETE_FILES_COUNT; i++) {
        if (strcasecmp(rel, OBSOLETE_FILES[i]) == 0) return 1;
    }
    return 0;
}

/* Recursive collector: gather every file under a flattened extraction as a
   '/' -separated relative path (obsolete files excluded), mirroring the
   manifest's canonical flat `files` entries. */
typedef struct {
    char root[MAX_PATH_LEN];
    size_t root_len;
    char ***list;
    int *count;
    int failed;
} ZipTreeCollector;

static int collect_zip_tree_visitor(const char *full, void *ctx) {
    ZipTreeCollector *c = (ZipTreeCollector *)ctx;
    if (c->failed) return -1;
    if (path_is_dir(full)) {
        return walk_dir_entries(full, collect_zip_tree_visitor, ctx);
    }

    const char *rel = full + c->root_len;
    while (*rel == '/' || *rel == '\\') rel++;
    if (is_obsolete_file(rel)) return 0;

    size_t len = strlen(rel);
    char *copy = (char *)malloc(len + 1);
    if (!copy) {
        c->failed = 1;
        return -1;
    }
    for (size_t i = 0; i <= len; i++) {
        copy[i] = (rel[i] == '\\') ? '/' : rel[i];
    }
    char **nl = (char **)realloc(*c->list, (size_t)(*c->count + 1) * sizeof(char *));
    if (!nl) {
        free(copy);
        c->failed = 1;
        return -1;
    }
    *c->list = nl;
    (*c->list)[(*c->count)++] = copy;
    return 0;
}

static unsigned int g_ziphash_counter = 0;

/**
 * Compute the expected package hash and canonical file list from the
 * uploaded zip (the published package itself), used when the hash manifest
 * is missing or invalid.  The zip IS the published artifact, so hashes
 * computed from it are authoritative for the up-to-date comparison.
 *
 * The zip is flatten-extracted to a temp dir (stripping the single
 * top-level wrapper, e.g. fx-folder.zip's 'fx-folder' dir, exactly like the
 * install path) and hashed with the same reference algorithm as
 * compute_directory_sha256(), so a fresh install hashes identically to the
 * published package.
 *
 * Returns 0 with *out_hash (64 hex + NUL) and *out_list/*out_count set
 * (caller frees with free_file_list()); -1 if the zip is unavailable or
 * unreadable.
 */
static int hash_uploaded_zip(int is_utils, char *out_hash, size_t hash_size,
                             char ***out_list, int *out_count) {
    size_t len = 0;
    const unsigned char *data = installer_uploaded_zip(is_utils, &len);
    if (!data || len == 0) return -1;

    char base[MAX_PATH_LEN];
#ifdef _WIN32
    if (GetTempPathA(MAX_PATH_LEN, base) == 0) return -1;
#else
    const char *tmpdir = getenv("TMPDIR");
    if (!tmpdir) tmpdir = "/tmp";
    snprintf(base, sizeof(base), "%s", tmpdir);
#endif

    // Scratch area: extract_zip_flatten moves the flattened tree into the
    // dir we pass it, so write the temp zip there, extract, then drop the
    // zip and hash the pure tree.
    char work[MAX_PATH_LEN];
    snprintf(work, sizeof(work), "%s%c.fsh_ziphash_%d_%u", base, PATH_SEPARATOR,
             (int)time(NULL), g_ziphash_counter++);
    if (mkdir_recursive(work) != 0) return -1;

    char zip_path[MAX_PATH_LEN];
    snprintf(zip_path, sizeof(zip_path), "%s%cpackage.zip", work, PATH_SEPARATOR);
    if (save_buf_to_file(zip_path, (const char *)data, len) < 0) {
        remove_dir_tree(work);
        return -1;
    }
    if (extract_zip_flatten(zip_path, work) != 0) {
        remove_dir_tree(work);
        return -1;
    }
    remove(zip_path);

    char **files = NULL;
    int count = 0;
    ZipTreeCollector c;
    memset(&c, 0, sizeof(c));
    strncpy(c.root, work, sizeof(c.root) - 1);
    c.root_len = strlen(c.root);
    c.list = &files;
    c.count = &count;
    int walk_ok = (walk_dir_entries(work, collect_zip_tree_visitor, &c) == 0 && !c.failed);

    int ret = -1;
    if (walk_ok && count > 0) {
        const char **rel = (const char **)files;
        int files_found = 0;
        if (compute_directory_sha256(work, rel, count, &files_found,
                                     out_hash, hash_size) == 0 &&
            files_found > 0) {
            *out_list = files;
            *out_count = count;
            files = NULL;
            count = 0;
            ret = 0;
        }
    }
    free_file_list(&files, &count);
    remove_dir_tree(work);
    return ret;
}

/**
 * Store + parse the package manifest (hashes.json) posted by
 * the web UI.  Populates the cached published hashes, the canonical
 * per-package file lists (from the manifest's `files` arrays) and the
 * last-update dates, and marks the hash check as available.
 *
 * The manifest is authoritative only when it parses with BOTH hashes and a
 * non-empty `files` array per package.  A missing/invalid manifest falls
 * back to the uploaded packages: expected hashes and file lists are computed
 * from the zips themselves (see hash_uploaded_zip), so the up-to-date check
 * keeps working without the manifest.
 * Returns 0 on success, -1 if neither the manifest nor the zips yielded
 * usable hashes.
 */
int ingest_remote_manifest(const char *json, size_t len) {
    if (!json || len == 0) {
        g_hash_check_available = 0;
        return -1;
    }
    char *copy = (char *)malloc(len + 1);
    if (!copy) {
        g_hash_check_available = 0;
        return -1;
    }
    memcpy(copy, json, len);
    copy[len] = '\0';

    // Parse into locals first so a bad manifest does not clobber the current
    // caches (a failed re-ingest keeps the previous good state).
    char utils_hash[65] = "", fx_hash[65] = "";
    char **utils_files = NULL;
    int utils_count = 0;
    char **fx_files = NULL;
    int fx_count = 0;
    char utils_date[32] = "", fx_date[32] = "";

    const char *utils_section = strstr(copy, "\"utils\"");
    if (utils_section) {
        const char *hash_key = strstr(utils_section, "\"hash\"");
        if (hash_key) {
            const char *val_start = strchr(hash_key + 6, '"'); /* skip past "hash: */
            if (val_start) {
                val_start++;
                const char *val_end = strchr(val_start, '"');
                if (val_end) {
                    size_t hlen = (size_t)(val_end - val_start);
                    if (hlen > 0 && hlen < sizeof(utils_hash)) {
                        memcpy(utils_hash, val_start, hlen);
                        utils_hash[hlen] = '\0';
                    }
                }
            }
        }
        parse_json_string_field(utils_section, "\"date\"", utils_date, sizeof(utils_date));
    }
    parse_manifest_files(copy, "\"utils\"", &utils_files, &utils_count);

    const char *fx_section = strstr(copy, "\"fx-folder\"");
    if (fx_section) {
        const char *hash_key = strstr(fx_section, "\"hash\"");
        if (hash_key) {
            const char *val_start = strchr(hash_key + 6, '"');
            if (val_start) {
                val_start++;
                const char *val_end = strchr(val_start, '"');
                if (val_end) {
                    size_t hlen = (size_t)(val_end - val_start);
                    if (hlen > 0 && hlen < sizeof(fx_hash)) {
                        memcpy(fx_hash, val_start, hlen);
                        fx_hash[hlen] = '\0';
                    }
                }
            }
        }
        parse_json_string_field(fx_section, "\"date\"", fx_date, sizeof(fx_date));
    }
    parse_manifest_files(copy, "\"fx-folder\"", &fx_files, &fx_count);

    free(g_manifest_json);
    g_manifest_json = copy;
    g_manifest_len = len;

    // The manifest is authoritative only when it carries BOTH hashes and a
    // non-empty `files` array per package.  Anything less (old-format
    // manifests, truncated/garbage uploads) is treated as invalid: fall back
    // to the uploaded packages themselves — the zip IS the published
    // artifact, so expected hashes/file lists computed from it are
    // authoritative for the up-to-date comparison.
    if (utils_hash[0] == '\0' || fx_hash[0] == '\0' ||
        utils_count <= 0 || fx_count <= 0) {
        free_file_list(&utils_files, &utils_count);
        free_file_list(&fx_files, &fx_count);
        if (hash_uploaded_zip(1, g_cached_utils_hash, sizeof(g_cached_utils_hash),
                              &utils_files, &utils_count) == 0 &&
            hash_uploaded_zip(0, g_cached_fx_folder_hash, sizeof(g_cached_fx_folder_hash),
                              &fx_files, &fx_count) == 0) {
            set_package_files(1, utils_files, utils_count);
            set_package_files(0, fx_files, fx_count);
            g_hash_cache_time = time(NULL);
            g_hash_check_available = 1;
            console_printf("[hash] INFO: Manifest missing or invalid; "
                           "hashes computed from uploaded packages "
                           "(utils: %d files, config: %d files)\n",
                           utils_count, fx_count);
            return 0;
        }
        free_file_list(&utils_files, &utils_count);
        free_file_list(&fx_files, &fx_count);
        g_hash_check_available = 0;
        console_printf("[hash] WARNING: Package manifest is missing or invalid "
                       "and no usable uploaded packages\n");
        return -1;
    }

    strncpy(g_cached_utils_hash, utils_hash, sizeof(g_cached_utils_hash));
    strncpy(g_cached_fx_folder_hash, fx_hash, sizeof(g_cached_fx_folder_hash));
    strncpy(g_cached_utils_date, utils_date, sizeof(g_cached_utils_date));
    strncpy(g_cached_fx_folder_date, fx_date, sizeof(g_cached_fx_folder_date));
    set_package_files(1, utils_files, utils_count);
    set_package_files(0, fx_files, fx_count);
    g_hash_cache_time = time(NULL);
    g_hash_check_available = 1;
    console_printf("[hash] INFO: Package manifest ingested "
                   "(utils: %d files, config: %d files)\n",
                   utils_count, fx_count);
    return 0;
}

/**
 * Store the Waterfox releases JSON posted by the web UI and invalidate the
 * per-binary version cache so the next Waterfox version resolution re-parses
 * the new data.
 */
int ingest_waterfox_releases(const char *json, size_t len) {
    if (!json || len == 0) return -1;
    char *copy = (char *)malloc(len + 1);
    if (!copy) return -1;
    memcpy(copy, json, len);
    copy[len] = '\0';
    free(g_waterfox_releases_json);
    g_waterfox_releases_json = copy;
    g_waterfox_releases_len = len;
    reset_waterfox_version_cache();
    return 0;
}

/**
 * Re-resolve the marketing version of every detected Waterfox binary from the
 * ingested releases JSON (overwrites the application.ini fallback).
 */
void refresh_waterfox_versions(RunningBrowser *browsers, int count) {
    for (int i = 0; i < count; i++) {
        enum BrowserVariant v = identify_variant_from_path(browsers[i].binary_path);
        if (v == BROWSER_WATERFOX || v == BROWSER_WATERFOX_BETA) {
            char buf[64];
            read_application_version(browsers[i].binary_path, v, buf, sizeof(buf));
            snprintf(browsers[i].version, sizeof(browsers[i].version), "%s", buf);
        }
    }
}

/**
 * Full status refresh (file-existence AND hash-based up-to-date flags) for
 * one browser.  Unlike refresh_install_status(), this does not suppress the
 * hash comparison; call it after the manifest is ingested so the flags
 * reflect the published hashes.
 *
 * installed = file presence (a stale or partial install is still installed);
 * up_to_date = hash comparison against the ingested manifest.
 */
void refresh_install_status_full(RunningBrowser *browser) {
    char binary_dir[MAX_PATH_LEN];
    strncpy(binary_dir, browser->binary_path, MAX_PATH_LEN);
    get_parent_dir(binary_dir);
    char utils_dir[MAX_PATH_LEN];
    snprintf(utils_dir, sizeof(utils_dir), "%s%cchrome%cutils",
             browser->profile_path, PATH_SEPARATOR, PATH_SEPARATOR);

    int saved = g_is_initial_scan;
    g_is_initial_scan = 0;
    browser->config_installed = check_files_present(0, binary_dir);
    browser->utils_installed = check_files_present(1, utils_dir);
    browser->config_up_to_date = check_package_status(0, binary_dir);
    browser->utils_up_to_date = check_package_status(1, utils_dir);
    g_is_initial_scan = saved;
}

/**
 * --test-hash support: read a local manifest JSON file and compute the hash
 * for the given package type over the manifest's canonical `files` list.
 * Prints the hash to stdout.  Returns 0 on success, -1 on failure.
 */
int test_hash_from_manifest(const char *type, const char *dir_path,
                            const char *manifest_path) {
#ifdef _WIN32
    WCHAR *wman = utf8_to_wide(manifest_path);
    FILE *f = wman ? _wfopen(wman, L"rb") : NULL;
    free(wman);
#else
    FILE *f = fopen(manifest_path, "rb");
#endif
    if (!f) {
        fprintf(stderr, "ERROR: Could not open manifest: %s\n", manifest_path);
        fprintf(stderr, "Generate it first with: "
                        "node tools/publish/upload.mjs --local --mode=prod\n");
        return -1;
    }
    fseek(f, 0, SEEK_END);
    long sz = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (sz <= 0 || sz > (long)(32L * 1024L * 1024L)) {
        fclose(f);
        return -1;
    }
    char *json = (char *)malloc((size_t)sz + 1);
    if (!json) {
        fclose(f);
        return -1;
    }
    size_t rd = fread(json, 1, (size_t)sz, f);
    fclose(f);
    if (rd != (size_t)sz) {
        free(json);
        return -1;
    }
    json[rd] = '\0';

    char **files = NULL;
    int count = 0;
    int ok = -1;
    if (strcmp(type, "utils") == 0) {
        ok = parse_manifest_files(json, "\"utils\"", &files, &count);
    } else if (strcmp(type, "fx-folder") == 0) {
        ok = parse_manifest_files(json, "\"fx-folder\"", &files, &count);
    }
    free(json);
    if (ok != 0) {
        fprintf(stderr, "ERROR: Manifest has no 'files' list for package '%s'\n", type);
        return -1;
    }

    char hash[65] = "";
    const char **rel = (const char **)files;
    int result = compute_directory_sha256(dir_path, rel, count, NULL, hash, sizeof(hash));
    free_file_list(&files, &count);
    if (result != 0) {
        fprintf(stderr, "ERROR: Could not compute hash\n");
        return -1;
    }
    printf("%s\n", hash);
    return 0;
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
static void read_source_stamp(const char *binary_path, char *out, size_t out_size) {
    read_application_ini_value(binary_path, "SourceStamp", out, out_size);
}

/** Read the SourceRepository= line (the hg repo this build came from). */
static void read_source_repository(const char *binary_path, char *out, size_t out_size) {
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
 * Build the hg json-rev URL for a Firefox Beta / Developer Edition build.
 * Those builds report only the milestone ("154.0") in application.ini while
 * the browser shows the beta build number ("154.0b10"); the latter is encoded
 * in the hg release tags of the build's SourceStamp commit (see ingest_hg_tags).
 * The web UI fetches this CORS-enabled URL and POSTs the JSON back.  Leaves out
 * empty for non-beta builds, when application.ini lacks
 * SourceRepository/SourceStamp, or when the repository is not a Mozilla hg
 * repo (forks ship their own SourceRepository with no json-rev desktop tags),
 * so callers fall back to the milestone.
 */
void get_hg_tags_url(const char *binary_path, enum BrowserVariant variant,
                     char *out, size_t out_size) {
    if (!out || out_size == 0) return;
    out[0] = '\0';
    if (variant != BROWSER_FIREFOX_BETA && variant != BROWSER_FIREFOX_DEVEDITION) return;

    char repo[512], stamp[96];
    read_source_repository(binary_path, repo, sizeof(repo));
    read_source_stamp(binary_path, stamp, sizeof(stamp));
    if (!repo[0] || !stamp[0]) return;

    // Only Mozilla hg repositories carry the desktop release tags this lookup
    // decodes (DEVEDITION_/FIREFOX_ ... _RELEASE).  Forks (Waterfox, Zen,
    // LibreWolf, Floorp, ...) ship their own SourceRepository; never build a
    // json-rev URL against a foreign host, even if one were misclassified as
    // beta above.
    if (strstr(repo, "//hg.mozilla.org/") == NULL &&
        strstr(repo, "//hg-edge.mozilla.org/") == NULL) {
        return;
    }

    size_t rl = strlen(repo);
    while (rl > 0 && repo[rl - 1] == '/') repo[--rl] = '\0';
    snprintf(out, out_size, "%s/json-rev/%s", repo, stamp);
}

/* ===== Firefox beta/devedition display version (hg release tags) =====
 * Beta and Developer Edition builds report only the milestone in
 * application.ini ([App] Version= is "154.0") while the browser shows the
 * beta build number ("154.0b10").  That build number lives in the hg release
 * tags of the build's SourceStamp commit (e.g. DEVEDITION_154_0b10_RELEASE),
 * which the web UI fetches from the hg json-rev API and POSTs here. */

#define HG_TAGS_CACHE_MAX 16
static char g_hg_stamp[HG_TAGS_CACHE_MAX][96];
static char g_hg_version[HG_TAGS_CACHE_MAX][64];
static int g_hg_count = 0;

/**
 * Decode a desktop hg release tag into its display version:
 *   DEVEDITION_154_0b10_RELEASE -> "154.0b10"
 *   FIREFOX_154_0_1_RELEASE     -> "154.0.1"
 * Android tags (FIREFOX-ANDROID_*) are ignored.  The version is the segment
 * between the product prefix and the trailing _RELEASE/_BUILD<n>, with '_'
 * replaced by '.'.  Returns 0 on success, -1 if the tag is not a desktop tag.
 */
static int decode_hg_tag(const char *tag, char *out, size_t out_size) {
    if (!tag || !out || out_size == 0) return -1;
    if (strstr(tag, "ANDROID")) return -1;

    const char *ver = NULL;
    if (strncmp(tag, "DEVEDITION_", 11) == 0) {
        ver = tag + 11;
    } else if (strncmp(tag, "FIREFOX_", 8) == 0) {
        ver = tag + 8;
    } else {
        return -1;
    }

    size_t len = strlen(ver);
    const char *release = strstr(ver, "_RELEASE");
    if (release) {
        len = (size_t)(release - ver);
    } else {
        const char *build = strstr(ver, "_BUILD");
        if (build) len = (size_t)(build - ver);
    }
    if (len == 0 || len >= out_size) return -1;

    // The version segment is digits with '_' separators and an optional bN
    // build suffix.  Require a leading digit so unrelated FIREFOX_* tags
    // (e.g. FIREFOX_NIGHTLY_*) are rejected rather than decoded as a version.
    if (!isdigit((unsigned char)ver[0])) return -1;
    for (size_t i = 0; i < len; i++) {
        char c = ver[i];
        if (c == '_') {
            c = '.';
        } else if (!(isdigit((unsigned char)c) || c == 'b')) {
            return -1;
        }
        out[i] = c;
    }
    out[len] = '\0';
    return 0;
}

/** Parse the "node" (commit id) field from a json-rev response. */
static void parse_hg_node(const char *json, char *out, size_t out_size) {
    if (!out || out_size == 0) return;
    out[0] = '\0';
    if (!json) return;
    const char *key = strstr(json, "\"node\"");
    if (!key) return;
    const char *val_start = strchr(key + 6, '"');
    if (!val_start) return;
    val_start++;
    const char *val_end = strchr(val_start, '"');
    if (!val_end) return;
    size_t len = (size_t)(val_end - val_start);
    if (len >= out_size) len = out_size - 1;
    memcpy(out, val_start, len);
    out[len] = '\0';
}

/**
 * Find the best desktop version tag in a json-rev response and decode it.
 * Prefers _RELEASE tags over _BUILD<n>.  Returns 0 on success.
 */
static int parse_hg_version_from_json(const char *json, char *out, size_t out_size) {
    if (!out || out_size == 0) return -1;
    out[0] = '\0';
    if (!json) return -1;

    const char *tags_key = strstr(json, "\"tags\"");
    if (!tags_key) return -1;
    const char *open = strchr(tags_key, '[');
    if (!open) return -1;
    const char *close = strchr(open, ']');
    if (!close) return -1;

    char build_ver[64] = "";
    const char *p = open + 1;
    while (p < close) {
        const char *qs = strchr(p, '"');
        if (!qs || qs >= close) break;
        const char *qe = strchr(qs + 1, '"');
        if (!qe || qe >= close) break;
        size_t tlen = (size_t)(qe - qs - 1);
        if (tlen > 0 && tlen < 96) {
            char tag[96];
            memcpy(tag, qs + 1, tlen);
            tag[tlen] = '\0';
            char ver[64];
            if (decode_hg_tag(tag, ver, sizeof(ver)) == 0) {
                if (strstr(tag, "_RELEASE")) {
                    snprintf(out, out_size, "%s", ver);
                    return 0;
                }
                if (!build_ver[0]) {
                    snprintf(build_ver, sizeof(build_ver), "%s", ver);
                }
            }
        }
        p = qe + 1;
    }

    if (build_ver[0]) {
        snprintf(out, out_size, "%s", build_ver);
        return 0;
    }
    return -1;
}

/**
 * Store + parse a hg json-rev response posted by the web UI.  Extracts the
 * commit node and its desktop release-tag version into the per-commit cache.
 * Returns 0 on success, -1 when the response has no usable node/version tag.
 */
int ingest_hg_tags(const char *json, size_t len) {
    if (!json || len == 0) return -1;

    char node[96];
    char ver[64];
    parse_hg_node(json, node, sizeof(node));
    if (!node[0]) return -1;
    if (parse_hg_version_from_json(json, ver, sizeof(ver)) != 0) return -1;

    for (int i = 0; i < g_hg_count; i++) {
        if (strcmp(g_hg_stamp[i], node) == 0) {
            snprintf(g_hg_version[i], sizeof(g_hg_version[i]), "%s", ver);
            return 0;
        }
    }
    if (g_hg_count < HG_TAGS_CACHE_MAX) {
        snprintf(g_hg_stamp[g_hg_count], sizeof(g_hg_stamp[g_hg_count]), "%s", node);
        snprintf(g_hg_version[g_hg_count], sizeof(g_hg_version[g_hg_count]), "%s", ver);
        g_hg_count++;
    }
    return 0;
}

/**
 * Overwrite Firefox Beta / Developer Edition versions with the display version
 * resolved from their build's hg release tags (see ingest_hg_tags).  Call
 * after ingest_hg_tags(); browsers whose commit was not ingested (or that are
 * not beta builds) keep the application.ini milestone version.
 */
void refresh_firefox_versions(RunningBrowser *browsers, int count) {
    for (int i = 0; i < count; i++) {
        enum BrowserVariant v = identify_variant_from_path(browsers[i].binary_path);
        if (v != BROWSER_FIREFOX_BETA && v != BROWSER_FIREFOX_DEVEDITION) continue;

        char stamp[96];
        read_source_stamp(browsers[i].binary_path, stamp, sizeof(stamp));
        if (!stamp[0]) continue;

        for (int j = 0; j < g_hg_count; j++) {
            if (strcmp(g_hg_stamp[j], stamp) == 0 && g_hg_version[j][0]) {
                snprintf(browsers[i].version, sizeof(browsers[i].version),
                         "%s", g_hg_version[j]);
                break;
            }
        }
    }
}

/**
 * Resolve Waterfox's marketing version — what the browser shows and what its
 * GitHub releases are tagged with ("6.7.0-beta.3") — from the build's
 * SourceStamp.
 *
 * Waterfox's application.ini reports the Firefox-derived version (e.g.
 * "153.1.0") instead, which matches no GitHub release.  We read the build's
 * SourceStamp (git commit of the build, from application.ini) and scan the
 * most recent Waterfox releases for the one whose target_commitish is that
 * commit; its tag_name is the marketing version.  The releases JSON is
 * fetched by the web UI and POSTed to the local server
 * (ingest_waterfox_releases) — the C code performs no network I/O.  The
 * result is cached per binary so several profiles of the same install only
 * re-scan the buffer once.
 *
 * Leaves out empty on any failure (no SourceStamp, no releases JSON ingested,
 * no release with a matching commit) so callers fall back to the
 * application.ini version.
 */
static char g_wf_cached_binary[4][MAX_PATH_LEN];
static char g_wf_cached_version[4][64];
static int g_wf_cached_count = 0;

static void reset_waterfox_version_cache(void) {
    g_wf_cached_count = 0;
}

/**
 * Extract the string value that follows a `"key"` occurrence located at
 * key_pos.  Tolerates both compact (`"key":"value"`) and spaced
 * (`"key": "value"`) JSON — GitHub's releases API is compact.  Leaves out
 * empty when the key is not followed by a string value.
 */
static void json_value_after_key(const char *key_pos, const char *key,
                                 char *out, size_t out_size) {
    /* Validate before writing: `out` was dereferenced (out[0] = '\0') after
     * the guard, not before — flagged by gcc -fanalyzer. */
    if (!key_pos || !key || !out || out_size == 0) return;
    out[0] = '\0';
    const char *val_start = strchr(key_pos + strlen(key), '"');
    if (!val_start) return;
    val_start++;
    const char *val_end = strchr(val_start, '"');
    if (!val_end) return;
    size_t len = (size_t)(val_end - val_start);
    if (len >= out_size) len = out_size - 1;
    memcpy(out, val_start, len);
    out[len] = '\0';
}

static void read_waterfox_version_from_github(const char *binary_path, char *out, size_t out_size) {
    if (!binary_path || !out || out_size == 0) return;
    out[0] = '\0';

    for (int i = 0; i < g_wf_cached_count; i++) {
        if (strcmp(g_wf_cached_binary[i], binary_path) == 0) {
            snprintf(out, out_size, "%s", g_wf_cached_version[i]);
            return;
        }
    }

    char stamp[96];
    read_source_stamp(binary_path, stamp, sizeof(stamp));

    // Nothing to parse until the web UI has POSTed the releases JSON.
    if (stamp[0] && g_waterfox_releases_json) {
        // GitHub's JSON is compact (`"tag_name":"6.6.17"`, no space after the
        // colon), so values are extracted with json_value_after_key rather
        // than assuming a spaced `"key": "` layout.  On a target_commitish
        // match (>= 7 hex chars, prefix), the nearest preceding tag_name is
        // this release's marketing version.
        const char *tcs_key = "\"target_commitish\"";
        const char *tag_key = "\"tag_name\"";
        const char *p = g_waterfox_releases_json;
        while ((p = strstr(p, tcs_key)) != NULL) {
            char sha[96];
            json_value_after_key(p, tcs_key, sha, sizeof(sha));
            if (sha[0]) {
                size_t sha_len = strlen(sha);
                size_t n = sha_len < strlen(stamp) ? sha_len : strlen(stamp);
                if (n >= 7 && strncmp(sha, stamp, n) == 0) {
                    const char *tag = NULL;
                    const char *q = g_waterfox_releases_json;
                    while ((q = strstr(q, tag_key)) != NULL && q < p) {
                        tag = q;
                        q += strlen(tag_key);
                    }
                    if (tag) {
                        char ver[64];
                        json_value_after_key(tag, tag_key, ver, sizeof(ver));
                        if (ver[0]) snprintf(out, out_size, "%s", ver);
                    }
                    break;
                }
            }
            p += strlen(tcs_key);
        }
    }

    // Cache the outcome — empty too, so a lookup before the releases JSON
    // arrives does not re-scan for the next profile of the same install.
    if (g_wf_cached_count < (int)(sizeof(g_wf_cached_binary) / sizeof(g_wf_cached_binary[0]))) {
        strncpy(g_wf_cached_binary[g_wf_cached_count], binary_path, MAX_PATH_LEN);
        g_wf_cached_binary[g_wf_cached_count][MAX_PATH_LEN - 1] = '\0';
        snprintf(g_wf_cached_version[g_wf_cached_count], sizeof(g_wf_cached_version[g_wf_cached_count]), "%s", out);
        g_wf_cached_count++;
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
static void read_application_version(const char *binary_path,
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
                            strncpy(out, val, out_size - 1);
                            out[out_size - 1] = '\0';
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
        strncpy(out_path, rel_path, out_size - 1);
        out_path[out_size - 1] = '\0';
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
        strncpy(out_profile_path, profile_path_arg, MAX_PATH_LEN);
        out_profile_path[MAX_PATH_LEN - 1] = '\0';
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
    strncpy(binary_dir, binary_path, sizeof(binary_dir) - 1);
    binary_dir[sizeof(binary_dir) - 1] = '\0';
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
                strncpy(out_profile_path, candidate_path, MAX_PATH_LEN);
                break;
            }
        }
    }
    fclose(f);
}

int check_config_status(const char *binary_path) {
    // Presence-only: config.js (or the canonical file list) exists in the
    // binary dir.  The up-to-date verdict comes from check_package_status()
    // via refresh_install_status_full().
    return check_files_present(0, binary_path);
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
                    strncpy(out_profiles[count], candidate_path, MAX_PATH_LEN);
                    out_profiles[count][MAX_PATH_LEN - 1] = '\0';
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
    char binary_dir[MAX_PATH_LEN];
    strncpy(binary_dir, browser->binary_path, MAX_PATH_LEN);
    get_parent_dir(binary_dir);
    browser->config_installed = check_config_status(binary_dir);
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
                        strncpy(rp->exe_name, pe.szExeFile, sizeof(rp->exe_name));
                        strncpy(rp->binary_path, full_path, MAX_PATH_LEN);
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
            strncpy(proc_list[p].cmdline_profile, profile, MAX_PATH_LEN);
            proc_list[p].cmdline_profile[MAX_PATH_LEN - 1] = '\0';
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
            strncpy(claimed_profiles[claimed_count], proc_list[q].cmdline_profile, MAX_PATH_LEN);
            claimed_profiles[claimed_count][MAX_PATH_LEN - 1] = '\0';
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
            strncpy(cached_binary[pool_idx], proc_list[p].binary_path, MAX_PATH_LEN);
            cached_binary[pool_idx][MAX_PATH_LEN - 1] = '\0';

            int n = collect_locked_profiles(proc_list[p].binary_path, cached_pools[pool_idx], MAX_BROWSERS);
            cached_pool_sizes[pool_idx] = n;
            for (int a = 0; a < n; a++) {
                pool_assigned[pool_idx][a] = 0;
            }
            cached_pool_count++;
        }

        // Strong match from the command line
        if (strlen(proc_list[p].cmdline_profile) > 0) {
            strncpy(proc_list[p].assigned_profile, proc_list[p].cmdline_profile, MAX_PATH_LEN);
            proc_list[p].assigned_profile[MAX_PATH_LEN - 1] = '\0';
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
            strncpy(proc_list[p].assigned_profile, cached_pools[pool_idx][a], MAX_PATH_LEN);
            proc_list[p].assigned_profile[MAX_PATH_LEN - 1] = '\0';
            pool_assigned[pool_idx][a] = 1;
            assigned = 1;
            break;
        }

        if (!assigned) {
            // More processes than profiles, or collect_locked_profiles returned 0
            // (compatibility.ini check too strict).
            if (cached_pool_sizes[pool_idx] > 0) {
                strncpy(proc_list[p].assigned_profile, cached_pools[pool_idx][0], MAX_PATH_LEN);
                proc_list[p].assigned_profile[MAX_PATH_LEN - 1] = '\0';
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
            strncpy(results[count].exe_name, proc_list[p].exe_name, sizeof(results[count].exe_name));
            strncpy(results[count].binary_path, proc_list[p].binary_path, MAX_PATH_LEN);
            strncpy(results[count].profile_path, proc_list[p].assigned_profile, MAX_PATH_LEN);
            results[count].pid = proc_list[p].pid;

            resolve_browser_name(proc_list[p].binary_path, results[count].identified_browser,
                                 sizeof(results[count].identified_browser));
            read_application_version(proc_list[p].binary_path,
                                     identify_variant_from_path(proc_list[p].binary_path),
                                     results[count].version, sizeof(results[count].version));

            if (strlen(results[count].profile_path) > 0) {
                char binary_dir[MAX_PATH_LEN];
                strncpy(binary_dir, proc_list[p].binary_path, MAX_PATH_LEN);
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
                        strncpy(results[count].binary_path, full_path, MAX_PATH_LEN);
                        strncpy(results[count].profile_path, profile_path, MAX_PATH_LEN);
                        results[count].pid = (unsigned long)pid;

                        resolve_browser_name(full_path, results[count].identified_browser, sizeof(results[count].identified_browser));
                        read_application_version(full_path,
                                                 identify_variant_from_path(full_path),
                                                 results[count].version, sizeof(results[count].version));

                        if (strlen(results[count].profile_path) > 0) {
                            char binary_dir[MAX_PATH_LEN];
                            strncpy(binary_dir, full_path, MAX_PATH_LEN);
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
                    strncpy(results[count].binary_path, full_path, MAX_PATH_LEN);
                    strncpy(results[count].profile_path, profile_path, MAX_PATH_LEN);
                    results[count].pid = (unsigned long)pid;

                    resolve_browser_name(full_path, results[count].identified_browser,
                                         sizeof(results[count].identified_browser));
                    read_application_version(full_path,
                                             identify_variant_from_path(full_path),
                                             results[count].version, sizeof(results[count].version));

                    if (strlen(results[count].profile_path) > 0) {
                        char binary_dir[MAX_PATH_LEN];
                        strncpy(binary_dir, full_path, MAX_PATH_LEN);
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