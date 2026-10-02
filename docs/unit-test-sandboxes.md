# Unit-test sandboxes (running privileged modules without a browser)

A handful of unit suites test `core/chrome/utils/updater/scriptsUpdater.sys.mjs` — a Firefox
privileged ESM — by **evaluating its source inside `node:vm`** instead of importing it. This page is
the how-and-why, so a new suite reuses the existing pieces instead of growing its own slightly
different fakes. (The leaf-helper suites — `hashUtils`, `createZip`, browsers/downloads, the C
installer — are plain Node tests and need none of this.)

## Why not just import the module?

`scriptsUpdater.sys.mjs` is loaded by the browser as a privileged module: it reaches for `Services`,
`ChromeUtils`, `Cc`/`Ci`, `PathUtils`, `IOUtils`, plus the generated `chrome://` config. Node has
none of those. Importing it would fail on the first one. Running the real source in a fake global
context keeps the test measuring **the shipped code** (not a re-implementation) while letting a test
drive states a browser cannot be talked into on demand: a mid-teardown tab, a missing SessionStore,
a dead driver realm, a wedged manifest host.

## The shape of a sandbox suite

1. Read the source, normalize CRLF, strip `export ` (`vm` runs it as a classic script):

   ```
   const source = fs
     .readFileSync(MODULE_PATH, 'utf-8')
     .replace(/\r\n/g, '\n')
     .replace(/^export /gm, '');
   ```

2. Build a `sandbox` object holding the fakes (`ChromeUtils`, `Services`, `Cc`, `Ci`, `PathUtils`,
   `IOUtils`, `console`, `TextEncoder`, …). Two of them are load-bearing enough to be shared — see
   [test/shared/sandboxServices.mjs](../test/shared/sandboxServices.mjs):

   - **`Services.vc.compare`** (`comparePlatformVersions`). The module calls it **at load time**:
     `isVersion('156.0a1')` picks the SessionStore spec (`moz-src://` from 156.0a1,
     `resource:///modules` before it). The stub only orders version _heads_ and throws on a
     non-numeric version rather than guessing.
   - **`ChromeUtils.defineESModuleGetters`** → `resolveSandboxLazyModule(name, spec)`. This is ONE
     place that knows the module's lazy set (SessionStore, Downloads), so a lazy module the suite
     does not know about throws here instead of silently arriving `undefined` — the failure mode
     that hid the version-conditional import across four harnesses. `Timer` is deliberately left to
     each suite, because suites instrument their timers (record them, fire one tick).

   ```
   ChromeUtils: {
     defineESModuleGetters: (target, getters) => {
       for (const [name, spec] of Object.entries(getters)) {
         target[name] =
           String(spec).includes('Timer') ? cb => setTimeout(cb, 0)
           : resolveSandboxLazyModule(name, spec, {onForgetClosedTab: …});
       }
     },
     importESModule(spec) { … }, // the generated CONFIG only
   },
   Services: {prefs, appinfo, vc: {compare: comparePlatformVersions}, wm, obs, …},
   ```

3. Evaluate:
   `vm.runInContext(source, vm.createContext(sandbox), {filename: 'scriptsUpdater.sys.mjs'})`.
   Module-scope code runs here — that is why the load-time `vc.compare` call must be answered before
   this line, and why the getter stubs are wired in the same step.

4. Drive the module through its **entry points** (`initScriptsUpdater(win)`, `checkForUpdates()`),
   not by reaching into its internals: the exports are functions on the sandbox global, and
   everything else stays private (which is what keeps the suite honest about the public surface).

## When each shared stub runs

| Stub                                                | Called at                                  | Called by                                                                                                                                                                              |
| --------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `comparePlatformVersions`                           | sandbox evaluation (module load)           | `isVersion('156.0a1')` in the lazy-getter block                                                                                                                                        |
| `resolveSandboxLazyModule` → `makeSessionStoreStub` | sandbox evaluation, once per getter        | `ChromeUtils.defineESModuleGetters`                                                                                                                                                    |
| `makeSessionStoreStub().promiseAllWindowsRestored`  | first `checkForUpdates()`                  | `sessionRestoredWait()` (the restore gate)                                                                                                                                             |
| `…getClosedTabDataForWindow` / `…forgetClosedTab`   | when a restored/duplicate tab is forgotten | `forgetUpdaterTab()`                                                                                                                                                                   |
| `resolveSandboxLazyModule` → `makeDownloadsStub`    | sandbox evaluation                         | the same getter block; `fetch` throws by design (no network in a sandbox, and `ensureUpdaterUi` degrades to "keep the installed UI", which is the real behavior for a missing package) |

Sandboxes are built **fresh per test** (`loadUpdater()` per test case), so no test can leak state
into another: each gets its own module instance, `Services`, windows and timer recordings.

## Deterministic time

Timers are captured, never awaited: `makeCc()`'s `@mozilla.org/timer;1` stub records every
`initWithCallback(cb, delay, type)` and exposes `fire()` (which invokes the callback the way a real
`nsITimer` would). A test therefore fires _exactly_ the timer it means — `selectWhenLoaded`'s 10 s
fallback, never the fetch `withTimeout` (firing that one resolves the manifest await as a
rejection). The attach block's restore wait is driven by the `sessionstore-windows-restored` event,
which the suite notifies explicitly instead of waiting for a timer to come around.

## Coverage split with the E2E suites

The sandbox suites are the deterministic half of a two-layer story:

| Layer                                              | Runs in                           | Best at                                                                                                                                                                                                              |
| -------------------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/**` (vm sandboxes)                      | Node, no browser                  | decision logic and failure branches: hashes, the daily gate, the attach branches (restored-tab replacement, selection, MRU window), channel fallback, mid-teardown tabs, a dead driver realm — milliseconds per case |
| `test/e2e/**` (see [e2e-tests.md](./e2e-tests.md)) | real Firefox via puppeteer + BiDi | everything browser-only: real `Services.vc`, real SessionStore notifications, real session restore, real installs                                                                                                    |

Neither layer may be assumed to cover the other. A stub is a claim about the browser, and the claim
belongs in an E2E assertion: the version-conditional SessionStore spec is pinned in the sandbox at
140.0 / 156.0a1 / 159.0a1, while the E2E legs prove a real engine actually resolves it (Nightly
resolves `moz-src://`; ESR 140 resolves `resource:///modules`), and scenario 11 asserts that a real
SessionStore restore ends with exactly one updater tab.

## Adding a new sandbox suite

1. Copy the harness shape from an existing suite (`scriptsUpdater-tab-attach.test.mjs` is the most
   complete: prefs/IO/nsIFile/Cc fakes, a fake browser window, `waitFor`).
2. Wire `Services.vc`/`defineESModuleGetters` through `test/shared/sandboxServices.mjs`.
3. Seed real temp fixtures through `PathUtils`/`IOUtils` and register temp roots in the suite's
   `after()` sweep — the repo gates on leaked temp dirs.
4. Prefer asserting through the module's entry points, and add an E2E assertion for anything the
   suite assumes about real browser behavior.
