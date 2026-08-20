#include "file_utils.h"
#include <string.h>
#include <stdlib.h>

#include "vendor/miniz/miniz.h"

#ifdef _WIN32
#include <windows.h>
#else
#include <unistd.h>
#include <dirent.h>
#include <sys/stat.h>
#endif

/**
 * True when a zip entry name is unsafe to write (absolute path, backslash,
 * or parent-directory traversal).  The published zips never contain such
 * names; this is a defense-in-depth guard around the miniz extraction.
 */
static int zip_entry_name_unsafe(const char *name) {
    if (!name || name[0] == '\0' || name[0] == '/' || strchr(name, '\\')) return 1;
    if (strncmp(name, "../", 3) == 0 || strstr(name, "/../")) return 1;
    return 0;
}

int save_buf_to_file(const char *path, const char *data, size_t data_len) {
#ifdef _WIN32
    WCHAR *wpath = utf8_to_wide(path);
    if (!wpath) return -1;
    FILE *f = _wfopen(wpath, L"wb");
    free(wpath);
#else
    FILE *f = fopen(path, "wb");
#endif
    if (!f) return -1;
    size_t written = fwrite(data, 1, data_len, f);
    fclose(f);
    return (written == data_len) ? 0 : -1;
}

/**
 * Extract a zip archive into dest_dir using the vendored miniz memory
 * reader — no external `unzip`, PowerShell Expand-Archive, or tar dependency
 * on any platform.  Only regular files are written; entry names are
 * sanitized against path traversal and parent directories are created as
 * needed.  The archive file and every output file are opened through the
 * UTF-8/wide-char helpers on Windows, so non-ASCII paths (e.g. Hebrew
 * profile directories) reach the filesystem intact.
 * Returns 0 on success, -1 on failure.
 */
int extract_zip(const char *zip_path, const char *dest_dir) {
    // Read the whole archive into memory.
#ifdef _WIN32
    WCHAR *wzip = utf8_to_wide(zip_path);
    FILE *f = wzip ? _wfopen(wzip, L"rb") : NULL;
    free(wzip);
#else
    FILE *f = fopen(zip_path, "rb");
#endif
    if (!f) return -1;
    fseek(f, 0, SEEK_END);
    long sz = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (sz <= 0 || sz > (long)(256L * 1024L * 1024L)) {
        fclose(f);
        return -1;
    }
    char *data = (char *)malloc((size_t)sz);
    if (!data) {
        fclose(f);
        return -1;
    }
    if (fread(data, 1, (size_t)sz, f) != (size_t)sz) {
        free(data);
        fclose(f);
        return -1;
    }
    fclose(f);

    mz_zip_archive zip;
    memset(&zip, 0, sizeof(zip));
    if (!mz_zip_reader_init_mem(&zip, data, (size_t)sz, 0)) {
        free(data);
        return -1;
    }

    // Make sure the destination exists (flat archives have no parent dirs to
    // trigger the per-entry mkdir below).  Existing dirs are tolerated.
    if (mkdir_recursive(dest_dir) != 0) {
        mz_zip_reader_end(&zip);
        free(data);
        return -1;
    }

    int ret = 0;
    mz_uint num = mz_zip_reader_get_num_files(&zip);
    for (mz_uint i = 0; i < num; i++) {
        mz_zip_archive_file_stat st;
        if (!mz_zip_reader_file_stat(&zip, i, &st)) {
            ret = -1;
            break;
        }
        if (mz_zip_reader_is_file_a_directory(&zip, i)) continue;
        if (zip_entry_name_unsafe(st.m_filename)) {
            ret = -1;
            break;
        }

        char out_path[MAX_PATH_LEN];
        snprintf(out_path, sizeof(out_path), "%s%c%s", dest_dir, PATH_SEPARATOR, st.m_filename);

        // Ensure the entry's parent directories exist.  Zip entry names use
        // '/' (zip standard), so cut at '/'; mkdir_recursive() then handles
        // the platform separator.
        char *p = out_path + strlen(dest_dir) + 1;
        for (; *p; p++) {
            if (*p == '/') {
                *p = '\0';
                mkdir_recursive(out_path);
                *p = '/';
            }
        }

        // Extract to memory, then write via the UTF-8-safe writer (wide-char
        // APIs on Windows).  miniz's own extract-to-file uses plain fopen,
        // which cannot address non-ASCII paths on Windows.
        size_t out_size = 0;
        void *out = mz_zip_reader_extract_to_heap(&zip, i, &out_size, 0);
        if (!out) {
            ret = -1;
            break;
        }
        if (save_buf_to_file(out_path, (const char *)out, out_size) != 0) {
            free(out);
            ret = -1;
            break;
        }
        free(out);
    }
    mz_zip_reader_end(&zip);
    free(data);
    return ret;
}

