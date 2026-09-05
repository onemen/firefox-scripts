#!/usr/bin/env node

/**
 * tools/skills-watchdog.mjs — drift watchdog for third-party agent skills (ADR
 * 0022: `.agents/skills/`, gh-installed, pristine).
 *
 * Every third-party skill carries gh-injected frontmatter metadata
 * (`metadata.github-repo/-ref/-path/-tree-sha`) — that metadata IS the
 * baseline, so unlike the URL watchdog this check needs no Actions cache and is
 * stateless in every mode. Authored skills (no `github-repo`) have no upstream
 * and are skipped by design.
 *
 * Modes (driven by .github/workflows/skills-watchdog.yml):
 *
 * - Weekly (schedule/dispatch): for each third-party skill, resolve the skill
 *   folder's tree SHA at the recorded ref and at the source repo's default
 *   branch via the GitHub API and classify:
 *
 *   - `content-drift` — the folder tree at the recorded ref no longer matches the
 *       frontmatter (rolling tag moved; exactly what `gh skill update <skill>`
 *       would apply).
 *   - `ref-behind` — the recorded ref lags the default branch AND the skill folder
 *       changed there. Static-tag installs never trigger `gh skill update` (no
 *       drift at the recorded ref), so the actionable command is a forced
 *       reinstall instead.
 *   - `ref-missing` — the recorded ref no longer exists upstream. Findings
 *       open/update ONE rolling tracking issue (`[skills-watchdog] third-party
 *       skill drift`, label `skills-watchdog`) listing each drifted skill with
 *       its exact update command; when a later run finds no drift, the open
 *       issue is closed. Updates are never pushed: they land as human-reviewed
 *       PRs.
 * - PR (`--pr`): stateless and always green — findings surface as `::warning::`
 *   annotations so the check can be required without blocking. No issues, no
 *   writes.
 * - `--dry-run`: print findings, no writes (API reads still happen).
 *
 * Ref resolution uses the canonical chain (`GET /git/ref/<ref>` → peel tag
 * objects → commit tree → walk the folder segments): the trees API accepts
 * commit SHAs and some ref shorthands, but `tags/<name>` is rejected (422), so
 * ref names go through the ref API. The metadata `github-path` is the skill
 * folder (`skills/<name>`), so every segment is a directory — the walk ends on
 * the folder tree, which is exactly what `github-tree-sha` recorded.
 *
 * API access: `GITHUB_TOKEN` when set (CI), else unauthenticated (public
 * sources; fine for a handful of skills, 60 req/h limit). Failures to check a
 * skill become findings (`check-failed`), never CI failures — advisory, like
 * ADR 0017's fork legs.
 */

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const REPO_ROOT = path.resolve(__dirname, '..');

export const SKILLS_DIR = '.agents/skills';
export const WATCHDOG_LABEL = 'skills-watchdog';
export const ISSUE_TITLE = '[skills-watchdog] third-party skill drift';

/**
 * Parse the gh-injected metadata block from a SKILL.md frontmatter. Targeted
 * parser (no YAML dependency): everything between the `---` fences, looking for
 * a `metadata:` line and the indented `github-*: value` pairs under it, plus
 * the top-level `name:`.
 *
 * @param {string} text SKILL.md content (CRLF tolerated)
 * @returns {{name: string | null; metadata: Record<string, string>}}
 */
export function parseSkillFrontmatter(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines[0]?.trim() !== '---') return {name: null, metadata: {}};
  let name = null;
  const metadata = {};
  let inMetadata = false;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '---') break;
    const top = line.match(/^(description|name):/);
    if (top && !line.startsWith(' ') && !line.startsWith('\t')) {
      if (top[1] === 'name') name = line.slice('name:'.length).trim() || null;
      inMetadata = false;
      continue;
    }
    if (/^metadata:\s*$/.test(line)) {
      inMetadata = true;
      continue;
    }
    if (inMetadata) {
      // Under `metadata:` gh writes 4-space-indented `key: value` pairs.
      const kv = line.match(/^\s+([A-Za-z-]+):\s*(.+)$/);
      if (kv) metadata[kv[1]] = kv[2].trim();
    }
  }
  return {name, metadata};
}

