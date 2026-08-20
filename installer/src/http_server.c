#include "http_server.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdbool.h>

#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
#pragma comment(lib, "ws2_32.lib")
#else
#include <unistd.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <fcntl.h>
typedef int SOCKET;
#define INVALID_SOCKET -1
#define SOCKET_ERROR -1
#define closesocket close
#endif

#include "resources.h"

/* Request-size caps: the browser tab uploads zips and JSON bodies, so the
 * server must be able to receive more than a single recv().  Bounded so a
 * misbehaving client cannot exhaust memory. */
#define MAX_REQUEST_HEADER (64 * 1024)
#define MAX_REQUEST_BODY (4 * 1024 * 1024)

static int recv_some(int client_fd, char *buf, int size) {
#ifdef _WIN32
    return recv(client_fd, buf, size, 0);
#else
    return (int)read(client_fd, buf, (size_t)size);
#endif
}

/** Case-insensitive search for `needle` within the first `limit` bytes. */
static const char *find_header_token(const char *haystack, const char *needle, size_t limit) {
    size_t nlen = strlen(needle);
    if (nlen == 0 || !haystack) return NULL;
    for (const char *p = haystack; (size_t)(p - haystack) + nlen <= limit; p++) {
        size_t i = 0;
        while (i < nlen) {
            char a = p[i];
            char b = needle[i];
            if (a >= 'A' && a <= 'Z') a = (char)(a - 'A' + 'a');
            if (b >= 'A' && b <= 'Z') b = (char)(b - 'A' + 'a');
            if (a != b) break;
            i++;
        }
        if (i == nlen) return p;
    }
    return NULL;
}

static SOCKET server_socket = INVALID_SOCKET;
static volatile bool server_running = false;

static struct {
    char route[MAX_ROUTE_LEN];
    route_handler_t handler;
} routes[MAX_ROUTES];
static int route_count = 0;

void http_server_register(const char *route, route_handler_t handler) {
    if (route_count < MAX_ROUTES) {
        strncpy(routes[route_count].route, route, MAX_ROUTE_LEN - 1);
        routes[route_count].handler = handler;
        route_count++;
    }
}

static route_handler_t find_handler(const char *path, char *query_out, size_t query_size) {
    query_out[0] = '\0';

    // Split path and query string
    char path_copy[MAX_PATH_LEN];
    strncpy(path_copy, path, sizeof(path_copy) - 1);
    path_copy[sizeof(path_copy) - 1] = '\0';

    char *query = strchr(path_copy, '?');
    if (query) {
        *query = '\0';
        query++;
        strncpy(query_out, query, query_size - 1);
        query_out[query_size - 1] = '\0';
    }

    for (int i = 0; i < route_count; i++) {
        if (strcmp(path_copy, routes[i].route) == 0) {
            return routes[i].handler;
        }
    }

    return NULL;
}

static void send_response(int client_fd, int status_code, const char *content_type,
                          const char *body, size_t body_len) {
    char header[512];
    int n;

    // Simple HTTP/1.0 response.  No Access-Control-Allow-Origin header: the UI
    // is served from this same origin, and cross-origin pages must not be able
    // to read installer responses or drive its API (state-changing routes are
    // additionally session-token-gated).
    if (status_code == 200) {
        n = snprintf(header, sizeof(header),
                     "HTTP/1.0 200 OK\r\n"
                     "Content-Type: %s\r\n"
                     "Connection: close\r\n"
                     "Content-Length: %zu\r\n"
                     "\r\n",
                     content_type, body_len);
    } else {
        n = snprintf(header, sizeof(header),
                     "HTTP/1.0 %d Error\r\n"
                     "Content-Type: text/plain\r\n"
                     "Connection: close\r\n"
                     "Content-Length: %zu\r\n"
                     "\r\n",
                     status_code, strlen(body) ? strlen(body) : 0);
    }

#ifdef _WIN32
    send(client_fd, header, n, 0);
    if (body && body_len > 0) {
        send(client_fd, body, (int)body_len, 0);
    }
#else
    (void)write(client_fd, header, (size_t)n);
    if (body && body_len > 0) {
        (void)write(client_fd, body, body_len);
    }
#endif
}

