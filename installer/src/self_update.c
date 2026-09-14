#include "self_update.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* The installer performs no network I/O: the web UI fetches the latest
 * release JSON (api.github.com sends CORS *) and POSTs the raw bytes here
 * (POST /api/self-update).  check_self_update() parses that stored buffer.
 *
 * Update detection is DATE-based (ADR 0019 amendment), not version-based: the release
 * body carries a managed JSON block (written by the publish automation,
 * tools/publish/componentReleases.mjs) of the shape
 *
 *     "installerDate": "YYYY-MM-DD",
 *     "download": { "<installer asset name>": "<browser_download_url>", ... }
 *
 * The comparison is against the build date baked into this binary
 * (INSTALLER_BUILD_DATE).  Both strings are YYYY-MM-DD, so a plain strcmp is
 * the correct chronological ordering.  The release tag itself is never
 * compared: `latest` is a permanently-named moving tag (ADR 0019), so a
 * version/tag comparison can never converge. */

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

/* Locate a JSON string value for `key` (bare key, no quotes — inside a
 * release BODY the block is JSON-escaped as \"key\", so the quote characters
 * are preceded by backslashes and must not be part of the needle), scanning
 * forward from `from` for the FIRST occurrence whose value parses.  Returns
 * the start of the string contents with *out_len set to the value length;
 * NULL when no occurrence from `from` yields a value.  Plain strstr — the
 * payloads this parses are written by our own publish automation, not
 * adversarial. */
static const char *find_string_value(const char *from, const char *key,
                                     size_t *out_len) {
    const char *p = from;
    while ((p = strstr(p, key)) != NULL) {
        const char *after = p + strlen(key);
        /* Boundary: the key must end a name, not merely appear inside one
         * (accept both \" and " as the terminator — this also keeps
         * "installer_linux" from matching inside "installer_linux_aarch64"). */
        if ((after[0] == '\\' && after[1] == '"') || after[0] == '"') {
            const char *colon = strchr(after, ':');
            const char *value = colon ? strchr(colon + 1, '"') : NULL;
            if (colon && value) {
                value++;
                const char *end = strchr(value, '"');
                if (end) {
                    /* Inside an escaped body the value's closing delimiter is
                     * \" — the backslash belongs to the delimiter, not the
                     * content (without this the date parses as
                     * "2026-09-13\" and the strict ISO check rejects it). */
                    if (end > value && *(end - 1) == '\\') end--;
                    *out_len = (size_t)(end - value);
                    return value;
                }
            }
        }
        p = after;  // keep scanning: a later occurrence may be the real one
    }
    return NULL;
}

/* Strict YYYY-MM-DD (10 chars, digits with dashes) — anything else means the
 * body block is malformed or from an older publish, and staying silent is the
 * safe answer. */
static int is_iso_date(const char *s, size_t len) {
    if (len != 10) return 0;
    for (size_t i = 0; i < len; i++) {
        if (i == 4 || i == 7) {
            if (s[i] != '-') return 0;
        } else if (s[i] < '0' || s[i] > '9') {
            return 0;
        }
    }
    return 1;
}

int check_self_update(const char *current_build,
                      const char *asset_name,
                      char *latest_date, size_t date_size,
                      char *download_url, size_t url_size) {
    latest_date[0] = '\0';
    download_url[0] = '\0';

    if (!g_self_update_json) {
        return -1;  // no release JSON ingested yet (UI fetch pending/failed)
    }

    // Managed block: parse the build date.  Bare keys — see
    // find_string_value for the escaped-body rationale.
    size_t date_len = 0;
    const char *date_start = find_string_value(g_self_update_json, "installerDate", &date_len);
    if (!date_start || !is_iso_date(date_start, date_len)) {
        return 0;  // no managed block (older body format) → silently no update
    }

    size_t copy_len = date_len < date_size - 1 ? date_len : date_size - 1;
    memcpy(latest_date, date_start, copy_len);
    latest_date[copy_len] = '\0';

    // Both sides are YYYY-MM-DD: lexicographic == chronological.
    if (strcmp(current_build, latest_date) >= 0) {
        return 0;  // this build is at least as new
    }

    // Newer build published.  Resolve this platform's download URL from the
    // managed "download" map (asset name → URL under the permanently-named
    // `latest` tag).  Search starts AFTER the date value so an asset list's
    // browser_download_url fields (earlier releases in the /releases array)
    // can never satisfy the lookup.  An absent entry still reports the
    // update: the UI falls back to pointing at the releases page.
    size_t url_len = 0;
    const char *url_start = find_string_value(date_start + date_len, asset_name, &url_len);
    if (!url_start || url_len == 0) {
        return 1;
    }
    size_t url_copy = url_len < url_size - 1 ? url_len : url_size - 1;
    memcpy(download_url, url_start, url_copy);
    download_url[url_copy] = '\0';
    return 1;  // update available
}
