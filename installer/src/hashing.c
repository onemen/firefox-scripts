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

int hash_uploaded_zip(int is_utils, char *out_hash, size_t hash_size,
                      char ***out_list, int *out_count);

/**
 * Compute the SHA-256 of a file bytes with the inlined FIPS 180-4
 * implementation (sha256.c) — no process spawn, no output-format dependency
 * on certutil/sha256sum, no mkstemp-then-hand-the-path-to-a-subprocess TOCTOU.
 * Returns 0 on success with 64-char lowercase hex (+ NUL) in out_hash.
 */
static int compute_file_sha256(const char *filepath, char *out_hash, size_t hash_size) {
    if (!filepath || !out_hash || hash_size < 65) return -1;

#ifdef _WIN32
    WCHAR *wpath = utf8_to_wide(filepath);
    FILE *f = wpath ? _wfopen(wpath, L"rb") : NULL;
    free(wpath);
#else
    FILE *f = fopen(filepath, "rb");
#endif
    if (!f) return -1;

    Sha256Ctx ctx;
    sha256_init(&ctx);
    unsigned char buf[65536];
    size_t n;
    int ret = 0;
    while ((n = fread(buf, 1, sizeof(buf), f)) > 0) {
        sha256_update(&ctx, buf, n);
    }
    if (ferror(f)) ret = -1;
    fclose(f);
    if (ret != 0) return ret;

    unsigned char digest[SHA256_DIGEST_SIZE];
    sha256_final(&ctx, digest);
    sha256_hex(digest, out_hash, hash_size);
    return 0;
}

/**
 * Canonical hash-path ordering: case-insensitive byte-wise comparison —
 * ASCII-lowercase each byte (primary key), then compare as unsigned char;
 * case-insensitively equal but distinct paths (A.txt vs a.txt) tie-break on
 * the raw bytes so the order is total and input-independent. The JS reference
 * (tools/publish/hashUtils.mjs compareCaseInsensitive) and the in-browser twin
 * (scriptsUpdater.sys.mjs compareHashOrder) implement the same byte contract
 * over UTF-8; the adversarial-path probe in installer/test/test_hash.mjs pins
 * the parity. Deliberately locale-independent.
 */
static int cmp_path_ci(const char *a, const char *b) {
    const char *ra = a;
    const char *rb = b;
    while (*a && *b) {
        unsigned char ca = (unsigned char)*a;
        unsigned char cb = (unsigned char)*b;
        if (ca >= 'A' && ca <= 'Z') ca = (unsigned char)(ca - 'A' + 'a');
        if (cb >= 'A' && cb <= 'Z') cb = (unsigned char)(cb - 'A' + 'a');
        if (ca != cb) return (int)ca - (int)cb;
        a++;
        b++;
    }
    unsigned char ca = (unsigned char)*a;
    unsigned char cb = (unsigned char)*b;
    if (ca >= 'A' && ca <= 'Z') ca = (unsigned char)(ca - 'A' + 'a');
    if (cb >= 'A' && cb <= 'Z') cb = (unsigned char)(cb - 'A' + 'a');
    if (ca != cb) return (int)ca - (int)cb;
    /* Folded-equal (reached only when both strings ended together): raw-byte
     * tie-break keeps distinct paths order-stable regardless of input. */
    return strcmp(ra, rb);
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

    // Hash the stream in memory: a staging file that exists only to be handed
    // to an external hashing tool is a TOCTOU window and a pointless disk
    // round-trip. The inline SHA-256 consumes the same bytes directly.
    Sha256Ctx ctx;
    sha256_init(&ctx);

    // Allocate and initialize sorted index array
    int *sorted = (int *)malloc((size_t)num_files * sizeof(int));
    if (!sorted) {
        return -1;
    }
    for (int i = 0; i < num_files; i++) sorted[i] = i;

    // Sort indexes by cmp_path_ci on relative paths
    for (int i = 1; i < num_files; i++) {
        int key = sorted[i];
        int j = i - 1;
        while (j >= 0 && cmp_path_ci(rel_paths[sorted[j]], rel_paths[key]) > 0) {
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

        // Feed relative path + "\n" (single byte 0x0A, never CRLF)
        sha256_update(&ctx, (const unsigned char *)rel, rel_len);
        sha256_update(&ctx, (const unsigned char *)"\n", 1);

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

        unsigned char buf[65536];
        size_t n;
        while ((n = fread(buf, 1, sizeof(buf), in)) > 0) {
            sha256_update(&ctx, buf, n);
        }
        if (ferror(in)) ret = -1;
        fclose(in);
        if (ret != 0) break;
    }

    if (out_files_found) *out_files_found = files_found;

    if (ret == 0) {
        unsigned char digest[SHA256_DIGEST_SIZE];
        sha256_final(&ctx, digest);
        sha256_hex(digest, out_hash, hash_size);
    }

    free(sorted);
    return ret;
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
 * Compute the expected package hash and canonical file list from a package
 * zip's raw bytes (the published package itself), used when the hash manifest
 * is missing or invalid — and by the manifest-verification path
 * (installer_verify_upload / installer_verify_stored_zips).
 * The zip IS the published artifact, so hashes computed from it are
 * authoritative for the up-to-date comparison.
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
int hash_zip_bytes(const unsigned char *data, size_t len, char *out_hash,
                   size_t hash_size, char ***out_list, int *out_count) {
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
#ifndef _WIN32
    // This scratch dir briefly holds the extracted package (privileged-JS
    // candidates) before hashing. Only it needs the restrictive mode — not
    // every mkdir_recursive target, which includes elevated install dirs a
    // non-root browser must still read.
    chmod(work, 0700);
#endif

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
    snprintf(c.root, sizeof(c.root), "%s", work);
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
 * Fetch the stored package zip and hash it — thin wrapper so the stored-zip
 * callers keep their original shape after the bytes-first split above.
 *
 * Returns 0 with *out_hash/*out_list/*out_count set (caller frees with
 * free_file_list()); -1 if the zip is unavailable or unreadable.
 */
int hash_uploaded_zip(int is_utils, char *out_hash, size_t hash_size,
                      char ***out_list, int *out_count) {
    size_t len = 0;
    const unsigned char *data = installer_uploaded_zip(is_utils, &len);
    return hash_zip_bytes(data, len, out_hash, hash_size, out_list, out_count);
}
