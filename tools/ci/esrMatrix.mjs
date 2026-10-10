#!/usr/bin/env node
// tools/ci/esrMatrix.mjs — Print the dynamic ESR leg matrix for the
// e2e.yml `esr-matrix` job.
//
// Reads the watchdog baseline (restored from the url-watchdog cache) and prints
// buildEsrMatrix(esr) — one leg per watched ESR major, as the browser key the
// matrix dimension carries: `["firefox-esr-140","firefox-esr-153"]`. With
// `--names` it prints buildEsrCacheNames(esr) instead — the cache name (ADR
// 0045) of each of those legs, keyed by the same browser keys
// (`{"firefox-esr-140":"esr-prev","firefox-esr-153":"esr"}`), which the leg
// looks itself up in. The two are separate outputs because the matrix dimension
// is the browser string: an object element there fails to dispatch.
//
// The watched window resolves from THREE homes, best → fallback:
// 1. the baseline file (the nightly's own home, restored by the workflow);
// 2. the `[url-watchdog] status` meta issue's `watchdog:data` marker (#136) —
//    the same nightly that rewrites the baseline also renders the block into
//    the issue body. The issue lives in GitHub's DB, not in the evictable
//    cache, so a wiped cache no longer degrades the window to the generic
//    serving-ESR leg. Requires the ESR_WATCHDOG_MARKERS env (comma separated,
//    optionally `owner/repo`-scoped) listing the marker values;
// 3. the generic serving-ESR key (`["firefox-esr"]`), which resolves its
//    version at run time from Mozilla's product-details keys: degradation,
//    never a hardcoded version.
//
// The JSON is the ONLY stdout output (warnings to stderr) so the workflow can
// assign it straight to the matrix / output expression.

import fs from 'node:fs';
import {buildEsrCacheNames, buildEsrMatrix, parseEsrMarker} from './watchdog-report.mjs';

const args = process.argv.slice(2);
const namesOnly = args.includes('--names');
const baselineFile = args.find(arg => !arg.startsWith('--')) || '.watchdog/baseline.json';

// Consume the ESR_WATCHDOG_MARKERS env var shapes the workflow passes. If the
// intended fallback fires, the values are read directly from the issue —
// machine-visible, no inference (the workflow's URL-fetch step sets this).
const markerValues = (process.env.ESR_WATCHDOG_MARKERS || '')
  .split(',')
  .map(v => v.trim())
  .filter(Boolean);

let esrState = null;
try {
  const baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
  esrState = baseline.esr ?? null;
} catch {
  console.error(`no readable watchdog baseline at ${baselineFile} — trying the meta-issue marker`);
}

if (!esrState && markerValues.length > 0) {
  for (const markerValue of markerValues) {
    const parsed = parseEsrMarker(markerValue);
    if (parsed) {
      esrState = parsed;
      console.error(
        `watchdog baseline absent — ESR window restored from the [url-watchdog] status issue marker`
      );
      break;
    }
  }
  if (!esrState) {
    console.error('no parseable watchdog:data marker in the provided values — generic fallback');
  }
} else if (!esrState) {
  console.error('ESR_WATCHDOG_MARKERS not set — generic serving-ESR fallback');
}

process.stdout.write(namesOnly ? buildEsrCacheNames(esrState) : buildEsrMatrix(esrState));
