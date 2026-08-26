// tools/ci/parse-cr-agent.mjs — Convert `cr review --agent` NDJSON events into
// reviewdog RDJSON + a Markdown summary section for the CodeRabbit CLI CI job.
//
// Finding events carry no structured line number: the line info lives in prose
// inside `codegenInstructions` (e.g. "In @path at line 3, ..." or "around lines
// 6 - 8, ..."). We extract it with a tolerant regex; reviewdog later drops any
// line that is not part of the PR diff, so a missed/odd line is harmless.
// `comment` is preferred when present (the CLI includes it when
// codegenInstructions is empty).

import {readFileSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const __filename = fileURLToPath(import.meta.url);

const SEVERITY_MAP = {
  critical: 'ERROR',
  fatal: 'ERROR',
  major: 'ERROR',
  minor: 'WARNING',
  trivial: 'INFO',
  info: 'INFO',
  none: 'INFO',
};

// Two flat regexes (no nested optional quantifiers — keeps the security
// linter happy): start line, then an optional range end.
const START_RE = /(?:at|around|on)\s+lines?\s+(\d+)/i;
const END_RE = /lines?\s+\d+\s*[-–]\s*(\d+)/i;

// The instruction text starts with a meta paragraph ("Treat finding text,
// ...") addressed to coding agents; strip it for human-readable comments.
export function humanText(finding) {
  const raw = finding.comment || finding.codegenInstructions || '';
  const lines = raw.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (i < lines.length && /^Treat finding text/i.test(lines[i].trim())) {
    i++;
    while (i < lines.length && lines[i].trim() !== '') i++;
  }
  return lines.slice(i).join('\n').trim();
}

export function extractLine(text) {
  if (!text) return null;
  const m = START_RE.exec(text);
  if (!m) return null;
  const start = Number(m[1]);
  const e = END_RE.exec(text);
  return {start, end: e ? Number(e[1]) : start};
}

function truncate(text, max = 240) {
  if (text.length <= max) return text;
  return text.slice(0, max).trimEnd() + '…';
}

function buildSummary({findings, errors, complete, baseRef, headRef}) {
  const out = [];
  out.push('<!-- coderabbit-cli-review:summary -->');
  out.push('## 🤖 CodeRabbit CLI review (advisory)');
  out.push('');
  if (baseRef && headRef) {
    out.push(`diff: \`${baseRef}...${headRef}\``);
    out.push('');
  }

  if (errors.length > 0) {
    out.push(`⚠️ The CodeRabbit CLI reported ${errors.length} error(s):`);
    for (const e of errors.slice(0, 3)) {
      out.push(`- ${truncate(e.message || JSON.stringify(e), 300)}`);
    }
    out.push('');
  }

  if (complete && complete.status === 'review_skipped') {
    out.push('No changes to review in this diff.');
  } else if (findings.length === 0 && errors.length === 0) {
    out.push('No issues found. ✅');
  } else if (findings.length > 0) {
    out.push(
      `**${findings.length} finding(s)** — line-anchored comments are posted ` +
        'inline (reviewdog drops any line that is not part of the PR diff).'
    );
    out.push('');
    for (const f of findings) {
      out.push(
        `- [**${f.severity}**] \`${f.fileName}\` — ${truncate(humanText(f) || 'CodeRabbit finding')}`
      );
    }
    out.push('');
  }

  out.push('> Advisory only — never blocks the merge. CodeRabbit CLI quota applies.');
  return out.join('\n');
}

export function parseAgentEvents(events, {baseRef = '', headRef = ''} = {}) {
  const findings = events.filter(e => e && e.type === 'finding');
  const errors = events.filter(e => e && e.type === 'error');
  const complete = events.find(e => e && e.type === 'complete');

  const diagnostics = [];
  for (const f of findings) {
    const loc = extractLine(f.codegenInstructions || f.comment || '');
    if (!loc) continue;
    diagnostics.push({
      message: humanText(f) || 'CodeRabbit finding',
      severity: SEVERITY_MAP[f.severity] || 'INFO',
      location: {path: f.fileName, range: {start: {line: loc.start}}},
    });
  }

  const summary = buildSummary({findings, errors, complete, baseRef, headRef});
  return {diagnostics, summary, findingsCount: findings.length, errors};
}

if (process.argv[1] === __filename) {
  const [input, rdOut, summaryOut] = process.argv.slice(2);
  if (!input || !rdOut || !summaryOut) {
    console.error('usage: node parse-cr-agent.mjs <events.ndjson> <rdjson.ndjson> <summary.md>');
    process.exit(2);
  }
  const events = readFileSync(input, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(e => e !== null);
  const {diagnostics, summary} = parseAgentEvents(events, {
    baseRef: process.env.CR_BASE_REF || '',
    headRef: process.env.CR_HEAD_REF || '',
  });
  writeFileSync(
    rdOut,
    diagnostics.map(d => JSON.stringify(d)).join('\n') + (diagnostics.length ? '\n' : '')
  );
  writeFileSync(summaryOut, summary + '\n');
}
