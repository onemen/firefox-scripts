#include "self_update.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* The installer performs no network I/O: the web UI fetches the latest
 * release JSON (api.github.com sends CORS *) and POSTs the raw bytes here
 * (POST /api/self-update).  check_self_update() parses that stored buffer. */
static char *g_self_update_json = NULL;
static size_t g_self_update_len = 0;

int ingest_self_update_json(const char *json, size_t len) {
    if (!json || len == 0) return -1;
    char *copy = (char *)malloc(len + 1);
    if (!copy) return -1;
    memcpy(copy, json, len);
    copy[len] = '\0';
    free(g_self_update_json);
    g_self_update_json = copy;
    g_self_update_len = len;
    return 0;
}

int check_self_update(const char *current_version,
                      const char *repo_owner,
                      const char *repo_name,
                      const char *asset_name,
                      char *latest_version, size_t ver_size,
                      char *download_url, size_t url_size) {
    (void)repo_owner;
    (void)repo_name;

    if (!g_self_update_json) {
        return -1;  // no release JSON ingested yet (UI fetch pending/failed)
    }

    const char *response = g_self_update_json;

    // Parse JSON response manually to find "tag_name" and the download URL
    // of the asset named asset_name (this platform's installer binary).
    // Simple string search approach.  GitHub JSON is formatted with a space
    // after each colon ("tag_name": "..."), so find the key and skip past
    // the colon and any whitespace to the opening quote.

    // Find tag_name
    const char *tag_key = strstr(response, "\"tag_name\"");
    if (!tag_key) {
        return -1;
    }
    const char *tag_colon = strchr(tag_key + strlen("\"tag_name\""), ':');
    if (!tag_colon) {
        return -1;
    }
    const char *tag_start = strchr(tag_colon + 1, '"');
    if (!tag_start) {
        return -1;
    }
    tag_start++;

    const char *tag_end = strchr(tag_start, '"');
    if (!tag_end) {
        return -1;
    }

    size_t tag_len = (size_t)(tag_end - tag_start);
    if (tag_len >= ver_size) tag_len = ver_size - 1;
    memcpy(latest_version, tag_start, tag_len);
    latest_version[tag_len] = '\0';

    // Compare versions (simple string comparison - assumes semver format "v1.2.3" or "1.2.3")
    // Strip leading 'v' if present
    const char *cur = current_version;
    const char *lat = latest_version;
    if (*cur == 'v') cur++;
    if (*lat == 'v') lat++;

    if (strcmp(cur, lat) == 0) {
        return 0;  // Same version
    }

    // Find the asset named asset_name in the release's assets array.  The
    // array holds several files (helper binaries, package zips, installers);
    // the first browser_download_url is NOT necessarily the installer.
    const char *assets_key = strstr(response, "\"assets\"");
    if (!assets_key) {
        return -1;
    }
    const char *assets_start = strchr(assets_key + strlen("\"assets\""), '[');
    if (!assets_start) {
        return -1;
    }

    const char *p = assets_start;
    while ((p = strstr(p, "\"name\"")) != NULL) {
        const char *name_colon = strchr(p + strlen("\"name\""), ':');
        if (!name_colon) break;
        const char *name_start = strchr(name_colon + 1, '"');
        if (!name_start) break;
        name_start++;
        const char *name_end = strchr(name_start, '"');
        if (!name_end) break;

        size_t name_len = (size_t)(name_end - name_start);
        int is_installer = (strlen(asset_name) == name_len) &&
                           strncmp(name_start, asset_name, name_len) == 0;

        // The next '"'name'"' or '}' bounds this asset object; the
        // browser_download_url must belong to it.
        const char *next_name = strstr(name_end, "\"name\"");
        const char *next_brace = strchr(name_end, '}');
        const char *limit = NULL;
        if (next_name && next_brace) {
            limit = (next_name < next_brace) ? next_name : next_brace;
        } else {
            limit = next_name ? next_name : next_brace;
        }

        if (is_installer) {
            const char *bdu = strstr(name_end, "\"browser_download_url\"");
            if (bdu && (!limit || bdu < limit)) {
                const char *bdu_colon = strchr(bdu + strlen("\"browser_download_url\""), ':');
                if (bdu_colon) {
                    const char *bdu_start = strchr(bdu_colon + 1, '"');
                    if (bdu_start) {
                        bdu_start++;
                        const char *bdu_end = strchr(bdu_start, '"');
                        if (bdu_end) {
                            size_t bdu_len = (size_t)(bdu_end - bdu_start);
                            if (bdu_len >= url_size) bdu_len = url_size - 1;
                            memcpy(download_url, bdu_start, bdu_len);
                            download_url[bdu_len] = '\0';
                            return 1;  // Update available
                        }
                    }
                }
            }
            // The release's tag is newer but it ships no installer for this
            // platform yet — nothing to download, so no update is offered.
            return 0;
        }
        p = name_end;
    }

    return 0;
}
