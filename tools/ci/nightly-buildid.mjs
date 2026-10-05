#!/usr/bin/env node

/**
 * tools/ci/nightly-buildid.mjs — print a stable, daily-changing identity for
 * the latest Firefox Nightly build.
 *
 * Mozilla publishes no machine-readable "latest Nightly build ID"
 * (product-details exposes `firefox_versions.json` only; the `*_builds.json`
 * files cover beta/release, not nightly — verified while drafting issue #30).
 * The Linux64 tarball's Last-Modified header IS the build timestamp: unique per
 * build, changes exactly when a new Nightly lands, and costs one HEAD request.
 *
 * The scheduled core-smoke workflow (.github/workflows/core-smoke-nightly.yml)
 * keys its Actions-cache marker on this ID, so a night with no new build skips
 * the leg entirely.
 *
 * Prints e.g. `20260826-1115`. Exits non-zero (no silent fallback) when the
 * header is missing or unparseable: a wrong build ID would cache a skip over a
 * build that was never validated, which is the one failure this gate must not
 * have.
 */

const URL = 'https://download.mozilla.org/?product=firefox-nightly-latest&os=linux64&lang=en-US';

const MONTHS = {
  Jan: '01',
  Feb: '02',
  Mar: '03',
  Apr: '04',
  May: '05',
  Jun: '06',
  Jul: '07',
  Aug: '08',
  Sep: '09',
  Oct: '10',
  Nov: '11',
  Dec: '12',
};

/**
 * "Wed, 26 Aug 2026 11:15:31 GMT" → "20260826-1115".
 *
 * Exported (and pure) so the mapping is unit-testable without a network round
 * trip — the parsing is the part that can silently rot.
 *
 * @param {string | null} lastModified - the HTTP Last-Modified header
 * @returns {string} the build identity
 */
export function parseBuildId(lastModified) {
  if (!lastModified) {
    throw new Error('nightly tarball has no last-modified header');
  }
  const m = lastModified.match(/^\w{3}, (\d{2}) (\w{3}) (\d{4}) (\d{2}):(\d{2}):\d{2} GMT$/);
  if (!m) throw new Error(`cannot parse last-modified: ${lastModified}`);
  const month = MONTHS[m[2]];
  if (!month) throw new Error(`unknown month in last-modified: ${lastModified}`);
  return `${m[3]}${month}${m[1]}-${m[4]}${m[5]}`;
}

/**
 * Fetch the identity. Split from main() so importing this module (for the unit
 * test) does not fire a request.
 *
 * @returns {Promise<string>} the build identity
 */
export async function fetchBuildId() {
  const res = await fetch(URL, {
    method: 'HEAD',
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`nightly HEAD failed: HTTP ${res.status}`);
  return parseBuildId(res.headers.get('last-modified'));
}

// Only run when invoked directly, not when imported by the test.
if (process.argv[1] && import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  fetchBuildId()
    .then(id => console.log(id))
    .catch(err => {
      console.error(`✗ ${err.message}`);
      process.exit(1);
    });
}
