#include "platform.h"
#include "detect_browser.h"
#include "http_server.h"
#include "self_update.h"
#include "admin_copy.h"
#include "file_utils.h"
#include "resources.h"
#include "obsolete_files.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifdef _WIN32
#include <tlhelp32.h>
#include <bcrypt.h>
#else
#include <fcntl.h>
#include <signal.h>
#include <time.h>
#include <unistd.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <sys/random.h>
#endif

#if defined(__GNUC__) && !defined(__clang__)
#pragma GCC diagnostic ignored "-Wformat-truncation"
#endif
#include <stdbool.h>

// ===== Verbose logging =====
static int g_verbose = 0;

// --smoke-test: run headless for CI security smoke tests — never abort when
// no browser is detected, never open a browser tab, and print the session
// token to stdout so the test can drive the API.
static int g_smoke_test = 0;

// --server-only: skip the browser scan and never open a UI tab — headless
// HTTP-server mode for the second-instance detection tests (E2E).
static int g_server_only = 0;

// --env-file <path>: after the server binds, write a JSON manifest (port,
// session token, run id, UI URL) to this file so the E2E harness can read the
// deployment facts instead of scraping stdout or the fixed default port.
static char g_env_file_path[MAX_PATH_LEN] = "";

#define verbose_printf(...)                 \
    do {                                    \
        if (g_verbose) printf(__VA_ARGS__); \
    } while (0)

// Per-run session token, embedded in the UI URL as ?t=<token>.  A restored tab
// from a PREVIOUS installer run carries an old token; /api/claim compares it
// against this one so stale tabs show a "closed" placeholder instead of the
// installer UI (and don't shut down the current installer when closed).
static char g_session_token[17];

// UI URL for this run, reopened explicitly after a restart that kills the tab.
static char g_ui_url[128];

// Profile that hosts the installer UI tab this run (the last-used browser).
// The restart worker reopens the UI there when that profile gets restarted.
static char g_ui_host_profile[MAX_PATH_LEN] = "";

// Port the HTTP server bound, needed to rebuild the UI URL after a restart.
static int g_http_port = 0;

// Port to request at startup.  -1 = flag not given (use DEFAULT_PORT);
// 0 = bind an OS-ephemeral port; >0 = bind exactly that port.  The sentinel
// matters: --port 0 (ephemeral) must stay distinguishable from no --port.
static int g_requested_port = -1;

// Run id (wall-clock ms since epoch — uniqueness across runs is all the
// harness needs; it is NOT a monotonic clock reading) — lets the E2E harness
// tell two installer runs apart when both write env.json manifests.
static unsigned long long run_id_ms(void) {
#ifdef _WIN32
    FILETIME ft;
    GetSystemTimeAsFileTime(&ft);
    unsigned long long t = ((unsigned long long)ft.dwHighDateTime << 32) | ft.dwLowDateTime;
    return (t - 116444736000000000ULL) / 10000ULL;  // 100ns ticks -> ms since epoch
#else
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    return (unsigned long long)ts.tv_sec * 1000ULL + (unsigned long long)ts.tv_nsec / 1000000ULL;
#endif
}

// Write the --env-file deployment manifest (best-effort): a tiny JSON record
// the E2E harness reads for port/token/run-id instead of scraping stdout.
// Never fatal — a test surface must not break a working server.
static void write_env_manifest(const char *path, int port) {
    if (!path || !path[0]) return;
    char json[512];
    int pos = snprintf(json, sizeof(json),
                       "{\"port\":%d,\"token\":\"%s\",\"runId\":%llu,\"uiUrl\":\"http://localhost:%d/?t=%s\"}",
                       port, g_session_token, run_id_ms(), port, g_session_token);
    if (pos <= 0 || pos >= (int)sizeof(json)) return;
    if (save_buf_to_file(path, json, (size_t)pos) == 0) {
        log_msg("[startup] env manifest written to %s\n", path);
    } else {
        log_msg("[startup] failed to write env manifest to %s\n", path);
    }
}

/* Fill buf with cryptographically secure random bytes from the OS RNG.
 * Returns 0 on success, -1 when the platform RNG is unavailable. */
static int fill_random_bytes(unsigned char *buf, size_t len) {
#ifdef _WIN32
    return BCryptGenRandom(NULL, buf, (ULONG)len, BCRYPT_USE_SYSTEM_PREFERRED_RNG) == 0
               ? 0
               : -1;
#else
    if (getentropy(buf, len) == 0) return 0;
    // Fallback for older libcs: /dev/urandom.
    int fd = open("/dev/urandom", O_RDONLY);
    if (fd < 0) return -1;
    ssize_t got = read(fd, buf, len);
    close(fd);
    return got == (ssize_t)len ? 0 : -1;
#endif
}

/* Generate the session token from the OS CSPRNG.  Returns 0 on success, -1
 * when secure randomness is unavailable — the caller must fail CLOSED (refuse
 * to start the API) rather than fall back to a weak seed, because this token
 * is the sole capability check for the install API.  On failure the token is
 * left untouched (no predictable fallback). */
static int generate_session_token(void) {
    unsigned char raw[16];
    if (fill_random_bytes(raw, sizeof(raw)) != 0) return -1;
    const char *hex = "0123456789abcdef";
    for (int i = 0; i < 16; i++) g_session_token[i] = hex[raw[i] % 16];
    g_session_token[16] = '\0';
    return 0;
}

// Exposed to http_server.c so shutdown/claim can validate a tab's token.
const char *installer_session_token(void) {
    return g_session_token;
}

// A request carrying the CURRENT run's session token (the UI embeds it in
// every URL as ?t=<token>).  Every state-changing endpoint requires it, so a
// random local web page can never drive the installer API (cross-origin pages
// are additionally refused via CORS).  Returns 1 when the query string holds
// exactly this run's token, 0 when missing or stale.
static int request_has_valid_token(const char *query) {
    if (!query) return 0;
    const char *t = strstr(query, "t=");
    // 't=' must start a parameter (start of query or after '&'), not match
    // inside another value like "xt=...".
    if (!t || (t != query && t[-1] != '&')) return 0;
    return strcmp(t + 2, g_session_token) == 0;
}

#ifdef _WIN32
// Set once the shutdown path starts, so the console handler and the keyboard
// watchdog below never run the graceful shutdown twice (exit(0) races).
static volatile LONG g_shutting_down = 0;

static BOOL WINAPI on_ctrl_c(DWORD dwCtrlType) {
    if (dwCtrlType == CTRL_C_EVENT || dwCtrlType == CTRL_BREAK_EVENT) {
        if (InterlockedExchange(&g_shutting_down, 1)) return TRUE;
        printf("\nShutting down...\n");
        http_server_stop();
        Sleep(200);
        exit(0);
        return TRUE;
    }
    return FALSE;
}

// ---------------------------------------------------------------------------
// Ctrl+C keyboard watchdog.
//
// SetConsoleCtrlHandler only fires when the console delivers CTRL_C_EVENT to
// this process.  That works under cmd.exe, which broadcasts the event to
// every process attached to the console, but NOT under PowerShell: PowerShell
// starts native processes in a new process group (CREATE_NEW_PROCESS_GROUP),
// which is excluded from the broadcast, and Windows PowerShell 5.1 never
// forwards Ctrl+C the way pwsh 7.3+ does.  The user then sees Ctrl+C do
// nothing even though the banner says "Press Ctrl+C to stop the installer."
//
// The watchdog polls the physical keyboard instead, so it works in every
// terminal host.  It only fires while a terminal window has input focus, so a
// Ctrl+C in the browser (copy) cannot accidentally stop the installer, and it
// is only started when a parent console was attached (i.e. the app was
// started from a terminal, not double-clicked).
// ---------------------------------------------------------------------------

// True while the foreground window belongs to a terminal/console host.
static int terminal_has_focus(void) {
    HWND con = GetConsoleWindow();
    HWND fg = GetForegroundWindow();
    if (!fg) return 0;
    if (con && fg == con) return 1;  // classic conhost window
    // Pseudoconsole (Windows Terminal, VS Code, third-party terminals):
    // GetConsoleWindow() is NULL, so identify the foreground process instead.
    DWORD pid = 0;
    GetWindowThreadProcessId(fg, &pid);
    if (!pid || pid == GetCurrentProcessId()) return 0;
    HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!h) return 0;
    char path[MAX_PATH] = "";
    DWORD sz = (DWORD)sizeof(path);
    BOOL ok = QueryFullProcessImageNameA(h, 0, path, &sz);
    CloseHandle(h);
    if (!ok) return 0;
    const char *base = strrchr(path, '\\');
    base = base ? base + 1 : path;
    static const char *const terminals[] = {
        "conhost.exe", "openconsole.exe", "windowsterminal.exe",
        "cmd.exe", "powershell.exe", "pwsh.exe",
        "wezterm.exe", "alacritty.exe", "mintty.exe", "kitty.exe",
        "ghostty.exe", "code.exe", NULL
    };
    for (int i = 0; terminals[i]; i++) {
        if (strcasecmp(base, terminals[i]) == 0) return 1;
    }
    return 0;
}

#ifdef _WIN32
/**
 * Find the detected browser whose top-level window is highest in the Z order
 * (i.e. the one the user most recently used).  Windows keeps the foreground
 * window on top, so the first visible window whose PID matches a detected
 * browser is the last-used browser.  Returns its index, or -1 when no running
 * browser exposes a visible window (callers fall back to the first entry).
 */
static int find_last_used_browser_index(const RunningBrowser *browsers, int count) {
    if (count <= 0) return -1;
    HWND hwnd = GetTopWindow(NULL);
    while (hwnd) {
        if (IsWindowVisible(hwnd)) {
            DWORD pid = 0;
            GetWindowThreadProcessId(hwnd, &pid);
            for (int i = 0; i < count; i++) {
                if (browsers[i].pid == (unsigned long)pid) {
                    return i;
                }
            }
        }
        hwnd = GetWindow(hwnd, GW_HWNDNEXT);
    }
    return -1;
}

/**
 * Bring the top-level window of `pid` to the foreground.  Best-effort: Windows
 * may refuse a focus steal, but restoring a minimized window plus
 * SetForegroundWindow/BringWindowToTop is the strongest hint available without
 * input-thread tricks.
 */
static void focus_browser_window(unsigned long pid) {
    if (!pid) return;
    HWND hwnd = GetTopWindow(NULL);
    HWND found = NULL;
    while (hwnd) {
        DWORD wpid = 0;
        GetWindowThreadProcessId(hwnd, &wpid);
        if (wpid == (DWORD)pid && IsWindowVisible(hwnd)) {
            found = hwnd;
            break;
        }
        hwnd = GetWindow(hwnd, GW_HWNDNEXT);
    }
    if (!found) return;
    if (IsIconic(found)) ShowWindow(found, SW_RESTORE);
    SetForegroundWindow(found);
    BringWindowToTop(found);
}
#endif

static DWORD WINAPI ctrl_c_watchdog(LPVOID unused) {
    (void)unused;
    // Two consecutive samples (~100 ms) of a held Ctrl+C while a terminal has
    // focus.  A quick Ctrl+C tap is typically held 100-300 ms.
    int samples = 0;
    for (;;) {
        Sleep(50);
        if ((GetAsyncKeyState(VK_CONTROL) & 0x8000) &&
            (GetAsyncKeyState('C') & 0x8000) &&
            terminal_has_focus()) {
            if (++samples >= 2) {
                samples = 0;
                on_ctrl_c(CTRL_C_EVENT);
                return 0;
            }
        } else {
            samples = 0;
        }
    }
    return 0;
}
#else
static int find_last_used_browser_index(const RunningBrowser *browsers, int count) {
    (void)browsers;
    (void)count;
    return -1;  // no z-order heuristic off-Windows; caller uses the first entry
}

static void focus_browser_window(unsigned long pid) {
    (void)pid;  // launching via open_url_in_profile/xdg-open handles focus
}
#endif

