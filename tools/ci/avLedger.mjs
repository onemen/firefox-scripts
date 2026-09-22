// SPDX-License-Identifier: MIT
//
// tools/ci/avLedger.mjs — the pure half of the AV verdict ledger.
//
// Why a ledger exists: an AV verdict is evidence about ONE byte sequence, and a
// rebuild produces a different sequence.  A Microsoft/WDSI submission ("your
// app was incorrectly detected") therefore clears exactly the hash it was
// submitted for — the fresh build that follows needs its own look, and the
// publish gate's warn band (1-2 engines, below the fail threshold) is easy to
// lose in a run log.  The ledger keeps the per-hash record (engine counts,
// flagging engines, verdict, when it was seen) so a reviewer can answer "has
// this exact binary been checked, by whom, and what did they say?" without
// reading old run logs, and so the `av-watchdog` re-scan and the publish path
// compare against something durable instead of re-deriving it.
//
// No imports, no I/O: every function here is pure, so the shapes the publish
// path and the watchdog write are unit-tested directly.

/** Ledger file format version. */
export const LEDGER_VERSION = 1;
/** Label on the watchdog's issues; the dedupe key. */
export const AV_WATCHDOG_LABEL = 'av-watchdog';
/** Title of the single status meta issue. */
export const META_ISSUE_TITLE = '[av-watchdog] published binaries';
/** Severity order used by tables and summaries. */
export const VERDICT_ORDER = ['fail', 'warn', 'clean', 'unknown'];

/**
 * One artifact's record: the verdict bands it was seen in, the engine counts
 * behind them, and when it was first and last observed.
 *
 * @typedef {object} LedgerEntry
 * @property {string} file artifact name (not a path)
 * @property {string} sha256
 * @property {number | null} size
 * @property {'fail' | 'warn' | 'clean' | 'unknown'} verdict worst band ever
 *   seen
 * @property {number | null} malicious
 * @property {number | null} suspicious
 * @property {number | null} harmless
 * @property {number | null} undetected
 * @property {string[]} flags engines reporting malicious
 * @property {number | null} threshold
 * @property {string} source who recorded it (`publish`, `av-watchdog`, `local`)
 * @property {string} firstSeen
 * @property {string} lastSeen
 * @property {number} observations
 * @property {'fail' | 'warn' | 'clean' | 'unknown'} [lastVerdict] newest
 *   observation
 * @property {string} [reason] why a verdict is unknown
 */

/**
 * The whole ledger: a sha256 → entry map plus format metadata.
 *
 * @typedef {object} Ledger
 * @property {number} version
 * @property {string} updated
 * @property {Object<string, LedgerEntry>} files
 */

/**
 * Published binary names on the gh-pages surface, e.g. `installer_win.exe`,
 * `helper_mac`, `installer_win-dev.exe`. `.sha256` sidecars, zips and
 * `hashes.json` are not binaries — the sidecars are hash _text_, and a scan of
 * them would be noise.
 */
const BINARY_RE = /^(installer|helper)_(win|linux|linux_aarch64|mac)(-dev)?(\.exe)?$/;

/**
 * @param {string[]} names file names from a published-surface listing
 * @returns {string[]} the names worth scanning, sorted for a stable report
 */
export function pickPublishedBinaries(names) {
  return (names ?? []).filter(n => BINARY_RE.test(n)).sort();
}

/**
 * Release tags whose attached assets serve the same kind of binaries as the
 * Pages surface: the `latest` release, and every date-stamped per-component
 * snapshot (`installer-<date>`, ADR 0019). A binary a user can download is a
 * binary that has to be watched, whichever surface serves it.
 *
 * @param {string} tag release tag name
 * @returns {boolean}
 */
export function isWatchedRelease(tag) {
  return tag === 'latest' || /^installer-\d{4}-\d{2}-\d{2}$/.test(tag ?? '');
}

/**
 * True for a name that belongs to the dev channel (`-dev` artifact suffix).
 *
 * @param {string} name
 * @returns {boolean}
 */
