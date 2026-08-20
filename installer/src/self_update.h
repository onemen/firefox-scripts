#ifndef SELF_UPDATE_H
#define SELF_UPDATE_H

#include "platform.h"

/**
 * Check for a newer installer version.
 * Parses the latest-release JSON that the web UI fetched and POSTed via
 * POST /api/self-update (the installer itself never touches the network).
 * The download URL is the browser_download_url of the asset named asset_name
 * (this platform's installer binary, e.g. "installer_win.exe").  Returns 1
 * if update available, 0 if current or no matching asset, -1 on error /
 * no data yet.
 */
int check_self_update(const char *current_version,
                      const char *repo_owner,
                      const char *repo_name,
                      const char *asset_name,
                      char *latest_version, size_t ver_size,
                      char *download_url, size_t url_size);

/**
 * Store the latest-release JSON received from the browser tab.
 * Returns 0 on success, -1 on failure.
 */
int ingest_self_update_json(const char *json, size_t len);

#endif /* SELF_UPDATE_H */