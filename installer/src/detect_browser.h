#ifndef DETECT_BROWSER_H
#define DETECT_BROWSER_H

#include "platform.h"

#define MAX_BROWSERS 50

enum BrowserVariant {
    BROWSER_FIREFOX_RELEASE,
    BROWSER_FIREFOX_DEVEDITION,
    BROWSER_FIREFOX_NIGHTLY,
    BROWSER_FIREFOX_BETA,
    BROWSER_WATERFOX,
    BROWSER_WATERFOX_BETA,
    BROWSER_ZEN,
    BROWSER_ZEN_TWILIGHT,
    BROWSER_LIBREWOLF,
    BROWSER_FLOORP,
    BROWSER_UNKNOWN
};

typedef struct {
    char exe_name[64];
    char binary_path[MAX_PATH_LEN];
    char profile_path[MAX_PATH_LEN];
    char identified_browser[128];
    char version[64];  // app version from application.ini, e.g. "155.0a1" (empty if unreadable)
    unsigned long pid;
    // Status fields
    int config_installed;   // 1 if at least one listed config file exists in binary dir
    int utils_installed;    // 1 if at least one listed utils file exists in profile
    int config_up_to_date;  // 1 if hashes match remote (requires fetch)
    int utils_up_to_date;   // Same for utils
} RunningBrowser;

/**
 * Scan running processes for known Gecko-based browsers
 * Returns the number of browsers found
 */
int scan_and_filter_browsers(RunningBrowser *results, int max_results);

/**
 * Refresh config_installed and utils_installed using file-existence checks
 * only (fast, no network, no hashing).  The up-to-date flags are left
 * untouched — the caller marks the just-installed components up-to-date
 * directly.  Call after an install completes so the UI shows the correct
 * installed/not-installed state rather than hash mismatch.
 */
void refresh_install_status(RunningBrowser *browser);

/**
 * Check if config files are installed in the binary directory
 * Returns 1 if installed, 0 if not
 */
int check_config_status(const char *binary_path);

/**
 * Check if utils files are installed in the profile directory
 * Returns 1 if installed, 0 if not
 */
int check_utils_status(const char *profile_path);

/**
 * Identify browser variant from its binary path
 */
enum BrowserVariant identify_variant_from_path(const char *path);

/**
 * Returns 1 if the remote hash Gist was reachable on the last fetch,
 * 0 if unreachable or the JSON could not be parsed.
 * The UI uses this to show a warning when update checks are unavailable.
 */
int get_hash_check_available(void);

/**
 * Last-update date ("YYYY-MM-DD") of a package from the remote manifest.
 * Empty string when the manifest was unreachable or has no date field.
 * Used by the web UI to annotate the manual-download links.
 */
const char *get_package_date(int is_utils);

/* ===== Browser-uploaded data ingestion =====
 * The installer C code performs no network I/O: the web UI fetches the hash
 * manifest, the package zips, the Waterfox releases list, the Firefox
 * beta/devedition hg tags and the installer latest-release JSON from
 * CORS-enabled URLs and POSTs the raw bytes to the local server.  These
 * functions ingest those payloads. */

/**
 * Store + parse the package manifest (hashes.json) posted by
 * the web UI.  Populates the cached published hashes, the canonical
 * per-package file lists (from the manifest's `files` arrays) and the
 * last-update dates, and marks the hash check as available.
 *
 * The manifest is authoritative only when it parses with BOTH hashes and a
 * non-empty `files` array per package; otherwise the expected hashes and
 * file lists are computed from the uploaded package zips (the published
 * artifact itself).  On success the caller should re-run
 * refresh_install_status_full() for every detected browser.
 * Returns 0 on success, -1 if neither the manifest nor the zips yielded
 * usable hashes.
 */
int ingest_remote_manifest(const char *json, size_t len);

/**
 * Store the Waterfox releases JSON posted by the web UI and invalidate the
 * per-binary version cache so the next Waterfox version resolution re-parses
 * the new data.  Returns 0 on success, -1 on failure.
 */
int ingest_waterfox_releases(const char *json, size_t len);

/**
 * Re-resolve the marketing version of every detected Waterfox binary from the
 * ingested releases JSON (overwrites the application.ini fallback).  Call
 * after ingest_waterfox_releases() so the UI shows the correct version.
 */
void refresh_waterfox_versions(RunningBrowser *browsers, int count);

/**
 * Build the hg json-rev URL for a Firefox Beta / Developer Edition binary
 * (empty for other variants or when application.ini lacks
 * SourceRepository/SourceStamp).  The web UI fetches this CORS-enabled URL
 * and POSTs the JSON back via /api/hg-tags.
 */
void get_hg_tags_url(const char *binary_path, enum BrowserVariant variant,
                     char *out, size_t out_size);

/**
 * Store + parse a hg json-rev response posted by the web UI.  Extracts the
 * commit node and its desktop release-tag version (e.g. "154.0b10" from
 * DEVEDITION_154_0b10_RELEASE).  Returns 0 on success, -1 on failure.
 */
int ingest_hg_tags(const char *json, size_t len);

/**
 * Re-resolve Firefox Beta / Developer Edition display versions from the
 * ingested hg tags (overwrites the application.ini milestone fallback).  Call
 * after ingest_hg_tags() so the UI shows the correct version.
 */
void refresh_firefox_versions(RunningBrowser *browsers, int count);

/**
 * Full status refresh (file-existence AND hash-based up-to-date flags) for
 * one browser.  Unlike refresh_install_status(), this does not suppress the
 * hash comparison; call it after the manifest is ingested so the flags
 * reflect the published hashes.
 */
void refresh_install_status_full(RunningBrowser *browser);

/**
 * URL of the Waterfox releases list (CORS-enabled) that the web UI fetches.
 */
#define WATERFOX_RELEASES_URL \
    "https://api.github.com/repos/BrowserWorks/waterfox/releases?per_page=30&page=1"

/**
 * --test-hash support: read a local manifest JSON file and compute the hash
 * for the given package type ("utils" or "fx-folder") over the manifest's
 * canonical `files` list.  Prints the hash to stdout.
 * Returns 0 on success, -1 on failure.
 */
int test_hash_from_manifest(const char *type, const char *dir_path,
                            const char *manifest_path);

/**
 * Compute the SHA256 hash over the package's canonical file list.
 * For each file (sorted by relative path):
 *   hash.update(relative_path + "\n")
 *   hash.update(file_contents)
 * Missing files contribute the relative path + "\n" with no bytes, so the
 * hash stays well-defined for partial installs.  The file list must exactly
 * match what publish ships (publish emits no entry for listed-but-missing
 * files, so an extra list entry would make local and published hashes diverge).
 * If out_files_found is non-NULL it receives the number of listed files
 * that exist on disk.
 * Returns 0 on success with 64-char hex digest in out_hash.
 */
int compute_directory_sha256(const char *base_dir,
                             const char **rel_paths, int num_files,
                             int *out_files_found,
                             char *out_hash, size_t hash_size);

#endif /* DETECT_BROWSER_H */
