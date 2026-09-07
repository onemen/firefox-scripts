// tools/ai-review.mjs — advisory AI code reviewer for PR diffs.
//
// Runs a model against each changed file's diff (per-file, chunked, with
// rate-limit backoff) and writes two artifacts:
//   - reviewdog RDJSON diagnostics (fed to `reviewdog -f=rdjson` in CI)
//   - a markdown summary comment (posted/updated in place by the workflow)
//
// Designed to be driven by .github/workflows/ai-review.yml with flags, so
// swapping models/providers or switching modes never requires editing YAML:
//
//   node tools/ai-review.mjs --max-findings 10   (local: reviews main...HEAD with the
//       first configured provider — gemini by default)
//
// Flags:
//   --provider <name>   Provider id (default: first configured provider with a
//                       key — gemini). Repeatable — tried in order per file.
//   --model <name>      Override the provider's default model.
//   --base-ref <ref>    Base ref for the diff (default: $BASE_REF env or main).
//   --head-ref <ref>    Head ref (default: $HEAD_REF env or HEAD).
//   --max-findings N    Cap on total findings written to RDJSON (default 10).
//   --max-files N       Cap on files reviewed per run (default 30).
//   --max-diff-chars N  Per-file diff size cap for the token budget (default 60000).
//   --summary-only      Write the summary but emit an empty diagnostics set.
//   --dry-run           Print what would be reviewed without calling any API.
//   --out <dir>         Output directory (default dist/review).
//
// The script is intentionally fail-soft: a provider failure for one file is
// recorded in the summary and the run continues. Exit code 0 even when the
// provider is down — this is an advisory reviewer, never a required check.

import {execFileSync} from 'node:child_process';
import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

// Providers/models are configured as an array of objects. Order matters: when
// no --provider is given, the first entry that has its API key set is used,
// with per-file fallback to the next entry. Edit this array to add/swap.
const PROVIDERS = [
  {
    id: 'gemini',
    label: 'Gemini',
    keyEnv: 'GEMINI_API_KEY',
    model: process.env.GEMINI_MODEL || 'gemini-3.6-flash',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    keyEnv: 'OPENROUTER_API_KEY',
    model: process.env.OPENROUTER_MODEL || 'openrouter/free',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
  },
];

function providerById(id) {
  return PROVIDERS.find(p => p.id === id);
}

// Context notes given to the model so it does not flag things that are
// normal for this codebase: Node ≥ 20 runs in CI (native fetch, structuredClone
// etc.), the script is ESM on the repo's own tooling, and a local helper that
// is used internally (not exported) is fine.
const REPO_CONTEXT = `Runtime context (do NOT flag these):
- Node.js >= 20 is the only runtime — global fetch, AbortSignal.timeout, structuredClone are available.
- This is an ESM module on Node; import.meta and top-level await are fine.
- A function used by other code in the same module does not need to be exported.
- This is a review helper/CI script, not user-facing browser code; logging is fine.`;

const DEFAULT_SYSTEM_PROMPT = `You are a senior software engineer reviewing a pull request diff for real bugs, security issues, regressions, and footguns.
Return ONLY a JSON object (no markdown, no code fences) with this shape:
{"summary": "2-3 sentence overall assessment of the changes", "findings": [{"line": <int, line number in the NEW file>, "severity": "error"|"warning"|"info", "message": "what is wrong and why", "suggestion": "concrete fix (optional)"}]}
Rules:
- "line" must be the line number in the new (target) version of the file.
- severity: error = bug/security/regression; warning = likely bug or footgun; info = minor.
- Only report findings that are DEFINITELY problems: a concrete bug, a security hole, a real regression, or a likely footgun with a specific failure mode. If unsure, do not report it.
- Do NOT report: missing exports on internal helpers, APIs you assume are unavailable, style preferences, naming, or anything a reviewer would wave away.
- If the changes are fine, return {"summary": "No issues found.", "findings": []}`;

export function parseArgs(argv) {
  const args = {
    providers: [],
    model: null,
    baseRef: process.env.BASE_REF || 'main',
    headRef: process.env.HEAD_REF || 'HEAD',
    maxFindings: 10,
    maxFiles: 30,
    maxDiffChars: 60000,
    summaryOnly: false,
    dryRun: false,
    out: join(process.cwd(), 'dist', 'review'),
    name: 'AI review',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => argv[++i];
    switch (arg) {
      case '--provider':
        args.providers.push(value());
        break;
      case '--model':
        args.model = value();
        break;
      case '--base-ref':
        args.baseRef = value();
        break;
      case '--head-ref':
        args.headRef = value();
        break;
      case '--max-findings':
        args.maxFindings = Number(value());
        break;
      case '--max-files':
        args.maxFiles = Number(value());
        break;
      case '--max-diff-chars':
        args.maxDiffChars = Number(value());
        break;
      case '--summary-only':
        args.summaryOnly = true;
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--out':
        args.out = value();
        break;
      case '--name':
        args.name = value();
        break;
      default:
        throw new Error(`Unknown flag: ${arg}`);
    }
  }
  return args;
}

