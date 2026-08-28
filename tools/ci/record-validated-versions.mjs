#!/usr/bin/env node

/**
 * tools/ci/record-validated-versions.mjs — write the validated-versions record
 * (.watchdog/validated.json) after a successful browser-specific E2E run.
 *
 * The prod publish pre-flight (pages.yml `pre-publish`) checks browser-version
 * drift against the URL watchdog's baseline — but a baseline refresh alone can
 * satisfy that check without any test run ever seeing the new version (issue
 * #4). This script closes the gap: the E2E workflow's final job calls it only
 * after every browser leg passed, recording the exact firefox / firefox-dev
 * versions the run validated. `check-browser-downloads.mjs --drift
 * --require-validated` then blocks a prod publish until the current releases
 * are covered by this record.
 *
 * Only the hard-gated browsers (firefox, firefox-dev — VALIDATED_BROWSERS in
 * check-browser-downloads.mjs) are recorded: fork legs are advisory, so they
 * stay on the watchdog-baseline drift check.
 *
 * Usage (inside the E2E workflow's record-validation job):
 *
 * node tools/ci/record-validated-versions.mjs
 *
 * Env: VALIDATED_DIR (where to write; defaults to .watchdog/), GITHUB_RUN_ID,
 * GITHUB_SHA (record metadata), GITHUB_STEP_SUMMARY (optional human summary).
 * Exits 1 if a version lookup fails — a record with holes would silently weaken
 * the publish gate.
 */

import fs from 'node:fs';
import path from 'node:path';
import {REPO_ROOT, VALIDATED_BROWSERS, resolveVersion} from '../check-browser-downloads.mjs';

async function main() {
  const outDir = process.env.VALIDATED_DIR || path.join(REPO_ROOT, '.watchdog');
  const outFile = path.join(outDir, 'validated.json');

  const record = {
    recordedAt: new Date().toISOString(),
    runId: process.env.GITHUB_RUN_ID || null,
    runUrl:
      process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY ?
        `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID || ''}`
      : null,
    sha: process.env.GITHUB_SHA || null,
    browsers: {},
  };

  for (const browser of VALIDATED_BROWSERS) {
    const version = await resolveVersion(browser);
    record.browsers[browser] = {version};
    console.log(`  ${browser}: ${version}`);
  }

  fs.mkdirSync(outDir, {recursive: true});
  fs.writeFileSync(outFile, JSON.stringify(record, null, 2) + '\n');
  console.log(`validated-versions record written: ${outFile}`);

  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = [
      '### Validated browser versions recorded',
      '',
      '| Browser | Version |',
      '| --- | --- |',
      ...VALIDATED_BROWSERS.map(b => `| ${b} | ${record.browsers[b].version} |`),
      '',
      `Run: ${record.runUrl || 'local'} · commit: ${record.sha || 'n/a'}`,
    ];
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
  }
}

main().catch(err => {
  console.error(`✗ Error: ${err.message}`);
  process.exit(1);
});
