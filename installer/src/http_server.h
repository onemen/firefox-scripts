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
int handle_api_ping(int client_fd, const char *query, const char *body, size_t body_len);
int handle_api_build_info(int client_fd, const char *query, const char *body, size_t body_len);
int handle_api_claim(int client_fd, const char *query, const char *body, size_t body_len);
int handle_api_browsers(int client_fd, const char *query, const char *body, size_t body_len);
int handle_api_install(int client_fd, const char *query, const char *body, size_t body_len);
int handle_api_status(int client_fd, const char *query, const char *body, size_t body_len);
int handle_api_self_update(int client_fd, const char *query, const char *body, size_t body_len);
int handle_api_restart(int client_fd, const char *query, const char *body, size_t body_len);
int handle_api_close_browser(int client_fd, const char *query, const char *body, size_t body_len);
int handle_api_open_folder(int client_fd, const char *query, const char *body, size_t body_len);
int handle_api_rescan(int client_fd, const char *query, const char *body, size_t body_len);
int handle_api_shutdown(int client_fd, const char *query, const char *body, size_t body_len);

// Browser-upload ingest endpoints (implemented in main.c).  The web UI does
// all network fetching (CORS-enabled URLs) and POSTs the raw bytes here.
// /api/self-update doubles as an ingest endpoint: a POST (body present)
// stores the latest-release JSON, a GET parses it.
int handle_api_manifest(int client_fd, const char *query, const char *body, size_t body_len);
int handle_api_upload(int client_fd, const char *query, const char *body, size_t body_len);
int handle_api_waterfox(int client_fd, const char *query, const char *body, size_t body_len);

// Current installer session token (defined in main.c).
const char *installer_session_token(void);

#endif /* HTTP_SERVER_H */