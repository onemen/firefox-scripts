#ifndef ADMIN_COPY_H
#define ADMIN_COPY_H

#include "platform.h"

/**
 * Copy a batch of files (src/dst pairs) into dst paths.
 *
 * On Windows, when any dst lives in a directory that the current process
 * cannot write to and the process is not elevated, the whole batch is handed
 * to a self-elevated copy of this executable (single UAC prompt), which
 * performs all copies and exits with a status code.  When no elevation is
 * needed the copies are done inline.
 *
 * Parent directories of every dst are created as needed.
 *
 * Returns 0 on success.
 * On failure returns a negative code and writes an error message to error_msg.
 */
int admin_copy_files(const char *const srcs[], const char *const dsts[], int count,
                     char *error_msg, size_t error_size);

/**
 * Handle the "--admin-copy" relaunch mode used by admin_copy_files().
 * argv[1] must equal "--admin-copy"; subsequent args are src/dst pairs.
 * Returns the process exit code (0 = success).
 */
int admin_copy_mode(int argc, char *argv[]);

/**
 * Copy an entire directory tree from src_dir into dst_dir, preserving the
 * relative layout.  Like admin_copy_files(), the whole batch is elevated with
 * a single UAC prompt when dst_dir is not writable.
 *
 * Returns 0 on success, negative on failure (error_msg filled in).
 */
int admin_copy_tree(const char *src_dir, const char *dst_dir,
                    char *error_msg, size_t error_size);

/**
 * Single-file convenience wrapper around admin_copy_files().
 * Returns 0 on success, negative on failure.
 */
int admin_copy(const char *src, const char *dst, char *error_msg, size_t error_size);

#endif /* ADMIN_COPY_H */
