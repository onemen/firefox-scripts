#!/usr/bin/env node
// tools/publish/release.mjs — dispatch the prod publish from your machine.
//
// Prod publishes are CI-only (ADR 0026, prodCiGuard.mjs): only the Pages
// publish workflow builds the complete cross-OS installer set. This wrapper is
// the local convenience front door for that workflow — same thing as running
// `gh workflow run pages.yml -f mode=prod`, plus a watch mode:
//
//   pnpm release              # dispatch the prod publish
//   pnpm release -- --force   # rebuild + re-upload even when hashes are unchanged
//   pnpm release -- --watch   # then poll the run until it completes
//
// Uses `gh` (your own login) to dispatch; the workflow's jobs read their token
// from secrets.GITHUB_TOKEN. Exit codes: 0 dispatched (and watched OK);
// 1 usage/gh/dispatch error; 2 watched run failed.

import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// NOTE: deliberately no paths.js import — it resolves the mode-derived config
// at load time and demands --mode, which a workflow dispatcher does not carry.
// gh resolves the repository from the checkout's default remote instead.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const WORKFLOW = 'pages.yml';

/** Repo slug from the checkout's origin remote (https or ssh form). */
export function repoSlug(remoteUrl) {
  const m = /github\.com[/:](.+?)\/(.+?)(?:\.git)?$/.exec(String(remoteUrl || '').trim());
  return m ? `${m[1]}/${m[2]}` : '';
}

/** Parse wrapper args (exported for unit tests). */
export function parseReleaseArgs(argv = process.argv.slice(2)) {
  const opts = {force: false, watch: false};
  for (const a of argv) {
    if (a === '--force') opts.force = true;
    else if (a === '--watch') opts.watch = true;
    else if (a === '--') continue;
    else throw new Error(`Unknown flag: ${a} (supported: --force, --watch)`);
  }
  return opts;
}

function run(cmd, args) {
  const res = spawnSync(cmd, args, {encoding: 'utf8', cwd: REPO_ROOT});
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} exited ${res.status}: ${(res.stderr || '').trim()}`);
  }
  return res;
}

async function watchRun(startedAt) {
  // Poll until a pages.yml run newer than the dispatch appears, then until it
  // completes. gh is the auth boundary; the REST list keeps this dependency-free.
  for (let i = 0; i < 60; i++) {
    const list = run('gh', [
      'run',
      'list',
      '--workflow',
      WORKFLOW,
      '--limit',
      '5',
      '--json',
      'databaseId,status,conclusion,createdAt,url',
    ]);
    const runs = JSON.parse(list.stdout).filter(r => r.createdAt > startedAt);
    if (runs.length > 0) {
      const r = runs[0];
      if (r.status === 'completed') {
        return r;
      }
      process.stdout.write(`  run ${r.databaseId} ${r.status}…\r`);
    }
    await new Promise(resolve => setTimeout(resolve, 15_000));
  }
  throw new Error('timed out waiting for the workflow run to complete');
}

export async function main() {
  let opts;
  try {
    opts = parseReleaseArgs();
  } catch (e) {
    console.error(String(e.message));
    process.exitCode = 1;
    return;
  }

  const startedAt = new Date(Date.now() - 5_000).toISOString();
  const args = ['workflow', 'run', WORKFLOW, '-f', 'mode=prod'];
  if (opts.force) args.push('-f', 'force=true');
  console.log(`Dispatching ${WORKFLOW} (mode=prod${opts.force ? ', force' : ''})…`);
  try {
    run('gh', args);
  } catch (e) {
    console.error(
      `Dispatch failed: ${e.message}\n  (is \`gh\` installed and logged in? \`gh auth status\`)`
    );
    process.exitCode = 1;
    return;
  }
  console.log('✓ Workflow dispatched — the full cross-OS matrix builds in CI.');

  if (!opts.watch) {
    const remote = spawnSync('git', ['remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      cwd: REPO_ROOT,
    }).stdout?.trim();
    const slug = repoSlug(remote);
    console.log(
      slug ?
        `Watch it: https://github.com/${slug}/actions/workflows/${WORKFLOW}`
      : `Watch it: gh run list --workflow ${WORKFLOW}`
    );
    return;
  }

  console.log('Watching (15s polls, up to 15 minutes)…');
  try {
    const r = await watchRun(startedAt);
    if (r.conclusion === 'success') {
      console.log(`\n✓ Publish run ${r.databaseId} succeeded — ${r.url}`);
    } else {
      console.error(`\n✗ Publish run ${r.databaseId} finished: ${r.conclusion} — ${r.url}`);
      process.exitCode = 2;
    }
  } catch (e) {
    console.error(`Watch failed: ${e.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main();
}