// ===== Install state for API =====

// Granular install states for cooperative multitasking.
// The status handler advances one phase per call so the single-threaded
// server stays responsive to other requests (e.g. /api/status polling).
// There are no DOWNLOAD states: the installer performs no network I/O.  The
// web UI fetches the zips (CORS-enabled URLs) and POSTs the raw bytes via
// /api/upload; the EXTRACT states read those in-memory buffers.
typedef enum {
    INSTALL_STATE_IDLE,
    INSTALL_STATE_EXTRACT_CONFIG,  // Extract config zip
    INSTALL_STATE_EXTRACT_UTILS,   // Extract utils zip
    INSTALL_STATE_DONE,
    INSTALL_STATE_ERROR
} InstallState;

static InstallState current_state = INSTALL_STATE_IDLE;
static char state_message[256] = "";
static int state_progress = 0;
static int install_browser_index = -1;
static int install_config = 0;
static int install_utils = 0;

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

static char g_work_dir[MAX_PATH_LEN];
static char g_binary_dir[MAX_PATH_LEN];
static char g_profile_dir[MAX_PATH_LEN];

static RunningBrowser detected_browsers[MAX_BROWSERS];
static int detected_count = 0;

// Session install tracking: what was installed during THIS installer run.
// Used by the restart handler to decide restart scope — a config install
// writes to the shared binary dir so EVERY browser of that binary needs a
// clean-cache restart, whereas a utils-only install only affects the one
// profile.  Indexed by detected_browsers index.
static int session_installed_config[MAX_BROWSERS];
static int session_installed_utils[MAX_BROWSERS];

// ===== JSON helpers =====

/**
 * Write a string escaped for JSON into a buffer.
 * Handles backslashes, double quotes, and control characters.
 * Returns the number of chars written (excluding null terminator).
 */
static int json_escape(char *buf, size_t size, const char *str) {
    int total = 0;
    for (const char *p = str; *p && (size_t)total < size - 1; p++) {
        unsigned char c = (unsigned char)*p;
        switch (c) {
            case '\\': total += snprintf(buf + total, size - (size_t)total, "\\\\"); break;
            case '"': total += snprintf(buf + total, size - (size_t)total, "\\\""); break;
            case '\n': total += snprintf(buf + total, size - (size_t)total, "\\n"); break;
            case '\r': total += snprintf(buf + total, size - (size_t)total, "\\r"); break;
            case '\t': total += snprintf(buf + total, size - (size_t)total, "\\t"); break;
            default:
                if (c < 0x20) {
                    total += snprintf(buf + total, size - (size_t)total, "\\u%04x", c);
                } else {
                    if ((size_t)total < size - 1) buf[total++] = c;
                }
                break;
        }
    }
    if ((size_t)total < size) buf[total] = '\0';
    return total;
}

// ===== File helpers for install =====

/**
 * Copy a file from src to dst using platform-native copy.
 * Returns 0 on success, -1 on failure.
 */
static int copy_file(const char *src, const char *dst) {
#ifdef _WIN32
    WCHAR *wsrc = utf8_to_wide(src);
    WCHAR *wdst = utf8_to_wide(dst);
    if (!wsrc || !wdst) {
        free(wsrc);
        free(wdst);
        return -1;
    }
    BOOL ok = CopyFileW(wsrc, wdst, FALSE);
    free(wsrc);
    free(wdst);
    return ok ? 0 : -1;
#else
    int in_fd = open(src, O_RDONLY);
    if (in_fd < 0) return -1;
    int out_fd = open(dst, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (out_fd < 0) {
        close(in_fd);
        return -1;
    }
    char buf[65536];
    ssize_t n;
    while ((n = read(in_fd, buf, sizeof(buf))) > 0) {
        ssize_t written = 0;
        while (written < n) {
            ssize_t r = write(out_fd, buf + written, (size_t)(n - written));
            if (r <= 0) {
                close(in_fd);
                close(out_fd);
                return -1;
            }
            written += r;
        }
    }
    close(in_fd);
    close(out_fd);
    return (n == 0) ? 0 : -1;
#endif
}

/**
 * Send a JSON response (common pattern used by all API handlers).
 */
static void send_json_response(int client_fd, const char *json, int json_len) {
    char header[512];
    // No Access-Control-Allow-Origin header: the UI is same-origin and foreign
    // pages must not read installer responses (see send_response).
    int hlen = snprintf(header, sizeof(header),
                        "HTTP/1.0 200 OK\r\n"
                        "Content-Type: application/json\r\n"
                        "Connection: close\r\n"
                        "Content-Length: %d\r\n"
                        "\r\n",
                        json_len);
#ifdef _WIN32
    send(client_fd, header, hlen, 0);
    send(client_fd, json, json_len, 0);
#else
    (void)write(client_fd, header, (size_t)hlen);
    (void)write(client_fd, json, (size_t)json_len);
#endif
}

// ===== API handlers =====

/**
 * Lightweight liveness endpoint for the UI's heartbeat.
 * Deliberately does NOT touch the install state machine: /api/status advances
 * the install one step per call, so a heartbeat that also polled it could
 * consume the final "done" step and make the UI's poll miss completion.
 */
int handle_api_ping(int client_fd, const char *query, const char *body, size_t body_len) {
    (void)query;
    (void)body;
    (void)body_len;
    const char *json = "{\"ok\":1}";
    send_json_response(client_fd, json, (int)strlen(json));
    return 0;
}

/**
 * Session-token check for restored tabs.  The UI passes ?t=<token> from its own
 * URL; if it differs from the current installer's token, the tab belongs to a
 * previous (closed) installer run and should show a "closed" placeholder.
 */
int handle_api_claim(int client_fd, const char *query, const char *body, size_t body_len) {
    (void)body;
    (void)body_len;
    int is_current = 1;
    if (query) {
        const char *t = strstr(query, "t=");
        if (t) {
            t += 2;
            is_current = (strcmp(t, g_session_token) == 0);
        }
    }
    char json[128];
    int pos = snprintf(json, sizeof(json), "{\"ok\":1,\"current\":%d}", is_current);
    send_json_response(client_fd, json, pos);
    return 0;
}

int handle_api_browsers(int client_fd, const char *query, const char *body, size_t body_len) {
    (void)query;
    (void)body;
    (void)body_len;

    // Return cached browser list — do NOT rescan.
    // Rescanning would pick up the browser that was just launched to show the UI.
    // Browsers are scanned once at startup; a rescan happens after each install completes.

    // Build JSON response
    char json[8192];
    int pos = 0;
    pos += snprintf(json + pos, sizeof(json) - (size_t)pos, "[");

    for (int i = 0; i < detected_count && pos < (int)sizeof(json) - 256; i++) {
        if (i > 0) pos += snprintf(json + pos, sizeof(json) - (size_t)pos, ",");

        char esc_name[256], esc_exe[64], esc_bin[MAX_PATH_LEN * 2], esc_prof[MAX_PATH_LEN * 2], esc_ver[160];
        char esc_hg[768];
        char hg_url[768];
        json_escape(esc_name, sizeof(esc_name), detected_browsers[i].identified_browser);
        json_escape(esc_exe, sizeof(esc_exe), detected_browsers[i].exe_name);
        json_escape(esc_bin, sizeof(esc_bin), detected_browsers[i].binary_path);
        json_escape(esc_prof, sizeof(esc_prof), detected_browsers[i].profile_path);
        json_escape(esc_ver, sizeof(esc_ver), detected_browsers[i].version);
        get_hg_tags_url(detected_browsers[i].binary_path,
                        identify_variant_from_path(detected_browsers[i].binary_path),
                        hg_url, sizeof(hg_url));
        json_escape(esc_hg, sizeof(esc_hg), hg_url);

        pos += snprintf(json + pos, sizeof(json) - (size_t)pos,
                        "{"
                        "\"index\":%d,"
                        "\"name\":\"%s\","
                        "\"exe\":\"%s\","
                        "\"pid\":%lu,"
                        "\"binaryPath\":\"%s\","
                        "\"profilePath\":\"%s\","
                        "\"version\":\"%s\","
                        "\"hgTagsUrl\":\"%s\","
                        "\"configInstalled\":%d,"
                        "\"utilsInstalled\":%d,"
                        "\"configUpToDate\":%d,"
                        "\"utilsUpToDate\":%d,"
                        "\"hashCheckOk\":%d"
                        "}",
                        i,
                        esc_name,
                        esc_exe,
                        detected_browsers[i].pid,
                        esc_bin,
                        esc_prof,
                        esc_ver,
                        esc_hg,
                        detected_browsers[i].config_installed,
                        detected_browsers[i].utils_installed,
                        detected_browsers[i].config_up_to_date,
                        detected_browsers[i].utils_up_to_date,
                        get_hash_check_available());
    }

    pos += snprintf(json + pos, sizeof(json) - (size_t)pos, "]");

    char header[512];
    int hlen = snprintf(header, sizeof(header),
                        "HTTP/1.0 200 OK\r\n"
                        "Content-Type: application/json\r\n"
                        "Connection: close\r\n"
                        "Content-Length: %d\r\n"
                        "\r\n",
                        pos);

#ifdef _WIN32
    send(client_fd, header, hlen, 0);
    send(client_fd, json, pos, 0);
#else
    (void)write(client_fd, header, (size_t)hlen);
    (void)write(client_fd, json, (size_t)pos);
#endif
    return 0;
}

/**
 * Return the download URLs of both package zips, for users who prefer to
 * install manually.  The web UI opens these links; GitHub serves release
 * assets with Content-Disposition: attachment, so the browser downloads them
 * to the user's Downloads folder.
 */
int handle_api_package_urls(int client_fd, const char *query, const char *body, size_t body_len) {
    (void)query;
    (void)body;
    (void)body_len;

    char utils_url[512], fx_url[512], updater_ui_url[512];
    snprintf(utils_url, sizeof(utils_url), "%s/utils%s.zip", INSTALLER_ZIP_URL, INSTALLER_ASSET_SUFFIX);
    snprintf(fx_url, sizeof(fx_url), "%s/fx-folder%s.zip", INSTALLER_ZIP_URL, INSTALLER_ASSET_SUFFIX);
    snprintf(updater_ui_url, sizeof(updater_ui_url), "%s/updater-ui%s.zip", INSTALLER_ZIP_URL, INSTALLER_ASSET_SUFFIX);

    // URLs the web UI fetches (all CORS-enabled) and POSTs back to the local
    // server — the C installer itself performs no network I/O.
    char self_update_url[512];
    snprintf(self_update_url, sizeof(self_update_url),
             "https://api.github.com/repos/%s/%s/releases/tags/%s",
             INSTALLER_REPO_OWNER, INSTALLER_REPO_NAME, INSTALLER_RELEASE_NAME);

    // Last-update dates from the remote manifest, for the manual-download
    // links ("last update ..." annotation).  Empty when the manifest was
    // unreachable.
    char esc_fx_date[128], esc_utils_date[128];
    json_escape(esc_fx_date, sizeof(esc_fx_date), get_package_date(0));
    json_escape(esc_utils_date, sizeof(esc_utils_date), get_package_date(1));

    char json[2048];
    int pos = snprintf(json, sizeof(json),
                       "{"
                       "\"utilsUrl\":\"%s\","
                       "\"fxFolderUrl\":\"%s\","
                       "\"updaterUiUrl\":\"%s\","
                       "\"fxFolderDate\":\"%s\","
                       "\"utilsDate\":\"%s\","
                       "\"hashesUrl\":\"%s\","
                       "\"selfUpdateUrl\":\"%s\","
                       "\"waterfoxUrl\":\"%s\""
                       "}",
                       utils_url, fx_url, updater_ui_url, esc_fx_date, esc_utils_date,
                       INSTALLER_HASHES_URL, self_update_url, WATERFOX_RELEASES_URL);

    send_json_response(client_fd, json, pos);
    return 0;
}

/**
 * Build identity for the web UI's "test build" banner.  A --local or
 * --mode=dev build reports itself (and, for local, the snapshot directory)
 * so a developer never mistakes a test run for a production installer.
 */
int handle_api_build_info(int client_fd, const char *query, const char *body, size_t body_len) {
    (void)query;
    (void)body;
    (void)body_len;

    char esc_dist[MAX_PATH_LEN * 2], esc_branch[256];
    json_escape(esc_dist, sizeof(esc_dist), INSTALLER_LOCAL_DIST_PATH);
    json_escape(esc_branch, sizeof(esc_branch), INSTALLER_DEV_BRANCH);

    char json[2048];
    int pos = snprintf(json, sizeof(json),
                       "{"
                       "\"isLocal\":%d,"
                       "\"isDev\":%d,"
                       "\"distPath\":\"%s\","
                       "\"devBranch\":\"%s\""
                       "}",
                       INSTALLER_LOCAL ? 1 : 0,
                       INSTALLER_DEV ? 1 : 0,
                       esc_dist,
                       esc_branch);

    send_json_response(client_fd, json, pos);
    return 0;
}

/**
 * Helper: set error state with a message and ensure cleanup.
 */
static void set_install_error(const char *msg) {
    current_state = INSTALL_STATE_ERROR;
    snprintf(state_message, sizeof(state_message), "%s", msg);
    verbose_printf("[install] ERROR: %s\n", msg);
}

/* ---- Compare helper: is every file under src_dir already present with
 * identical bytes under dst_dir?  Used to skip the config copy (and its UAC
 * prompt) when the staged package matches what is already installed. ---- */
typedef struct {
    const char *src_root;
    const char *dst_root;
    int identical;
} TreeCompareCtx;

static int tree_compare_visitor(const char *full_path, void *ctx) {
    TreeCompareCtx *tc = (TreeCompareCtx *)ctx;

    if (path_is_dir(full_path)) {
        walk_dir_entries(full_path, tree_compare_visitor, tc);
        return 0;
    }

    // Destination = dst_root + (full_path minus src_root).
    char rel[MAX_PATH_LEN];
    snprintf(rel, sizeof(rel), "%s", full_path + strlen(tc->src_root));
    if (rel[0] == '/' || rel[0] == '\\') {
        memmove(rel, rel + 1, strlen(rel));
    }
    char dst_path[MAX_PATH_LEN];
    snprintf(dst_path, sizeof(dst_path), "%s%c%s",
             tc->dst_root, PATH_SEPARATOR, rel);

    FILE *a = fopen(full_path, "rb");
    FILE *b = fopen(dst_path, "rb");
    if (!a || !b) {
        if (a) fclose(a);
        if (b) fclose(b);
        tc->identical = 0;
        return 0;
    }
    char buf_a[8192], buf_b[8192];
    for (;;) {
        size_t na = fread(buf_a, 1, sizeof(buf_a), a);
        size_t nb = fread(buf_b, 1, sizeof(buf_b), b);
        if (na != nb || memcmp(buf_a, buf_b, na) != 0) {
            tc->identical = 0;
            break;
        }
        if (na == 0) break;
    }
    fclose(a);
    fclose(b);
    return 0;
}

/** 1 if every file under src_dir exists byte-identical under dst_dir. */
static int tree_identical_to(const char *src_dir, const char *dst_dir) {
    TreeCompareCtx tc = { src_dir, dst_dir, 1 };
    walk_dir_entries(src_dir, tree_compare_visitor, &tc);
    return tc.identical;
}

/* Returns 1 if a TCP listener already accepts connections on 127.0.0.1:port.
 * Because the listener socket uses SO_REUSEADDR, a second installer can bind
 * the same port even while the first runs; probing the port directly is the
 * reliable way to detect an existing instance. */
static int tcp_listening(int port) {
#ifdef _WIN32
    WSADATA wsa;
    if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) return 0;
    SOCKET s = socket(AF_INET, SOCK_STREAM, 0);
    /* -fanalyzer false positive: it models a state where the handle was both
     * created (fd leak / use) and == INVALID_SOCKET — mutually exclusive for
     * winsock's unsigned SOCKET. The valid path is closed below, so suppress.
     * Verify by removing this pragma and running `make analyze`. */
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wanalyzer-fd-leak"
#pragma GCC diagnostic ignored "-Wanalyzer-fd-use-without-check"
    if (s == INVALID_SOCKET) {
        WSACleanup();
        return 0;
    }
    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port = htons((unsigned short)port);
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    int r = (connect(s, (struct sockaddr *)&addr, sizeof(addr)) == 0);
    closesocket(s);
    WSACleanup();
#pragma GCC diagnostic pop
    return r;
#else
    int s = socket(AF_INET, SOCK_STREAM, 0);
    if (s < 0) return 0;
    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port = htons((unsigned short)port);
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    int r = (connect(s, (struct sockaddr *)&addr, sizeof(addr)) == 0);
    close(s);
    return r;
#endif
}

