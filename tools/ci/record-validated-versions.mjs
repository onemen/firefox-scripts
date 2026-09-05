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
import {
  META_ISSUE_TITLE,
  REPO_ROOT,
  VALIDATED_BROWSERS,
  WATCHDOG_LABEL,
  resolveVersion,
} from '../check-browser-downloads.mjs';

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

  await notifyMetaIssue(record);
}

/** Minimal GitHub REST helper (issues/comments only). */
async function ghJson(token, pathname, {method = 'GET', body} = {}) {
  const res = await fetch(`https://api.github.com${pathname}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? {'Content-Type': 'application/json'} : {}),
    },
    ...(body ? {body: JSON.stringify(body)} : {}),
    signal: AbortSignal.timeout(30_000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`GitHub API ${method} ${pathname}: HTTP ${res.status} ${json.message || ''}`);
  }
  return json;
}

/**
 * Comment the validated firefox / firefox-dev versions on the watchdog meta
 * issue, so the dashboard also shows hard-gate validation status. Deduped: a
 * comment is posted only when the versions differ from the last validation
 * comment (the run link changes every run, so the comparison is on the versions
 * segment only). Non-fatal — a notification failure must not fail the
 * record-validation job.
 */
async function notifyMetaIssue(record) {
  const token = process.env.GITHUB_TOKEN || '';
  const repo = process.env.GITHUB_REPOSITORY || '';
  if (!token || !repo) {
    console.log('meta issue notification skipped (no GITHUB_TOKEN / GITHUB_REPOSITORY)');
    return;
  }
  const versions = VALIDATED_BROWSERS.map(b => `${b}=${record.browsers[b]?.version ?? '?'}`).join(
    ' · '
  );
  const body = `Validated by E2E: ${versions} — [run](${record.runUrl || 'n/a'})`;
  try {
    const issues = await ghJson(
      token,
      `/repos/${repo}/issues?state=open&labels=${WATCHDOG_LABEL}&per_page=100`
    );
    const meta = issues.find(i => i.title === META_ISSUE_TITLE);
    if (!meta) {
      // The watchdog creates the meta issue on its next weekly run.
      console.log('meta issue not found yet — validation comment deferred to the watchdog');
      return;
    }
    const comments = await ghJson(
      token,
      `/repos/${meta.number}/comments?per_page=5&sort=created&direction=desc`
    );
    const last = comments.find(c => c.body?.startsWith('Validated by E2E:'));
    if (last && last.body.includes(versions)) {
      console.log(`meta issue already shows ${versions} — no comment`);
      return;
    }
    await ghJson(token, `/repos/${meta.number}/comments`, {
      method: 'POST',
      body: {body},
    });
    console.log(`commented validated versions on meta issue #${meta.number}: ${versions}`);
  } catch (err) {
    console.log(`meta issue notification failed (non-fatal): ${err.message}`);
  }
}

main().catch(err => {
  console.error(`✗ Error: ${err.message}`);
  process.exit(1);
});
