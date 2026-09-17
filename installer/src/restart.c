/*
 * restart.c — browser close / relaunch / restart orchestration.
 *
 * Extracted verbatim from main.c (2026-09, audit §3.1 modularity splits):
 * graceful WM_CLOSE-based shutdown, session-restore pref handling, snap
 * launcher quirks, profile relaunch, and the async restart worker. The
 * HTTP surface (/api/restart, /api/close_browser) stays in main.c; this
 * module owns the "how" of restarting browsers. Shared installer state
 * (detected browsers, session install flags, UI URL/token) is declared
 * in restart.h and defined in main.c.
 */

#include "platform.h"
#include "detect_browser.h"
#include "restart.h"
#include "file_utils.h"

#ifdef _WIN32
#include <tlhelp32.h>
#else
#include <signal.h> /* kill() for the graceful PID close */
#include <unistd.h> /* fork/setsid for the detached relaunch */
#endif

// ===== Restart helpers =====

// Graceful shutdown is important: taskkill /F makes Firefox think it crashed,
// so the next launch runs crash-recovery (and can show restore-error pages).
// Sending WM_CLOSE to the browser's top-level windows triggers Firefox's normal
// quit path, which writes a valid session store.

#ifdef _WIN32
static BOOL CALLBACK close_window_enum_proc(HWND hwnd, LPARAM lparam) {
    DWORD pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);
    if (pid == (DWORD)lparam) PostMessageW(hwnd, WM_CLOSE, 0, 0);
    return TRUE;
}
#endif

// Wait up to wait_ms for the process to exit; force-kill the tree if it doesn't.
#ifdef _WIN32
static void wait_close_or_force(unsigned long pid, int wait_ms) {
    HANDLE h = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
                           FALSE, (DWORD)pid);
    if (h) {
        if (WaitForSingleObject(h, (DWORD)wait_ms) == WAIT_OBJECT_0) {
            CloseHandle(h);
            return;  // exited cleanly
        }
        CloseHandle(h);
    } else if (GetLastError() == ERROR_INVALID_PARAMETER) {
        return;  // already gone
    }
    char cmd[512];
    snprintf(cmd, sizeof(cmd), "taskkill /f /pid %lu /t", (unsigned long)pid);
    STARTUPINFOA si = { sizeof(si) };
    PROCESS_INFORMATION pi;
    if (CreateProcessA(NULL, cmd, NULL, NULL, FALSE,
                       CREATE_NO_WINDOW, NULL, NULL, &si, &pi)) {
        WaitForSingleObject(pi.hProcess, 3000);
        CloseHandle(pi.hProcess);
        CloseHandle(pi.hThread);
    }
    Sleep(300);
}
#endif

/**
 * Gracefully close a single browser process (and its child processes) by PID.
 * Targeted — used when only a utils update needs a restart.
 */
void close_browser_by_pid(unsigned long pid, int wait_ms) {
#ifdef _WIN32
    EnumWindows(close_window_enum_proc, (LPARAM)pid);
    wait_close_or_force(pid, wait_ms);
#else
    if (kill((pid_t)pid, SIGTERM) == 0) sleep_ms(300);
#endif
}

/**
 * Gracefully close every running MAIN process of the given install (matched by
 * full binary path), plus its child processes.  Used when a config update
 * happened: all profiles of THIS install share the config dir, so they all
 * need to be restarted with a clean cache.
 *
 * Matching is by full image path, not by executable name — several Firefox
 * family installs can run at once under the same image name (e.g. ESR and
 * Nightly are both firefox.exe); an image-name kill would close all of them
 * (#180).
 */
