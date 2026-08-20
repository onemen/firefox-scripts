#ifndef COMMON_H
#define COMMON_H

#include <sys/types.h>

#define EXIT_SUCCESS 0
#define EXIT_BAD_ARGS 1
#define EXIT_ELEV_FAIL 2
#define EXIT_COPY_FAIL 3

#ifdef __linux__

int mkdir_p(const char *path, mode_t mode);
int can_write_to(const char *dst_path);

#elif __APPLE__

int mkdir_p(const char *path, mode_t mode);
int can_write_to(const char *dst_path);

#endif

#endif