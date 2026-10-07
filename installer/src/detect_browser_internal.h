#ifndef DETECT_BROWSER_INTERNAL_H
#define DETECT_BROWSER_INTERNAL_H

/*
 * detect_browser_internal.h — the internal surface shared by the three
 * modules the 2026-10-06 audit split out of detect_browser.c (P2-15,
 * #450): hashing.c (SHA-256 over directories and uploaded zips),
 * manifest.c (the strstr JSON parsing of hashes.json / Waterfox releases /
 * hg tags) and detect_browser.c (browser, process and profile detection).
 *
 * Everything declared here is file-local BY DESIGN: a helper two of the
 * three modules need that the installer API (platform.h /
 * detect_browser.h) must never expose. Nothing outside this trio includes
 * this header.
 */

#include "detect_browser.h"

int check_files_present(int is_utils, const char *base_dir);
int check_package_status(int is_utils, const char *base_dir);
void console_printf(const char *fmt, ...);
void free_file_list(char ***list, int *count);
int hash_uploaded_zip(int is_utils, char *out_hash, size_t hash_size,
                      char ***out_list, int *out_count);
int hash_zip_bytes(const unsigned char *data, size_t len, char *out_hash,
                   size_t hash_size, char ***out_list, int *out_count);
int is_obsolete_file(const char *rel);
void read_application_version(const char *binary_path,
                              enum BrowserVariant variant,
                              char *out, size_t out_size);
void read_source_repository(const char *binary_path, char *out, size_t out_size);
void read_source_stamp(const char *binary_path, char *out, size_t out_size);
void read_waterfox_version_from_github(const char *binary_path, char *out, size_t out_size);

extern int g_is_initial_scan;
#endif /* DETECT_BROWSER_INTERNAL_H */
