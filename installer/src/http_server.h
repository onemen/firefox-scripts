#ifndef HTTP_SERVER_H
#define HTTP_SERVER_H

#include "platform.h"

#define MAX_ROUTES 32
#define MAX_ROUTE_LEN 64

typedef int (*route_handler_t)(int client_fd, const char *query_string,
                               const char *body, size_t body_len);

/**
 * Start the HTTP server on the specified port (0 = random available port)
 * Returns the actual port on success, -1 on failure
 */
int http_server_start(unsigned short preferred_port);

/**
 * Register a route handler
 */
void http_server_register(const char *route, route_handler_t handler);

/**
 * Main server loop - serves requests until http_server_stop() is called
 */
void http_server_serve(void);

/**
 * Stop the server
 */
void http_server_stop(void);

/**
 * Override the per-connection read deadlines (idle recv timeout, total
 * per-request read bound), in milliseconds. Values <= 0 keep the current
 * setting. Intended for the smoke-test harness only — production always runs
 * with the defaults from http_server.c.
 */
void http_server_set_timeouts(int recv_timeout_ms, int request_total_timeout_ms);

// Route handlers (implemented in http_server.c, referenced in main.c)
int handle_root(int client_fd, const char *query, const char *body, size_t body_len);
int handle_style(int client_fd, const char *query, const char *body, size_t body_len);
int handle_script(int client_fd, const char *query, const char *body, size_t body_len);
int handle_favicon(int client_fd, const char *query, const char *body, size_t body_len);
int handle_logo_firefox(int client_fd, const char *query, const char *body, size_t body_len);
int handle_logo_waterfox(int client_fd, const char *query, const char *body, size_t body_len);
int handle_logo_zen(int client_fd, const char *query, const char *body, size_t body_len);
int handle_logo_librewolf(int client_fd, const char *query, const char *body, size_t body_len);
int handle_logo_floorp(int client_fd, const char *query, const char *body, size_t body_len);
int handle_api_shutdown(int client_fd, const char *query, const char *body, size_t body_len);

// Current installer session token (defined in main.c).
const char *installer_session_token(void);

// One query parameter's value, byte-exact (audit 2026-10-06, P1-9 / #445).
// `query` is the raw query string without the leading '?': the name must
// match in full and the value ends at '&' or the end of the string, so t=
// need not be the last parameter and xt= is not t=. Returns 1 only when the
// parameter exists and equals `value`; a missing/empty query never matches.
int query_param_equals(const char *query, const char *name, const char *value);

// Generic HTTP response writer (defined in http_server.c). Every handler,
// including those in main.c, answers through this — non-200 statuses are how
// a refused request is surfaced (403 from the Host/Origin check and from the
// manifest-verification rejections).
void send_response(int client_fd, int status_code, const char *content_type,
                   const char *body, size_t body_len);

#endif /* HTTP_SERVER_H */