int mkdir_recursive(const char *path) {
    char tmp[MAX_PATH_LEN];
    strncpy(tmp, path, sizeof(tmp) - 1);
    tmp[sizeof(tmp) - 1] = '\0';

    for (char *p = tmp + 1; *p; p++) {
        if (*p == PATH_SEPARATOR) {
            *p = '\0';
#ifdef _WIN32
            // Cutting at a separator always lands on a UTF-8 char boundary.
            WCHAR *wdir = utf8_to_wide(tmp);
            if (wdir) {
                CreateDirectoryW(wdir, NULL);
                free(wdir);
            }
#else
            mkdir(tmp, 0755);
#endif
            *p = PATH_SEPARATOR;
        }
    }
#ifdef _WIN32
    WCHAR *wdir = utf8_to_wide(tmp);
    if (wdir) {
        CreateDirectoryW(wdir, NULL);
        free(wdir);
    }
#else
    mkdir(tmp, 0755);
#endif
    return 0;
}

/* ===== Zip extraction with top-level folder flattening ===== */

/** True if path is a directory. */
int path_is_dir(const char *path) {
#ifdef _WIN32
    WCHAR *wpath = utf8_to_wide(path);
    if (!wpath) return 0;
    DWORD attrs = GetFileAttributesW(wpath);
    free(wpath);
    return (attrs != INVALID_FILE_ATTRIBUTES && (attrs & FILE_ATTRIBUTE_DIRECTORY)) ? 1 : 0;
#else
    struct stat st;
    return (stat(path, &st) == 0 && S_ISDIR(st.st_mode)) ? 1 : 0;
#endif
}

/** Delete a single file (W-API on Windows so non-ASCII paths work). */
static int remove_file_utf8(const char *path) {
#ifdef _WIN32
    WCHAR *wpath = utf8_to_wide(path);
    if (!wpath) return -1;
    int rc = DeleteFileW(wpath) ? 0 : -1;
    free(wpath);
    return rc;
#else
    return remove(path);
#endif
}

/** Invoke visitor for every direct child of dir.  Returns 0 on success. */
int walk_dir_entries(const char *dir, dir_visitor_fn visitor, void *ctx) {
#ifdef _WIN32
    WCHAR *wdir = utf8_to_wide(dir);
    if (!wdir) return -1;
    size_t dlen = wcslen(wdir);
    WCHAR *pattern = (WCHAR *)malloc((dlen + 3) * sizeof(WCHAR));
    if (!pattern) {
        free(wdir);
        return -1;
    }
    wcscpy(pattern, wdir);
    wcscat(pattern, L"\\*");

    WIN32_FIND_DATAW fd;
    HANDLE h = FindFirstFileW(pattern, &fd);
    free(pattern);
    free(wdir);
    if (h == INVALID_HANDLE_VALUE) return -1;
    int ret = 0;
    do {
        if (wcscmp(fd.cFileName, L".") == 0 || wcscmp(fd.cFileName, L"..") == 0) continue;
        // Full path is UTF-8 base + UTF-8-converted entry name; visitors hand
        // it back to the file utils, which convert to UTF-16 at the API edge.
        char *name8 = wide_to_utf8(fd.cFileName);
        if (!name8) {
            ret = -1;
            break;
        }
        char full[MAX_PATH_LEN];
        snprintf(full, sizeof(full), "%s\\%s", dir, name8);
        free(name8);
        if (visitor(full, ctx) != 0) {
            ret = -1;
            break;
        }
    } while (FindNextFileW(h, &fd));
    FindClose(h);
    return ret;
#else
    DIR *d = opendir(dir);
    if (!d) return -1;
    struct dirent *e;
    int ret = 0;
    while ((e = readdir(d)) != NULL) {
        if (strcmp(e->d_name, ".") == 0 || strcmp(e->d_name, "..") == 0) continue;
        char full[MAX_PATH_LEN];
        snprintf(full, sizeof(full), "%s/%s", dir, e->d_name);
        if (visitor(full, ctx) != 0) {
            ret = -1;
            break;
        }
    }
    closedir(d);
    return ret;
#endif
}

/** Copy a single file. */
static int copy_file_to(const char *src, const char *dest) {
#ifdef _WIN32
    WCHAR *wsrc = utf8_to_wide(src);
    WCHAR *wdest = utf8_to_wide(dest);
    if (!wsrc || !wdest) {
        free(wsrc);
        free(wdest);
        return -1;
    }
    FILE *in = _wfopen(wsrc, L"rb");
    FILE *out = in ? _wfopen(wdest, L"wb") : NULL;
    free(wsrc);
    free(wdest);
#else
    FILE *in = fopen(src, "rb");
    FILE *out = in ? fopen(dest, "wb") : NULL;
#endif
    if (!in) return -1;
    if (!out) {
        fclose(in);
        return -1;
    }
    char buf[65536];
    size_t n;
    while ((n = fread(buf, 1, sizeof(buf), in)) > 0) {
        if (fwrite(buf, 1, n, out) != n) {
            fclose(in);
            fclose(out);
            remove_file_utf8(dest);
            return -1;
        }
    }
    int ok = (ferror(in) == 0);
    fclose(in);
    if (fclose(out) != 0) ok = 0;
    if (!ok) {
        remove_file_utf8(dest);
        return -1;
    }
    return 0;
}