// In CI the base branch is fetched as origin/$BASE_REF (no local branch is
// created), while local runs pass a plain ref like origin/main. Resolve to a
// ref that actually exists in this checkout.
export function resolveBaseRef(baseRef) {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `origin/${baseRef}`]);
    return `origin/${baseRef}`;
  } catch {
    return baseRef;
  }
}

// CI checks out the PR head as a detached HEAD — the head ref name does not
// exist as a local branch there. Fall back to HEAD when the named ref is
// missing (matches the pre-script workflow, which always diffed ...HEAD).
export function resolveHeadRef(headRef) {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', headRef]);
    return headRef;
  } catch {
    return 'HEAD';
  }
}

export function classifyStatus(status) {
  return status === 0 || status === 408 || status === 429 || status >= 500 ?
      'transient'
    : 'permanent';
}

export function isRetryable(status) {
  return classifyStatus(status) === 'transient';
}

export function normalizeFinding(finding, file) {
  const severity = String(finding?.severity || 'info').toLowerCase();
  const line = Math.max(1, Number.parseInt(finding?.line, 10) || 1);
  return {
    message:
      String(finding?.message || '') +
      (finding?.suggestion ? `\n\nSuggestion: ${String(finding.suggestion)}` : ''),
    severity:
      /^(error|critical|fatal)/.test(severity) ? 'ERROR'
      : /^warn/.test(severity) ? 'WARNING'
      : 'INFO',
    location: {path: file, range: {start: {line}}},
  };
}

// Retry budget per provider request. An advisory review that hits a flaky or
// rate-limited provider should degrade in seconds, not minutes (CI observed a
// 6-minute run that ended with every file skipped). 429 is never retried: a
// quota response is pointless to retry and the observed 429 windows last
// minutes, so the first rate limit ends the file immediately. 5xx / network
// blips get a short retry window (Retry-After honored but capped).
const MAX_RETRY_MS = 15_000;
const MAX_RETRY_AFTER_MS = 5_000;

// Resolve as soon as `signal` aborts (or after ms), so a run-level rate-limit
// abort is not held up by a pending retry timer. A double resolve is harmless.
function sleep(ms, signal) {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      {once: true}
    );
  });
}

export async function request(provider, body, signal) {
  let delay = 2000;
  const start = Date.now();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(provider.endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${provider.key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal:
          signal ?
            AbortSignal.any([signal, AbortSignal.timeout(90_000)])
          : AbortSignal.timeout(90_000),
      });
      if (response.ok) return {kind: 'success', body: await response.json()};
      if (response.status === 429) {
        // First rate limit ends this file immediately; the run-level signal
        // aborts anything still in flight (see reviewFiles).
        return {kind: 'transient', status: 429};
      }
      if (!isRetryable(response.status)) {
        let detail = '';
        try {
          const errorBody = await response.json();
          detail = errorBody?.error?.message || errorBody?.message || '';
        } catch {
          // Some provider errors have an empty or non-JSON response body.
        }
        return {
          kind: 'permanent',
          status: response.status,
          reason:
            response.status === 401 ?
              'authentication failed (check the key and provider)'
            : 'provider rejected the request',
          detail: detail.slice(0, 300),
        };
      }
      const retryAfter = Number(response.headers.get('retry-after'));
      const wait = Math.min(
        Number.isFinite(retryAfter) ? retryAfter * 1000 : delay,
        MAX_RETRY_AFTER_MS
      );
      if (attempt === 2 || Date.now() - start + wait > MAX_RETRY_MS) {
        return {kind: 'transient', status: response.status};
      }
      await sleep(wait, signal);
      if (signal?.aborted) return {kind: 'transient', status: 429};
      delay = Math.min(delay * 2, 16_000);
    } catch {
      if (signal?.aborted) return {kind: 'transient', status: 429};
      if (attempt === 2 || Date.now() - start > MAX_RETRY_MS) {
        return {kind: 'transient', status: 0};
      }
      await sleep(Math.min(delay, MAX_RETRY_MS), signal);
      if (signal?.aborted) return {kind: 'transient', status: 429};
      delay = Math.min(delay * 2, 16_000);
    }
  }
  return {kind: 'transient', status: 0};
}
function changedFiles(baseRef, headRef, maxFiles) {
  return execFileSync(
    'git',
    ['diff', `${resolveBaseRef(baseRef)}...${resolveHeadRef(headRef)}`, '--name-only', '-z'],
    {
      encoding: 'utf8',
    }
  )
    .split('\0')
    .filter(file => file && !file.startsWith('dist/') && !file.startsWith('docs/local_plan/'))
    .slice(0, maxFiles);
}
function fileDiff(baseRef, headRef, file) {
  return execFileSync(
    'git',
    [
      'diff',
      `${resolveBaseRef(baseRef)}...${resolveHeadRef(headRef)}`,
      '--no-ext-diff',
      '--',
      file,
    ],
    {
      encoding: 'utf8',
    }
  );
}

