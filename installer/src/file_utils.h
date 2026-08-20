#ifndef FILE_UTILS_H
#define FILE_UTILS_H

#include "platform.h"

typedef int (*dir_visitor_fn)(const char *full_path, void *ctx);

/**
 * Invoke visitor for every direct child of dir (files and directories).
 * Returns 0 on success.
 */
int walk_dir_entries(const char *dir, dir_visitor_fn visitor, void *ctx);

/**
 * True if path is a directory.
 */
int path_is_dir(const char *path);

/**
 * Save a memory buffer to a file (binary-safe).
 * Returns 0 on success, -1 on failure.
 */
int save_buf_to_file(const char *path, const char *data, size_t data_len);

/**
 * Extract a zip archive (located at zip_path) into dest_dir.
 * Returns 0 on success, -1 on failure.
 */
int extract_zip(const char *zip_path, const char *dest_dir);

/**
 * Extract a zip archive into dest_dir, flattening a single top-level directory
 * wrapper (e.g. fx-folder.zip ships files under an 'fx-folder' directory for
 * manual downloads).  Flat zips are extracted normally.
 * Returns 0 on success, -1 on failure.
 */
int extract_zip_flatten(const char *zip_path, const char *dest_dir);

/**
 * Create directories recursively for a given path (parent of file).
 * Returns 0 on success, -1 on failure.
 */
int mkdir_recursive(const char *path);

/**
 * Recursively delete a directory tree.
 * Returns 0 on success, -1 on failure.
 */
int remove_dir_tree(const char *dir);

#endif /* FILE_UTILS_H */