void close_browser_binary(const char *binary_path, int wait_ms) {
#ifdef _WIN32
    if (strlen(binary_path) == 0) return;
    wchar_t wbin[MAX_PATH];
    if (MultiByteToWideChar(CP_UTF8, 0, binary_path, -1, wbin, MAX_PATH) == 0) return;
    // szExeFile is only the image NAME, so pre-filter on the basename of the
    // binary path; the full-path check below is what actually scopes the kill.
    const wchar_t *wbase = wbin;
    const wchar_t *slash = wcsrchr(wbin, L'\\');
    if (slash && slash[1]) wbase = slash + 1;

    DWORD pids[256];
    int npids = 0;
    HANDLE hSnapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (hSnapshot != INVALID_HANDLE_VALUE) {
        PROCESSENTRY32W pe;
        pe.dwSize = sizeof(pe);
        if (Process32FirstW(hSnapshot, &pe)) {
            do {
                if (npids >= 256 || _wcsicmp(pe.szExeFile, wbase) != 0) continue;
                HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE,
                                       pe.th32ProcessID);
                if (!h) continue;  // cannot verify the path — leave it alone
                char path[MAX_PATH] = "";
                DWORD sz = (DWORD)sizeof(path);
                BOOL ok = QueryFullProcessImageNameA(h, 0, path, &sz);
                CloseHandle(h);
                // Case-insensitive compare: Windows paths are case-preserving,
                // and Firefox itself may differ in case from detection's copy.
                // Both APIs return long ANSI paths, but detection captured the
                // path via GetModuleFileNameExA — an 8.3-form capture would just
                // fail to match here ("no close"), never close a wrong install.
                if (ok && _stricmp(path, binary_path) == 0)
                    pids[npids++] = pe.th32ProcessID;
            } while (Process32NextW(hSnapshot, &pe));
        }
        CloseHandle(hSnapshot);
    }
    verbose_printf("[restart] close_browser_binary(%s): %d matching process(es)\n",
                   binary_path, npids);
    log_msg("[restart] closing %d process(es) of %s\n", npids, binary_path);
    // Ask them all to close, then wait/force each (two phases so multi-instance
    // cases shut down in parallel instead of serially).
    for (int i = 0; i < npids; i++) EnumWindows(close_window_enum_proc, (LPARAM)pids[i]);
    for (int i = 0; i < npids; i++) wait_close_or_force(pids[i], wait_ms);
#else
    (void)binary_path;
#endif
}

/**
 * Set browser.sessionstore.resume_session_once=true in a profile's prefs.js.
 *
 * Firefox has NO command-line switch to force a session restore (-restore is
 * not a real option).  Its own "forced restart" mechanism (used after an
 * update or extension install) is exactly this pref: the session is restored
 * on the NEXT launch, and Firefox then clears the pref itself, so it applies
 * only once.  The browser must be fully closed when this runs.
 */
static void set_resume_session_once(const char *profile) {
    if (strlen(profile) == 0) return;
    char path[MAX_PATH_LEN + 16];
#ifdef _WIN32
    snprintf(path, sizeof(path), "%s\\prefs.js", profile);
#else
    snprintf(path, sizeof(path), "%s/prefs.js", profile);
#endif
    const char *pref_line = "user_pref(\"browser.sessionstore.resume_session_once\", true);";

    // Read the whole file (prefs.js is small; the browser is closed).
    char *buf = NULL;
    long len = 0;
#ifdef _WIN32
    WCHAR *wpath = utf8_to_wide(path);
    FILE *f = wpath ? _wfopen(wpath, L"rb") : NULL;
    free(wpath);
#else
    FILE *f = fopen(path, "rb");
#endif
    if (f) {
        fseek(f, 0, SEEK_END);
        long flen = ftell(f);
        fseek(f, 0, SEEK_SET);
        if (flen > 0 && flen < 4 * 1024 * 1024) {
            buf = (char *)malloc((size_t)flen + 1);
            if (buf) {
                size_t rd = fread(buf, 1, (size_t)flen, f);
                buf[rd] = '\0';
                len = (long)rd;
            }
        }
        fclose(f);
    }

    if (!buf) {
        // No/corrupt prefs.js: create it with just the pref.
        log_msg("[restart] creating %s with resume_session_once\n", path);
        save_buf_to_file(path, pref_line, (size_t)strlen(pref_line));
        return;
    }

    // Replace an existing resume_session_once line, else append.
    const char *marker = "user_pref(\"browser.sessionstore.resume_session_once\"";
    char *found = strstr(buf, marker);
    if (found) {
        char *line_end = strchr(found, '\n');
        long head_len = (long)(found - buf);
        long tail_len = line_end ? (long)strlen(line_end + 1) : 0;
        long need = head_len + (long)strlen(pref_line) + 1 + tail_len + 1;
        char *new_buf = (char *)malloc((size_t)need);
        if (new_buf) {
            long pos = 0;
            memcpy(new_buf, buf, (size_t)head_len);
            pos += head_len;
            memcpy(new_buf + pos, pref_line, strlen(pref_line));
            pos += (long)strlen(pref_line);
            new_buf[pos++] = '\n';
            if (line_end) memcpy(new_buf + pos, line_end + 1, (size_t)tail_len);
            pos += tail_len;
            save_buf_to_file(path, new_buf, (size_t)pos);
            log_msg("[restart] set resume_session_once in %s\n", path);
            free(new_buf);
        }
    } else {
        long blen = (long)strlen(buf);
        /* Decide the separator from the source buffer instead of reading back
         * from new_buf after the memcpy: CI's gcc (13.x) could not relate the
         * memcpy-written extent to the following new_buf[pos - 1] read and
         * reported a heap over-read; buf[blen - 1] is the in-tree pattern the
         * analyzer already proves (cf. detect_browser.c line trimming). */
        int needs_nl = (blen == 0 || buf[blen - 1] != '\n');
        long need = blen + (needs_nl ? 1 : 0) + (long)strlen(pref_line) + 1;
        char *new_buf = (char *)malloc((size_t)need);
        if (new_buf) {
            long pos = 0;
            memcpy(new_buf, buf, (size_t)blen);
            pos = blen;
            if (needs_nl) new_buf[pos++] = '\n';
            memcpy(new_buf + pos, pref_line, strlen(pref_line));
            pos += (long)strlen(pref_line);
            new_buf[pos++] = '\n';
            save_buf_to_file(path, new_buf, (size_t)pos);
            log_msg("[restart] appended resume_session_once to %s\n", path);
            free(new_buf);
        }
    }
    free(buf);
}

