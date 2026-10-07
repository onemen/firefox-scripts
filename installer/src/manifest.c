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
typedef struct {
    char utils[65];
    char fx[65];
} PackageHashes;

void free_file_list(char ***list, int *count);

/**
 * True when a manifest files[] relative path must be rejected before it is
 * ever joined onto a base directory.  The list is
 * attacker-controlled input (POST /api/manifest); the JS side applies the
 * same policy to the same list via isUnsafeZipEntryName
 * (scriptsUpdater.sys.mjs).  Rejects empty names, absolute paths, Windows
 * separators, drive letters, dot components, control characters and shell
 * metacharacters; caps the length at MAX_PATH_LEN - 1.
 */
static int manifest_rel_unsafe(const char *rel, size_t len) {
    static const char forbidden[] = "\"'`$&;|<>\n\r";
    if (!rel || len == 0 || len >= MAX_PATH_LEN) return 1;
    if (rel[0] == '/' || rel[0] == '\\') return 1;
    for (size_t i = 0; i < len; i++) {
        unsigned char c = (unsigned char)rel[i];
        if (c < 0x20 || c == 0x7F) return 1;      /* control chars */
        if (strchr(forbidden, (char)c)) return 1; /* shell metachars */
    }
    /* Component scan: dot components, drive letters ("C:"), separators. */
    char part[MAX_PATH_LEN];
    size_t cstart = 0;
    for (size_t i = 0; i <= len; i++) {
        if (i == len || rel[i] == '/') {
            size_t plen = i - cstart;
            if (plen >= sizeof(part)) return 1;
            if (plen > 0) {
                memcpy(part, rel + cstart, plen);
                part[plen] = '\0';
                if (strcmp(part, ".") == 0 || strcmp(part, "..") == 0) return 1;
                if (plen >= 2 && part[1] == ':') return 1; /* drive letter */
            }
            cstart = i + 1;
        } else if (rel[i] == '\\') {
            return 1; /* backslash: Windows separator, always an attack here */
        }
    }
    return 0;
}
static void set_package_files(int is_utils, char **list, int count);
static int get_package_files(int is_utils, const char ***list, int *count);
static int parse_manifest_files(const char *json, const char *section,
                                char ***out_list, int *out_count);

static void reset_waterfox_version_cache(void);

/* ===== Hash-based status check infrastructure ===== */

/**
 * Global flag: zero until the remote hash manifest has been ingested and
 * parsed successfully.  Reset to 1 by ingest_remote_manifest() on success.
 * Exposed via get_hash_check_available() so the UI can surface the status.
 */
int g_hash_check_available = 0;

/* Hash-related diagnostics always print: the whole point of the status flag is
   to surface remote-hash failures instead of silently falling back. */

/**
 * Static cache for remote hashes from the publish-branch hash manifest.
 * Cache TTL prevents re-downloading on every status poll.
 */
static char g_cached_utils_hash[65] = "";
static char g_cached_fx_folder_hash[65] = "";
static time_t g_hash_cache_time = 0;
#define HASH_CACHE_TTL_SEC 300 /* 5 minutes */