/**
 * Build the third-party skill inventory from the skills directory: one entry
 * per SKILL.md that carries `metadata.github-repo`. Authored skills are
 * excluded (no upstream — ADR 0022).
 *
 * @param {string} root repo root (contains `.agents/skills/`)
 * @returns {{
 *   skill: string;
 *   dir: string;
 *   repo: string;
 *   ref: string;
 *   skillPath: string;
 *   treeSha: string;
 * }[]}
 */
export function loadInventory(root) {
  const skillsRoot = path.join(root, SKILLS_DIR);
  if (!fs.existsSync(skillsRoot)) return [];
  const inventory = [];
  for (const entry of fs.readdirSync(skillsRoot, {withFileTypes: true})) {
    if (!entry.isDirectory()) continue;
    const file = path.join(skillsRoot, entry.name, 'SKILL.md');
    if (!fs.existsSync(file)) continue;
    const {metadata} = parseSkillFrontmatter(fs.readFileSync(file, 'utf8'));
    const repoUrl = metadata['github-repo'] || '';
    const m = repoUrl.match(/github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/);
    if (!m) continue; // authored here — no upstream to watch
    inventory.push({
      skill: entry.name,
      dir: `${SKILLS_DIR}/${entry.name}`,
      repo: m[1],
      ref: metadata['github-ref'] || '',
      skillPath: metadata['github-path'] || '',
      treeSha: metadata['github-tree-sha'] || '',
    });
  }
  return inventory.sort((a, b) => a.skill.localeCompare(b.skill));
}

/**
 * Strip the `refs/` prefix for the ref API (`refs/tags/v1` → `tags/v1`).
 *
 * @param {string} ref
 */