/**
 * Path to EXEC for a detected browser, vs. the recorded binary path.
 * Detection records the process image (/proc/<pid>/exe), so a Snap install
 * yields the inner /snap/<name>/<rev>/usr/lib/firefox/firefox binary.
 * Exec'ing that inner binary directly runs it OUTSIDE the snap's confinement:
 * it cannot hand a URL off to the confined, already-running snap instance
 * (the instance's IPC lives behind the snap's private /tmp + AppArmor) and
 * instead starts a second, unconfined browser — the installer tab never lands
 * in the user's browser.  Relaunching through the /snap/bin/<name> snap-exec
 * wrapper (what the desktop entry and every normal snap launch use) shares
 * the running instance's confinement, so the handoff works.  Non-snap
 * installs are relaunched as recorded.
 *
 * Only used off-Windows (snaps are a Linux packaging).
 */
#ifndef _WIN32
static void snap_launcher_path(const char *binary, char *out, size_t out_sz) {
    if (strncmp(binary, "/snap/", 6) == 0) {
        const char *name_start = binary + 6;
        const char *name_end = strchr(name_start, '/');
        if (name_end && name_end > name_start) {
            snprintf(out, out_sz, "/snap/bin/%.*s", (int)(name_end - name_start),
                     name_start);
            return;
        }
    }
    snprintf(out, out_sz, "%s", binary);
}
#endif

/**
 * Launch a browser instance for the given profile with a clean cache.
 * Passes `url` (if non-empty) as --new-tab so the installer tab opens as part
 * of this launch.  Session restore is handled by the resume_session_once pref
 * set in set_resume_session_once() (Firefox has no -restore CLI flag).
 * Returns 1 if a process was started, 0 otherwise.
 */
static int launch_browser_profile(const RunningBrowser *b, const char *url) {
    if (strlen(b->binary_path) == 0) return 0;
#ifdef _WIN32
    STARTUPINFOW si = { sizeof(si) };
    PROCESS_INFORMATION pi;
    char cmdline[4096];
    if (strlen(b->profile_path) > 0) {
        if (url && url[0]) {
            snprintf(cmdline, sizeof(cmdline),
                     "\"%s\" --profile \"%s\" -purgecaches --new-tab \"%s\"",
                     b->binary_path, b->profile_path, url);
        } else {
            snprintf(cmdline, sizeof(cmdline),
                     "\"%s\" --profile \"%s\" -purgecaches",
                     b->binary_path, b->profile_path);
        }
    } else {
        if (url && url[0]) {
            snprintf(cmdline, sizeof(cmdline),
                     "\"%s\" -purgecaches --new-tab \"%s\"", b->binary_path, url);
        } else {
            snprintf(cmdline, sizeof(cmdline),
                     "\"%s\" -purgecaches", b->binary_path);
        }
    }
    // Command line is UTF-8 (binary/profile/url are UTF-8 internally); convert
    // the whole string so a non-ASCII profile path reaches Firefox intact.
    WCHAR *wcmdline = utf8_to_wide(cmdline);
    if (wcmdline && CreateProcessW(NULL, wcmdline, NULL, NULL, FALSE,
                                   0, NULL, NULL, &si, &pi)) {
        CloseHandle(pi.hProcess);
        CloseHandle(pi.hThread);
        free(wcmdline);
        verbose_printf("[restart] Launched %s\n", b->profile_path);
        return 1;
    }
    free(wcmdline);
    verbose_printf("[restart] ERROR: CreateProcessW failed, error %lu\n", GetLastError());
    return 0;
#else
    char launch[MAX_PATH_LEN];
    snap_launcher_path(b->binary_path, launch, sizeof(launch));
    const char *tab = (url && url[0]) ? url : NULL;  // execl's argv ends at
    // the first NULL, so a NULL url must drop --new-tab entirely, not pass a
    // dangling switch (same guard as the Windows branch above).
    pid_t child = fork();
    if (child == 0) {
        setsid();
        if (strlen(b->profile_path) > 0) {
            if (tab) {
                execl(launch, launch, "-profile", b->profile_path,
                      "-purgecaches", "--new-tab", tab, (char *)NULL);
            } else {
                execl(launch, launch, "-profile", b->profile_path,
                      "-purgecaches", (char *)NULL);
            }
        } else {
            if (tab) {
                execl(launch, launch, "-purgecaches", "--new-tab", tab,
                      (char *)NULL);
            } else {
                execl(launch, launch, "-purgecaches", (char *)NULL);
            }
        }
        _exit(1);
    }
    if (child > 0) {
        verbose_printf("[restart] Forked PID %d for %s\n", child, b->profile_path);
        return 1;
    }
    verbose_printf("[restart] ERROR: fork failed\n");
    return 0;
#endif
}

