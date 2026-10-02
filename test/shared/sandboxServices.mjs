// test/shared/sandboxServices.mjs — the pieces of the `Services` global that the
// vm sandboxes evaluating core/chrome/utils/updater/scriptsUpdater.sys.mjs from
// source cannot get from Node, shared so each suite does not grow its own
// slightly different stub.

/**
 * Stand-in for `Services.vc.compare`, for the sandboxes that run
 * scriptsUpdater.sys.mjs straight from source. The module calls it once at load
 * time — `isVersion('156.0a1')` picks the SessionStore spec (moz-src:// from
 * 156.0a1 on, resource:///modules before it) — so the stub only has to order
 * the version HEADS: 140.0 < 156.0a1 <= 159.0a1. Firefox's own comparator puts
 * a release above its own prerelease (156.0 > 156.0a1), which lands on the same
 * spec choice as "equal"; the alpha/beta token ordering is deliberately not
 * reimplemented here. A non-numeric version throws instead of silently guessing
 * an order.
 *
 * @param {string} a - a platform version (Services.appinfo.platformVersion)
 * @param {string} b - the version to compare against
 * @returns {number} negative / 0 / positive, like Services.vc.compare
 */
export function comparePlatformVersions(a, b) {
  const [na, nb] = [Number.parseFloat(a), Number.parseFloat(b)];
  if (!Number.isFinite(na) || !Number.isFinite(nb)) {
    throw new Error(`comparePlatformVersions stub cannot order ${a} vs ${b}`);
  }
  return (
    na === nb ? 0
    : na < nb ? -1
    : 1
  );
}

/**
 * `Downloads.sys.mjs` as the sandboxes see it. The module only calls
 * `fetch(url, path)` (inside ensureUpdaterUi's try/catch, which degrades to
 * "keep the installed UI"): the sandboxes have no network, so the stub fails
 * LOUDLY and the call site falls back exactly like a real missing package.
 *
 * @returns {object} a module-namespace-shaped stub
 */
export function makeDownloadsStub() {
  return {
    async fetch(url) {
      throw new Error(`Downloads.fetch is not stubbed in this sandbox (${url})`);
    },
  };
}

/**
 * Resolve one lazy getter the module asks for, by SPEC — the single place that
 * knows the module's lazy module set. Every vm suite funnels its
 * `ChromeUtils.defineESModuleGetters` stub through this, so a module added to
 * the module's block cannot silently resolve to `undefined` in one harness and
 * work in another (which is how a version-conditional import hides a bug).
 * `Timer` is deliberately NOT handled here: each suite's timer stub is its own
 * instrumented object.
 *
 * @param {string} name - the lazy getter's property name
 * @param {string} spec - the specifier the module requested
 * @param {{onForgetClosedTab?: (win: object, index: number) => void}} [hooks]
 * @returns {unknown} the value the getter should produce
 */
export function resolveSandboxLazyModule(name, spec, {onForgetClosedTab} = {}) {
  const text = String(spec);
  if (text.includes('sessionstore/SessionStore.sys.mjs')) {
    return makeSessionStoreStub(onForgetClosedTab);
  }
  if (text.includes('Downloads.sys.mjs')) {
    return makeDownloadsStub();
  }
  throw new Error(`unhandled lazy ESM getter: ${name} -> ${spec}`);
}

/**
 * The SessionStore module namespace as the sandboxes see it. The module only
 * ever reaches SessionStore through its lazy getter (the spec is chosen from
 * the platform version), and the closed-tab purge needs the same API surface a
 * real namespace has: getClosedTabDataForWindow() plus forgetClosedTab(win,
 * index).
 *
 * @param {(win: object, index: number) => void} [onForgetClosedTab] - test seam
 *   invoked for every purge (assert the restored tab was forgotten)
 * @param {() => string} [closedTabData] - overrides the closed-tab payload
 *   (default: one window holding the updater page in `_closedTabs`)
 * @returns {object} a module-namespace-shaped stub
 */
export function makeSessionStoreStub(
  onForgetClosedTab = () => {},
  closedTabData = () =>
    JSON.stringify({
      windows: [
        {
          _closedTabs: [
            {
              state: {
                entries: [{url: 'chrome://firefox-scripts/content/ui/updater.html'}],
              },
            },
          ],
        },
      ],
    })
) {
  return {
    promiseAllWindowsRestored: Promise.resolve(),
    getClosedTabDataForWindow: () => closedTabData(),
    forgetClosedTab: (win, index) => {
      onForgetClosedTab(win, index);
    },
  };
}