/**
 * Cooperative multitasking status handler.
 * When state is not IDLE, this does ONE chunk of install work per call
 * (download config, extract config, download utils, extract utils, done).
 * Each call advances one step so the server stays responsive to
 * other requests (e.g. status polling from JS UI).
 */
int handle_api_status(int client_fd, const char *query, const char *body, size_t body_len) {
    // /api/status advances the install state machine one step per call, so it
    // must require the session token: a foreign page sending plain GETs could
    // otherwise drive a pending installation even though CORS prevents it from
    // reading the responses.  The UI polls it via fetchJSON, which appends t=.
    if (!request_has_valid_token(query)) {
        const char *err = "{\"error\":\"unauthorized\"}";
        send_json_response(client_fd, err, (int)strlen(err));
        return 0;
    }
    (void)query;
    (void)body;
    (void)body_len;

    if (current_state != INSTALL_STATE_IDLE && current_state != INSTALL_STATE_DONE && current_state != INSTALL_STATE_ERROR) {
        // ---- Do one chunk of work ----
        switch (current_state) {
            case INSTALL_STATE_EXTRACT_CONFIG: {
                size_t zip_len = 0;
                const unsigned char *zip_data = installer_uploaded_zip(0, &zip_len);
                if (!zip_data || zip_len == 0) {
                    set_install_error("Configuration files were not available: the installer tab could "
                                      "not download them. Check your network connection and reload the tab.");
                    break;
                }

                char fx_zip_path[MAX_PATH_LEN];
                snprintf(fx_zip_path, sizeof(fx_zip_path), "%s%cfx-folder.zip", g_work_dir, PATH_SEPARATOR);

                if (save_buf_to_file(fx_zip_path, (const char *)zip_data, zip_len) < 0) {
                    set_install_error("Failed to save downloaded config zip to temp file");
                    break;
                }

                // fx-folder.zip wraps its files under a top-level 'fx-folder'
                // directory (kept for manual downloads).  Extract into a staging
                // dir first (always writable), then copy the flattened tree into
                // the browser dir — admin_copy_tree() self-elevates with a single
                // UAC prompt when the target directory is protected.
                char staging[MAX_PATH_LEN];
                snprintf(staging, sizeof(staging), "%s%cconfig_stage", g_work_dir, PATH_SEPARATOR);
                mkdir_recursive(staging);

                verbose_printf("[install] Extracting config zip to staging %s\n", staging);
                if (extract_zip_flatten(fx_zip_path, staging) < 0) {
                    remove(fx_zip_path);
                    remove_dir_tree(staging);
                    set_install_error("Failed to extract configuration files.");
                    break;
                }
                remove(fx_zip_path);

                // Skip the copy (and its UAC prompt) when the staged config
                // already matches what is installed — a no-op config install
                // must not ask for administrator rights.
                if (tree_identical_to(staging, g_binary_dir)) {
                    verbose_printf("[install] Config already up to date — skipping copy\n");
                    remove_dir_tree(staging);
                    if (install_utils && strlen(g_profile_dir) > 0) {
                        state_progress = 55;
                        current_state = INSTALL_STATE_EXTRACT_UTILS;
                    } else {
                        state_progress = 100;
                        current_state = INSTALL_STATE_DONE;
                    }
                    break;
                }

                verbose_printf("[install] Copying config files to %s\n", g_binary_dir);
                char copy_err[256] = "";
                if (admin_copy_tree(staging, g_binary_dir, copy_err, sizeof(copy_err)) != 0) {
                    remove_dir_tree(staging);
                    set_install_error(copy_err[0] ? copy_err : "Failed to copy configuration files. "
                                                               "The directory may need administrator permissions.");
                    break;
                }
                remove_dir_tree(staging);
                verbose_printf("[install] Config files copied successfully\n");

                // Advance to next step
                if (install_utils && strlen(g_profile_dir) > 0) {
                    state_progress = 55;
                    current_state = INSTALL_STATE_EXTRACT_UTILS;
                } else {
                    state_progress = 100;
                    current_state = INSTALL_STATE_DONE;
                }
                break;
            }
            case INSTALL_STATE_EXTRACT_UTILS: {
                size_t zip_len = 0;
                const unsigned char *zip_data = installer_uploaded_zip(1, &zip_len);
                if (!zip_data || zip_len == 0) {
                    set_install_error("Utility files were not available: the installer tab could "
                                      "not download them. Check your network connection and reload the tab.");
                    break;
                }

                char utils_zip_path[MAX_PATH_LEN];
                snprintf(utils_zip_path, sizeof(utils_zip_path), "%s%cutils.zip", g_work_dir, PATH_SEPARATOR);

                if (save_buf_to_file(utils_zip_path, (const char *)zip_data, zip_len) < 0) {
                    set_install_error("Failed to save downloaded utils zip to temp file");
                    break;
                }

                char chrome_dir[MAX_PATH_LEN];
                snprintf(chrome_dir, sizeof(chrome_dir), "%s%cchrome%cutils", g_profile_dir, PATH_SEPARATOR, PATH_SEPARATOR);
                mkdir_recursive(chrome_dir);

                verbose_printf("[install] Extracting utils zip to %s\n", chrome_dir);
                if (extract_zip(utils_zip_path, chrome_dir) < 0) {
                    remove(utils_zip_path);
                    set_install_error("Failed to extract utility files");
                    break;
                }
                remove(utils_zip_path);

                // Delete obsolete files (shipped in the zip but not part of the
                // installer's canonical file list) so the installed set matches
                // the manifest's `files` list and hash.
                for (int i = 0; i < OBSOLETE_FILES_COUNT; i++) {
                    char obsolete_path[MAX_PATH_LEN];
                    snprintf(obsolete_path, sizeof(obsolete_path), "%s%c%s",
                             chrome_dir, PATH_SEPARATOR, OBSOLETE_FILES[i]);
#ifdef _WIN32
                    WCHAR *wpath = utf8_to_wide(obsolete_path);
                    int gone = wpath && DeleteFileW(wpath);
                    free(wpath);
#else
                    int gone = (remove(obsolete_path) == 0);
#endif
                    if (gone) {
                        verbose_printf("[install] Removed obsolete file %s\n", OBSOLETE_FILES[i]);
                    }
                }

                verbose_printf("[install] Utils extracted successfully\n");

                // updater-ui.zip rides along with utils: the update tab lives
                // in the profile at chrome/utils/updater/ui.  A missing
                // package is skipped silently — the updater self-heals on its
                // next daily check.
                if (installer_has_uploaded_ui_zip()) {
                    char ui_zip_path[MAX_PATH_LEN];
                    snprintf(ui_zip_path, sizeof(ui_zip_path), "%s%cupdater-ui.zip",
                             g_work_dir, PATH_SEPARATOR);
                    size_t ui_len = 0;
                    const unsigned char *ui_data = installer_uploaded_ui_zip(&ui_len);
                    if (ui_data &&
                        save_buf_to_file(ui_zip_path, (const char *)ui_data, ui_len) == 0) {
                        char ui_dir[MAX_PATH_LEN];
                        snprintf(ui_dir, sizeof(ui_dir),
                                 "%s%cchrome%cutils%cupdater%cui",
                                 g_profile_dir, PATH_SEPARATOR, PATH_SEPARATOR,
                                 PATH_SEPARATOR, PATH_SEPARATOR);
                        mkdir_recursive(ui_dir);
                        if (extract_zip(ui_zip_path, ui_dir) < 0) {
                            verbose_printf("[install] Failed to extract updater-ui zip (continuing)\n");
                        } else {
                            verbose_printf("[install] Updater UI extracted successfully\n");
                        }
                        remove(ui_zip_path);
                    }
                }

                state_progress = 100;
                current_state = INSTALL_STATE_DONE;
                break;
            }
            default:
                break;
        }
    }

    // ---- Build status response ----
    const char *step_str;
    int is_terminal = 0;
    switch (current_state) {
        case INSTALL_STATE_IDLE: step_str = "idle"; break;
        case INSTALL_STATE_EXTRACT_CONFIG: step_str = "installing_config"; break;
        case INSTALL_STATE_EXTRACT_UTILS: step_str = "installing_utils"; break;
        case INSTALL_STATE_DONE:
            step_str = "done";
            is_terminal = 1;
            break;
        case INSTALL_STATE_ERROR:
            step_str = "error";
            is_terminal = 1;
            break;
        default: step_str = "unknown"; break;
    }

    // For terminal states, set appropriate messages
    if (current_state == INSTALL_STATE_DONE) {
        snprintf(state_message, sizeof(state_message),
                 "Installation complete. Please restart the browser.");
    }

    char json[1024];
    int pos = snprintf(json, sizeof(json),
                       "{"
                       "\"step\":\"%s\","
                       "\"message\":\"%s\","
                       "\"progress\":%d,"
                       "\"terminal\":%d"
                       "}",
                       step_str, state_message, state_progress, is_terminal);

    send_json_response(client_fd, json, pos);

    // Reset idle after reporting done/error so next status returns idle
    // Refresh the config_installed and utils_installed flags for the
    // browser that was just installed (avoids a full process rescan).
    if (current_state == INSTALL_STATE_DONE || current_state == INSTALL_STATE_ERROR) {
        int refreshed_idx = install_browser_index;
        int done_config = install_config;
        int done_utils = install_utils;
        int install_ok = (current_state == INSTALL_STATE_DONE);
        current_state = INSTALL_STATE_IDLE;
        install_browser_index = -1;
        install_config = 0;
        install_utils = 0;

        if (refreshed_idx >= 0 && refreshed_idx < detected_count) {
            // Record what this install changed so the restart handler can
            // pick the right scope (config => restart the whole binary group,
            // utils => restart only the affected profile).
            if (install_ok) {
                if (done_config) session_installed_config[refreshed_idx] = 1;
                if (done_utils) session_installed_utils[refreshed_idx] = 1;
            }

            // Config files live in the shared binary dir, so a config install
            // affects every profile of that binary.  Refresh the status of ALL
            // detected browsers so sibling profiles don't keep stale flags.
            // refresh_install_status() is presence-only and fast; the
            // up-to-date flags are marked directly below instead of re-hashing
            // (which would spawn certutil per file and block the single-threaded
            // server while the UI is polling).
            for (int i = 0; i < detected_count; i++) {
                refresh_install_status(&detected_browsers[i]);
            }
            if (install_ok) {
                for (int i = 0; i < detected_count; i++) {
                    if (done_config &&
                        strcmp(detected_browsers[i].binary_path,
                               detected_browsers[refreshed_idx].binary_path) == 0) {
                        detected_browsers[i].config_up_to_date = 1;
                    }
                    if (done_utils && i == refreshed_idx) {
                        detected_browsers[i].utils_up_to_date = 1;
                    }
                }
            }
        }
    }

    return 0;
}