/**
 * Open a URL in a SPECIFIC profile by launching the binary with --profile.
 * Firefox routes the URL to the running instance of that profile (or starts a
 * new one), so the installer tab reliably lands in a known browser instead of
 * whichever instance happens to claim a bare URL.  The launch is argument-array
 * based (no shell), mirroring launch_browser_profile().
 */
void open_url_in_profile(const char *binary, const char *profile, const char *url) {
    if (strlen(binary) == 0 || strlen(profile) == 0) {
        open_browser(url, NULL);
        return;
    }
#ifdef _WIN32
    char cmd[2 * MAX_PATH_LEN + 256];
    snprintf(cmd, sizeof(cmd), "\"%s\" --profile \"%s\" \"%s\"", binary, profile, url);
    WCHAR *wcmd = utf8_to_wide(cmd);
    STARTUPINFOW si = { sizeof(si) };
    PROCESS_INFORMATION pi;
    if (wcmd && CreateProcessW(NULL, wcmd, NULL, NULL, FALSE,
                               0, NULL, NULL, &si, &pi)) {
        CloseHandle(pi.hProcess);
        CloseHandle(pi.hThread);
        free(wcmd);
        log_msg("[openurl] %s\n", cmd);
        return;
    }
    free(wcmd);
    log_msg("[openurl] CreateProcessW failed: %lu\n", GetLastError());
    open_browser(url, NULL);
#else
    char launch[MAX_PATH_LEN];
    snap_launcher_path(binary, launch, sizeof(launch));
    pid_t child = fork();
    if (child == 0) {
        setsid();
        execl(launch, launch, "-profile", profile, "--new-tab", url,
              (char *)NULL);
        _exit(1);
    }
    if (child > 0) {
        log_msg("[openurl] forked PID %d for profile %s\n", child, profile);
        return;
    }
    log_msg("[openurl] fork failed\n");
    open_browser(url, NULL);
#endif
}

// ===== Async restart worker =====
//
// The restart (close tab -> graceful quit -> relaunch with UI URL) is performed
// on a detached thread so the single-threaded HTTP server keeps accepting
// connections.  The installer tab is NOT left to session restore (which is
// unreliable and duplicates tabs); its URL is passed on the relaunch command
// line so it opens as part of the new browser's startup.

#ifdef _WIN32
static volatile int g_restart_worker_running = 0;
#endif