/* Serve a gzip-compressed embedded resource.  The browser transparently
 * decompresses Content-Encoding: gzip, so the UI treats it like the raw
 * asset — this keeps the web UI text and brand logos (~150 KB raw) out of
 * the binary. */
static void send_gz(int client_fd, const char *content_type,
                    const unsigned char *gz, size_t gz_len) {
    char header[512];
    int n = snprintf(header, sizeof(header),
                     "HTTP/1.0 200 OK\r\n"
                     "Content-Type: %s\r\n"
                     "Content-Encoding: gzip\r\n"
                     "Connection: close\r\n"
                     "Content-Length: %zu\r\n"
                     "\r\n",
                     content_type, gz_len);
#ifdef _WIN32
    send(client_fd, header, n, 0);
    if (gz_len > 0) {
        send(client_fd, (const char *)gz, (int)gz_len, 0);
    }
#else
    (void)write(client_fd, header, (size_t)n);
    if (gz_len > 0) {
        (void)write(client_fd, gz, gz_len);
    }
#endif
}

#if INSTALLER_LOCAL
/** Content type for a local snapshot file, guessed from its extension. */
static const char *local_content_type(const char *path) {
    const char *dot = strrchr(path, '.');
    if (!dot) return "application/octet-stream";
    if (strcmp(dot, ".zip") == 0) return "application/zip";
    if (strcmp(dot, ".png") == 0) return "image/png";
    if (strcmp(dot, ".svg") == 0) return "image/svg+xml; charset=utf-8";
    if (strcmp(dot, ".html") == 0) return "text/html; charset=utf-8";
    if (strcmp(dot, ".json") == 0) return "application/json; charset=utf-8";
    if (strcmp(dot, ".js") == 0) return "application/javascript; charset=utf-8";
    if (strcmp(dot, ".css") == 0) return "text/css; charset=utf-8";
    return "application/octet-stream";
}

/**
 * Serve <exe_dir>/<path> for local-test builds (upload:local).  The snapshot
 * ships zips (utils, fx-folder, updater-ui), hashes.json and helper binaries
 * next to the installer exe, so the web UI and the in-browser updater fetch
 * them from http://localhost:DEFAULT_PORT/ with no GitHub involved.
 * Exact-match routes (the embedded UI and every /api/*) win; this is only the
 * fallback.
 */
static void serve_local_file(int client_fd, const char *path) {
    if (!path || strstr(path, "..") != NULL) {
        send_response(client_fd, 404, "text/plain", "Not Found", 9);
        return;
    }

    char rel[MAX_PATH_LEN];
    snprintf(rel, sizeof(rel), "%s", path);
    char *q = strchr(rel, '?');
    if (q) *q = '\0';
    const char *base = (rel[0] == '/') ? rel + 1 : rel;
    if (base[0] == '\0' || strncmp(base, "api/", 4) == 0) {
        send_response(client_fd, 404, "text/plain", "Not Found", 9);
        return;
    }

    char dir[MAX_PATH_LEN];
    if (installer_own_dir(dir, sizeof(dir)) != 0) {
        send_response(client_fd, 500, "text/plain", "Internal Error", 14);
        return;
    }
    char full[MAX_PATH_LEN];
    path_join(dir, base, full, sizeof(full));

#ifdef _WIN32
    WCHAR *wfull = utf8_to_wide(full);
    FILE *f = wfull ? _wfopen(wfull, L"rb") : NULL;
    free(wfull);
#else
    FILE *f = fopen(full, "rb");
#endif
    if (!f) {
        send_response(client_fd, 404, "text/plain", "Not Found", 9);
        return;
    }

    fseek(f, 0, SEEK_END);
    long sz = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (sz < 0 || sz > MAX_REQUEST_BODY) {
        fclose(f);
        send_response(client_fd, 500, "text/plain", "File Too Large", 14);
        return;
    }
    char *buf = (char *)malloc((size_t)sz + 1);
    if (!buf) {
        fclose(f);
        send_response(client_fd, 500, "text/plain", "Out of Memory", 13);
        return;
    }
    size_t rd = fread(buf, 1, (size_t)sz, f);
    fclose(f);
    if (rd != (size_t)sz) {
        free(buf);
        send_response(client_fd, 500, "text/plain", "Read Error", 10);
        return;
    }
    send_response(client_fd, 200, local_content_type(full), buf, (size_t)sz);
    free(buf);
}
#endif /* INSTALLER_LOCAL */

