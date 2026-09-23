#!/usr/bin/env node

/**
 * tools/make-installer-icon.mjs — build the Windows icon resource for the
 * installer/helper PEs from the project's own favicon artwork.
 *
 * Why this exists: the installer and helper shipped with **no** icon resource
 * at all (no `.ico` in the repo, no `ICON` statement in either `.rc`), so both
 * PEs rendered as a generic blank document in Explorer/the taskbar. A stripped,
 * unsigned PE with no icon and no publisher is a weak-signal profile for
 * antivirus machine learning (see docs/DEVELOPING.md → AV false positives), and
 * it is a plain UX defect besides.
 *
 * The source is `tools/publish/remote-ui/logos/favicon.svg` — the updater's own
 * logo — so the binary carries the same mark as the UI. The SVG is a 24×24
 * **stroked** glyph (`fill="none"`, `stroke-width: 2.2`), which is unreadable
 * at 16 px on a transparent tile, so the glyph is re-rendered per size over a
 * rounded brand-blue tile with a white stroke, and the stroke width is floored
 * so small sizes stay legible. This is an adaptation of the artwork, not a
 * different mark: same path data, same `#2563eb`.
 *
 * Rendering uses the repo's existing `puppeteer-core` devDependency and a
 * locally installed Chrome/Chromium/Edge (this is a build-time asset tool, run
 * by hand when the artwork changes — never in CI, never on every build). The
 * packed file is committed: `installer/src/installer.ico`.
 *
 * ICO layout, deliberately conservative for maximum compatibility:
 *
 * - 16/24/32/48 → uncompressed 32-bit BMP entries (BITMAPINFOHEADER + bottom-up
 *   BGRA + the AND mask), the format every Windows version and every shell/AV
 *   parser handles. These are also the sizes Explorer/taskbar/ Alt-Tab actually
 *   ask for.
 * - 128/256 → PNG-compressed entries (Vista+), which keep the committed file
 *   small while still giving Explorer a crisp large/extra-large view.
 *
 * Every entry is a real cost: both PE version resources embed the whole file,
 * so the icon is ~40 % of a non-standard 64 px entry's worth of bytes on every
 * download. Sizes are therefore limited to the ones a shell asks for.
 *
 * Usage: node tools/make-installer-icon.mjs # write the default path node
 * tools/make-installer-icon.mjs --out /tmp/x.ico # write somewhere else node
 * tools/make-installer-icon.mjs --chrome <path> # explicit browser
 * PUPPETEER_EXECUTABLE_PATH=<path> node tools/make-installer-icon.mjs
 *
 * Exits non-zero with an actionable message when no browser is found.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {fileURLToPath} from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SVG_PATH = path.join(REPO_ROOT, 'tools', 'publish', 'remote-ui', 'logos', 'favicon.svg');
const DEFAULT_OUT = path.join(REPO_ROOT, 'installer', 'src', 'installer.ico');

/** The favicon's path data, its 24×24 box, and the stroke width it specifies. */
const GLYPH = {
  d: 'M12 2 2 7l10 5 10-5zM2 17l10 5 10-5M2 12l10 5 10-5',
  viewBox: 24,
  strokeWidth: 2.2,
};
const BRAND = '#2563eb';
/** Glyph occupies this share of the tile (the rest is breathing room). */
const GLYPH_COVERAGE = 0.66;
/** Never let the stroke render thinner than this many device pixels. */
const MIN_STROKE_PX = 1.5;

const BMP_SIZES = [16, 24, 32, 48];
const PNG_SIZES = [128, 256];
const SIZES = [...BMP_SIZES, ...PNG_SIZES];

/** Candidate browser binaries, in preference order (env var wins). */
function findBrowser(explicit) {
  const candidates = [
    explicit,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    // Windows
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    // macOS
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    // Linux
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    'no Chrome/Chromium/Edge binary found — pass --chrome <path> or set\n' +
      'PUPPETEER_EXECUTABLE_PATH (checked: ' +
      candidates.join(', ') +
      ')'
  );
}

/**
 * Render one size and return its raw RGBA bytes (straight from the canvas, so
 * no PNG decoding is needed for the BMP entries).
 *
 * @param {import('puppeteer-core').Page} page
 * @param {number} size
 * @returns {Promise<Uint8Array>}
 */
