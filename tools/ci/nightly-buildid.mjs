#!/usr/bin/env node
/**
 * tools/ci/nightly-buildid.mjs — print a stable, daily-changing identity for
 * the latest Firefox Nightly build.
 *
 * Mozilla publishes no machine-readable "latest Nightly build ID"
 * (product-details exposes `firefox_versions.json` only; the `*_builds.json`
 * files cover beta/release, not nightly). The Linux64 tarball's Last-Modified
 * header IS the build timestamp: unique per build, changes exactly when a new
 * Nightly lands, and costs one HEAD request.
 *
 * The scheduled core-smoke workflow (core-smoke-nightly.yml) keys its
 * Actions-cache marker on this ID, so a night with no new build skips the leg.
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

async function main() {
  const res = await fetch(URL, {
    method: 'HEAD',
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`nightly HEAD failed: HTTP ${res.status}`);
  const lastModified = res.headers.get('last-modified');
  if (!lastModified) throw new Error('nightly tarball has no last-modified header');
  // "Wed, 26 Aug 2026 11:15:31 GMT" → "20260826-1115" (minute precision).
  const m = lastModified.match(/^\w{3}, (\d{2}) (\w{3}) (\d{4}) (\d{2}):(\d{2}):\d{2} GMT$/);
  if (!m) throw new Error(`cannot parse last-modified: ${lastModified}`);
  const month = MONTHS[m[2]];
  if (!month) throw new Error(`unknown month in last-modified: ${lastModified}`);
  console.log(`${m[3]}${month}${m[1]}-${m[4]}${m[5]}`);
}

main().catch(err => {
  console.error(`✗ ${err.message}`);
  process.exit(1);
});
