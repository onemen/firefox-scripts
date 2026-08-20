#include "admin_copy.h"
#include "file_utils.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>

#ifdef _WIN32
#include <windows.h>
#include <shellapi.h>

static int is_elevated(void) {
    HANDLE token;
    DWORD size;
    DWORD elevated = 0;

    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token))
        return 0;

    GetTokenInformation(token, TokenElevation, &elevated, sizeof(elevated), &size);
    CloseHandle(token);
    return elevated;
}

/** Strip the file name off dst_path, leaving the trailing dir (may not exist). */
static void get_dst_dir(const char *dst_path, char *out, size_t out_size) {
    strncpy(out, dst_path, out_size - 1);
    out[out_size - 1] = '\0';
    char *p = out + strlen(out);
    while (p > out && p[-1] != '\\' && p[-1] != '/') p--;
    if (p > out) p[-1] = '\0';
}

/** Strip the final path component (backslash included). */
static void strip_last_component(char *path) {
    size_t len = strlen(path);
    while (len > 0 && (path[len - 1] == '\\' || path[len - 1] == '/')) {
        path[--len] = '\0';
    }
    while (len > 0 && path[len - 1] != '\\' && path[len - 1] != '/') len--;
    path[len] = '\0';
}

/**
 * Test whether we can write into the deepest *existing* ancestor directory of
 * dst.  Parent dirs of dst may not exist yet (e.g. defaults/pref), so walk up
 * until we find a directory that exists and probe it with a temp file.
 * Returns 1 when writable, 0 when access is denied.
 */
static int can_write_to(const char *dst_path) {
    char dir[MAX_PATH_LEN];
    get_dst_dir(dst_path, dir, sizeof(dir));

    for (;;) {
        WCHAR *wdir = utf8_to_wide(dir);
        DWORD attrs = wdir ? GetFileAttributesW(wdir) : INVALID_FILE_ATTRIBUTES;
        free(wdir);
        if (attrs != INVALID_FILE_ATTRIBUTES && (attrs & FILE_ATTRIBUTE_DIRECTORY)) {
            char test_path[MAX_PATH_LEN];
            snprintf(test_path, sizeof(test_path), "%s\\__wtest_%08lx.tmp",
                     dir, GetCurrentProcessId());
            WCHAR *wtest = utf8_to_wide(test_path);
            if (!wtest) return 0;
            HANDLE h = CreateFileW(wtest, GENERIC_WRITE, 0, NULL,
                                   CREATE_NEW, FILE_ATTRIBUTE_NORMAL, NULL);
            if (h != INVALID_HANDLE_VALUE) {
                CloseHandle(h);
                DeleteFileW(wtest);
                free(wtest);
                return 1;
            }
            free(wtest);
            return (GetLastError() != ERROR_ACCESS_DENIED);
        }
        if (strlen(dir) == 0) break;
        strip_last_component(dir);
        if (strlen(dir) == 0) break;
    }
    return 1;
}

/** Create every missing parent directory of dst_path (not the file itself). */
static void create_parent_dirs(const char *dst_path) {
    char dir[MAX_PATH_LEN];
    get_dst_dir(dst_path, dir, sizeof(dir));

    char tmp[MAX_PATH_LEN];
    strncpy(tmp, dir, sizeof(tmp) - 1);
    tmp[sizeof(tmp) - 1] = '\0';

    for (char *c = tmp + 1; *c; c++) {
        if (*c == '\\' || *c == '/') {
            char saved = *c;
            *c = '\0';
            // Cutting at a separator always lands on a UTF-8 char boundary.
            WCHAR *wdir = utf8_to_wide(tmp);
            if (wdir) {
                CreateDirectoryW(wdir, NULL);
                free(wdir);
            }
            *c = saved;
        }
    }
    WCHAR *wdir = utf8_to_wide(tmp);
    if (wdir) {
        CreateDirectoryW(wdir, NULL);
        free(wdir);
    }
}