function truncateDiff(diff, maxChars) {
  // The marker must tell the model not to guess: a truncated diff hides
  // surrounding code (e.g. the top of a function), and models fabricate
  // "used before declared" bugs from that missing context. Verify against
  // the real file instead of inferring from hunk order.
  return diff.length > maxChars ?
      `${diff.slice(0, maxChars)}\n\n[...diff truncated at ${maxChars} chars — code outside these hunks is\nnot shown; if a suspected issue depends on it (e.g. declaration order),\nverify against the actual file before reporting]`
    : diff;
}

function availableProviders(args) {
  // No --provider flag -> use every configured provider that has a key, in
  // array order (gemini first, then fallbacks). Named --provider flags are
  // resolved in the order given.
  const requested = args.providers.length > 0 ? args.providers : PROVIDERS.map(p => p.id);
  const seen = new Set();
  const available = [];
  for (const id of requested) {
    const def = providerById(id);
    if (!def) throw new Error(`Unknown provider: ${id}`);
    if (seen.has(id)) continue;
    seen.add(id);
    const key = process.env[def.keyEnv];
    if (!key) continue;
    available.push({
      name: def.id,
      label: def.label,
      key,
      model: args.model || def.model,
      endpoint: def.endpoint,
    });
  }
  return available;
}

// Review a list of files with the given providers, calling requestImpl for
// each file (injectable for tests). Returns diagnostics + per-file summaries.
// Run fn over items with at most `limit` concurrent in-flight calls, keeping
// result order aligned with input order. Used to review files in parallel so a
// healthy run costs ~one request round-trip instead of one per file.
async function withConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, worker));
  return results;
}

export async function reviewFiles({
  files,
  fileDiffs,
  providers,
  maxDiffChars = 60000,
  maxFindings = 10,
  summaryOnly = false,
  name = 'AI review',
  requestImpl = request,
  concurrency = 4,
}) {
  const diagnostics = [];
  const summaries = [];
  let rateLimited = false;
  let rateLimitProvider = null;
  const controller = new AbortController();
  const entries = files
    .map(file => ({file, diff: fileDiffs?.get(file) ?? ''}))
    .filter(({diff}) => diff && !diff.startsWith('Binary files'));

  const results = await withConcurrency(entries, concurrency, async ({file, diff}) => {
    if (rateLimited) return {file, skipped: true};
    const prompt = truncateDiff(diff, maxDiffChars);
    let result;
    let providerName = 'none';
    let providerFailure;
    for (const provider of providers) {
      const outcome = await requestImpl(
        provider,
        {
          model: provider.model,
          temperature: 0.2,
          response_format: {type: 'json_object'},
          messages: [
            {role: 'system', content: DEFAULT_SYSTEM_PROMPT},
            {
              role: 'user',
              content: `${REPO_CONTEXT}\n\nReview the diff of ${file}:\n\n${prompt}`,
            },
          ],
        },
        controller.signal
      );
      // A rate limit on another file aborts everything still in flight.
      if (rateLimited) return {file, skipped: true};
      if (outcome.kind === 'success') {
        result = outcome.body;
        providerName = provider.name;
        break;
      }
      providerFailure = outcome;
      if (outcome.status === 429) rateLimitProvider = provider.name;
      if (outcome.kind === 'permanent' && outcome.status !== 404) break;
    }
    if (!result) {
      if (providerFailure?.status === 429) {
        rateLimited = true;
        controller.abort();
      }
      return {file, failed: providerFailure};
    }
    return {file, result, providerName};
  });

  let skipped = 0;
  for (const r of results) {
    if (r.skipped) {
      skipped += 1;
      continue;
    }
    if (r.failed) {
      const reason =
        r.failed.kind === 'permanent' ?
          `${r.failed.reason} (HTTP ${r.failed.status}${r.failed.detail ? `: ${r.failed.detail}` : ''})`
        : r.failed.status ?
          `${r.failed.status === 429 ? 'rate limited' : 'transient provider error'} (HTTP ${r.failed.status})`
        : 'transient providers unavailable (network/timeout)';
      summaries.push(`⚠️ \`${r.file}\` — no provider completed the review (${reason}); skipped.`);
      continue;
    }
    const content = r.result.choices?.[0]?.message?.content;
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      summaries.push(
        `### \`${r.file}\` — ${r.providerName}\nModel returned an invalid or unusable JSON reply; findings skipped.`
      );
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      // JSON.parse('null') (and '42', '"text"', '[]', …) parses but yields no
      // usable review object — observed live when a provider returned a bare
      // null, which then crashed the whole run at parsed.summary. Fail soft:
      // same per-file skip as invalid JSON.
      summaries.push(
        `### \`${r.file}\` — ${r.providerName}\nModel returned an invalid or unusable JSON reply; findings skipped.`
      );
      continue;
    }
    summaries.push(
      `### \`${r.file}\` — ${r.providerName}\n${parsed.summary || 'No summary provided.'}`
    );
    for (const finding of parsed.findings || []) {
      const normalized = normalizeFinding(finding, r.file);
      if (normalized.message.trim()) diagnostics.push(normalized);
    }
  }
  if (skipped > 0) {
    summaries.push(
      `> ${rateLimitProvider ?? 'Provider'} rate limit exhausted; remaining files were skipped.`
    );
  }
  const finalDiagnostics = summaryOnly ? [] : diagnostics.slice(0, maxFindings);
  return {
    rdjson: {source: {name}, diagnostics: finalDiagnostics},
    summary: summaries,
    totalFindings: diagnostics.length,
  };
}