export function isDevBinary(name) {
  return /-dev(\.exe)?$/.test(name);
}

/**
 * Normalize one scan result into a ledger entry. Counts are kept even when they
 * are zero (a clean verdict of "0 of 72 engines" is the evidence a reviewer
 * wants), and `reason` carries why a verdict is unknown.
 *
 * @param {object} r
 * @param {string} r.file name (not a path — the ledger is about the artifact)
 * @param {string} r.sha256
 * @param {number} [r.size] bytes
 * @param {'fail' | 'warn' | 'clean' | 'unknown'} r.verdict
 * @param {{
 *   malicious?: number;
 *   suspicious?: number;
 *   harmless?: number;
 *   undetected?: number;
 * }} [r.stats]
 * @param {string[]} [r.flags] engines reporting malicious
 * @param {number} [r.threshold]
 * @param {string} r.source who recorded it (`publish`, `av-watchdog`, `local`)
 * @param {string} r.at ISO timestamp
 * @param {string} [r.reason] why the verdict is unknown
 * @returns {LedgerEntry} ledger entry
 */
export function ledgerEntry({
  file,
  sha256,
  size,
  verdict,
  stats,
  flags,
  threshold,
  source,
  at,
  reason,
}) {
  if (!sha256 || !/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`bad sha256: ${sha256}`);
  if (!VERDICT_ORDER.includes(verdict)) throw new Error(`bad verdict: ${verdict}`);
  const entry = {
    file,
    sha256,
    size: size ?? null,
    verdict,
    malicious: stats?.malicious ?? null,
    suspicious: stats?.suspicious ?? null,
    harmless: stats?.harmless ?? null,
    undetected: stats?.undetected ?? null,
    flags: [...(flags ?? [])].sort(),
    threshold: threshold ?? null,
    source,
    firstSeen: at,
    lastSeen: at,
    observations: 1,
  };
  if (reason) entry.reason = reason;
  return entry;
}

/**
 * Merge fresh entries into a ledger, keyed by sha256. An already-known hash
 * keeps its firstSeen and keeps its strongest verdict: a clean re-check of a
 * hash a previous observation flagged does NOT erase the flag (the engines may
 * simply have reclassified the same bytes — the record of both matters), while
 * `lastVerdict` tracks the newest observation.
 *
 * @param {Ledger | null | undefined} ledger previous ledger
 * @param {LedgerEntry[]} entries from ledgerEntry()
 * @param {{at: string}} opts
 * @returns {Ledger}
 */
export function mergeLedger(ledger, entries, {at}) {
  const files = {...(ledger?.files ?? {})};
  for (const entry of entries) {
    const prev = files[entry.sha256];
    if (!prev) {
      files[entry.sha256] = entry;
      continue;
    }
    const rank = v => VERDICT_ORDER.indexOf(v);
    const worst = rank(entry.verdict) < rank(prev.verdict) ? entry.verdict : prev.verdict;
    files[entry.sha256] = {
      ...entry,
      verdict: worst,
      firstSeen: prev.firstSeen ?? entry.firstSeen,
      observations: (prev.observations ?? 1) + 1,
      lastVerdict: entry.verdict,
      // Keep every engine that was ever reported: the union is what a WDSI
      // submission lists, and dropping a flag the moment one scan goes quiet
      // would erase the evidence. Sorted only so the ledger is stable across
      // runs — this is not a recency order.
      flags: [...new Set([...(entry.flags ?? []), ...(prev.flags ?? [])])].sort(),
    };
    if (prev.reason && !entry.reason) delete files[entry.sha256].reason;
  }
  return {version: LEDGER_VERSION, updated: at, files};
}

/**
 * @param {Ledger | null | undefined} ledger
 * @returns {{
 *   fail: number;
 *   warn: number;
 *   clean: number;
 *   unknown: number;
 *   total: number;
 * }}
 */
