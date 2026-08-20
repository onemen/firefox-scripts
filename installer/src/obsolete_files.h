/*
 * Obsolete files: files that previously shipped inside the published zips and
 * must be deleted after install so a stale shipped file cannot linger next to
 * the new files.
 *
 * The published manifest (hashes.json) carries the canonical `files` list per
 * package — it is fetched at runtime and must stay in sync with the zips on
 * GitHub.  Obsolete files can NOT be listed in the manifest and are excluded
 * from the hash (createZip.mjs CUSTOM_IGNORE_PATTERNS / upload.mjs
 * HASH_EXCLUDE).
 *
 * versionInfo.json: legacy — it shipped in earlier zips and was consumed by an
 * update-checker outside this project.  It no longer ships; the entry below
 * only cleans historically-installed copies.
 */
#ifndef OBSOLETE_FILES_H
#define OBSOLETE_FILES_H

static const char *const OBSOLETE_FILES[] = {
    "versionInfo.json",
};

#define OBSOLETE_FILES_COUNT ((int)(sizeof(OBSOLETE_FILES) / sizeof(OBSOLETE_FILES[0])))

#endif /* OBSOLETE_FILES_H */
