# Interactive RDP debugging of core files

The Puppeteer-BiDi E2E harness (ADR 0015) drives web content and the updater tab, but it cannot
reach **browser-chrome**: a `userChrome.js`, `BootstrapLoader.js` or `config.js` failure is
invisible there. For that we use the **debugging-firefox** agent skill (MIT; upstream
[117649/debugging-firefox](https://github.com/117649/debugging-firefox)), vendored at
`.agents/skills/debugging-firefox/` — a dependency-free Node client for Firefox's classic DevTools
RDP (the same hook the Browser Toolbox uses), which evaluates privileged parent-process code and can
install/reload XPIs.

## Install

The skill is vendored in this repo, so hosts that support the
[Agent Skills spec](https://agentskills.io/specification) pick it up automatically. To track
upstream instead of the vendored copy:

```bash
gh skill install 117649/debugging-firefox debugging-firefox
```

Validating: the offline suite is
`node .agents/skills/debugging-firefox/scripts/firefox-rdp.test.mjs` (25 tests, mock server only —
no Firefox needed). The vendored copy is a dev tool, not shipped code; re-sync it deliberately when
upstream moves.

## Quick start — disposable instance

Launch a throwaway Firefox on a temp profile (nothing shared, no user data), then request the RDP
listener separately — the refreshed skill forbids cold-launching with `--start-debugger-server` and
does not authorize `--headless`:

```bash
PROF=$(mktemp -d)
printf '%s\n' \
  'user_pref("devtools.debugger.remote-enabled", true);' \
  'user_pref("devtools.debugger.prompt-connection", false);' \
  'user_pref("devtools.chrome.enabled", true);' \
  > "$PROF/user.js"
firefox --profile "$PROF" &
# once startup has settled, ask the running instance to open the RDP listener
# (same profile → Firefox forwards the flag over its remote command endpoint;
# a --no-remote first instance would have no handler to receive it):
firefox --profile "$PROF" --start-debugger-server 6080
```

Connect, run the capability gate, evaluate, close:

```js
import {FirefoxRdpClient} from './.agents/skills/debugging-firefox/scripts/firefox-rdp.mjs';

const client = new FirefoxRdpClient({port: 6080, timeoutMs: 20_000});
await client.connect(); // gate: greeting → listProcesses → getTarget → console actor
const info = await client.evaluateJson(`JSON.stringify({
  version: Services.appinfo.version,
  profile: Services.dirsvc.get('ProfD', Ci.nsIFile).path,
})`);
console.log(info);
await client.close();
```

## Eval gotchas (from the live pilot, Firefox 154)

- `evaluateJSAsync` already exposes the privileged globals (`Services`, `ChromeUtils`, `Components`,
  `Cc`/`Ci`, `IOUtils`, `PathUtils`). Do **not** `ChromeUtils.importESModule(...)` for them — it
  fails with `Failed to load resource://...`; use the globals directly.
- XPConnect wants explicit IIDs: `Services.dirsvc.get('ProfD', Ci.nsIFile)` — the no-arg form throws
  `Not enough arguments`.
- Results must be serializable — use `evaluateJson` with an expression returning
  `JSON.stringify(...)`; use `pollJson(text, predicate, {timeoutMs})` for async work instead of raw
  timers.
- Escape Windows paths (`\\\\`) inside `evaluate()` strings.

## Cleanup contract

- `client.close()`; terminate only the **profile-matched** process tree and verify the RDP port
  closed; delete the temp profile.
- Never attach to or mutate a pre-existing Firefox/profile; one mutation owner per instance; restore
  everything you changed.
- Before an XPI install or any mutation, read
  `.agents/skills/debugging-firefox/references/live-testing.md` (evidence ladder, restart rules).

## Worked example

The pilot that validated this workflow probed, all read-only on a disposable profile: app identity;
the exact `userChrome.js` FF149 branch computed from `platformVersion` (the
`toggleAttribute`/`setAttribute` split, bug 2008041); and `userChrome.js`'s own `readFile` primitive
against `prefs.js`. The same pattern debugs a missing loader, a broken `BootstrapLoader.js` header
parse, or a `createElement` regression before it reaches CI.

## Boundary

Ordinary webpage automation stays on Puppeteer-BiDi (ADR 0015, `test/e2e/`). RDP is for
browser-chrome and add-on runtime work that BiDi cannot see.