export function shortRef(ref) {
  return ref.replace(/^refs\//, '');
}

/**
 * Resolve the tree SHA of a skill folder on a repo, starting from a commit SHA
 * and walking the folder segments (`github-path` is the folder, so every
 * segment is a directory). Returns null when a segment is missing.
 *
 * @param {(pathname: string) => Promise<any>} fetchJson
 * @param {string} repo `owner/name`
 * @param {string} commitSha commit whose tree to walk
 * @param {string} skillPath folder path from the metadata (`skills/<name>`)
 * @returns {Promise<string | null>}
 */
export async function folderTreeAt(fetchJson, repo, commitSha, skillPath) {
  let cur = commitSha;
  for (const segment of skillPath.split('/').filter(Boolean)) {
    const tree = await fetchJson(`/repos/${repo}/git/trees/${cur}`);
    const entry = (tree.tree || []).find(e => e.path === segment);
    if (!entry || entry.type !== 'tree') return null;
    cur = entry.sha;
  }
  return cur;
}

/**
 * Resolve a recorded ref (e.g. `refs/tags/v1`) to a commit SHA via the ref API,
 * peeling annotated tag objects. Throws {status: 404} when the ref is gone.
 *
 * @param {(pathname: string) => Promise<any>} fetchJson
 * @param {string} repo
 * @param {string} ref
 * @returns {Promise<string>}
 */
export async function refToCommit(fetchJson, repo, ref) {
  const refObj = await fetchJson(`/repos/${repo}/git/ref/${shortRef(ref)}`);
  let sha = refObj.object.sha;
  if (refObj.object.type === 'tag') {
    sha = (await fetchJson(`/repos/${repo}/git/tags/${sha}`)).object.sha;
  }
  return sha;
}

/**
 * Collect drift findings for an inventory. `fetchJson(pathname)` must return
 * the parsed GitHub API body or throw {status} — injected so tests run without
 * network.
 *
 * @param {ReturnType<typeof loadInventory>} inventory
 * @param {(pathname: string) => Promise<any>} fetchJson
 * @returns {Promise<
 *   {
 *     skill: string;
 *     repo: string;
 *     ref: string;
 *     dir: string;
 *     kind: string;
 *     reason?: string;
 *     aheadBy?: number | null;
 *     localTreeSha?: string;
 *     upstreamTreeSha?: string | null;
 *   }[]
 * >}
 */
export async function collectDrift(inventory, fetchJson) {
  const findings = [];
  for (const item of inventory) {
    try {
      const commit = await refToCommit(fetchJson, item.repo, item.ref);
      const upstreamAtRef = await folderTreeAt(fetchJson, item.repo, commit, item.skillPath);
      if (!upstreamAtRef) {
        throw new Error(`skill folder ${item.skillPath} not found at ${item.ref}`);
      }

      // Context: recorded ref vs the default branch, and whether the skill
      // folder itself changed there. compare/<ref>...HEAD reports ahead_by =
      // commits HEAD has that the ref lacks (i.e. how far the ref is behind
      // the default branch) — behind_by stays 0 for an ancestor ref, so it is
      // the wrong field for ref-behind detection (CodeRabbit triage, PR #122).
      const cmp = await fetchJson(`/repos/${item.repo}/compare/${shortRef(item.ref)}...HEAD`).catch(
        () => null
      );
      const aheadBy = cmp ? cmp.ahead_by : null;
      const headTree = await fetchJson(`/repos/${item.repo}/git/trees/HEAD`);
      const upstreamAtHead = await folderTreeAt(fetchJson, item.repo, headTree.sha, item.skillPath);
      const changedOnHead = upstreamAtHead !== null && upstreamAtHead !== upstreamAtRef;

      if (upstreamAtRef !== item.treeSha) {
        findings.push({
          ...item,
          kind: 'content-drift',
          aheadBy,
          localTreeSha: item.treeSha,
          upstreamTreeSha: upstreamAtRef,
        });
      } else if (aheadBy > 0 && changedOnHead) {
        findings.push({
          ...item,
          kind: 'ref-behind',
          aheadBy,
          localTreeSha: item.treeSha,
          upstreamTreeSha: upstreamAtHead,
        });
      }
    } catch (err) {
      findings.push({
        ...item,
        kind: err?.status === 404 ? 'ref-missing' : 'check-failed',
        reason: err?.message || String(err),
      });
    }
  }
  return findings;
}

/**
 * The exact command that applies the update for a finding. `content-drift`
 * (drift at the recorded ref) is what `gh skill update` applies; `ref-behind`
 * static-tag installs never drift at the ref, so they need a forced reinstall
 * that re-resolves the latest release.
 *
 * @param {{kind: string; skill: string; repo: string}} f
 */
export function updateCommand(f) {
  if (f.kind === 'ref-behind') {
    return `gh skill install ${f.repo} ${f.skill} --dir .agents/skills --force`;
  }
  return `gh skill update ${f.skill} --all`;
}

/**
 * Markdown body for the rolling tracking issue: one section per drifted skill,
 * each with its state and update command. Human-reviewed PR after running —
 * never push directly.
 *
 * @param {Awaited<ReturnType<typeof collectDrift>>} findings
 * @param {string} runUrl
 */
export function issueBody(findings, runUrl = 'local') {
  const sections = findings.map(f => {
    if (f.kind === 'content-drift') {
      return (
        `### ${f.skill} — content drift\n\n` +
        `- source: ${f.repo} @ \`${f.ref}\`\n` +
        `- installed tree: \`${(f.localTreeSha || '').slice(0, 12)}\` → upstream: \`${(f.upstreamTreeSha || '').slice(0, 12)}\`\n` +
        (f.aheadBy > 0 ? `- the default branch is ${f.aheadBy} commit(s) ahead of the ref\n` : '') +
        `\n\`\`\`\n${updateCommand(f)}\n\`\`\`\n`
      );
    }
    if (f.kind === 'ref-behind') {
      return (
        `### ${f.skill} — upstream moved (default branch ${f.aheadBy} commit(s) ahead)\n\n` +
        `- source: ${f.repo} @ \`${f.ref}\` — skill folder changed on the default branch\n` +
        `- installed tree: \`${(f.localTreeSha || '').slice(0, 12)}\` → default branch: \`${(f.upstreamTreeSha || '').slice(0, 12)}\`\n\n` +
        `\`\`\`\n${updateCommand(f)}\n\`\`\`\n`
      );
    }
    if (f.kind === 'ref-missing') {
      return (
        `### ${f.skill} — recorded ref missing upstream\n\n` +
        `- source: ${f.repo} @ \`${f.ref}\` — \`${f.reason}\`\n\n` +
        `\`\`\`\ngh skill install ${f.repo} ${f.skill} --dir .agents/skills --force\n\`\`\`\n`
      );
    }
    return (
      `### ${f.skill} — check failed\n\n` +
      `- source: ${f.repo} @ \`${f.ref}\`\n- \`${f.reason}\`\n`
    );
  });
  return (
    `Third-party skills in \`${SKILLS_DIR}/\` drifted from their upstream ` +
    `sources (ADR 0022). Run the command in the repo root, review the diff ` +
    `(upstream skill text is a prompt-injection surface), and open a PR — ` +
    `never push directly.\n\nWatchdog run: ${runUrl}\n\n${sections.join('\n')}`
  );
}

/** Minimal GitHub REST helper (issues + reads; token optional for reads). */
export async function ghApi(token, pathname, {method = 'GET', body} = {}) {
  const res = await fetch(`https://api.github.com${pathname}`, {
    method,
    headers: {
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(token ? {Authorization: `Bearer ${token}`} : {}),
      ...(body ? {'Content-Type': 'application/json'} : {}),
    },
    ...(body ? {body: JSON.stringify(body)} : {}),
    signal: AbortSignal.timeout(30_000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(
      `GitHub API ${method} ${pathname}: HTTP ${res.status} ${json.message || ''}`
    );
    err.status = res.status;
    throw err;
  }
  return json;
}

/**
 * Open (or update / reopen) the rolling tracking issue; close it when the drift
 * resolved. Returns the issue URL acted on, or null.
 */
async function upsertTrackingIssue(token, repo, findings, runUrl) {
  // state=all: a previously closed tracking issue is reused (reopened) when
  // drift returns, instead of opening a fresh one each cycle.
  const known = await ghApi(
    token,
    `/repos/${repo}/issues?state=all&labels=${WATCHDOG_LABEL}&per_page=100`
  );
  const existing = known.find(i => i.title === ISSUE_TITLE);

  if (!findings.length) {
    if (existing && existing.state === 'open') {
      await ghApi(token, `/repos/${repo}/issues/${existing.number}/comments`, {
        method: 'POST',
        body: {body: `All third-party skills current as of run ${runUrl} — closing.`},
      });
      await ghApi(token, `/repos/${repo}/issues/${existing.number}`, {
        method: 'PATCH',
        body: {state: 'closed', state_reason: 'completed'},
      });
      console.log(`  resolved — closed #${existing.number}`);
    } else {
      console.log('  no drift, no open tracking issue');
    }
    return existing?.html_url ?? null;
  }

  const body = issueBody(findings, runUrl);
  if (existing) {
    await ghApi(token, `/repos/${repo}/issues/${existing.number}`, {
      method: 'PATCH',
      body: {state: 'open', body},
    });
    console.log(`  updated tracking issue #${existing.number}`);
    return existing.html_url;
  }
  const created = await ghApi(token, `/repos/${repo}/issues`, {
    method: 'POST',
    body: {title: ISSUE_TITLE, body, labels: [WATCHDOG_LABEL]},
  });
  console.log(`  opened tracking issue #${created.number}`);
  return created.html_url;
}

export async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const prMode = process.argv.includes('--pr');
  const token = process.env.GITHUB_TOKEN || '';
  const repo = process.env.GITHUB_REPOSITORY || '';
  const runUrl =
    process.env.RUN_URL || `local (${new Date().toISOString().replace('T', ' ').slice(0, 16)})`;

  const inventory = loadInventory(REPO_ROOT);
  console.log(
    `skills-watchdog: ${inventory.length} third-party skill(s)` +
      (prMode ? ' — PR mode (stateless, advisory).'
      : dryRun ? ' — dry-run.'
      : '')
  );
  if (!inventory.length) return;

  const findings = await collectDrift(inventory, pathname => ghApi(token, pathname));

  for (const f of findings) {
    const detail =
      f.kind === 'check-failed' || f.kind === 'ref-missing' ? ` — ${f.reason}`
      : f.behindBy ? ` (behind by ${f.behindBy})`
      : '';
    const line = `  ⚠ ${f.skill}: ${f.kind}${detail}`;
    if (prMode) console.log(`::warning title=skills-watchdog::${line.trim()}`);
    else console.log(line);
  }
  if (!findings.length) console.log('  all third-party skills match their recorded upstream');

  if (prMode) return; // stateless — annotations only, never issues
  if (dryRun) {
    if (findings.length) {
      console.log(`  dry-run — would ${repo ? 'update' : 'open'} the tracking issue:\n`);
      console.log(issueBody(findings, runUrl));
    }
    return;
  }

  if (!repo) {
    console.log('  GITHUB_REPOSITORY not set — skipping issue update (local run).');
    return;
  }
  await upsertTrackingIssue(token, repo, findings, runUrl);
}

/* Executed directly → run; imported → tests use the exported helpers. */
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch(err => {
    console.error(err);
    process.exitCode = 1;
  });
}
