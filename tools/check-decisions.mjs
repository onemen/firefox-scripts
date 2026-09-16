#!/usr/bin/env node
// check-decisions.mjs — verify the ADR log in docs/decisions/.
//
// Fails when:
//   1. two records share the same NNNN number, or a filename number does not
//      match its in-file "# NNNN:" title;
//   2. any relative markdown link inside docs/decisions/ resolves to a missing
//      file (external URLs and bare anchors are ignored);
//   3. a "superseded by [NNNN](...)" status points at a missing record;
//   4. index.md does not mention every record;
//   5. an `Amends:` / `Amended:` status line (ADR 0029) points at a missing
//      file or a non-record, its [NNNN] does not match the target filename,
//      links to itself, or the pair is not reciprocated (X Amends Y ⇔
//      Y Amended X). A self-contained `Amended: YYYY-MM-DD — …` line carries no
//      links and is declared, not validated.
//
// Usage: node tools/check-decisions.mjs   (wired into CI via pnpm check:decisions)

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const decisionsDir = path.join(repoRoot, 'docs', 'decisions');
export const INDEX = 'index.md';
export const TEMPLATE = '0000-template.md';

const linkPattern = /\[[^\]]*\]\(([^)\s]+)\)/g;
const titlePattern = /^# (\d{4}): /;
const statusFieldPattern = /^(?:- )?\*\*([^*]+):\*\*\s*(.*)$/;
const supersededPattern = /^superseded by \[(\d{4})\]\(([^)]+)\)$/;
const recordLinkPattern = /\[(\d{4})\]\(([^)\s]+)\)/g;

/**
 * Parse a record's Status block — the contiguous `- **Key:** value` list under
 * the `# NNNN:` title — into a Map of key → values. A repeated key (e.g. two
 * `Amends:` lines) accumulates. Prettier-wrapped continuation lines are joined
 * into the previous entry's value — but a line that itself starts with
 * `**Key:**` (dash optional) is always a NEW field, never a continuation, so
 * adjacent `Amends:`/`Amended:` items keep their links separate. Prose before
 * the block is skipped; the block ends at a blank line followed by prose (or at
 * a non-list, non-continuation line). Returns an empty Map when the record has
 * no Status block. Fenced code blocks hold format examples, never fields.
 *
 * @param {string[]} lines
 * @returns {Map<string, string[]>}
 */
export function parseStatusBlock(lines) {
  const fields = new Map();
  let inFence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (inFence) continue;
    if (line.trim() === '') {
      if (fields.size > 0) break;
      continue;
    }
    const field = line.match(statusFieldPattern);
    if (field) {
      const values = fields.get(field[1]) ?? [];
      values.push(field[2].trim());
      fields.set(field[1], values);
      continue;
    }
    if (fields.size > 0 && /^\s/.test(line)) {
      const last = [...fields.keys()].at(-1);
      const values = fields.get(last);
      values[values.length - 1] = `${values[values.length - 1]} ${line.trim()}`;
      continue;
    }
    if (fields.size > 0) break; // prose after the block
  }
  return fields;
}

/**
 * The [NNNN](path) targets of an `Amends:` / `Amended:` value.
 *
 * @param {string} value
 * @returns {{num: string; path: string}[]}
 */
function linkTargets(value) {
  return [...value.matchAll(recordLinkPattern)].map(m => ({num: m[1], path: m[2]}));
}

/**
 * Check one decisions directory. Pure: returns errors instead of exiting, so
 * the unit tests can point it at a fixture directory.
 *
 * @param {string} dir the docs/decisions directory to check
 * @returns {{
 *   errors: string[];
 *   records: {
 *     file: string;
 *     number: string;
 *     status: string;
 *     fields: Map<string, string[]>;
 *   }[];
 * }}
 */