int admin_copy_files(const char *const srcs[], const char *const dsts[], int count,
                     char *error_msg, size_t error_size) {
    if (count <= 0) return 0;

    // Do any of the targets need elevation?
    int need_elevation = 0;
    for (int i = 0; i < count; i++) {
        if (!can_write_to(dsts[i]) && !is_elevated()) {
            need_elevation = 1;
            break;
        }
    }

    if (need_elevation) {
        // Build a single command line: --admin-copy "src1" "dst1" ...
        size_t cap = 64;
        for (int i = 0; i < count; i++) {
            cap += strlen(srcs[i]) + strlen(dsts[i]) + 8;
        }
        char *params = (char *)malloc(cap);
        if (!params) {
            snprintf(error_msg, error_size, "Out of memory building elevation command");
            return -4;
        }
        int pos = snprintf(params, cap, "--admin-copy");
        for (int i = 0; i < count; i++) {
            pos += snprintf(params + pos, cap - (size_t)pos,
                            " \"%s\" \"%s\"", srcs[i], dsts[i]);
        }

        WCHAR exe_path[MAX_PATH_LEN];
        if (!GetModuleFileNameW(NULL, exe_path, MAX_PATH_LEN)) {
            snprintf(error_msg, error_size, "Cannot determine own executable path");
            free(params);
            return -2;
        }

        WCHAR *wparams = utf8_to_wide(params);
        free(params);
        if (!wparams) {
            snprintf(error_msg, error_size, "Out of memory building elevation command");
            return -2;
        }

        SHELLEXECUTEINFOW sei = { sizeof(sei) };
        sei.fMask = SEE_MASK_NOCLOSEPROCESS;
        sei.lpVerb = L"runas";
        sei.lpFile = exe_path;
        sei.lpParameters = wparams;
        sei.nShow = SW_HIDE;

        BOOL ok = ShellExecuteExW(&sei);
        free(wparams);
        if (!ok) {
            snprintf(error_msg, error_size,
                     "Elevation failed or was cancelled (error %lu)", GetLastError());
            return -2;
        }

        WaitForSingleObject(sei.hProcess, INFINITE);
        DWORD exit_code = 1;
        if (!GetExitCodeProcess(sei.hProcess, &exit_code)) exit_code = 1;
        CloseHandle(sei.hProcess);
        if (exit_code != 0) {
            snprintf(error_msg, error_size,
                     "Elevated copy failed (exit code %lu)", exit_code);
            return -3;
        }
        return 0;
    }

    // Direct copy.
    for (int i = 0; i < count; i++) {
        create_parent_dirs(dsts[i]);
        WCHAR *wsrc = utf8_to_wide(srcs[i]);
        WCHAR *wdst = utf8_to_wide(dsts[i]);
        BOOL copied = wsrc && wdst && CopyFileW(wsrc, wdst, FALSE);
        free(wsrc);
        free(wdst);
        if (!copied) {
            snprintf(error_msg, error_size,
                     "Copy failed for %s: error %lu", dsts[i], GetLastError());
            return -1;
        }
    }
    return 0;
}

int admin_copy_mode(int argc, char *argv[]) {
    // args: --admin-copy src1 dst1 src2 dst2 ...
    int pairs = (argc - 2) / 2;
    for (int i = 0; i < pairs; i++) {
        const char *src = argv[2 + i * 2];
        const char *dst = argv[2 + i * 2 + 1];
        create_parent_dirs(dst);
        WCHAR *wsrc = utf8_to_wide(src);
        WCHAR *wdst = utf8_to_wide(dst);
        BOOL copied = wsrc && wdst && CopyFileW(wsrc, wdst, FALSE);
        free(wsrc);
        free(wdst);
        if (!copied) {
            fprintf(stderr, "admin-copy: failed %s -> %s (error %lu)\n",
                    src, dst, GetLastError());
            return 1;
        }
    }
    return 0;
}