export function ledgerStats(ledger) {
  const counts = {fail: 0, warn: 0, clean: 0, unknown: 0, total: 0};
  for (const entry of Object.values(ledger?.files ?? {})) {
    if (entry.verdict in counts) counts[entry.verdict] += 1;
    counts.total += 1;
  }
  return counts;
}

/** `sha256` prefix used in issue titles (`abcdef12…`). */
export function shortHash(sha256) {
  return `${sha256.slice(0, 12)}…`;
}

/** `4 malicious / 0 suspicious / 68 harmless / 0 undetected` (or `—`). */
export function engineCounts(entry) {
  if (entry.malicious === null || entry.malicious === undefined) return '—';
  return (
    `${entry.malicious} malicious / ${entry.suspicious ?? 0} suspicious / ` +
    `${entry.harmless ?? 0} harmless / ${entry.undetected ?? 0} undetected`
  );
}

/**
 * Markdown table of a ledger, worst verdict first — the body of the meta issue
 * and of a publish run summary.
 *
 * @param {Ledger | null | undefined} ledger
 * @returns {string}
 */
export function ledgerTable(ledger) {
  const entries = Object.values(ledger?.files ?? {}).sort(
    (a, b) =>
      VERDICT_ORDER.indexOf(a.verdict) - VERDICT_ORDER.indexOf(b.verdict) ||
      a.file.localeCompare(b.file)
  );
  const rows = [
    '| verdict | artifact | engines | flagged by | first seen | last checked |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const e of entries) {
    rows.push(
      `| ${e.verdict} | \`${e.file}\` \`${shortHash(e.sha256)}\` | ${engineCounts(e)} | ` +
        `${e.flags.length > 0 ? e.flags.join(', ') : '—'} | ${e.firstSeen ?? '—'} | ` +
        `${e.lastSeen ?? '—'} |`
    );
  }
  if (entries.length === 0) rows.push('| — | (no observations yet) | — | — | — | — |');
  return rows.join('\n');
}

/**
 * Deduped issue title for one flagged artifact: the hash is part of the title,
 * so a rebuild that clears the flag does not collide with the old issue.
 *
 * @param {LedgerEntry} entry
 * @returns {string}
 */
export function issueTitleFor(entry) {
  return `[av-watchdog] ${entry.file} ${shortHash(entry.sha256)} ${entry.verdict}`;
}

/**
 * @param {LedgerEntry} entry
 * @param {string} runUrl
 * @returns {string} issue body
 */
export function issueBodyFor(entry, runUrl) {
  return [
    `A **published** artifact is flagged by VirusTotal: \`${entry.file}\` ` + `\`${entry.sha256}\``,
    '',
    `- verdict: **${entry.verdict}** (threshold ${entry.threshold ?? '—'})`,
    `- engines: ${engineCounts(entry)}`,
    `- flagged by: ${entry.flags.length > 0 ? entry.flags.join(', ') : '—'}`,
    `- first seen: ${entry.firstSeen ?? '—'}`,
    `- last checked: ${entry.lastSeen ?? '—'} (run ${runUrl})`,
    '',
    'The publish gate only judges the bytes it is about to upload, so a verdict can flip **after**',
    'a clean publish. These are the bytes users download today.',
    '',
    'Next steps: confirm against the ledger, then either re-report to Microsoft (see',
    'docs/DEVELOPING.md → AV false positives) or publish a rebuilt/signed artifact once the',
    'publish gate agrees.',
  ].join('\n');
}

/**
 * The hash of a published file whose flag has cleared — used to close a stale
 * watchdog issue automatically.
 *
 * @param {Ledger | null | undefined} ledger
 * @param {string} sha256
 * @returns {boolean}
 */
export function isCleared(ledger, sha256) {
  const entry = ledger?.files?.[sha256];
  if (!entry) return false;
  // A merged entry keeps the WORST verdict it ever saw (that is the record), so
  // "clean now" is what the LAST observation said; a hash seen only once has no
  // lastVerdict yet.
  return (entry.lastVerdict ?? entry.verdict) === 'clean';
}