/** Recursively delete a directory tree. */
static int remove_dir_recursive(const char *dir);
static int remove_visitor(const char *full, void *ctx) {
    (void)ctx;
    if (path_is_dir(full)) return remove_dir_recursive(full);
    return (remove_file_utf8(full) == 0) ? 0 : -1;
}
static int remove_dir_recursive(const char *dir) {
    int ret = walk_dir_entries(dir, remove_visitor, NULL);
#ifdef _WIN32
    WCHAR *wdir = utf8_to_wide(dir);
    if (!wdir || RemoveDirectoryW(wdir) == 0) ret = -1;
    free(wdir);
#else
    if (rmdir(dir) != 0) ret = -1;
#endif
    return ret;
}

/**
 * Recursively delete a directory tree.  Returns 0 on success, -1 on failure.
 */
int remove_dir_tree(const char *dir) {
    return remove_dir_recursive(dir);
}

/** Move a file or directory (directories are merged into dest). */
static int move_entry(const char *src, const char *dest);
static int move_visitor(const char *full, void *ctx) {
    const char *dest = (const char *)ctx;
    const char *name = strrchr(full, PATH_SEPARATOR);
    name = name ? name + 1 : full;
    char target[MAX_PATH_LEN];
    snprintf(target, sizeof(target), "%s%c%s", dest, PATH_SEPARATOR, name);
    return move_entry(full, target);
}
static int move_entry(const char *src, const char *dest) {
    if (path_is_dir(src)) {
        if (mkdir_recursive(dest) != 0) return -1;
        if (walk_dir_entries(src, move_visitor, (void *)dest) != 0) return -1;
        return remove_dir_recursive(src) == 0 ? 0 : -1;
    }
#ifdef _WIN32
    WCHAR *wsrc = utf8_to_wide(src);
    WCHAR *wdest = utf8_to_wide(dest);
    int renamed = (wsrc && wdest && _wrename(wsrc, wdest) == 0);
    free(wsrc);
    free(wdest);
    if (renamed) return 0;
#else
    if (rename(src, dest) == 0) return 0;
#endif
    if (copy_file_to(src, dest) == 0) {
        remove_file_utf8(src);
        return 0;
    }
    return -1;
}

typedef struct {
    int has_file;
    int subdir_count;
    char only_subdir[MAX_PATH_LEN];
} ExtractScanInfo;

static int extract_scan_visitor(const char *full, void *ctx) {
    ExtractScanInfo *info = (ExtractScanInfo *)ctx;
    if (path_is_dir(full)) {
        info->subdir_count++;
        if (info->subdir_count == 1) {
            strncpy(info->only_subdir, full, sizeof(info->only_subdir) - 1);
            info->only_subdir[sizeof(info->only_subdir) - 1] = '\0';
        }
    } else {
        info->has_file = 1;
    }
    return 0;
}

/**
 * Extract a zip and flatten a single top-level directory wrapper into dest_dir.
 *
 * The published fx-folder.zip wraps its files under a top-level 'fx-folder'
 * directory (kept so a manual download unzips into an fx-folder folder — how
 * it has worked for years).  This function extracts into a temp dir inside
 * dest_dir, descends into the wrapper when the archive has exactly one
 * top-level directory, moves the contents into dest_dir, and removes the temp
 * dir.  Flat zips are handled too (contents move directly).
 * Returns 0 on success, -1 on failure.
 */
int extract_zip_flatten(const char *zip_path, const char *dest_dir) {
    static unsigned int counter = 0;
    counter++;

    char tmp[MAX_PATH_LEN];
    snprintf(tmp, sizeof(tmp), "%s%c.fsh_extract_%d_%u",
             dest_dir, PATH_SEPARATOR, (int)time(NULL), counter);
    tmp[sizeof(tmp) - 1] = '\0';

    if (mkdir_recursive(tmp) != 0) return -1;
    if (extract_zip(zip_path, tmp) != 0) {
        remove_dir_recursive(tmp);
        return -1;
    }

    char base[MAX_PATH_LEN];
    strncpy(base, tmp, sizeof(base) - 1);
    base[sizeof(base) - 1] = '\0';

    for (int depth = 0; depth < 4; depth++) {
        ExtractScanInfo info;
        memset(&info, 0, sizeof(info));
        walk_dir_entries(base, extract_scan_visitor, &info);
        if (info.has_file) break;
        if (info.subdir_count == 1) {
            strncpy(base, info.only_subdir, sizeof(base) - 1);
            base[sizeof(base) - 1] = '\0';
            continue;
        }
        break;
    }

    int ret = 0;
    if (walk_dir_entries(base, move_visitor, (void *)dest_dir) != 0) ret = -1;
    remove_dir_recursive(tmp);
    return ret;
}
