#!/usr/bin/env node

/**
 * tools/ci/record-validated-versions.mjs — write the validated-versions record
 * (.watchdog-validated/validated.json) after a successful firefox/firefox-dev
 * E2E run.
 *
 * The prod publish pre-flight (pages.yml `pre-publish`) checks browser-version
 * drift against the URL watchdog's baseline — but a baseline refresh alone can
 * satisfy that check without any test run ever seeing the new version (issue
 * #4). This script closes the gap: the E2E workflow's record-validation job
 * calls it only after the `updater` matrix legs ran and passed, recording the
 * EXACT firefox / firefox-dev versions those legs installed.
 * `check-browser-downloads.mjs --drift --require-validated` then blocks a prod
 * publish until the current releases are covered by this record.
 *
 * The versions are NOT re-resolved here: the updater legs install Firefox via
 * Mozilla "latest" redirect URLs that embed no version, so each leg reads the
 * version from its installed binary and uploads it as a per-leg artifact
 * (e2e-version-<browser>-<os>.json — matrix job outputs do not aggregate on
 * GitHub). This script consumes those artifacts and requires all three OS legs
 * of a browser to agree (a live re-resolve could record a release no leg ever
 * tested — #134 review finding 5).
 *
 * Only the hard-gated browsers (firefox, firefox-dev — VALIDATED_BROWSERS in
 * check-browser-downloads.mjs) are recorded: fork legs are advisory, so they
 * stay on the watchdog-baseline drift check.
 *
 * Usage (inside the E2E workflow's record-validation job):
 *
 * node tools/ci/record-validated-versions.mjs
 *
 * Env: E2E_VERSIONS_DIR (dir where download-artifact flattened the per-leg
 * version artifacts), VALIDATED_DIR (where to write; defaults to .watchdog/),
 * GITHUB_RUN_ID, GITHUB_SHA (record metadata), GITHUB_STEP_SUMMARY (optional
 * human summary). Exits 1 if the leg artifacts are missing or disagree — a
 * record with holes would silently weaken the publish gate.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  META_ISSUE_TITLE,
  REPO_ROOT,
  VALIDATED_BROWSERS,
  WATCHDOG_LABEL,
} from '../check-browser-downloads.mjs';

/** Runner OSes of the `updater` matrix legs (e2e.yml) — the full leg set. */
export const UPDATER_LEG_OSES = ['ubuntu-latest', 'macos-latest', 'windows-latest'];

/**
 * Read the per-leg version artifacts the e2e workflow's updater matrix legs
 * upload — the exact versions those legs INSTALLED and validated.
 *
 * Enforces the agreement contract: each VALIDATED_BROWSER must have one
 * artifact per expected OS, and all legs must report the SAME version. A hole
 * or disagreement throws — a record with holes would silently weaken the
 * publish pre-flight gate.
 *
 * @param {string} dir E2E_VERSIONS_DIR (where download-artifact flattened the
 *   e2e-version-* artifacts)
 * @param {string[]} [expectedOses] runner OS labels that must all be present
 * @returns {Record<string, {version: string}>} per-browser record entries
 */
export function collectLegVersions(dir, expectedOses = UPDATER_LEG_OSES) {
  if (!dir || !fs.existsSync(dir)) {
    throw new Error(
      `E2E_VERSIONS_DIR ${JSON.stringify(dir ?? '')} not found — the updater matrix legs ` +
        'did not run or uploaded no version artifacts'
    );
  }
  const perBrowser = {};
  for (const file of fs.readdirSync(dir)) {
    if (!file.startsWith('e2e-version-') || !file.endsWith('.json')) continue;
    let leg;
    try {
      leg = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    } catch (err) {
      throw new Error(`unreadable version artifact ${file}: ${err.message}`, {cause: err});
    }
    if (
      !leg ||
      typeof leg.browser !== 'string' ||
      typeof leg.version !== 'string' ||
      !leg.version
    ) {
      throw new Error(`malformed version artifact ${file}: expected {browser, os, version}`);
    }
    (perBrowser[leg.browser] ??= []).push({os: leg.os ?? '?', version: leg.version});
  }
  const out = {};
  for (const browser of VALIDATED_BROWSERS) {
    const legs = perBrowser[browser] ?? [];
    const seenOses = legs.map(l => l.os);
    const missing = expectedOses.filter(o => !seenOses.includes(o));
    if (missing.length > 0) {
      throw new Error(
        `${browser}: missing version artifacts for ${missing.join(', ')} ` +
          `(found: ${seenOses.join(', ') || 'none'})`
      );
    }
    const distinct = [...new Set(legs.map(l => l.version))];
    if (distinct.length !== 1) {
      throw new Error(
        `${browser}: OS legs disagree on the validated version — ` +
          legs.map(l => `${l.os}=${l.version}`).join(', ')
      );
    }
    out[browser] = {version: distinct[0]};
  }
  return out;
}

async function main() {
  const outDir = process.env.VALIDATED_DIR || path.join(REPO_ROOT, '.watchdog');
  const outFile = path.join(outDir, 'validated.json');

  // The tested versions come from the legs' artifacts, never from a live
  // re-resolve (resolving "latest" again could record a release no leg saw).
  const versionsDir = process.env.E2E_VERSIONS_DIR;
  const browsers = collectLegVersions(versionsDir);
  for (const browser of VALIDATED_BROWSERS) {
    console.log(
      `  ${browser}: ${browsers[browser].version} (all ${UPDATER_LEG_OSES.length} OS legs agreed)`
    );
  }

  const record = {
    recordedAt: new Date().toISOString(),
    runId: process.env.GITHUB_RUN_ID || null,
    runUrl:
      process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY ?
        `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID || ''}`
      : null,
    sha: process.env.GITHUB_SHA || null,
    browsers,
  };

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
      `Each version was installed and validated on ${UPDATER_LEG_OSES.join(', ')} — all legs agreed.`,
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

// Guard on basename so a unit test can import collectLegVersions without
// tripping the CLI entry point (same pattern as check-browser-downloads.mjs).
const isMain =
  process.argv[1] && path.basename(process.argv[1]) === 'record-validated-versions.mjs';
if (isMain) {
  main().catch(err => {
    console.error(`✗ Error: ${err.message}`);
    process.exit(1);
  });
}
