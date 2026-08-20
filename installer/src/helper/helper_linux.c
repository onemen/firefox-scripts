#define _GNU_SOURCE
#include "common.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/types.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <errno.h>

static int copy_file(const char *src, const char *dst) {
    int in_fd = open(src, O_RDONLY);
    if (in_fd < 0)
        return -1;

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

int main(int argc, char *argv[]) {
    if (argc < 3 || (argc % 2) == 0)
        return EXIT_BAD_ARGS;

    int needs_elevation = 0;
    for (int i = 2; i < argc; i += 2) {
        if (!can_write_to(argv[i])) {
            needs_elevation = 1;
            break;
        }
    }

    if (geteuid() != 0 && needs_elevation) {
        char exe_path[4096];
        ssize_t elen = readlink("/proc/self/exe", exe_path, sizeof(exe_path) - 1);
        if (elen < 0)
            return EXIT_ELEV_FAIL;
        exe_path[elen] = 0;

        char **args = malloc((size_t)(argc + 2) * sizeof(char *));
        if (!args)
            return EXIT_ELEV_FAIL;

        const char *elevator = (access("/usr/bin/pkexec", X_OK) == 0) ? "pkexec" : "sudo";
        args[0] = (char *)elevator;
        args[1] = exe_path;
        for (int i = 1; i < argc; i++)
            args[i + 1] = argv[i];
        args[argc + 1] = NULL;

        execvp(elevator, args);
        free(args);
        return EXIT_ELEV_FAIL;
    }

    for (int i = 1; i < argc; i += 2) {
        const char *dst = argv[i + 1];

        const char *p = dst + strlen(dst);
        while (p > dst && p[-1] != '/')
            p--;

        if (p > dst) {
            char dir[4096];
            size_t dlen = (size_t)(p - dst);
            if (dlen >= sizeof(dir))
                return EXIT_COPY_FAIL;
            memcpy(dir, dst, dlen);
            dir[dlen] = 0;
            if (mkdir_p(dir, 0755) < 0)
                return EXIT_COPY_FAIL;
        }

        if (copy_file(argv[i], dst) < 0)
            return EXIT_COPY_FAIL;
    }

    return EXIT_SUCCESS;
}