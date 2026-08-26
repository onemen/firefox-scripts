#!/usr/bin/env node
// check-decisions.mjs — verify the ADR log in docs/decisions/.
//
// Fails when:
//   1. two records share the same NNNN number, or a filename number does not
//      match its in-file "# NNNN:" title;
//   2. any relative markdown link inside docs/decisions/ resolves to a missing
//      file (external URLs and bare anchors are ignored);
//   3. a "superseded by [NNNN](...)" status points at a missing record;
//   4. index.md does not mention every record.
//
// Usage: node tools/check-decisions.mjs   (wired into CI via pnpm check:decisions)

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const decisionsDir = path.join(repoRoot, 'docs', 'decisions');
const INDEX = 'index.md';
const TEMPLATE = '0000-template.md';

const errors = [];
const records = []; // { file, number, status }

const fail = (file, message) => errors.push(`${file}: ${message}`);

const linkPattern = /\[[^\]]*\]\(([^)\s]+)\)/g;
const titlePattern = /^# (\d{4}): /;
const statusPattern = /^- \*\*Status:\*\*\s*(.*)$/;
const supersededPattern = /^superseded by \[(\d{4})\]\(([^)]+)\)$/;

if (!fs.existsSync(decisionsDir)) {
  console.error(`docs/decisions/ not found at ${decisionsDir}`);
  process.exit(1);
}

for (const entry of fs.readdirSync(decisionsDir)) {
  if (!entry.endsWith('.md')) continue;
  const filePath = path.join(decisionsDir, entry);
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');

  // Every file: relative links must resolve to an existing file.
  // HTML comments (e.g. the template's status hint) are ignored.
  const visible = content.replace(/<!--[\s\S]*?-->/g, '');
  for (const match of visible.matchAll(linkPattern)) {
    const target = match[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // external URL
    if (target.startsWith('#')) continue; // anchor-only
    const relative = target.split('#')[0];
    if (!relative) continue;
    const resolved = path.resolve(path.dirname(filePath), relative);
    if (!fs.existsSync(resolved)) {
      fail(entry, `broken link: ${target} → ${path.relative(repoRoot, resolved)}`);
    }
  }

  if (entry === INDEX || entry === TEMPLATE) continue; // not records

  const fileMatch = entry.match(/^(\d{4})-/);
  if (!fileMatch) {
    fail(entry, 'filename must start with NNNN- (four digits and a dash)');
    continue;
  }
  const titleLine = lines.find(line => titlePattern.test(line)) ?? '';
  const titleMatch = titleLine.match(titlePattern);
  if (!titleMatch) {
    fail(entry, 'missing "# NNNN: ..." title heading');
    continue;
  }
  if (titleMatch[1] !== fileMatch[1]) {
    fail(entry, `title number ${titleMatch[1]} does not match filename number ${fileMatch[1]}`);
  }

  const statusLine = lines.find(line => statusPattern.test(line)) ?? '';
  const status = (statusLine.match(statusPattern) ?? [])[1] ?? '';
  const superseded = status.match(supersededPattern);
  if (status.startsWith('superseded by') && !superseded) {
    fail(entry, `malformed status: "${status}" (expected "superseded by [NNNN](./NNNN-slug.md)")`);
  } else if (superseded) {
    const target = path.resolve(path.dirname(filePath), superseded[2]);
    if (!fs.existsSync(target)) fail(entry, `superseded-by target missing: ${superseded[2]}`);
  }

  records.push({file: entry, number: fileMatch[1], status});
}

// Duplicate numbers.
const seen = new Map();
for (const record of records) {
  if (seen.has(record.number)) {
    fail(record.file, `duplicate ADR number ${record.number} (also ${seen.get(record.number)})`);
  }
  seen.set(record.number, record.file);
}

// index.md must mention every record.
const indexPath = path.join(decisionsDir, INDEX);
if (!fs.existsSync(indexPath)) {
  console.error(`${INDEX} not found at ${indexPath} — the decision log needs its index`);
  process.exit(1);
}
const indexContent = fs.readFileSync(indexPath, 'utf8');
for (const record of records) {
  if (!indexContent.includes(record.file)) {
    fail(record.file, `not listed in ${INDEX} (add it to the steering or historical list)`);
  }
}

if (errors.length) {
  console.error('✗ Decision log check failed:');
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}
console.log(
  `✓ docs/decisions: ${records.length} records, no duplicate numbers, all links and statuses OK`
);