int admin_copy(const char *src, const char *dst, char *error_msg, size_t error_size) {
    const char *srcs[1] = { src };
    const char *dsts[1] = { dst };
    return admin_copy_files(srcs, dsts, 1, error_msg, error_size);
}

#elif defined(__linux__)

#include <unistd.h>
#include <sys/types.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <fcntl.h>

static int can_write_to(const char *dst_path) {
    const char *p = dst_path + strlen(dst_path);
    while (p > dst_path && p[-1] != '/') p--;

    if (p == dst_path) return (access(".", W_OK) == 0);

    char dir[MAX_PATH_LEN];
    size_t dlen = (size_t)(p - dst_path);
    if (dlen >= sizeof(dir)) return 0;
    memcpy(dir, dst_path, dlen);
    dir[dlen] = 0;

    if (access(dir, F_OK) != 0) return 1;  // Directory doesn't exist yet
    return (access(dir, W_OK) == 0);
}

static int copy_file_content(const char *src, const char *dst) {
    int in_fd = open(src, O_RDONLY);
    if (in_fd < 0) return -1;

    int out_fd = open(dst, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (out_fd < 0) {
        close(in_fd);
        return -1;
    }

    char buf[65536];
    ssize_t n;
    while ((n = read(in_fd, buf, sizeof(buf))) > 0) {
        ssize_t written = 0;
        while (written < n) {
            ssize_t r = write(out_fd, buf + written, (size_t)(n - written));
            if (r <= 0) {
                close(in_fd);
                close(out_fd);
                return -1;
            }
            written += r;
        }
    }

    close(in_fd);
    close(out_fd);
    return (n == 0) ? 0 : -1;
}

static void create_parent_dirs(const char *dst_path) {
    char dir[MAX_PATH_LEN];
    strncpy(dir, dst_path, sizeof(dir) - 1);
    dir[sizeof(dir) - 1] = '\0';
    char *p = dir + strlen(dir);
    while (p > dir && p[-1] != '/') p--;
    if (p > dir) p[-1] = '\0';

    char tmp[MAX_PATH_LEN];
    strncpy(tmp, dir, sizeof(tmp) - 1);
    tmp[sizeof(tmp) - 1] = '\0';
    for (char *c = tmp + 1; *c; c++) {
        if (*c == '/') {
            *c = '\0';
            mkdir(tmp, 0755);
            *c = '/';
        }
    }
    mkdir(tmp, 0755);
}

int admin_copy_files(const char *const srcs[], const char *const dsts[], int count,
                     char *error_msg, size_t error_size) {
    if (count <= 0) return 0;

    int need_elevation = 0;
    for (int i = 0; i < count; i++) {
        if (!can_write_to(dsts[i]) && geteuid() != 0) {
            need_elevation = 1;
            break;
        }
    }

    if (need_elevation) {
        // Build argv: --admin-copy src1 dst1 ...
        size_t cap = 4 + (size_t)count * 2;
        char **args = (char **)calloc(cap, sizeof(char *));
        if (!args) {
            snprintf(error_msg, error_size, "Out of memory building elevation command");
            return -4;
        }
        int ai = 0;
        args[ai++] = (char *)"pkexec";  // will be overridden below based on availability
        args[ai++] = NULL;              // exe path
        args[ai++] = (char *)"--admin-copy";
        for (int i = 0; i < count; i++) {
            args[ai++] = (char *)srcs[i];
            args[ai++] = (char *)dsts[i];
        }
        args[ai] = NULL;

        char exe_path[MAX_PATH_LEN];
        ssize_t elen = readlink("/proc/self/exe", exe_path, sizeof(exe_path) - 1);
        if (elen < 0) {
            snprintf(error_msg, error_size, "Cannot read own executable path");
            free(args);
            return -2;
        }
        exe_path[elen] = 0;
        args[1] = exe_path;

        const char *elevator = (access("/usr/bin/pkexec", X_OK) == 0) ? "pkexec" : "sudo";
        args[0] = (char *)elevator;

        pid_t pid = fork();
        if (pid == 0) {
            execvp(elevator, args);
            _exit(1);
        }
        free(args);

        int status;
        waitpid(pid, &status, 0);
        if (WIFEXITED(status)) {
            if (WEXITSTATUS(status) != 0) {
                snprintf(error_msg, error_size,
                         "Elevated copy failed (exit code %d)", WEXITSTATUS(status));
                return -3;
            }
            return 0;
        }
        snprintf(error_msg, error_size, "Elevation failed or was denied");
        return -2;
    }

    for (int i = 0; i < count; i++) {
        create_parent_dirs(dsts[i]);
        if (copy_file_content(srcs[i], dsts[i]) < 0) {
            snprintf(error_msg, error_size, "Copy failed for %s: %s",
                     dsts[i], strerror(errno));
            return -1;
        }
    }
    return 0;
}

int admin_copy_mode(int argc, char *argv[]) {
    int pairs = (argc - 2) / 2;
    for (int i = 0; i < pairs; i++) {
        const char *src = argv[2 + i * 2];
        const char *dst = argv[2 + i * 2 + 1];
        create_parent_dirs(dst);
        if (copy_file_content(src, dst) < 0) {
            fprintf(stderr, "admin-copy: failed %s -> %s (%s)\n",
                    src, dst, strerror(errno));
            return 1;
        }
    }
    return 0;
}

int admin_copy(const char *src, const char *dst, char *error_msg, size_t error_size) {
    const char *srcs[1] = { src };
    const char *dsts[1] = { dst };
    return admin_copy_files(srcs, dsts, 1, error_msg, error_size);
}

#elif defined(__APPLE__)

#include <unistd.h>
#include <sys/types.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <copyfile.h>
#include <mach-o/dyld.h>

static int can_write_to(const char *dst_path) {
    const char *p = dst_path + strlen(dst_path);
    while (p > dst_path && p[-1] != '/') p--;

    if (p == dst_path) return (access(".", W_OK) == 0);

    char dir[MAX_PATH_LEN];
    size_t dlen = (size_t)(p - dst_path);
    if (dlen >= sizeof(dir)) return 0;
    memcpy(dir, dst_path, dlen);
    dir[dlen] = 0;

    if (access(dir, F_OK) != 0) return 1;
    return (access(dir, W_OK) == 0);
}

static void create_parent_dirs(const char *dst_path) {
    char dir[MAX_PATH_LEN];
    strncpy(dir, dst_path, sizeof(dir) - 1);
    dir[sizeof(dir) - 1] = '\0';
    char *p = dir + strlen(dir);
    while (p > dir && p[-1] != '/') p--;
    if (p > dir) p[-1] = '\0';

    char tmp[MAX_PATH_LEN];
    strncpy(tmp, dir, sizeof(tmp) - 1);
    tmp[sizeof(tmp) - 1] = '\0';
    for (char *c = tmp + 1; *c; c++) {
        if (*c == '/') {
            *c = '\0';
            mkdir(tmp, 0755);
            *c = '/';
        }
    }
    mkdir(tmp, 0755);
}

int admin_copy_files(const char *const srcs[], const char *const dsts[], int count,
                     char *error_msg, size_t error_size) {
    if (count <= 0) return 0;

    int need_elevation = 0;
    for (int i = 0; i < count; i++) {
        if (!can_write_to(dsts[i]) && geteuid() != 0) {
            need_elevation = 1;
            break;
        }
    }

    if (need_elevation) {
        // Build argv: --admin-copy src1 dst1 ... and use osascript once.
        size_t cap = 8 + (size_t)count * 2;
        char **args = (char **)calloc(cap, sizeof(char *));
        if (!args) {
            snprintf(error_msg, error_size, "Out of memory building elevation command");
            return -4;
        }
        int ai = 0;
        args[ai++] = (char *)"osascript";
        args[ai++] = (char *)"-e";

        char exe_path[MAX_PATH_LEN];
        uint32_t esize = sizeof(exe_path);
        if (_NSGetExecutablePath(exe_path, &esize) != 0) {
            snprintf(error_msg, error_size, "Cannot read own executable path");
            free(args);
            return -2;
        }

        char *script = (char *)malloc(4096 + (size_t)count * (MAX_PATH_LEN * 2));
        if (!script) {
            free(args);
            snprintf(error_msg, error_size, "Out of memory building elevation script");
            return -4;
        }
        int pos = snprintf(script, 4096 + (size_t)count * (MAX_PATH_LEN * 2),
                           "do shell script \"\\\"%s\\\" --admin-copy", exe_path);
        for (int i = 0; i < count; i++) {
            pos += snprintf(script + pos, 4096 + (size_t)count * (MAX_PATH_LEN * 2) - (size_t)pos,
                            " \\\"%s\\\" \\\"%s\\\"", srcs[i], dsts[i]);
        }
        snprintf(script + pos, 4096 + (size_t)count * (MAX_PATH_LEN * 2) - (size_t)pos,
                 "\" with administrator privileges");

        args[ai++] = script;
        args[ai] = NULL;

        pid_t child = fork();
        if (child == 0) {
            execvp("osascript", args);
            _exit(1);
        }
        int status;
        waitpid(child, &status, 0);
        free(script);
        free(args);
        if (WIFEXITED(status) && WEXITSTATUS(status) == 0) return 0;
        snprintf(error_msg, error_size, "Elevated copy failed or was denied");
        return -2;
    }

    for (int i = 0; i < count; i++) {
        create_parent_dirs(dsts[i]);
        if (copyfile(srcs[i], dsts[i], 0, COPYFILE_ALL) < 0) {
            snprintf(error_msg, error_size, "Copy failed for %s: %s",
                     dsts[i], strerror(errno));
            return -1;
        }
    }
    return 0;
}

int admin_copy_mode(int argc, char *argv[]) {
    int pairs = (argc - 2) / 2;
    for (int i = 0; i < pairs; i++) {
        const char *src = argv[2 + i * 2];
        const char *dst = argv[2 + i * 2 + 1];
        create_parent_dirs(dst);
        if (copyfile(src, dst, 0, COPYFILE_ALL) < 0) {
            fprintf(stderr, "admin-copy: failed %s -> %s (%s)\n",
                    src, dst, strerror(errno));
            return 1;
        }
    }
    return 0;
}

int admin_copy(const char *src, const char *dst, char *error_msg, size_t error_size) {
    const char *srcs[1] = { src };
    const char *dsts[1] = { dst };
    return admin_copy_files(srcs, dsts, 1, error_msg, error_size);
}

#else
// Fallback for other platforms - just do a file copy without elevation
int admin_copy_files(const char *const srcs[], const char *const dsts[], int count,
                     char *error_msg, size_t error_size) {
    for (int i = 0; i < count; i++) {
        char cmd[MAX_PATH_LEN * 3];
        snprintf(cmd, sizeof(cmd), "cp \"%s\" \"%s\"", srcs[i], dsts[i]);
        if (system(cmd) != 0) {
            snprintf(error_msg, error_size, "Copy command failed for %s", dsts[i]);
            return -1;
        }
    }
    return 0;
}

int admin_copy_mode(int argc, char *argv[]) {
    int pairs = (argc - 2) / 2;
    for (int i = 0; i < pairs; i++) {
        char cmd[MAX_PATH_LEN * 3];
        snprintf(cmd, sizeof(cmd), "cp \"%s\" \"%s\"", argv[2 + i * 2], argv[2 + i * 2 + 1]);
        if (system(cmd) != 0) return 1;
    }
    return 0;
}

int admin_copy(const char *src, const char *dst, char *error_msg, size_t error_size) {
    const char *srcs[1] = { src };
    const char *dsts[1] = { dst };
    return admin_copy_files(srcs, dsts, 1, error_msg, error_size);
}
#endif

// ===== Recursive tree copy with batch elevation =====

typedef struct {
    const char *src_root;
    const char *dst_root;
    const char **srcs;
    const char **dsts;
    int count;
    int cap;
    char *buf;
    size_t buf_size;
    size_t buf_pos;
    int failed;
} TreeCollectCtx;

static int tree_collect_visitor(const char *full, void *vctx);

static int tree_collect_walk(const char *dir, TreeCollectCtx *ctx) {
    return walk_dir_entries(dir, tree_collect_visitor, ctx);
}

static int tree_collect_visitor(const char *full, void *vctx) {
    TreeCollectCtx *ctx = (TreeCollectCtx *)vctx;
    if (path_is_dir(full)) {
        return tree_collect_walk(full, ctx);
    }
    if (ctx->count >= ctx->cap) {
        ctx->failed = 1;
        return -1;
    }
    if (ctx->buf_pos + MAX_PATH_LEN * 2 > ctx->buf_size) {
        ctx->failed = 1;
        return -1;
    }

    char *src_copy = ctx->buf + ctx->buf_pos;
    char *dst_copy = src_copy + MAX_PATH_LEN;
    snprintf(src_copy, MAX_PATH_LEN, "%s", full);

    // Compute the path relative to src_root and mirror it under dst_root.
    const char *rel = full + strlen(ctx->src_root);
    while (*rel == PATH_SEPARATOR) rel++;
    snprintf(dst_copy, MAX_PATH_LEN, "%s%c%s", ctx->dst_root, PATH_SEPARATOR, rel);

    ctx->srcs[ctx->count] = src_copy;
    ctx->dsts[ctx->count] = dst_copy;
    ctx->buf_pos += MAX_PATH_LEN * 2;
    ctx->count++;
    return 0;
}

typedef struct {
    int n;
} TreeCountCtx;

static int tree_count_visitor(const char *full, void *vctx) {
    TreeCountCtx *c = (TreeCountCtx *)vctx;
    if (path_is_dir(full)) {
        return walk_dir_entries(full, tree_count_visitor, vctx);
    }
    c->n++;
    return 0;
}

int admin_copy_tree(const char *src_dir, const char *dst_dir,
                    char *error_msg, size_t error_size) {
    // First pass: count files (recursively) so we can size the pair arrays.
    TreeCountCtx cc;
    cc.n = 0;
    if (walk_dir_entries(src_dir, tree_count_visitor, &cc) != 0) {
        snprintf(error_msg, error_size, "Failed to enumerate extracted files");
        return -1;
    }
    int file_count = cc.n;

    if (file_count == 0) return 0;

    // Allocate pair arrays + one big buffer holding every src/dst string.
    const char **srcs = (const char **)calloc((size_t)file_count, sizeof(char *));
    const char **dsts = (const char **)calloc((size_t)file_count, sizeof(char *));
    size_t buf_size = (size_t)file_count * (MAX_PATH_LEN * 2) + MAX_PATH_LEN;
    char *buf = (char *)malloc(buf_size);
    if (!srcs || !dsts || !buf) {
        free(srcs);
        free(dsts);
        free(buf);
        snprintf(error_msg, error_size, "Out of memory collecting files to copy");
        return -4;
    }

    TreeCollectCtx ctx;
    memset(&ctx, 0, sizeof(ctx));
    ctx.src_root = src_dir;
    ctx.dst_root = dst_dir;
    ctx.srcs = srcs;
    ctx.dsts = dsts;
    ctx.cap = file_count;
    ctx.buf = buf;
    ctx.buf_size = buf_size;

    if (tree_collect_walk(src_dir, &ctx) != 0) {
        free(srcs);
        free(dsts);
        free(buf);
        snprintf(error_msg, error_size, "Failed to enumerate extracted files");
        return -1;
    }

    int ret = 0;
    if (ctx.failed) {
        snprintf(error_msg, error_size, "Too many files to copy");
        ret = -4;
    } else {
        ret = admin_copy_files(srcs, dsts, ctx.count, error_msg, error_size);
    }

    free(srcs);
    free(dsts);
    free(buf);
    return ret;
}