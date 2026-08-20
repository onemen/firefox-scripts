#include "common.h"
#include <string.h>
#include <unistd.h>
#include <sys/stat.h>
#include <errno.h>

int mkdir_p(const char *path, mode_t mode) {
    char tmp[4096];
    size_t len = strlen(path);
    if (len >= sizeof(tmp))
        return -1;

    memcpy(tmp, path, len + 1);

    for (size_t i = 0; tmp[i]; i++) {
        if (tmp[i] == '/') {
            tmp[i] = 0;
            mkdir(tmp, mode);
            tmp[i] = '/';
        }
    }

    if (mkdir(tmp, mode) == 0)
        return 0;
    return (errno == EEXIST) ? 0 : -1;
}

int can_write_to(const char *dst_path) {
    const char *p = dst_path + strlen(dst_path);
    while (p > dst_path && p[-1] != '/')
        p--;

    if (p == dst_path)
        return access(".", W_OK) == 0;

    char dir[4096];
    size_t dlen = (size_t)(p - dst_path);
    if (dlen >= sizeof(dir))
        return 0;
    memcpy(dir, dst_path, dlen);
    dir[dlen] = 0;

    if (access(dir, F_OK) != 0)
        return 1;

    return access(dir, W_OK) == 0;
}