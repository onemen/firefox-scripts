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
// A missing/unreadable baseline falls back to the generic serving-ESR key
// (`["firefox-esr"]`), which resolves its version at run time from Mozilla's
// product-details keys: degradation, never a hardcoded version. The JSON is the
// ONLY stdout output (warnings go to stderr) so the workflow can assign it
// straight to the matrix / output expression.

import fs from 'node:fs';
import {buildEsrCacheNames, buildEsrMatrix} from './watchdog-report.mjs';

const args = process.argv.slice(2);
const namesOnly = args.includes('--names');
const baselineFile = args.find(arg => !arg.startsWith('--')) || '.watchdog/baseline.json';

let esrState = null;
try {
  const baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
  esrState = baseline.esr ?? null;
} catch {
  console.error(
    `no readable watchdog baseline at ${baselineFile} — using the serving-ESR fallback`
  );
}

process.stdout.write(namesOnly ? buildEsrCacheNames(esrState) : buildEsrMatrix(esrState));