int handle_api_install(int client_fd, const char *query, const char *body, size_t body_len) {
    (void)body;
    (void)body_len;
    // State-changing: refuse requests that don't carry this run's session
    // token, so a random local web page cannot trigger an install.
    if (!request_has_valid_token(query)) {
        const char *err = "{\"error\":\"unauthorized\"}";
        send_json_response(client_fd, err, (int)strlen(err));
        return 0;
    }
    // Parse query: browser=N&config=1&utils=1
    int browser_idx = -1;
    int do_config = 0;
    int do_utils = 0;

    if (query) {
        const char *b = strstr(query, "browser=");
        if (b) browser_idx = atoi(b + 8);

        const char *c = strstr(query, "config=");
        if (c) do_config = atoi(c + 7);

        const char *u = strstr(query, "utils=");
        if (u) do_utils = atoi(u + 6);
    }

    // Reject if there's already an install in progress
    if (current_state != INSTALL_STATE_IDLE) {
        const char *err = "{\"error\":\"Install already in progress\"}";
        send_json_response(client_fd, err, (int)strlen(err));
        return 0;
    }

    if (browser_idx < 0 || browser_idx >= detected_count) {
        const char *err = "{\"error\":\"Invalid browser index\"}";
        send_json_response(client_fd, err, (int)strlen(err));
        return 0;
    }

    if (!do_config && !do_utils) {
        const char *err = "{\"error\":\"Nothing selected to install\"}";
        send_json_response(client_fd, err, (int)strlen(err));
        return 0;
    }

    // The package zips are fetched by the browser tab (the C code performs no
    // network I/O).  If the tab could not fetch one of them (offline, Pages
    // host down), refuse to start and tell the user to reload the tab rather
    // than failing mid-install.
    if (do_config && !installer_has_uploaded_zip(0)) {
        const char *err = "{\"error\":\"The config package could not be downloaded. "
                          "Check your network connection and reload the installer tab.\"}";
        send_json_response(client_fd, err, (int)strlen(err));
        return 0;
    }
    if (do_utils && !installer_has_uploaded_zip(1)) {
        const char *err = "{\"error\":\"The utils package could not be downloaded. "
                          "Check your network connection and reload the installer tab.\"}";
        send_json_response(client_fd, err, (int)strlen(err));
        return 0;
    }

    // Save install parameters
    install_browser_index = browser_idx;
    install_config = do_config;
    install_utils = do_utils;

    // Pre-compute paths that stay constant during the install
    char tmp_dir[MAX_PATH_LEN];
    if (get_temp_dir(tmp_dir, sizeof(tmp_dir)) < 0) {
        const char *err = "{\"error\":\"Cannot get temp directory\"}";
        send_json_response(client_fd, err, (int)strlen(err));
        return 0;
    }

    snprintf(g_work_dir, sizeof(g_work_dir), "%s%cfirefox-scripts-install", tmp_dir, PATH_SEPARATOR);
    mkdir_recursive(g_work_dir);

    strncpy(g_binary_dir, detected_browsers[browser_idx].binary_path, MAX_PATH_LEN);
    get_parent_dir(g_binary_dir);
    // Snap installs keep their autoconfig in /etc/firefox, not the read-only
    // /snap/... app dir — fx-folder must be copied there.
    config_dir_for_app_dir(g_binary_dir, g_binary_dir, sizeof(g_binary_dir));

    strncpy(g_profile_dir, detected_browsers[browser_idx].profile_path, MAX_PATH_LEN);

    // Set initial state - the status handler will advance the state machine.
    // The uploaded zip buffers are validated above; extraction reads them.
    if (do_config) {
        current_state = INSTALL_STATE_EXTRACT_CONFIG;
        state_progress = 5;
        snprintf(state_message, sizeof(state_message),
                 "Starting installation for %s...",
                 detected_browsers[browser_idx].identified_browser);
    } else if (do_utils && strlen(g_profile_dir) > 0) {
        current_state = INSTALL_STATE_EXTRACT_UTILS;
        state_progress = 55;
        snprintf(state_message, sizeof(state_message),
                 "Extracting utility files...");
    } else {
        // Nothing meaningful to do
        current_state = INSTALL_STATE_DONE;
        state_progress = 100;
        snprintf(state_message, sizeof(state_message),
                 "Nothing to install for %s",
                 detected_browsers[browser_idx].identified_browser);
    }

    // Acknowledge immediately and return - actual work happens in status poll
    const char *ack = "{\"status\":\"started\"}";
    send_json_response(client_fd, ack, (int)strlen(ack));

    verbose_printf("[install] Install started for %s (config=%d, utils=%d)\n",
                   detected_browsers[browser_idx].identified_browser, do_config, do_utils);

    return 0;
}

int handle_api_self_update(int client_fd, const char *query, const char *body, size_t body_len) {
    // State-changing (stores the self-update payload): require the token.
    if (!request_has_valid_token(query)) {
        const char *err = "{\"error\":\"unauthorized\"}";
        send_json_response(client_fd, err, (int)strlen(err));
        return 0;
    }
    (void)query;

    // POST (body present): store the latest-release JSON the web UI fetched.
    // GET (no body): parse the stored JSON and report the version status.
    if (body && body_len > 0) {
        if (ingest_self_update_json(body, body_len) != 0) {
            const char *err = "{\"error\":\"Could not store self-update payload\"}";
            send_json_response(client_fd, err, (int)strlen(err));
            return 0;
        }
        verbose_printf("[self-update] Stored latest-release JSON (%zu bytes)\n", body_len);
        const char *ok = "{\"ok\":1}";
        send_json_response(client_fd, ok, (int)strlen(ok));
        return 0;
    }

    char latest_version[64] = "";
    char download_url[512] = "";

    int ret = check_self_update(INSTALLER_VERSION,
                                INSTALLER_REPO_OWNER,
                                INSTALLER_REPO_NAME,
                                INSTALLER_BINARY_NAME,
                                latest_version, sizeof(latest_version),
                                download_url, sizeof(download_url));

    char json[1024];
    int pos;

    if (ret < 0) {
        pos = snprintf(json, sizeof(json),
                       "{\"error\":\"Could not check for updates\",\"currentVersion\":\"%s\"}",
                       INSTALLER_VERSION);
    } else if (ret == 0) {
        pos = snprintf(json, sizeof(json),
                       "{\"updateAvailable\":false,\"currentVersion\":\"%s\",\"latestVersion\":\"%s\"}",
                       INSTALLER_VERSION, latest_version);
    } else {
        pos = snprintf(json, sizeof(json),
                       "{\"updateAvailable\":true,\"currentVersion\":\"%s\",\"latestVersion\":\"%s\",\"downloadUrl\":\"%s\"}",
                       INSTALLER_VERSION, latest_version, download_url);
    }

    char header[512];
    int hlen = snprintf(header, sizeof(header),
                        "HTTP/1.0 200 OK\r\n"
                        "Content-Type: application/json\r\n"
                        "Connection: close\r\n"
                        "Content-Length: %d\r\n"
                        "\r\n",
                        pos);

#ifdef _WIN32
    send(client_fd, header, hlen, 0);
    send(client_fd, json, pos, 0);
#else
    (void)write(client_fd, header, (size_t)hlen);
    (void)write(client_fd, json, (size_t)pos);
#endif
    return 0;
}

/* ===== Browser-upload ingest endpoints =====
 * The installer performs no network I/O: the web UI fetches the hash
 * manifest, the package zips, the Waterfox releases list and the installer
 * latest-release JSON from CORS-enabled URLs and POSTs the raw bytes here.
 * Each endpoint stores the payload; the C side re-parses it on demand. */

/**
 * POST /api/manifest — body: hashes.json bytes.
 * Stores + parses the manifest and re-evaluates every browser's status so
 * the UI's up-to-date flags reflect the published hashes.
 */
