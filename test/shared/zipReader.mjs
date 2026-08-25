// test/shared/zipReader.mjs — Minimal pure-Node ZIP reader used by the
// createZip unit tests.  Parses the end-of-central-directory record and the
// central directory to list entry names and decompress entry contents, so the
// tests make no assumption about `unzip` being installed (cross-platform).

import zlib from 'zlib';

/**
 * List the entries of a ZIP buffer: [{name, method, localOffset, compSize}].
 *
 * @param {Buffer} buf
 * @returns {{
 *   name: string;
 *   method: number;
 *   localOffset: number;
 *   compSize: number;
 * }[]}
 */
export function listZipEntries(buf) {
  // End of central directory: signature 0x06054b50, within the last 64 KiB.
  let eocd = -1;
  const start = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= start; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('no end-of-central-directory record');

  const cdOffset = buf.readUInt32LE(eocd + 16);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const entries = [];
  let p = cdOffset;
  const end = cdOffset + cdSize;
  while (p < end) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory signature');
    const method = buf.readUInt16LE(p + 10);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    // archiver writes data-descriptor zips: the local header's sizes are zero
    // and the real compressed size lives only in the central directory.
    const compSize = buf.readUInt32LE(p + 20);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.push({name, method, localOffset, compSize});
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * Decompress one entry (by name) to its original content.
 *
 * @param {Buffer} buf
 * @param {{
 *   name: string;
 *   method: number;
 *   localOffset: number;
 *   compSize: number;
 * }} entry
 * @returns {Buffer}
 */
export function readZipEntry(buf, entry) {
  const nameLen = buf.readUInt16LE(entry.localOffset + 26);
  const extraLen = buf.readUInt16LE(entry.localOffset + 28);
  const dataStart = entry.localOffset + 30 + nameLen + extraLen;
  const data = buf.subarray(dataStart, dataStart + entry.compSize);
  if (entry.method === 8) return zlib.inflateRawSync(data); // deflate
  if (entry.method === 0) return data; // stored
  throw new Error(`unsupported compression method ${entry.method}`);
}