int do_restart_work(const restart_plan_t *plan) {
    if (plan->config_changed) {
        // Close every running instance of THIS install (matched by full binary
        // path — they all share the config dir).  WM_CLOSE lets Firefox write a
        // valid session store.  Never kill by image name: ESR and Nightly both
        // run as firefox.exe, so an image-name kill would close unrelated
        // installs too (#180).
        verbose_printf("[restart] Config updated -> closing all instances of %s\n",
                       plan->binary_path);
        log_msg("[restart] closing all instances of %s\n", plan->binary_path);
        close_browser_binary(plan->binary_path, 8000);
    } else {
        // Targeted: close only the profiles whose utils were updated.
        for (int i = 0; i < plan->restart_count; i++) {
            RunningBrowser *rb = &detected_browsers[plan->restart_idx[i]];
            verbose_printf("[restart] Utils updated -> closing %s (PID: %lu)\n",
                           rb->identified_browser, rb->pid);
            log_msg("[restart] closing %s (PID: %lu)\n", rb->identified_browser, rb->pid);
            close_browser_by_pid(rb->pid, 8000);
        }
    }

    // Relaunch each unique profile in the restart set (dedupe so two detected
    // processes of the same profile don't launch that profile twice).  The UI
    // host profile gets the installer URL on its command line so the tab opens
    // as part of the launch instead of a separate delayed step.
    int started = 0;
    char relaunched_profiles[MAX_BROWSERS][MAX_PATH_LEN];
    int relaunch_count = 0;
    for (int i = 0; i < plan->restart_count; i++) {
        RunningBrowser *rb = &detected_browsers[plan->restart_idx[i]];
        if (strlen(rb->profile_path) == 0) continue;  // cannot relaunch a profile-less row
        int dup = 0;
        for (int j = 0; j < relaunch_count; j++) {
            if (strcmp(relaunched_profiles[j], rb->profile_path) == 0) {
                dup = 1;
                break;
            }
        }
        if (dup) continue;
        // Set the one-shot resume_session_once pref (Firefox's documented
        // forced-restart mechanism) so this relaunched browser restores its
        // previous session even if browser.startup.page != 3.
        set_resume_session_once(rb->profile_path);
        const char *url = (plan->ui_host_killed &&
                           strcmp(rb->profile_path, g_ui_host_profile) == 0)
                              ? g_ui_url
                              : NULL;
        log_msg("[restart] relaunching profile %s%s\n", rb->profile_path,
                url ? " (with UI URL)" : "");
        if (launch_browser_profile(rb, url)) started = 1;
        snprintf(relaunched_profiles[relaunch_count], MAX_PATH_LEN, "%s", rb->profile_path);
        relaunch_count++;
    }

    // Consume the session install flags for the profiles that were just
    // restarted.  The flags mean "changed this session and not restarted yet",
    // so a later Restart click targets only profiles whose utils changed since
    // the previous restart — this is what makes "install and restart one at a
    // time" work (restarting profile A, then installing utils for profile B
    // and restarting again must restart B alone, not A again).
    if (plan->restart_count > 0) {
        if (plan->config_changed) {
            // Config lives in the shared binary dir, so the restart set covered
            // every profile of this binary — clear both flag types for the
            // whole group.
            const char *binary = detected_browsers[plan->restart_idx[0]].binary_path;
            for (int i = 0; i < detected_count; i++) {
                if (strcmp(detected_browsers[i].binary_path, binary) == 0) {
                    session_installed_config[i] = 0;
                    session_installed_utils[i] = 0;
                }
            }
        } else {
            // Utils-only restart: clear only the profiles that were restarted.
            for (int i = 0; i < plan->restart_count; i++) {
                session_installed_utils[plan->restart_idx[i]] = 0;
            }
        }
    }
    return started;
}

#ifdef _WIN32
static DWORD WINAPI restart_worker_thread(void *arg) {
    restart_plan_t *plan = (restart_plan_t *)arg;

    if (plan->ui_host_killed) {
        // The UI tab (about to be killed) was told to close itself via
        // window.close()/about:blank.  Wait a moment so that navigation commits
        // before the graceful close writes the session store, otherwise a
        // later -restore could bring a stale copy of the installer tab back.
        log_msg("[restart] waiting for UI tab to close\n");
        Sleep(1500);
    }

    // Graceful close (WM_CLOSE) -> wait for exit -> relaunch with
    // -purgecaches -restore and the UI URL on the command line.
    do_restart_work(plan);

    log_msg("[restart] worker done\n");
    free(plan);
    g_restart_worker_running = 0;
    return 0;
}

int restart_start_async(const restart_plan_t *plan) {
    // Single-flight: exactly one worker may run at a time (the pristine
    // main.c spawn block, moved verbatim behind a function seam so the
    // caller stays readable and the guard state stays internal to this
    // module).
    if (g_restart_worker_running) return 0;
    restart_plan_t *heap_plan = (restart_plan_t *)malloc(sizeof(restart_plan_t));
    if (!heap_plan) return 0;
    *heap_plan = *plan;
    g_restart_worker_running = 1;
    HANDLE h = CreateThread(NULL, 0, restart_worker_thread, heap_plan, 0, NULL);
    if (h) {
        CloseHandle(h);
        return 1;
    }
    g_restart_worker_running = 0;
    free(heap_plan);
    return 0;
}
#endif /* _WIN32 */

int restart_worker_busy(void) {
#ifdef _WIN32
    return g_restart_worker_running;
#else
    return 0; /* restarts run synchronously off-Windows */
#endif
}