int http_server_start(unsigned short preferred_port) {
#ifdef _WIN32
    WSADATA wsa;
    int wsa_err = WSAStartup(MAKEWORD(2, 2), &wsa);
    if (wsa_err != 0) {
        fprintf(stderr, "WSAStartup failed: %d\n", wsa_err);
        return -1;
    }
#endif

    server_socket = socket(AF_INET, SOCK_STREAM, 0);
    if (server_socket == INVALID_SOCKET) {
#ifdef _WIN32
        fprintf(stderr, "socket() failed: WSAGetLastError=%d\n", WSAGetLastError());
        WSACleanup();
#endif
        return -1;
    }

    int optval = 1;
    setsockopt(server_socket, SOL_SOCKET, SO_REUSEADDR, (const char *)&optval, sizeof(optval));

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = inet_addr("127.0.0.1");
    addr.sin_port = htons(preferred_port);

    if (bind(server_socket, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
#ifdef _WIN32
        fprintf(stderr, "bind() failed: WSAGetLastError=%d\n", WSAGetLastError());
#endif
        closesocket(server_socket);
        server_socket = INVALID_SOCKET;
#ifdef _WIN32
        WSACleanup();
#endif
        return -1;
    }

    // Get actual port
    socklen_t addr_len = sizeof(addr);
    if (getsockname(server_socket, (struct sockaddr *)&addr, &addr_len) == 0) {
        int actual_port = ntohs(addr.sin_port);

        if (listen(server_socket, 32) < 0) {
#ifdef _WIN32
            fprintf(stderr, "listen() failed: WSAGetLastError=%d\n", WSAGetLastError());
#endif
            closesocket(server_socket);
            server_socket = INVALID_SOCKET;
#ifdef _WIN32
            WSACleanup();
#endif
            return -1;
        }

        server_running = true;
        return actual_port;
    } else {
#ifdef _WIN32
        fprintf(stderr, "getsockname() failed: WSAGetLastError=%d\n", WSAGetLastError());
#endif
    }

    closesocket(server_socket);
    server_socket = INVALID_SOCKET;
#ifdef _WIN32
    WSACleanup();
#endif
    return -1;
}

void http_server_serve(void) {
    if (!server_running) return;

    while (server_running) {
        struct sockaddr_in client_addr;
        socklen_t client_len = sizeof(client_addr);

#ifdef _WIN32
        SOCKET client_fd = accept(server_socket, (struct sockaddr *)&client_addr, &client_len);
#else
        int client_fd = accept(server_socket, (struct sockaddr *)&client_addr, &client_len);
#endif

        if (client_fd == INVALID_SOCKET) {
            if (server_running) {
                sleep_ms(100);
            }
            continue;
        }

        // Read the full request: header block (terminated by a blank line)
        // plus any POST body.  Bodies are binary (zip bytes), so the read
        // loop is bounded by Content-Length, not by NUL bytes.
        size_t req_cap = 8192;
        size_t req_len = 0;
        char *req = (char *)malloc(req_cap);
        const char *body = NULL;
        size_t body_len = 0;
        int req_status = 0; /* 1 = complete+parsed, -1 = request too large, 0 = incomplete/closed */

        if (req) {
            for (;;) {
                if (req_len + 1 >= req_cap) {
                    if (req_cap >= MAX_REQUEST_HEADER + MAX_REQUEST_BODY) {
                        req_status = -1;
                        break;
                    }
                    size_t nc = req_cap * 2;
                    if (nc > MAX_REQUEST_HEADER + MAX_REQUEST_BODY) nc = MAX_REQUEST_HEADER + MAX_REQUEST_BODY;
                    char *nr = (char *)realloc(req, nc);
                    if (!nr) {
                        req_status = -1;
                        break;
                    }
                    req = nr;
                    req_cap = nc;
                }
                int n = recv_some(client_fd, req + req_len, (int)(req_cap - req_len - 1));
                if (n <= 0) break; /* client closed or error */
                req_len += (size_t)n;
                req[req_len] = '\0';

                // Locate the end of the header block ("\r\n\r\n", tolerating bare "\n\n").
                const char *he = strstr(req, "\r\n\r\n");
                size_t he_off;
                int he_extra;
                if (he) {
                    he_off = (size_t)(he - req);
                    he_extra = 4;
                } else {
                    he = strstr(req, "\n\n");
                    if (!he) continue;
                    he_off = (size_t)(he - req);
                    he_extra = 2;
                }
                if (he_off > MAX_REQUEST_HEADER) {
                    req_status = -1;
                    break;
                }

                // Parse Content-Length (case-insensitive header scan).
                size_t content_length = 0;
                const char *p = req;
                for (;;) {
                    const char *cl = find_header_token(p, "content-length:", he_off - (size_t)(p - req));
                    if (!cl || (size_t)(cl - req) >= he_off) break;
                    cl += strlen("content-length:");
                    while (*cl == ' ' || *cl == '\t') cl++;
                    content_length = 0;
                    while (*cl >= '0' && *cl <= '9') {
                        if (content_length < MAX_REQUEST_BODY / 10) {
                            content_length = content_length * 10 + (size_t)(*cl - '0');
                        }
                        cl++;
                    }
                    p = cl;
                }

                if (content_length > MAX_REQUEST_BODY) {
                    req_status = -1;
                    break;
                }
                size_t expected = he_off + (size_t)he_extra + content_length;
                if (req_len >= expected) {
                    body = req + he_off + (size_t)he_extra;
                    body_len = content_length;
                    req_status = 1;
                    break;
                }
                // Headers complete but the body is still arriving — keep reading.
            }
        }

        if (req_status == 1) {
            // Parse first line: "GET /path HTTP/1.0"
            char method[16], path[MAX_PATH_LEN];
            if (sscanf(req, "%15s %1023s", method, path) == 2) {
                log_msg("[http] %s %s (%zu body bytes)\n", method, path, body_len);
                if (strcmp(method, "GET") == 0 || strcmp(method, "POST") == 0) {
                    char query[MAX_PATH_LEN];
                    route_handler_t handler = find_handler(path, query, sizeof(query));

                    if (handler) {
                        handler(client_fd, query, body, body_len);
                    } else {
#if INSTALLER_LOCAL
                        // Local-test build: serve unmatched paths from the
                        // snapshot dir next to the exe (zips, hashes.json,
                        // updater.html, logos/, helper binaries).
                        serve_local_file(client_fd, path);
#else
                        send_response(client_fd, 404, "text/plain", "Not Found", 9);
#endif
                    }
                } else {
                    send_response(client_fd, 405, "text/plain", "Method Not Allowed", 18);
                }
            } else {
                send_response(client_fd, 400, "text/plain", "Bad Request", 11);
            }
        } else if (req_status == -1) {
            send_response(client_fd, 413, "text/plain", "Request Too Large", 18);
        }
        free(req);

#ifdef _WIN32
        closesocket(client_fd);
#else
        close(client_fd);
#endif
    }
}

void http_server_stop(void) {
    server_running = false;
    if (server_socket != INVALID_SOCKET) {
        closesocket(server_socket);
        server_socket = INVALID_SOCKET;
    }
#ifdef _WIN32
    WSACleanup();
#endif
}

// Route handlers - these reference resources.h for embedded web files

int handle_root(int client_fd, const char *query, const char *body, size_t body_len) {
    (void)query;
    (void)body;
    (void)body_len;
    send_gz(client_fd, "text/html; charset=utf-8", RES_INDEX_HTML_GZ, sizeof(RES_INDEX_HTML_GZ));
    return 0;
}

int handle_style(int client_fd, const char *query, const char *body, size_t body_len) {
    (void)query;
    (void)body;
    (void)body_len;
    send_gz(client_fd, "text/css; charset=utf-8", RES_STYLE_CSS_GZ, sizeof(RES_STYLE_CSS_GZ));
    return 0;
}

int handle_script(int client_fd, const char *query, const char *body, size_t body_len) {
    (void)query;
    (void)body;
    (void)body_len;
    send_gz(client_fd, "application/javascript; charset=utf-8", RES_SCRIPT_JS_GZ, sizeof(RES_SCRIPT_JS_GZ));
    return 0;
}

/* Asset handler for a fixed embedded resource served as image/svg+xml. */
#define DEFINE_SVG_HANDLER(name, resource)                                          \
    int name(int client_fd, const char *query, const char *body, size_t body_len) { \
        (void)query;                                                                \
        (void)body;                                                                 \
        (void)body_len;                                                             \
        send_response(client_fd, 200, "image/svg+xml; charset=utf-8", resource,     \
                      strlen(resource));                                            \
        return 0;                                                                   \
    }

DEFINE_SVG_HANDLER(handle_favicon, RES_FAVICON_SVG)

/* Asset handler for a gzip-compressed embedded resource (see send_gz). */
#define DEFINE_GZ_HANDLER(name, content_type, gz_resource)                          \
    int name(int client_fd, const char *query, const char *body, size_t body_len) { \
        (void)query;                                                                \
        (void)body;                                                                 \
        (void)body_len;                                                             \
        send_gz(client_fd, content_type, gz_resource, sizeof(gz_resource));         \
        return 0;                                                                   \
    }

DEFINE_GZ_HANDLER(handle_logo_firefox, "image/png", RES_LOGO_FIREFOX_GZ)
DEFINE_GZ_HANDLER(handle_logo_waterfox, "image/png", RES_LOGO_WATERFOX_GZ)
DEFINE_GZ_HANDLER(handle_logo_zen, "image/png", RES_LOGO_ZEN_GZ)
DEFINE_GZ_HANDLER(handle_logo_librewolf, "image/png", RES_LOGO_LIBREWOLF_GZ)
DEFINE_GZ_HANDLER(handle_logo_floorp, "image/png", RES_LOGO_FLOORP_GZ)

int handle_api_shutdown(int client_fd, const char *query, const char *body, size_t body_len) {
    (void)body;
    (void)body_len;
    // Only honor shutdown from a tab carrying the CURRENT session token.  A
    // stale tab from a previous run — or a random local web page — must not be
    // able to kill the current installer when it is closed, so a missing or
    // mismatched token is ignored.
    const char *current = installer_session_token();
    if (!query || !current) {
        const char *ignored = "{\"status\":\"ignored\"}";
        send_response(client_fd, 200, "application/json; charset=utf-8",
                      ignored, (int)strlen(ignored));
        return 0;
    }
    {
        const char *t = strstr(query, "t=");
        if (!t || (t != query && t[-1] != '&') || strcmp(t + 2, current) != 0) {
            const char *ignored = "{\"status\":\"ignored\"}";
            send_response(client_fd, 200, "application/json; charset=utf-8",
                          ignored, (int)strlen(ignored));
            return 0;
        }
    }
    log_msg("[shutdown] requested\n");
    // Send a minimal JSON response acknowledging shutdown,
    // then stop the server so the process exits after serving this request.
    const char *resp = "{\"status\":\"shutting_down\"}";
    int resp_len = (int)strlen(resp);
    send_response(client_fd, 200, "application/json; charset=utf-8", resp, (size_t)resp_len);

    // Stop the server loop — the process will exit after this request completes.
    server_running = false;
    if (server_socket != INVALID_SOCKET) {
        closesocket(server_socket);
        server_socket = INVALID_SOCKET;
    }
    return 0;
}

// handle_api_* functions are defined in main.c and declared in http_server.h