int handle_api_manifest(int client_fd, const char *query, const char *body, size_t body_len) {
    // State-changing (replaces the package manifest): require the token.
    if (!request_has_valid_token(query)) {
        const char *err = "{\"error\":\"unauthorized\"}";
        send_json_response(client_fd, err, (int)strlen(err));
        return 0;
    }
    (void)query;
    if (!body || body_len == 0) {
        const char *err = "{\"error\":\"Empty manifest upload\"}";
        send_json_response(client_fd, err, (int)strlen(err));
        return 0;
    }
    if (ingest_remote_manifest(body, body_len) != 0) {
        const char *err = "{\"error\":\"Could not parse package manifest\"}";
        send_json_response(client_fd, err, (int)strlen(err));
        return 0;
    }

    // Re-evaluate installed/up-to-date flags for every detected browser now
    // that the published hashes are known (the scan ran before ingest, so it
    // only recorded file presence).  check_package_status() returns the
    // up-to-date state, so installed and up_to_date end up identical here.
    for (int i = 0; i < detected_count; i++) {
        // refresh_install_status_full() sets both the presence-based
        // installed flags and the hash-based up_to_date flags.
        refresh_install_status_full(&detected_browsers[i]);
    }

    const char *ok = "{\"ok\":1}";
    send_json_response(client_fd, ok, (int)strlen(ok));
    return 0;
}

/**
 * POST /api/upload?kind=config|utils — body: raw zip bytes.
 * Stores the package zip so the install state machine can extract it.
 */
int handle_api_upload(int client_fd, const char *query, const char *body, size_t body_len) {
    // State-changing (accepts a package zip): require the token.
    if (!request_has_valid_token(query)) {
        const char *err = "{\"error\":\"unauthorized\"}";
        send_json_response(client_fd, err, (int)strlen(err));
        return 0;
    }
    int is_utils = 0;
    int is_ui = 0;
    if (query) {
        const char *k = strstr(query, "kind=");
        if (k) {
            if (strncmp(k + 5, "utils", 5) == 0) is_utils = 1;
            else if (strncmp(k + 5, "ui", 2) == 0)
                is_ui = 1;
        }
    }
    if (!body || body_len == 0) {
        const char *err = "{\"error\":\"Empty zip upload\"}";
        send_json_response(client_fd, err, (int)strlen(err));
        return 0;
    }
    int stored = is_ui ? installer_set_uploaded_ui_zip(body, body_len)
                       : installer_set_uploaded_zip(is_utils, body, body_len);
    if (stored != 0) {
        const char *err = "{\"error\":\"Failed to store zip\"}";
        send_json_response(client_fd, err, (int)strlen(err));
        return 0;
    }
    const char *kind = is_ui ? "updater-ui" : (is_utils ? "utils" : "config");
    verbose_printf("[upload] Stored %s zip (%zu bytes)\n", kind, body_len);

    char json[256];
    int pos = snprintf(json, sizeof(json),
                       "{\"ok\":1,\"kind\":\"%s\",\"bytes\":%zu}",
                       kind, body_len);
    send_json_response(client_fd, json, pos);
    return 0;
}

/**
 * POST /api/waterfox — body: Waterfox releases JSON bytes.
 * Stores the releases list and re-resolves every Waterfox binary's marketing
 * version from it (overwrites the application.ini fallback).
 */
int handle_api_waterfox(int client_fd, const char *query, const char *body, size_t body_len) {
    // State-changing (stores Waterfox releases): require the token.
    if (!request_has_valid_token(query)) {
        const char *err = "{\"error\":\"unauthorized\"}";
        send_json_response(client_fd, err, (int)strlen(err));
        return 0;
    }
    (void)query;
    if (!body || body_len == 0) {
        const char *err = "{\"error\":\"Empty Waterfox releases upload\"}";
        send_json_response(client_fd, err, (int)strlen(err));
        return 0;
    }
    if (ingest_waterfox_releases(body, body_len) != 0) {
        const char *err = "{\"error\":\"Could not parse Waterfox releases\"}";
        send_json_response(client_fd, err, (int)strlen(err));
        return 0;
    }
    refresh_waterfox_versions(detected_browsers, detected_count);

    const char *ok = "{\"ok\":1}";
    send_json_response(client_fd, ok, (int)strlen(ok));
    return 0;
}

/**
 * POST /api/hg-tags — body: a hg json-rev response for a Firefox Beta /
 * Developer Edition build's SourceStamp commit.  Stores the commit's desktop
 * release-tag version and re-resolves every matching binary's display version
 * (overwrites the application.ini milestone fallback).
 */
int handle_api_hg_tags(int client_fd, const char *query, const char *body, size_t body_len) {
    // State-changing (stores hg tag data): require the token.
    if (!request_has_valid_token(query)) {
        const char *err = "{\"error\":\"unauthorized\"}";
        send_json_response(client_fd, err, (int)strlen(err));
        return 0;
    }
    (void)query;
    if (!body || body_len == 0) {
        const char *err = "{\"error\":\"Empty hg tags upload\"}";
        send_json_response(client_fd, err, (int)strlen(err));
        return 0;
    }
    if (ingest_hg_tags(body, body_len) != 0) {
        const char *err = "{\"error\":\"Could not parse hg tags\"}";
        send_json_response(client_fd, err, (int)strlen(err));
        return 0;
    }
    refresh_firefox_versions(detected_browsers, detected_count);

    const char *ok = "{\"ok\":1}";
    send_json_response(client_fd, ok, (int)strlen(ok));
    return 0;
}

int handle_api_close_browser(int client_fd, const char *query, const char *body, size_t body_len) {
    (void)body;
    (void)body_len;
    // State-changing (kills a browser): require the token.
    if (!request_has_valid_token(query)) {
        const char *err = "{\"error\":\"unauthorized\"}";
        send_json_response(client_fd, err, (int)strlen(err));
        return 0;
    }
    // Parse query: browser=N
    int browser_idx = -1;
    if (query) {
        const char *b = strstr(query, "browser=");
        if (b) browser_idx = atoi(b + 8);
    }

    if (browser_idx < 0 || browser_idx >= detected_count) {
        const char *err = "{\"error\":\"Invalid browser index\"}";
        send_json_response(client_fd, err, (int)strlen(err));
        return 0;
    }

    RunningBrowser *b = &detected_browsers[browser_idx];
    verbose_printf("[close-browser] Killing %s (PID: %lu, exe: %s)\n",
                   b->identified_browser, b->pid, b->exe_name);

#ifdef _WIN32
    // Use up to three kill methods in sequence to handle multi-process browsers.
    DWORD pid_exit = 1, im_exit = 1, ps_exit = 1;

    // 1) Kill by specific PID (most targeted)
    {
        char cmd[512];
        snprintf(cmd, sizeof(cmd), "taskkill /f /pid %lu", (unsigned long)b->pid);
        STARTUPINFOA si = { sizeof(si) };
        PROCESS_INFORMATION pi;
        if (CreateProcessA(NULL, cmd, NULL, NULL, FALSE,
                           CREATE_NO_WINDOW, NULL, NULL, &si, &pi)) {
            WaitForSingleObject(pi.hProcess, 5000);
            GetExitCodeProcess(pi.hProcess, &pid_exit);
            CloseHandle(pi.hProcess);
            CloseHandle(pi.hThread);
        }
        Sleep(500);
    }

    // 2) Kill by image name with process tree
    {
        char cmd[512];
        snprintf(cmd, sizeof(cmd), "taskkill /f /im \"%s\" /t", b->exe_name);
        STARTUPINFOA si = { sizeof(si) };
        PROCESS_INFORMATION pi;
        if (CreateProcessA(NULL, cmd, NULL, NULL, FALSE,
                           CREATE_NO_WINDOW, NULL, NULL, &si, &pi)) {
            WaitForSingleObject(pi.hProcess, 5000);
            GetExitCodeProcess(pi.hProcess, &im_exit);
            CloseHandle(pi.hProcess);
            CloseHandle(pi.hThread);
        }
        Sleep(500);
    }

    // 3) PowerShell backup (kills by any means)
    {
        char cmd[1024];
        snprintf(cmd, sizeof(cmd),
                 "powershell -NoProfile -NonInteractive -Command \"Get-Process %s | Stop-Process -Force\"",
                 b->exe_name);
        STARTUPINFOA si = { sizeof(si) };
        PROCESS_INFORMATION pi;
        if (CreateProcessA(NULL, cmd, NULL, NULL, FALSE,
                           CREATE_NO_WINDOW, NULL, NULL, &si, &pi)) {
            WaitForSingleObject(pi.hProcess, 10000);
            GetExitCodeProcess(pi.hProcess, &ps_exit);
            CloseHandle(pi.hProcess);
            CloseHandle(pi.hThread);
        }
        Sleep(500);
    }

    char json[1024];
    int pos = snprintf(json, sizeof(json),
                       "{\"status\":\"kill_attempted\",\"pid_kill_exit\":%lu,"
                       "\"taskkill_im_exit\":%lu,\"powershell_exit\":%lu,"
                       "\"message\":\"All kill methods completed\"}",
                       pid_exit, im_exit, ps_exit);
    send_json_response(client_fd, json, pos);
#else
    // POSIX: try SIGTERM first (gentle), then pkill -9 (aggressive)
    int sigterm_ret = -1;
    if (kill((pid_t)b->pid, SIGTERM) == 0) {
        sigterm_ret = 0;
        sleep_ms(300);
    }

    char proc_name[256];
    strncpy(proc_name, b->exe_name, sizeof(proc_name) - 1);
    proc_name[sizeof(proc_name) - 1] = '\0';
#ifdef __linux__
    char *dot = strstr(proc_name, ".exe");
    if (dot) *dot = '\0';
#endif
    char pkill_cmd[4096];
    snprintf(pkill_cmd, sizeof(pkill_cmd), "pkill -9 -f \"%s\" 2>/dev/null", proc_name);
    int pkill_ret = system(pkill_cmd);

    char json[512];
    int pos = snprintf(json, sizeof(json),
                       "{\"status\":\"kill_attempted\",\"sigterm_ret\":%d,\"pkill_ret\":%d,\"message\":\"pkill completed\"}",
                       sigterm_ret, pkill_ret);
    send_json_response(client_fd, json, pos);
#endif

    return 0;
}

/**
 * Open a detected browser's application or profile folder in the OS file
 * manager.  Like restart, only honored from a tab carrying the current
 * session token — a stale restored tab (or a random local page) must not be
 * able to probe or open arbitrary local paths.
 */
int handle_api_open_folder(int client_fd, const char *query, const char *body, size_t body_len) {
    (void)body;
    (void)body_len;

    // Require this run's session token (previously only stale tokens were
    // rejected; a missing token must be refused too).
    if (!request_has_valid_token(query)) {
        const char *err = "{\"error\":\"unauthorized\"}";
        send_json_response(client_fd, err, (int)strlen(err));
        return 0;
    }

    int browser_idx = -1;
    int open_profile = 0;
    if (query) {
        const char *b = strstr(query, "browser=");
        if (b) browser_idx = atoi(b + 8);
        const char *k = strstr(query, "kind=");
        if (k && strncmp(k + 5, "profile", 7) == 0) open_profile = 1;
    }

    if (browser_idx < 0 || browser_idx >= detected_count) {
        const char *err = "{\"error\":\"Invalid browser index\"}";
        send_json_response(client_fd, err, (int)strlen(err));
        return 0;
    }

    RunningBrowser *b = &detected_browsers[browser_idx];
    char path[MAX_PATH_LEN];
    if (open_profile) {
        if (strlen(b->profile_path) == 0) {
            const char *err = "{\"error\":\"No profile folder detected\"}";
            send_json_response(client_fd, err, (int)strlen(err));
            return 0;
        }
        strncpy(path, b->profile_path, MAX_PATH_LEN - 1);
        path[MAX_PATH_LEN - 1] = '\0';
    } else {
        if (strlen(b->binary_path) == 0) {
            const char *err = "{\"error\":\"No application folder detected\"}";
            send_json_response(client_fd, err, (int)strlen(err));
            return 0;
        }
        strncpy(path, b->binary_path, MAX_PATH_LEN - 1);
        path[MAX_PATH_LEN - 1] = '\0';
        get_parent_dir(path); /* open the install dir, not the exe file */
    }

    verbose_printf("[open-folder] Opening %s for browser %d\n", path, browser_idx);
    if (open_folder(path) != 0) {
        const char *err = "{\"error\":\"Could not open folder\"}";
        send_json_response(client_fd, err, (int)strlen(err));
        return 0;
    }
    const char *ok = "{\"ok\":1}";
    send_json_response(client_fd, ok, (int)strlen(ok));
    return 0;
}

