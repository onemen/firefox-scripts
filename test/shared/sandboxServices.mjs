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
