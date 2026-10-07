/*
 * zip_store.c — the in-memory store for the browser-uploaded package zips
 * (fx-folder.zip, utils.zip, updater-ui.zip) that /api/upload fills and the
 * install state machine extracts from.  Extracted from main.c unchanged
 * (audit 2026-10-06 P2-15, #450); the accessors live in platform.h.
 */

#include "platform.h"
#include <stdlib.h>
#include <string.h>

/* ===== Browser-uploaded package zips =====
 * The web UI fetches fx-folder.zip, utils.zip and updater-ui.zip from the
 * CORS-enabled Pages host and POSTs the raw bytes to
 * /api/upload?kind=config|utils|ui.  The install state machine extracts
 * straight from these in-memory buffers (one copy per package, reused across
 * installs of multiple profiles).  updater-ui.zip is optional: it rides along
 * with utils and is skipped silently when its fetch failed. */
static char *g_uploaded_config_zip = NULL;
static size_t g_uploaded_config_len = 0;
static char *g_uploaded_utils_zip = NULL;
static size_t g_uploaded_utils_len = 0;
static char *g_uploaded_ui_zip = NULL;
static size_t g_uploaded_ui_len = 0;

const unsigned char *installer_uploaded_zip(int is_utils, size_t *out_len) {
    if (is_utils) {
        if (out_len) *out_len = g_uploaded_utils_len;
        return (const unsigned char *)g_uploaded_utils_zip;
    }
    if (out_len) *out_len = g_uploaded_config_len;
    return (const unsigned char *)g_uploaded_config_zip;
}

int installer_has_uploaded_zip(int is_utils) {
    if (is_utils) return (g_uploaded_utils_zip && g_uploaded_utils_len > 0);
    return (g_uploaded_config_zip && g_uploaded_config_len > 0);
}

int installer_set_uploaded_zip(int is_utils, const char *data, size_t len) {
    if (!data || len == 0) return -1;
    char *copy = (char *)malloc(len);
    if (!copy) return -1;
    memcpy(copy, data, len);
    if (is_utils) {
        free(g_uploaded_utils_zip);
        g_uploaded_utils_zip = copy;
        g_uploaded_utils_len = len;
    } else {
        free(g_uploaded_config_zip);
        g_uploaded_config_zip = copy;
        g_uploaded_config_len = len;
    }
    return 0;
}

const unsigned char *installer_uploaded_ui_zip(size_t *out_len) {
    if (out_len) *out_len = g_uploaded_ui_len;
    return (const unsigned char *)g_uploaded_ui_zip;
}

int installer_has_uploaded_ui_zip(void) {
    return (g_uploaded_ui_zip && g_uploaded_ui_len > 0);
}

int installer_set_uploaded_ui_zip(const char *data, size_t len) {
    if (!data || len == 0) return -1;
    char *copy = (char *)malloc(len);
    if (!copy) return -1;
    memcpy(copy, data, len);
    free(g_uploaded_ui_zip);
    g_uploaded_ui_zip = copy;
    g_uploaded_ui_len = len;
    return 0;
}
