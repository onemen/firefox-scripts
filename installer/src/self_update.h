#ifndef SELF_UPDATE_H
#define SELF_UPDATE_H

#include "platform.h"

/**
 * Check for a newer installer build (date-based, ADR 0019 amendment).
 * Parses the latest-release JSON that the web UI fetched and POSTed via
 * POST /api/self-update (the installer itself never touches the network).
 * The release body carries a managed block written by the publish
 * automation:  "installerDate": "YYYY-MM-DD"  and
 * "download": { "<installer asset name>": "<browser_download_url>", ... }.
 *
 * current_build is the build date baked into this binary
 * (INSTALLER_BUILD_DATE, YYYY-MM-DD).  Returns 1 if a newer build is
 * published (latest_date + download_url filled; download_url empty when the
 * map has no entry for asset_name), 0 when up to date / no managed block,
 * -1 on error / no data yet.
 */
int check_self_update(const char *current_build,
                      const char *asset_name,
                      char *latest_date, size_t date_size,
                      char *download_url, size_t url_size);

/**
 * Store the latest-release JSON received from the browser tab.
 * Returns 0 on success, -1 on failure.
 */
int ingest_self_update_json(const char *json, size_t len);

#endif /* SELF_UPDATE_H */