export function checkDecisionsDir(dir) {
  const errors = [];
  const records = [];

  const fail = (file, message) => errors.push(`${file}: ${message}`);

  if (!fs.existsSync(dir)) {
    errors.push(`${dir}: not found — the decision log needs its directory`);
    return {errors, records};
  }

  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith('.md')) continue;
    const filePath = path.join(dir, entry);
    // Normalize CRLF so a Windows-edited .md cannot smuggle a trailing `\\r`
    // into the Status capture and false-fail the superseded-status check.
    const content = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
    const lines = content.split('\n');

    // Every file: relative links must resolve to an existing file.
    // HTML comments (e.g. the template's status hint), fenced code blocks
    // (e.g. ADR 0029's status-line examples) and inline code spans (format
    // descriptions like `[NNNN](target-file.md)`) are ignored.
    const visible = content
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/```[\s\S]*?(?:```|$)/g, '')
      .replace(/`[^`\n]*`/g, '');
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

    const fields = parseStatusBlock(lines);
    const status = fields.get('Status')?.[0] ?? '';
    const superseded = status.match(supersededPattern);
    if (status.startsWith('superseded by') && !superseded) {
      fail(
        entry,
        `malformed status: "${status}" (expected "superseded by [NNNN](./NNNN-slug.md)")`
      );
    } else if (superseded) {
      const target = path.resolve(dir, superseded[2]);
      if (!fs.existsSync(target)) fail(entry, `superseded-by target missing: ${superseded[2]}`);
    }

    records.push({file: entry, number: fileMatch[1], status, fields});
  }

  // ADR 0029: `Amends:` / `Amended:` status lines — machine-readable amendment
  // bookkeeping. Reciprocity is checked from both ends so a one-sided link is
  // caught whichever record the author edited.
  const byNumber = new Map(records.map(record => [record.number, record]));
  // An `Amended:` line without links is valid only as the documented date
  // declaration (2026-09-16 — what changed); anything else link-free, and any
  // `Amends:` value with no record link at all, is a declared-but-empty field.
  const dateDeclarationPattern = /^\d{4}-\d{2}-\d{2}\s+—\s+\S/;
  for (const record of records) {
    for (const field of ['Amends', 'Amended']) {
      for (const value of record.fields.get(field) ?? []) {
        const targets = linkTargets(value);
        if (targets.length === 0) {
          if (field === 'Amends' || !dateDeclarationPattern.test(value)) {
            fail(
              record.file,
              `${field}: "${value}" declares no amendment target — link a record with ` +
                `[NNNN](./NNNN-slug.md), or (Amended only) use "YYYY-MM-DD — what changed"`
            );
          }
          continue;
        }
        for (const {num, path: target} of targets) {
          if (num === record.number) {
            fail(record.file, `${field} links to itself`);
            continue;
          }
          const resolved = path.resolve(dir, target);
          const targetFile = path.basename(resolved);
          if (!fs.existsSync(resolved)) {
            fail(record.file, `${field}: target missing: ${target}`);
            continue;
          }
          // A target must be one of the parsed records inside this directory —
          // a basename that merely looks like NNNN-slug (or a path outside the
          // dir) must not associate with an ADR number below.
          const isRecord =
            path.dirname(resolved) === dir &&
            targetFile !== INDEX &&
            targetFile !== TEMPLATE &&
            records.some(r => r.file === targetFile);
          if (!isRecord) {
            fail(record.file, `${field}: ${target} is not a decision record`);
            continue;
          }
          if (targetFile.slice(0, 4) !== num) {
            fail(
              record.file,
              `${field}: link [${num}] does not match the target filename (${target})`
            );
            continue;
          }
          const back = field === 'Amends' ? 'Amended' : 'Amends';
          const backValues = byNumber.get(num)?.fields.get(back) ?? [];
          const backNums = backValues.flatMap(v => linkTargets(v).map(t => t.num));
          if (!backNums.includes(record.number)) {
            fail(
              record.file,
              `${field} ${targetFile} is not reciprocated — ${targetFile} needs a "${back}:" ` +
                `link back to [${record.number}] (ADR 0029: X ${field} Y ⇔ Y ${back} X)`
            );
          }
        }
      }
    }
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
  const indexPath = path.join(dir, INDEX);
  if (!fs.existsSync(indexPath)) {
    errors.push(`${INDEX} not found at ${indexPath} — the decision log needs its index`);
  } else {
    const indexContent = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');
    for (const record of records) {
      if (!indexContent.includes(record.file)) {
        fail(record.file, `not listed in ${INDEX} (add it to the steering or historical list)`);
      }
    }
  }

  return {errors, records};
}

export function main() {
  if (!fs.existsSync(decisionsDir)) {
    console.error(`docs/decisions/ not found at ${decisionsDir}`);
    process.exit(1);
  }
  const {errors, records} = checkDecisionsDir(decisionsDir);
  if (errors.length > 0) {
    console.error('✗ Decision log check failed:');
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }
  console.log(
    `✓ docs/decisions: ${records.length} records, no duplicate numbers, all links, statuses and amendments OK`
  );
}

const isMain = process.argv[1] && path.basename(process.argv[1]) === 'check-decisions.mjs';
if (isMain) {
  main();
}
