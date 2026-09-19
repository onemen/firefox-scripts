#!/usr/bin/env node
// tools/ci/esrMatrix.mjs — Print the dynamic ESR leg matrix for the
// e2e.yml `esr-matrix` job.
//
// Reads the watchdog baseline (restored from the url-watchdog cache) and
// prints buildEsrMatrix(esr) — one leg per watched ESR major
// (`["firefox-esr-140","firefox-esr-153"]`). A missing/unreadable baseline
// falls back to the generic serving-ESR key (`["firefox-esr"]`), which
// resolves its version at run time from Mozilla's product-details keys:
// degradation, never a hardcoded version. The JSON is the ONLY stdout output
// (warnings go to stderr) so the workflow can assign it straight to the
// matrix expression.

import fs from 'node:fs';
import {buildEsrMatrix} from './watchdog-report.mjs';

const baselineFile = process.argv[2] || '.watchdog/baseline.json';

let esrState = null;
try {
  const baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
  esrState = baseline.esr ?? null;
} catch {
  console.error(
    `no readable watchdog baseline at ${baselineFile} — using the serving-ESR fallback`
  );
}

process.stdout.write(buildEsrMatrix(esrState));
