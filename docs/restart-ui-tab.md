# Installer UI Tab After Browser Restart

How the installer keeps its UI tab alive across the browser restart that finishes an install, and
why it works that way. The restart strategy is recorded as ADR
[0014](./decisions/0014-restart-session-restore.md).

## Problem

The installer runs a local HTTP server and opens a browser tab with its UI at
`http://localhost:8777/?t=<token>`. After installing utils/config it offers a **Restart** button
that closes the target browser and relaunches it with a clean cache. The installer UI tab must come
back after that restart — otherwise the user loses the installer and the server process stays open
forever with no tab to close it.

Firefox has **no `-restore` command-line flag**; a forced session restore is done via the one-shot
pref `browser.sessionstore.resume_session_once = true`, which Firefox clears itself after the next
launch. That is Firefox's own "forced restart" mechanism (see
[SessionStartup.jsm](https://searchfox.org/mozilla-central/source/browser/components/sessionstore/SessionStartup.jsm)).

## How the restart works

Relevant code: `installer/src/main.c` (restart helpers, `handle_api_restart`,
`restart_worker_thread`), `installer/web/script.js` (restart button handler).

### Startup

- The installer serves the UI on the fixed port `DEFAULT_PORT` (8777, from `config/installer.conf`).
  A second installer instance detects the running server (`tcp_listening()`), opens its tab, and
  exits quietly instead of starting a second server.
- The UI tab is opened in the first detected profile explicitly
  (`open_url_in_profile(browsers[0].binary, browsers[0].profile, url)`), so the tab lives in a known
  profile and the restart flow always targets it.
- Each run gets a random 16-hex session token embedded in the URL:
  `http://localhost:8777/?t=<token>`. `/api/claim`, `/api/ping`, `/api/shutdown`, and `/api/restart`
  are token-aware: a tab carrying an old token is a _stale restored tab_ — it shows a "closed"
  placeholder and cannot shut down or restart the current installer.

### Restart (async worker thread, so the HTTP server stays responsive)

1. The server decides whether the profile hosting the installer tab is in the kill set. If yes:
   rotate the session token (the old tab becomes stale immediately), build the new UI URL, and
   respond `{"rotate":1,"token":"<new>"}`.
2. The tab closes itself: `window.close()` (harmless if blocked for non-script-opened tabs), then
   `location.href = 'about:blank'` — `about:blank` tabs are excluded from the saved session, so the
   installer tab is not restored.
3. The worker waits ~1.5 s for the navigation to commit, then **graceful quit**: `EnumWindows` +
   `WM_CLOSE` on every top-level window of the target process(es), wait up to 8 s for exit,
   `taskkill /f /pid X /t` as fallback. `WM_CLOSE` runs Firefox's normal quit path and writes a
   valid `sessionstore.jsonlz4`; `taskkill /F` would make the next launch look like a crash (the
   "Sorry. We're having trouble getting your pages back." tab).
4. For each relaunched profile, write `user_pref("browser.sessionstore.resume_session_once", true);`
   into its `prefs.js` (`set_resume_session_once`) — the one-shot pref that restores the session
   even when `browser.startup.page` is not "restore previous session".
5. Relaunch: the UI-host profile gets
   `firefox --profile <X> -purgecaches --new-tab <http://localhost:8777/?t=<new>>`, other profiles
   get `firefox --profile <X> -purgecaches`. Targeting the profile explicitly prevents the URL from
   being routed to a different running instance.

Result: the user's previous session restores and exactly one installer tab opens on the live server.

## Key Firefox facts (verified)

- There is **no `-restore` flag** in the
  [command-line parameter list](https://firefox-source-docs.mozilla.org/browser/CommandLineParameters.html);
  URL-opening flags are `-url`, `--new-tab`, `--new-window`, `--private-window`.
- Forcing a session restore is done with the one-shot pref
  `browser.sessionstore.resume_session_once` written into `prefs.js` (not `user.js`, which
  re-applies every start and would make the restore permanent).
- `firefox --new-tab about:sessionrestore` only opens the restore-list page; it does not restore by
  itself.
- `taskkill /F` is a crash; `WM_CLOSE` is a clean quit that saves the session.
- `about:blank` / `about:newtab` / `about:home` tabs are not persisted in the saved session.
- Launching a bare URL lets Firefox route it to whichever instance claims it — with multiple
  profiles running, the installer tab could land in the wrong profile. The restart therefore
  launches with `--profile <path>` explicitly.