/**
 * Re-run browser detection and replace the cached list.  Installed/up-to-date
 * flags and the session install tracking are carried over for entries whose
 * binary + profile path still match, so a browser opened after the installer
 * started appears as a fresh card while already-shown cards keep their state.
 */
static void rescan_detected_browsers(void) {
    RunningBrowser fresh[MAX_BROWSERS];
    int fresh_count = scan_and_filter_browsers(fresh, MAX_BROWSERS);

    for (int i = 0; i < fresh_count; i++) {
        for (int j = 0; j < detected_count; j++) {
            if (strcmp(fresh[i].binary_path, detected_browsers[j].binary_path) == 0 &&
                strcmp(fresh[i].profile_path, detected_browsers[j].profile_path) == 0) {
                fresh[i].config_installed = detected_browsers[j].config_installed;
                fresh[i].utils_installed = detected_browsers[j].utils_installed;
                fresh[i].config_up_to_date = detected_browsers[j].config_up_to_date;
                fresh[i].utils_up_to_date = detected_browsers[j].utils_up_to_date;
                session_installed_config[i] = session_installed_config[j];
                session_installed_utils[i] = session_installed_utils[j];
                break;
            }
        }
    }
    // A browser closed this session can no longer be restarted: clear any
    // session tracking past the fresh list.
    for (int i = fresh_count; i < MAX_BROWSERS; i++) {
        session_installed_config[i] = 0;
        session_installed_utils[i] = 0;
    }

    memcpy(detected_browsers, fresh, sizeof(fresh));
    detected_count = fresh_count;
}

/**
 * GET /api/rescan?t=<token> — re-run browser detection so a browser opened
 * after the installer started gets its own card.  Session-token-gated like
 * /api/open-folder and refused while an install is in progress (a reindex
 * would shift the running install's browser index).
 */
int handle_api_rescan(int client_fd, const char *query, const char *body, size_t body_len) {
    (void)body;
    (void)body_len;

    // Require this run's session token (previously only stale tokens were
    // rejected; a missing token must be refused too).
    if (!request_has_valid_token(query)) {
        const char *err = "{\"error\":\"unauthorized\"}";
        send_json_response(client_fd, err, (int)strlen(err));
        return 0;
    }

    if (current_state != INSTALL_STATE_IDLE) {
        const char *err = "{\"error\":\"Install already in progress\"}";
        send_json_response(client_fd, err, (int)strlen(err));
        return 0;
    }

    rescan_detected_browsers();

    // Newly detected browsers were scanned without the remote data that
    // refines versions and hash status, so re-apply everything already
    // ingested (the same refresh handle_api_manifest runs after ingest).
    refresh_waterfox_versions(detected_browsers, detected_count);
    refresh_firefox_versions(detected_browsers, detected_count);
    for (int i = 0; i < detected_count; i++) {
        refresh_install_status_full(&detected_browsers[i]);
    }

    verbose_printf("[rescan] %d browser(s) detected\n", detected_count);
    const char *ok = "{\"ok\":1}";
    send_json_response(client_fd, ok, (int)strlen(ok));
    return 0;
}

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
static void close_browser_by_pid(unsigned long pid, int wait_ms) {
#ifdef _WIN32
    EnumWindows(close_window_enum_proc, (LPARAM)pid);
    wait_close_or_force(pid, wait_ms);
#else
    if (kill((pid_t)pid, SIGTERM) == 0) sleep_ms(300);
#endif
}

/**
 * Gracefully close every process of the given executable image.
 * Used when a config update happened — all instances share the config dir,
 * so they all need to be restarted with a clean cache.
 */