export async function runReview(args = parseArgs(process.argv.slice(2))) {
  if (!args.baseRef) throw new Error('BASE_REF is required (--base-ref or $BASE_REF)');
  const providers = availableProviders(args);
  if (args.dryRun) {
    const files = changedFiles(args.baseRef, args.headRef, args.maxFiles);
    return {
      dryRun: true,
      files,
      providers: providers.map(p => `${p.name} (${p.model})`),
      rdjson: {source: {name: args.name}, diagnostics: []},
      summary: files.map(file => `### \`${file}\`\n(dry run — not reviewed)`),
    };
  }
  if (providers.length === 0) {
    throw new Error('No provider keys configured. Set GEMINI_API_KEY and/or OPENROUTER_API_KEY.');
  }
  const files = changedFiles(args.baseRef, args.headRef, args.maxFiles);
  const fileDiffs = new Map(files.map(file => [file, fileDiff(args.baseRef, args.headRef, file)]));
  const result = await reviewFiles({
    files,
    fileDiffs,
    providers,
    maxDiffChars: args.maxDiffChars,
    maxFindings: args.maxFindings,
    summaryOnly: args.summaryOnly,
    name: args.name,
  });
  return {dryRun: false, ...result};
}

export async function writeArtifacts(args, result) {
  await mkdir(args.out, {recursive: true});
  const rdjsonPath = join(args.out, 'ai-review-rd.json');
  const summaryPath = join(args.out, 'ai-review-summary.md');
  await writeFile(rdjsonPath, `${JSON.stringify(result.rdjson)}\n`);
  const lines = [
    '<!-- ai-review:summary -->',
    '## 🤖 AI review (advisory)',
    '',
    `Model: ${result.providers?.join(', ') || 'see per-file notes'} · findings: ${result.totalFindings ?? result.rdjson.diagnostics.length}`,
    '',
    ...result.summary,
    '',
    '> Advisory only — this review never blocks the merge. Provider free-tier limits apply.',
    '',
  ];
  await writeFile(summaryPath, lines.join('\n'));
  return {rdjsonPath, summaryPath};
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `AI review: providers=${args.providers.join('+')} base=${args.baseRef || '(missing)'} head=${args.headRef}`
  );
  const result = await runReview(args);
  const {rdjsonPath, summaryPath} = await writeArtifacts(args, result);
  if (result.dryRun) {
    console.log(
      `Dry run: ${result.files.length} file(s) would be reviewed by ${result.providers.join(', ')}`
    );
  } else {
    console.log(
      `Reviewed ${result.summary.length} file(s); ${result.totalFindings} finding(s) (${result.rdjson.diagnostics.length} posted).`
    );
  }
  console.log(`Wrote ${rdjsonPath} and ${summaryPath}`);
}