/* Canonical shipped file lists, per package (relative paths, '/' separators).
   Each entry is a malloc'd string.  Populated by ingest_remote_manifest() from
   the manifest's `files` arrays. */
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
            snprintf(utils_hash, utils_hash_size, "%s", g_cached_utils_hash);
        }
        if (strlen(g_cached_fx_folder_hash) > 0) {
            snprintf(fx_folder_hash, fx_hash_size, "%s", g_cached_fx_folder_hash);
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
        snprintf(utils_hash, utils_hash_size, "%s", g_cached_utils_hash);
    }
    if (strlen(g_cached_fx_folder_hash) > 0) {
        snprintf(fx_folder_hash, fx_hash_size, "%s", g_cached_fx_folder_hash);
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
 * Returns 1 if the remote hash manifest was reachable and parsed successfully,
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
int check_package_status(int is_utils, const char *base_dir) {
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

    // Manifest unreachable → fall back to file presence.
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
int check_files_present(int is_utils, const char *base_dir) {
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
void free_file_list(char ***list, int *count) {
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

        /* Validate BEFORE copying on: the files list is attacker-controlled
         * input (POST /api/manifest), and a rel is later joined into a full
         * path and - historically - interpolated into a shell command.
         * Mirror the JS guard the updater applies to the
         * same list (isUnsafeZipEntryName, scriptsUpdater.sys.mjs). */
        if (manifest_rel_unsafe(s, len)) {
            free_file_list(&list, &count);
            return -1;
        }

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
int is_obsolete_file(const char *rel) {
    for (int i = 0; i < OBSOLETE_FILES_COUNT; i++) {
        if (strcasecmp(rel, OBSOLETE_FILES[i]) == 0) return 1;
    }
    return 0;
}

/**
 * Extract one package's published `hash` from a manifest body. `section` is
 * the quoted section key ("\"utils\"" / "\"fx-folder\"") — the exact search
 * ingest_remote_manifest() has always used; ingest and the upload/manifest
 * verification share this one parser so
 * they can never disagree about what the manifest says. `json` must point at
 * at least `len` bytes; the working copy is bounded by them.
 *
 * Returns 0 with out filled (64 hex + NUL), -1 when the manifest carries no
 * hash for the package (out stays empty).
 */
static int manifest_package_hash(const char *json, size_t len, const char *section,
                                 char *out, size_t out_size) {
    out[0] = '\0';
    if (!json || len == 0 || !section || out_size < 65) return -1;
    char *copy = (char *)malloc(len + 1);
    if (!copy) return -1;
    memcpy(copy, json, len);
    copy[len] = '\0';

    int ret = -1;
    const char *sec = strstr(copy, section);
    if (sec) {
        const char *hash_key = strstr(sec, "\"hash\"");
        if (hash_key) {
            const char *val_start = strchr(hash_key + 6, '"'); /* skip past "hash: */
            if (val_start) {
                val_start++;
                const char *val_end = strchr(val_start, '"');
                if (val_end) {
                    size_t hlen = (size_t)(val_end - val_start);
                    if (hlen > 0 && hlen < out_size) {
                        memcpy(out, val_start, hlen);
                        out[hlen] = '\0';
                        ret = 0;
                    }
                }
            }
        }
    }
    free(copy);
    return ret;
}

/**
 * Compare a package zip's directory hash against the hash a manifest body
 * publishes for it. Returns 0 when they match — and also when there is
 * nothing to verify (no manifest, or no hash for that package: the
 * documented no-manifest fallback, where the zip is its own reference, is
 * unchanged). Returns -1 only for a real mismatch, or when a zip that
 * SHOULD be verifiable cannot be hashed at all (fail closed).
 */
static int zip_matches_manifest_hash(const char *manifest_json, size_t manifest_len,
                                     int is_utils, const unsigned char *zip,
                                     size_t zip_len) {
    if (!manifest_json || manifest_len == 0) return 0;
    char expected[65];
    if (manifest_package_hash(manifest_json, manifest_len,
                              is_utils ? "\"utils\"" : "\"fx-folder\"",
                              expected, sizeof(expected)) != 0) {
        return 0; /* no published hash for this package — nothing to check */
    }
    char actual[65];
    char **files = NULL;
    int count = 0;
    if (hash_zip_bytes(zip, zip_len, actual, sizeof(actual), &files, &count) != 0) {
        free_file_list(&files, &count);
        return -1; /* unverifiable (corrupt zip) — fail closed */
    }
    free_file_list(&files, &count);
    return strcmp(actual, expected) == 0 ? 0 : -1;
}

/**
 * Verify a candidate upload against the manifest already ingested
 * for POST /api/upload. Called BEFORE the zip is stored.
 * Returns 0 when the bytes match or when no manifest reference exists yet;
 * -1 on mismatch — the handler answers 403.
 */
int installer_verify_upload(int is_utils, const char *data, size_t len) {
    if (!g_manifest_json) return 0; /* no reference yet — upload proceeds */
    return zip_matches_manifest_hash(g_manifest_json, g_manifest_len, is_utils,
                                     (const unsigned char *)data, len);
}

/**
 * Verify the zips already stored against a CANDIDATE manifest body
 * for POST /api/manifest. Called BEFORE ingest, so a mismatched
 * manifest is refused and the current state stays untouched. The manifest
 * and the zips arrive in parallel (10-ingest.js), so this covers zip-first
 * order while installer_verify_upload() covers manifest-first. Returns 0
 * when everything matches or nothing is stored yet (the upload path will
 * verify later); -1 on mismatch.
 */
int installer_verify_stored_zips(const char *manifest_json, size_t len) {
    if (!manifest_json || len == 0) return 0;
    size_t zlen = 0;
    const unsigned char *zip = installer_uploaded_zip(1, &zlen);
    if (zip && zlen > 0 &&
        zip_matches_manifest_hash(manifest_json, len, 1, zip, zlen) != 0) {
        return -1;
    }
    zip = installer_uploaded_zip(0, &zlen);
    if (zip && zlen > 0 &&
        zip_matches_manifest_hash(manifest_json, len, 0, zip, zlen) != 0) {
        return -1;
    }
    return 0;
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
        /* one shared hash parser — exactly what the upload/manifest
         * verification compares against */
        manifest_package_hash(copy, len, "\"utils\"", utils_hash, sizeof(utils_hash));
        parse_json_string_field(utils_section, "\"date\"", utils_date, sizeof(utils_date));
    }
    parse_manifest_files(copy, "\"utils\"", &utils_files, &utils_count);

    const char *fx_section = strstr(copy, "\"fx-folder\"");
    if (fx_section) {
        manifest_package_hash(copy, len, "\"fx-folder\"", fx_hash, sizeof(fx_hash));
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

    snprintf(g_cached_utils_hash, sizeof(g_cached_utils_hash), "%s", utils_hash);
    snprintf(g_cached_fx_folder_hash, sizeof(g_cached_fx_folder_hash), "%s", fx_hash);
    snprintf(g_cached_utils_date, sizeof(g_cached_utils_date), "%s", utils_date);
    snprintf(g_cached_fx_folder_date, sizeof(g_cached_fx_folder_date), "%s", fx_date);
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

void read_waterfox_version_from_github(const char *binary_path, char *out, size_t out_size) {
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
        snprintf(g_wf_cached_binary[g_wf_cached_count], MAX_PATH_LEN, "%s", binary_path);
        snprintf(g_wf_cached_version[g_wf_cached_count], sizeof(g_wf_cached_version[g_wf_cached_count]), "%s", out);
        g_wf_cached_count++;
    }
}