static void close_browser_image(const char *exe_name, int wait_ms) {
#ifdef _WIN32
    wchar_t wexe[MAX_PATH];
    MultiByteToWideChar(CP_UTF8, 0, exe_name, -1, wexe, MAX_PATH);
    DWORD pids[256];
    int npids = 0;
    HANDLE hSnapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (hSnapshot != INVALID_HANDLE_VALUE) {
        PROCESSENTRY32W pe;
        pe.dwSize = sizeof(pe);
        if (Process32FirstW(hSnapshot, &pe)) {
            do {
                if (npids < 256 && _wcsicmp(pe.szExeFile, wexe) == 0)
                    pids[npids++] = pe.th32ProcessID;
            } while (Process32NextW(hSnapshot, &pe));
        }
        CloseHandle(hSnapshot);
    }
    // Ask them all to close, then wait/force each (two phases so multi-instance
    // cases shut down in parallel instead of serially).
    for (int i = 0; i < npids; i++) EnumWindows(close_window_enum_proc, (LPARAM)pids[i]);
    for (int i = 0; i < npids; i++) wait_close_or_force(pids[i], wait_ms);
#else
    (void)exe_name;
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
    pid_t child = fork();
    if (child == 0) {
        setsid();
        if (strlen(b->profile_path) > 0) {
            execl(launch, launch, "-profile", b->profile_path,
                  "-purgecaches", "--new-tab", url, (char *)NULL);
        } else {
            execl(launch, launch, "-purgecaches", "--new-tab", url,
                  (char *)NULL);
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
static void open_url_in_profile(const char *binary, const char *profile, const char *url) {
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

typedef struct {
    int config_changed;
    int ui_host_killed;  // the profile hosting the UI tab is being killed
    char exe_name[MAX_PATH_LEN];
    int restart_idx[MAX_BROWSERS];
    int restart_count;
} restart_plan_t;

static volatile int g_restart_worker_running = 0;

static int do_restart_work(const restart_plan_t *plan) {
    if (plan->config_changed) {
        // Gracefully close every instance of the exe (they all share the config
        // dir).  WM_CLOSE lets Firefox write a valid session store.
        verbose_printf("[restart] Config updated -> closing ALL instances of %s\n",
                       plan->exe_name);
        log_msg("[restart] closing ALL instances of %s\n", plan->exe_name);
        close_browser_image(plan->exe_name, 8000);
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
        strncpy(relaunched_profiles[relaunch_count], rb->profile_path, MAX_PATH_LEN);
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
#endif

int handle_api_restart(int client_fd, const char *query, const char *body, size_t body_len) {
    (void)body;
    (void)body_len;
    // Parse query: browser=N (index of the first browser of the group whose
    // Restart button was clicked).  The server decides the restart scope from
    // what was installed this session for that binary group.
    int browser_idx = -1;
    if (query) {
        const char *b = strstr(query, "browser=");
        if (b) browser_idx = atoi(b + 8);
    }

    // Restart is only honored from a tab carrying the current session token;
    // a stale restored tab must not restart browsers behind the current
    // installer's back.  A missing token is refused too.
    if (!request_has_valid_token(query)) {
        const char *err = "{\"error\":\"unauthorized\"}";
        send_json_response(client_fd, err, (int)strlen(err));
        return 0;
    }

    if (browser_idx < 0 || browser_idx >= detected_count) {
        const char *err = "{\"error\":\"Invalid browser index\"}";
        char header[512];
        int hlen = snprintf(header, sizeof(header),
                            "HTTP/1.0 400 Bad Request\r\n"
                            "Content-Type: application/json\r\n"
                            "Connection: close\r\n"
                            "Content-Length: %zu\r\n"
                            "\r\n",
                            strlen(err));
#ifdef _WIN32
        send(client_fd, header, hlen, 0);
        send(client_fd, err, (int)strlen(err), 0);
#else
        (void)write(client_fd, header, (size_t)hlen);
        (void)write(client_fd, err, strlen(err));
#endif
        return 0;
    }

    RunningBrowser *target = &detected_browsers[browser_idx];
    verbose_printf("[restart] Request for %s (PID: %lu, binary: %s)\n",
                   target->identified_browser, target->pid, target->binary_path);

    // A config install writes to the shared binary dir, so when config was
    // updated for this binary ALL of its browsers need a clean-cache restart.
    int config_changed = 0;
    for (int i = 0; i < detected_count; i++) {
        if (session_installed_config[i] &&
            strcmp(detected_browsers[i].binary_path, target->binary_path) == 0) {
            config_changed = 1;
            break;
        }
    }

    // Build the restart set for this binary.
    int restart_idx[MAX_BROWSERS];
    int restart_count = 0;
    for (int i = 0; i < detected_count; i++) {
        if (strcmp(detected_browsers[i].binary_path, target->binary_path) != 0) continue;
        if (config_changed) {
            restart_idx[restart_count++] = i;
        } else if (session_installed_utils[i]) {
            restart_idx[restart_count++] = i;
        }
    }
    if (restart_count == 0) {
        // No session install recorded (e.g. stale UI) — restart the clicked browser.
        restart_idx[restart_count++] = browser_idx;
    }

    // The browser hosting the installer UI may be in the restart set.  We
    // intentionally do NOT exit the installer in that case: the relaunched
    // browser restores its previous session, which includes the installer UI
    // tab (http://localhost:PORT/).  Keeping the server alive and responsive
    // lets the restored tab reconnect; the installer exits when that tab is
    // closed (beforeunload -> /api/shutdown).

    restart_plan_t plan;
    memset(&plan, 0, sizeof(plan));
    plan.config_changed = config_changed;
    strncpy(plan.exe_name, target->exe_name, MAX_PATH_LEN - 1);
    plan.exe_name[MAX_PATH_LEN - 1] = '\0';
    memcpy(plan.restart_idx, restart_idx, sizeof(int) * (size_t)restart_count);
    plan.restart_count = restart_count;

    // Is the browser hosting the installer UI tab going to be killed?  If so,
    // the tab cannot be left to session restore: depending on
    // browser.startup.page it either never comes back (page=1) or comes back
    // AND gets duplicated by an explicit reopen (page=3).  Instead the tab is
    // told to close itself (window.close()/about:blank), the session token is
    // rotated so any stale restored copy is inert, and the UI is reopened
    // explicitly from the command line after relaunch.
    int ui_host_killed = 0;
    if (g_ui_host_profile[0] != '\0') {
        // Locate the UI host so the check is correct regardless of detection
        // order (the UI opens in the last-used browser, not always index 0).
        int ui_host_idx = -1;
        for (int i = 0; i < detected_count; i++) {
            if (strcmp(detected_browsers[i].profile_path, g_ui_host_profile) == 0) {
                ui_host_idx = i;
                break;
            }
        }
        if (config_changed) {
            // A config change restarts every browser sharing target's binary,
            // so the UI host is killed iff it shares that binary path.
            ui_host_killed =
                ui_host_idx >= 0 &&
                strcmp(detected_browsers[ui_host_idx].binary_path, target->binary_path) == 0;
        } else {
            for (int i = 0; i < restart_count; i++) {
                if (strcmp(detected_browsers[restart_idx[i]].profile_path,
                           g_ui_host_profile) == 0) {
                    ui_host_killed = 1;
                    break;
                }
            }
        }
    }
    plan.ui_host_killed = ui_host_killed;

    if (ui_host_killed) {
        // Old tabs become stale immediately; the worker reopens the NEW URL.
        // Rotate only when the CSPRNG succeeds — the current token is already
        // secure, so a failed rotation must not degrade it.
        if (generate_session_token() == 0) {
            snprintf(g_ui_url, sizeof(g_ui_url), "http://localhost:%d/?t=%s",
                     g_http_port, g_session_token);
            log_msg("[restart] UI host killed; rotated token to %s\n", g_session_token);
        } else {
            log_msg("[restart] UI host killed; CSPRNG unavailable, keeping current token\n");
        }
    }

    log_msg("[restart] request browser=%d config_changed=%d restart_count=%d ui_host_killed=%d\n",
            browser_idx, config_changed, restart_count, ui_host_killed);

    char json[512];
    int pos;
    int async = 0;
#ifdef _WIN32
    if (!g_restart_worker_running) {
        restart_plan_t *heap_plan = (restart_plan_t *)malloc(sizeof(restart_plan_t));
        if (heap_plan) {
            *heap_plan = plan;
            g_restart_worker_running = 1;
            HANDLE h = CreateThread(NULL, 0, restart_worker_thread, heap_plan, 0, NULL);
            if (h) {
                CloseHandle(h);
                async = 1;
            } else {
                g_restart_worker_running = 0;
                free(heap_plan);
            }
        }
    }
#endif

    if (async) {
        // The worker thread performs the close/kill/relaunch/reopen off the
        // server loop.  With ui_host_killed, tell the tab to close itself and
        // hand it the new token so it knows the restart is expected.
        if (ui_host_killed) {
            pos = snprintf(json, sizeof(json),
                           "{\"status\":\"restarted\",\"message\":\"Browser restart initiated\","
                           "\"exiting\":0,\"rotate\":1,\"token\":\"%s\"}",
                           g_session_token);
        } else {
            pos = snprintf(json, sizeof(json),
                           "{\"status\":\"restarted\",\"message\":\"Browser restart initiated\","
                           "\"exiting\":0}");
        }
    } else if (ui_host_killed && g_restart_worker_running) {
        // A restart worker is already running and will reopen the UI; don't
        // act on this second request (and don't leave the UI without a tab).
        pos = snprintf(json, sizeof(json),
                       "{\"status\":\"restarting\",\"message\":\"Restart already in progress\","
                       "\"exiting\":0}");
    } else if (do_restart_work(&plan)) {
        pos = snprintf(json, sizeof(json),
                       "{\"status\":\"restarted\",\"message\":\"Browser restart initiated\","
                       "\"exiting\":0}");
    } else {
        pos = snprintf(json, sizeof(json),
                       "{\"status\":\"error\",\"message\":\"Could not restart browser\"}");
    }

    send_json_response(client_fd, json, pos);
    return 0;
}

// ===== Main =====

static void print_help(void) {
    printf("Firefox Scripts Installer v%s\n\n", INSTALLER_VERSION);
    printf("Usage: installer [OPTIONS]\n\n");
    printf("Options:\n");
    printf("  --help          Show this help message\n");
    printf("  --version       Show version information\n");
    printf("  --verbose       Enable diagnostic output to terminal\n");
    printf("  --log-console   Same as --verbose\n");
    printf("  --test-hash <type> <path> --manifest <file>\n");
    printf("                  Compute SHA256 hash of files in <path> for <type>\n");
    printf("  --test-self-update <json-file> <version> <asset>\n");
    printf("                  Unit-test check_self_update against a release JSON\n");
    printf("                  (type: \"utils\" or \"fx-folder\") using the canonical\n");
    printf("                  file list from <file> (e.g. a dist/prod-*/hashes.json)\n");
    printf("  --smoke-test    Headless mode for CI security smoke tests: run the\n");
    printf("                  HTTP API without aborting on missing browsers or\n");
    printf("                  opening a browser tab; print the session token.\n");
    printf("\nWhen run without options, the installer starts an HTTP server\n");
    printf("and opens a browser-based UI for choosing installation options.\n");
    printf("Use --verbose when running from a terminal to see progress.\n");
}

static int main_impl(int argc, char *argv[]) {
    // Elevation mode: relaunched with admin rights by admin_copy_files() to
    // copy src/dst pairs into a protected directory (single UAC prompt).
    // Must be handled before anything else so the elevated process only
    // copies files and exits.
    if (argc >= 4 && strcmp(argv[1], "--admin-copy") == 0) {
        return admin_copy_mode(argc, argv);
    }

#ifdef _WIN32
    // Attach to parent console so printf works with -mwindows AND Ctrl+C
    // can reach us.  OK if it fails (no parent console).
    BOOL console_attached = AttachConsole(ATTACH_PARENT_PROCESS);
    SetConsoleCtrlHandler(on_ctrl_c, TRUE);
    // Ctrl+C via SetConsoleCtrlHandler only fires when the console delivers
    // CTRL_C_EVENT (cmd.exe, pwsh 7.3+).  PowerShell 5.1 starts native
    // processes in a new process group that never receives the broadcast, so
    // also watch the keyboard while a terminal window has focus.
    if (console_attached) {
        HANDLE hWatch = CreateThread(NULL, 0, ctrl_c_watchdog, NULL, 0, NULL);
        if (hWatch) CloseHandle(hWatch);
    }
#endif

    // Handle flags.  The existing one-shot modes (--help, --test-hash,
    // --test-self-update, --scan-only) still dispatch on argv[1] below; the
    // runtime server flags (--verbose, --smoke-test, --server-only, --port,
    // --env-file) are parsed for EVERY argument so they compose, e.g.
    //   installer --server-only --port 0 --env-file "$TMP/env.json"
    // (the E2E harness combines them freely).
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--verbose") == 0 ||
            strcmp(argv[i], "--log-console") == 0) {
#ifdef _WIN32
            freopen("CONOUT$", "w", stdout);
            freopen("CONOUT$", "w", stderr);
#endif
            g_verbose = 1;
            continue;
        }
        if (strcmp(argv[i], "--smoke-test") == 0) {
            g_smoke_test = 1;
            g_verbose = 1;
            continue;
        }
        if (strcmp(argv[i], "--server-only") == 0) {
            // Test surface: HTTP server without browser scan or UI tab.
            // Implies the smoke rules (never abort on zero browsers).
            g_server_only = 1;
            g_smoke_test = 1;
            g_verbose = 1;
            continue;
        }
        if (strcmp(argv[i], "--port") == 0) {
            if (i + 1 >= argc) {
                fprintf(stderr, "Usage: %s --port <n> (0 = OS-ephemeral)\n", argv[0]);
                return 1;
            }
            char *end = NULL;
            long val = strtol(argv[++i], &end, 10);
            if (!end || *end != '\0' || val < 0 || val > 65535) {
                fprintf(stderr, "Invalid --port value: %s (expected 0-65535)\n", argv[i]);
                return 1;
            }
            g_requested_port = (int)val;
            continue;
        }
        if (strcmp(argv[i], "--env-file") == 0) {
            if (i + 1 >= argc) {
                fprintf(stderr, "Usage: %s --env-file <path>\n", argv[0]);
                return 1;
            }
            strncpy(g_env_file_path, argv[++i], MAX_PATH_LEN - 1);
            g_env_file_path[MAX_PATH_LEN - 1] = '\0';
            continue;
        }
    }

    if (argc > 1) {
        if (strcmp(argv[1], "--help") == 0) {
            print_help();
            return 0;
        }
        if (strcmp(argv[1], "--version") == 0) {
            printf("%s\n", INSTALLER_VERSION);
            return 0;
        }
        if (strcmp(argv[1], "--test-hash") == 0) {
            if (argc < 4) {
                fprintf(stderr, "Usage: %s --test-hash <type> <path> [--manifest <file>]\n", argv[0]);
                return 1;
            }
            const char *type = argv[2];
            const char *dir_path = argv[3];
            const char *manifest_path = NULL;
            if (argc >= 6 && strcmp(argv[4], "--manifest") == 0) {
                manifest_path = argv[5];
            }
            if (!manifest_path) {
                fprintf(stderr,
                        "--test-hash requires --manifest <file> "
                        "(e.g. dist/prod-*/hashes.json)\n");
                return 1;
            }
            if (strcmp(type, "utils") != 0 && strcmp(type, "fx-folder") != 0) {
                fprintf(stderr, "Unknown type: %s (use 'utils' or 'fx-folder')\n", type);
                return 1;
            }
            return (test_hash_from_manifest(type, dir_path, manifest_path) == 0) ? 0 : 1;
        }
        if (strcmp(argv[1], "--test-self-update") == 0) {
            /* Unit-test harness for the self-update logic: ingest a release
             * JSON file, then run check_self_update and print the outcome as
             * parseable lines.  Used by installer/test/test_self_update.mjs
             * (pnpm test:hash). */
            if (argc < 5) {
                fprintf(stderr,
                        "Usage: %s --test-self-update <json-file> <current-version> <asset-name>\n",
                        argv[0]);
                return 2;
            }
            const char *json_path = argv[2];
            const char *cur_ver = argv[3];
            const char *asset_name = argv[4];
            FILE *f = fopen(json_path, "rb");
            if (!f) {
                fprintf(stderr, "Cannot open %s\n", json_path);
                return 2;
            }
            fseek(f, 0, SEEK_END);
            long len = ftell(f);
            fseek(f, 0, SEEK_SET);
            if (len < 0) {
                fclose(f);
                return 2;
            }
            char *buf = (char *)malloc((size_t)len + 1);
            if (!buf) {
                fclose(f);
                return 2;
            }
            size_t rd = fread(buf, 1, (size_t)len, f);
            buf[rd] = '\0';
            fclose(f);
            if (ingest_self_update_json(buf, rd) != 0) {
                free(buf);
                fprintf(stderr, "ingest_self_update_json failed\n");
                return 2;
            }
            free(buf);
            char latest_version[64] = "";
            char download_url[512] = "";
            int ret = check_self_update(cur_ver,
                                        "onemen", "firefox-scripts", asset_name,
                                        latest_version, sizeof(latest_version),
                                        download_url, sizeof(download_url));
            printf("status=%d\n", ret);
            printf("latest_version=%s\n", latest_version);
            printf("download_url=%s\n", download_url);
            return 0;
        }
        if (strcmp(argv[1], "--scan-only") == 0) {
            // Debug helper: run browser detection only, print the result, and
            // exit without network checks, the HTTP server, or the UI.
#ifdef _WIN32
            freopen("CONOUT$", "w", stdout);
            freopen("CONOUT$", "w", stderr);
#endif
            g_verbose = 1;
            detected_count = scan_and_filter_browsers(detected_browsers, MAX_BROWSERS);
            printf("Found %d browser(s):\n", detected_count);
            for (int i = 0; i < detected_count; i++) {
                printf("  %d: %s (PID: %lu)\n",
                       i, detected_browsers[i].identified_browser, detected_browsers[i].pid);
                printf("     Binary: %s\n", detected_browsers[i].binary_path);
                printf("     Version: %s\n",
                       detected_browsers[i].version[0] ? detected_browsers[i].version : "(unknown)");
                if (strlen(detected_browsers[i].profile_path) > 0) {
                    printf("     Profile: %s\n", detected_browsers[i].profile_path);
                }
                printf("     Config: %s, Utils: %s\n",
                       detected_browsers[i].config_installed ? "installed" : "not installed",
                       detected_browsers[i].utils_installed ? "installed" : "not installed");
            }
            return 0;
        }
    }

#if defined(_WIN32)
    // Check for UNC path (\\) — CMD.exe cannot handle UNC as working directory
    {
        char cwd[MAX_PATH_LEN];
        if (GetCurrentDirectoryA(MAX_PATH_LEN, cwd) && cwd[0] == '\\' && cwd[1] == '\\') {
            printf("\nWARNING: Running from a UNC path (\\\\.).\n");
            printf("Windows does not support UNC paths as working directories.\n");
            printf("Please copy this installer to a local drive (e.g. C:\\…) ");
            printf("or use 'net use' to map this path to a drive letter.\n\n");
        }
    }
#endif

    // The installer performs no network I/O: the web UI tab fetches the
    // published packages, the hash manifest and the release lists (CORS-
    // enabled URLs) and POSTs the raw bytes to the local server.  Nothing to
    // verify or prime here — the tab always opens and drives that.
    printf("Firefox Scripts Installer v%s\n", INSTALLER_VERSION);

    // Scan browsers (--server-only skips the scan: headless HTTP-server mode
    // for the second-instance tests, where no browser UI is ever touched).
    if (g_server_only) {
        printf("Server-only mode: skipping browser scan.\n");
        detected_count = 0;
    } else {
        printf("Scanning for running browsers...\n");
        detected_count = scan_and_filter_browsers(detected_browsers, MAX_BROWSERS);
    }

    if (detected_count == 0 && !g_smoke_test) {
        printf("No supported browsers detected.\n");
        printf("Please start Firefox, Waterfox, Zen Browser, LibreWolf, or Floorp and run again.\n");
#ifdef _WIN32
        MessageBoxA(NULL,
                    "No supported browsers detected.\n\n"
                    "Please start Firefox, Zen Browser, Waterfox, LibreWolf, or Floorp and run the installer again.",
                    "Firefox Scripts Installer", MB_OK | MB_ICONINFORMATION);
#elif defined(__APPLE__)
        // On macOS, show a dialog via AppleScript
        system("osascript -e 'display dialog \"No supported browsers detected.\\n\\nPlease start Firefox, Zen Browser, Waterfox, LibreWolf, or Floorp and run the installer again.\" with title \"Firefox Scripts Installer\" buttons {\"OK\"} default button \"OK\"' 2>/dev/null");
#else
        // On Linux, try zenity, then xmessage, then dialog
        {
            int ret = system("zenity --info --title='Firefox Scripts Installer' --text='No supported browsers detected.\n\nPlease start Firefox, Zen Browser, Waterfox, LibreWolf, or Floorp and run the installer again.' 2>/dev/null");
            if (ret != 0) {
                ret = system("xmessage -center -title 'Firefox Scripts Installer' 'No supported browsers detected.\n\nPlease start Firefox, Zen Browser, Waterfox, LibreWolf, or Floorp and run the installer again.' 2>/dev/null");
            }
            if (ret != 0) {
                system("dialog --title 'Firefox Scripts Installer' --msgbox 'No supported browsers detected.\n\nPlease start Firefox, Zen Browser, Waterfox, LibreWolf, or Floorp and run the installer again.' 10 50 2>/dev/null");
            }
        }
#endif
        return 1;
    } else {
        printf("Found %d browser(s):\n", detected_count);
        for (int i = 0; i < detected_count; i++) {
            printf("  %d: %s (PID: %lu)\n",
                   i, detected_browsers[i].identified_browser, detected_browsers[i].pid);
            printf("     Binary: %s\n", detected_browsers[i].binary_path);
            if (strlen(detected_browsers[i].profile_path) > 0) {
                printf("     Profile: %s\n", detected_browsers[i].profile_path);
            }
            printf("     Config: %s, Utils: %s\n",
                   detected_browsers[i].config_installed ? "installed" : "not installed",
                   detected_browsers[i].utils_installed ? "installed" : "not installed");
        }
    }

    // A previous instance may be serving the UI even though our bind would
    // succeed (SO_REUSEADDR).  Detect it up front: open the running server's
    // tab in the default browser and exit quietly instead of running a second
    // server on the same port.  The freshly opened tab is the feedback.
    // Skipped when --port was given: the E2E free-port/no-hijack contract
    // starts several installers on non-default ports, so the default-port
    // probe must not redirect them to somebody else's UI.
    if (g_requested_port < 0 && tcp_listening(DEFAULT_PORT)) {
        printf("A Firefox Scripts Installer is already running; opening its tab.\n");
        char existing_url[128];
        snprintf(existing_url, sizeof(existing_url),
                 "http://localhost:%d/", DEFAULT_PORT);
        // --server-only never touches a browser — the E2E second-instance
        // test relies on this to stay hermetic (no default-browser tab).
        if (!g_server_only) open_browser(existing_url, NULL);
        return 1;
    }

    // Start HTTP server.  The UI tab ALWAYS opens: it is the only component
    // with network access, so even when everything is up-to-date it must run
    // to fetch + ingest the manifest and confirm the status to the user.
    // --port <n> overrides the compiled default; 0 binds an OS-ephemeral port
    // (getsockname reports the actual port, so the UI URL is rebuilt from it).
    int port = http_server_start((unsigned short)(g_requested_port >= 0 ? g_requested_port
                                                                        : DEFAULT_PORT));
    if (port < 0) {
        // Port is already bound by another installer instance.  Instead of
        // dying, open the running server's UI tab in the default browser so
        // the user gets their window back, then exit quietly.  The freshly
        // opened tab (with feedback) is the only notification needed.
        // Name and reconnect on the port actually attempted (--port <n> can
        // differ from the compiled default): another installer instance may
        // be serving exactly that custom port.
        int attempted = g_requested_port >= 0 ? g_requested_port : DEFAULT_PORT;
        printf("Error: Could not start HTTP server (port %d in use).\n", attempted);
        printf("A Firefox Scripts Installer is already running; opening its tab.\n");
        char existing_url[128];
        snprintf(existing_url, sizeof(existing_url),
                 "http://localhost:%d/", attempted);
        // Same hermeticity rule as the pre-bind probe above.
        if (!g_server_only) open_browser(existing_url, NULL);
        return 1;
    }

    g_http_port = port;
    // Fail closed: without a CSPRNG there is no safe way to authenticate the
    // install API, so refuse to start rather than serve with a guessable token.
    if (generate_session_token() != 0) {
        printf("Error: system random number generator unavailable; refusing to start.\n");
        return 1;
    }
    log_msg("[startup] port=%d session_token=%s\n", port, g_session_token);
    if (g_smoke_test) {
        // The smoke test needs the token to prove valid-token requests pass the
        // gate; print it (flushed) so the spawned process can read it.
        printf("SMOKE_TEST_SESSION_TOKEN=%s\n", g_session_token);
        fflush(stdout);
    }
    // Deployment manifest for the E2E harness: written only when --env-file
    // was passed, after the token exists so the record is complete.
    if (g_env_file_path[0] != '\0') {
        write_env_manifest(g_env_file_path, port);
    }

    printf("\nStarting installer UI at http://localhost:%d/\n", port);

    // Register routes
    http_server_register("/", handle_root);
    http_server_register("/style.css", handle_style);
    http_server_register("/script.js", handle_script);
    http_server_register("/favicon.svg", handle_favicon);
    http_server_register("/logos/firefox.png", handle_logo_firefox);
    http_server_register("/logos/waterfox.png", handle_logo_waterfox);
    http_server_register("/logos/zen.png", handle_logo_zen);
    http_server_register("/logos/librewolf.png", handle_logo_librewolf);
    http_server_register("/logos/floorp.png", handle_logo_floorp);
    http_server_register("/api/ping", handle_api_ping);
    http_server_register("/api/build-info", handle_api_build_info);
    http_server_register("/api/claim", handle_api_claim);
    http_server_register("/api/browsers", handle_api_browsers);
    http_server_register("/api/install", handle_api_install);
    http_server_register("/api/status", handle_api_status);
    http_server_register("/api/self-update", handle_api_self_update);
    http_server_register("/api/package-urls", handle_api_package_urls);
    http_server_register("/api/manifest", handle_api_manifest);
    http_server_register("/api/upload", handle_api_upload);
    http_server_register("/api/waterfox", handle_api_waterfox);
    http_server_register("/api/hg-tags", handle_api_hg_tags);
    http_server_register("/api/restart", handle_api_restart);
    http_server_register("/api/close-browser", handle_api_close_browser);
    http_server_register("/api/open-folder", handle_api_open_folder);
    http_server_register("/api/rescan", handle_api_rescan);
    http_server_register("/api/shutdown", handle_api_shutdown);

    // Open browser.  The URL carries this run's session token so the UI can
    // tell current tabs from stale restored tabs of earlier installer runs.
    // Launch it in the FIRST detected profile explicitly: opening with just the
    // exe would let Firefox route the URL to an arbitrary running instance,
    // leaving the tab in a browser that the Restart flow never targets (which
    // is why the restored session had no installer tab).
    snprintf(g_ui_url, sizeof(g_ui_url), "http://localhost:%d/?t=%s", port, g_session_token);
    log_msg("[startup] opening %s\n", g_ui_url);
    if (!g_smoke_test) {
        // E2E diagnostics: echo the detection + launch decision to stdout so
        // installer-e2e.mjs (which inherits this process's stdio) can report
        // why a tab did or did not appear in the test browser.
        printf("[installer] detected %d browser(s):\n", detected_count);
        log_msg("[installer] detected %d browser(s):\n", detected_count);
        for (int i = 0; i < detected_count; i++) {
            printf("  [%d] %s\n      binary: %s\n      profile: %s\n", i,
                   detected_browsers[i].identified_browser,
                   detected_browsers[i].binary_path,
                   detected_browsers[i].profile_path);
            log_msg("  [%d] %s binary: %s profile: %s\n", i,
                    detected_browsers[i].identified_browser,
                    detected_browsers[i].binary_path,
                    detected_browsers[i].profile_path);
        }
        if (detected_count > 0) {
            // Prefer the most recently used browser window over the first
            // detected entry, so with several browsers open the tab lands where
            // the user is actually working instead of an arbitrary instance.
            int ui_host_idx = find_last_used_browser_index(detected_browsers, detected_count);
            if (ui_host_idx < 0) ui_host_idx = 0;
            printf("[installer] opening %s in browser %d (%s)\n", g_ui_url,
                   ui_host_idx, detected_browsers[ui_host_idx].identified_browser);
            log_msg("[installer] opening %s in browser %d (%s)\n", g_ui_url,
                    ui_host_idx, detected_browsers[ui_host_idx].identified_browser);
            // Record which profile hosts the UI tab so the restart worker can
            // reopen the UI there after a restart that kills this browser.
            if (strlen(detected_browsers[ui_host_idx].profile_path) > 0) {
                strncpy(g_ui_host_profile, detected_browsers[ui_host_idx].profile_path, MAX_PATH_LEN - 1);
                g_ui_host_profile[MAX_PATH_LEN - 1] = '\0';
            }
            open_url_in_profile(detected_browsers[ui_host_idx].binary_path,
                                detected_browsers[ui_host_idx].profile_path, g_ui_url);
            // Bring the hosting window to the foreground so the new tab is visible.
            focus_browser_window(detected_browsers[ui_host_idx].pid);
        } else {
            printf("[installer] no browsers detected; falling back to default browser\n");
            log_msg("[installer] no browsers detected; falling back to default browser\n");
            open_browser(g_ui_url, NULL);  // fallback to default browser
        }
        fflush(stdout);  // long-running process: make the E2E diagnostics visible
    }

    printf("Press Ctrl+C to stop the installer.\n");

    // Serve requests
    http_server_serve();

    return 0;
}

int main(int argc, char *argv[]) {
#ifdef _WIN32
    // The CRT's ANSI argv conversion mangles non-ASCII paths on non-UTF-8
    // system codepages (e.g. Hebrew CP1255), which breaks --admin-copy and
    // --test-hash for non-ASCII paths.  Re-parse the real UTF-16 command line
    // and convert to the installer's internal UTF-8 encoding.
    // (main_impl's early returns exit the process, so any unconverted buffer
    // leaks only until process exit.)
    int wargc = 0;
    wchar_t **wargv = CommandLineToArgvW(GetCommandLineW(), &wargc);
    if (wargv && wargc > 0) {
        char **uargv = (char **)calloc((size_t)wargc + 1, sizeof(char *));
        if (uargv) {
            int ok = 1;
            for (int i = 0; i < wargc; i++) {
                uargv[i] = wide_to_utf8(wargv[i]);
                if (!uargv[i]) {
                    ok = 0;
                    break;
                }
            }
            if (ok) {
                int rc = main_impl(wargc, uargv);
                for (int i = 0; i < wargc; i++) free(uargv[i]);
                free(uargv);
                LocalFree(wargv);
                return rc;
            }
            for (int i = 0; i < wargc; i++) free(uargv[i]);
            free(uargv);
        }
        LocalFree(wargv);
    }
#endif
    return main_impl(argc, argv);
}