/*
 * restart.h — browser close / relaunch / restart orchestration API.
 * Implementations live in restart.c; the HTTP handlers in main.c decide
 * WHEN to restart, this module owns HOW.
 */

#ifndef RESTART_H
#define RESTART_H

#include "platform.h"
#include "detect_browser.h"

/**
 * Gracefully close a single browser process (and its children) by PID.
 * Targeted — used when only a utils update needs a restart.
 */
void close_browser_by_pid(unsigned long pid, int wait_ms);

/**
 * Gracefully close every running main process of the given install (matched
 * by full binary path, never image name — #180), plus its child processes.
 * Used when a config update happened.
 */
void close_browser_binary(const char *binary_path, int wait_ms);

/**
 * Open a URL in a specific profile by launching the binary with --profile
 * (argument-array based, no shell). Falls back to open_browser().
 */
void open_url_in_profile(const char *binary, const char *profile, const char *url);

typedef struct {
    int config_changed;
    int ui_host_killed;             /* the profile hosting the UI tab is being killed */
    char binary_path[MAX_PATH_LEN]; /* install (binary) the restart targets */
    int restart_idx[MAX_BROWSERS];
    int restart_count;
} restart_plan_t;

/**
 * Execute a restart plan: graceful close of the restart set, one-shot
 * session-restore pref, relaunch with the UI URL when the UI host was
 * killed, and session install-flag bookkeeping. Returns 1 if any browser
 * was relaunched, 0 otherwise.
 */
int do_restart_work(const restart_plan_t *plan);

/**
 * True while the Windows async restart worker is running (single-flight
 * guard). Declared cross-platform because the restart response logic reads
 * it on every OS; always 0 off-Windows — restarts run synchronously there,
 * so by the time the caller checks, the restart has already completed.
 */
int restart_worker_busy(void);

#ifdef _WIN32
/**
 * Hand the plan to the detached restart worker (single-flight: returns 0
 * if a worker is already running or the thread could not be created — the
 * caller then runs do_restart_work() synchronously, exactly as before the
 * split).
 */
int restart_start_async(const restart_plan_t *plan);
#endif

/* Shared installer state (defined in main.c, read/updated here). */
extern char g_ui_host_profile[MAX_PATH_LEN];
extern char g_ui_url[128];
extern RunningBrowser detected_browsers[MAX_BROWSERS];
extern int detected_count;
extern int session_installed_config[MAX_BROWSERS];
extern int session_installed_utils[MAX_BROWSERS];

#endif /* RESTART_H */