async function renderRgba(page, size) {
  const base64 = await page.evaluate(
    (size, glyph, brand, coverage, minStroke) => {
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');

      // Rounded brand tile.
      const radius = size * 0.22;
      ctx.fillStyle = brand;
      ctx.beginPath();
      ctx.moveTo(radius, 0);
      ctx.arcTo(size, 0, size, size, radius);
      ctx.arcTo(size, size, 0, size, radius);
      ctx.arcTo(0, size, 0, 0, radius);
      ctx.arcTo(0, 0, size, 0, radius);
      ctx.closePath();
      ctx.fill();

      // Glyph, centered and scaled so it keeps a margin inside the tile.
      const scale = (size * coverage) / (glyph.viewBox - 4); // glyph spans 2..22
      ctx.translate(size / 2, size / 2);
      ctx.scale(scale, scale);
      ctx.translate(-glyph.viewBox / 2, -glyph.viewBox / 2);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = Math.max(glyph.strokeWidth, minStroke / scale);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke(new Path2D(glyph.d));

      const {data} = ctx.getImageData(0, 0, size, size);
      let binary = '';
      for (let i = 0; i < data.length; i++) binary += String.fromCharCode(data[i]);
      return btoa(binary);
    },
    size,
    GLYPH,
    BRAND,
    GLYPH_COVERAGE,
    MIN_STROKE_PX
  );
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

/** A 32-bit BMP entry: BITMAPINFOHEADER + bottom-up BGRA + the AND mask. */
function bmpEntry(rgba, size) {
  const headerSize = 40;
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    // BMP rows are bottom-up; source rows are top-down.
    const src = (size - 1 - y) * size * 4;
    const dst = y * size * 4;
    for (let x = 0; x < size; x++) {
      pixels[dst + x * 4] = rgba[src + x * 4 + 2]; // B
      pixels[dst + x * 4 + 1] = rgba[src + x * 4 + 1]; // G
      pixels[dst + x * 4 + 2] = rgba[src + x * 4]; // R
      pixels[dst + x * 4 + 3] = rgba[src + x * 4 + 3]; // A
    }
  }
  // AND mask: 1 bpp, 4-byte aligned rows. All-zero = "use the alpha channel".
  const maskStride = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskStride * size);

  const header = Buffer.alloc(headerSize);
  header.writeUInt32LE(headerSize, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // height doubled: XOR + AND images
  header.writeUInt16LE(1, 12); // planes
  header.writeUInt16LE(32, 14); // bits per pixel
  header.writeUInt32LE(0, 16); // BI_RGB
  header.writeUInt32LE(pixels.length + mask.length, 20); // biSizeImage
  return Buffer.concat([header, pixels, mask]);
}

/** A PNG entry (Vista+), filter 0 on every scanline — small and dependency-free. */
function pngEntry(rgba, size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter type: None
    rgba.copy ?
      rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
    : Buffer.from(rgba.subarray(y * size * 4, (y + 1) * size * 4)).copy(
        raw,
        y * (size * 4 + 1) + 1
      );
  }

  const crcTable = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
    return table;
  })();
  const crc32 = buf => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, {level: 9})),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Pack entries into an ICO container (ICONDIR + ICONDIRENTRY[] + images). */
function packIco(entries) {
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0); // reserved
  dir.writeUInt16LE(1, 2); // type: icon
  dir.writeUInt16LE(entries.length, 4);

  let offset = 6 + entries.length * 16;
  const dirEntries = [];
  for (const {size, image} of entries) {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size; // 0 means 256
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0; // palette colors
    entry[3] = 0; // reserved
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(image.length, 8);
    entry.writeUInt32LE(offset, 12);
    dirEntries.push(entry);
    offset += image.length;
  }
  return Buffer.concat([dir, ...dirEntries, ...entries.map(e => e.image)]);
}

function parseArgs(argv) {
  const opts = {out: DEFAULT_OUT, chrome: ''};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out' && argv[i + 1]) opts.out = path.resolve(argv[++i]);
    else if (argv[i] === '--chrome' && argv[i + 1]) opts.chrome = argv[++i];
    else if (argv[i] === '--help') {
      console.log('Usage: node tools/make-installer-icon.mjs [--out <file.ico>] [--chrome <path>]');
      process.exit(0);
    } else {
      console.error(`unknown argument: ${argv[i]} (see --help)`);
      process.exit(2);
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(SVG_PATH)) {
    console.error(`source artwork not found: ${SVG_PATH}`);
    process.exit(1);
  }
  // The glyph data lives in this script; assert the artwork it came from still
  // contains it, so a swapped favicon is noticed instead of silently ignored.
  const svg = fs.readFileSync(SVG_PATH, 'utf-8');
  if (!svg.includes(GLYPH.d)) {
    console.error(
      `${path.relative(REPO_ROOT, SVG_PATH)} no longer contains the glyph this script\n` +
        'renders. Update GLYPH.d (and GLYPH.strokeWidth/viewBox) to the new artwork.'
    );
    process.exit(1);
  }

  const browserPath = findBrowser(opts.chrome);
  const {default: puppeteer} = await import('puppeteer-core');
  console.log(`icon: rendering ${SIZES.join('/')} px from ${path.relative(REPO_ROOT, SVG_PATH)}`);
  console.log(`icon: browser ${browserPath}`);

  const browser = await puppeteer.launch({
    executablePath: browserPath,
    headless: true,
    args: ['--no-sandbox', '--hide-scrollbars', '--force-device-scale-factor=1'],
  });
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><meta charset="utf-8"><title>icon</title>');

    const entries = [];
    for (const size of SIZES) {
      const rgba = await renderRgba(page, size);
      const bmp = BMP_SIZES.includes(size);
      entries.push({size, image: bmp ? bmpEntry(rgba, size) : pngEntry(rgba, size)});
      console.log(
        `icon:   ${String(size).padStart(3)} px  ${bmp ? 'BMP' : 'PNG'}  ${entries.at(-1).image.length} bytes`
      );
    }

    const ico = packIco(entries);
    fs.mkdirSync(path.dirname(opts.out), {recursive: true});
    fs.writeFileSync(opts.out, ico);
    console.log(
      `icon: wrote ${path.relative(REPO_ROOT, opts.out)} (${ico.length} bytes, ${entries.length} entries)`
    );
  } finally {
    await browser.close();
  }
}

await main();
