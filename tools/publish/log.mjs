// log.mjs — tiny colorized console helpers for the publish CLIs.
//
// No dependency: plain ANSI SGR escape codes. Colors are enabled only when
// stdout is a terminal AND the NO_COLOR convention is not set (see
// https://no-color.org), so piped/CI output stays clean and greppable.
// Windows 10+ enables VT processing automatically for Node's stdout.

const hasColor =
  process.stdout.isTTY === true &&
  process.env.NO_COLOR === undefined &&
  process.env.TERM !== 'dumb';

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

/** Wrap text in an ANSI color when output is a color-capable TTY. */
export function paint(...codes) {
  return text => (hasColor ? `${codes.join('')}${text}${C.reset}` : text);
}

export const bold = paint(C.bold);
export const dim = paint(C.dim);
export const red = paint(C.red);
export const green = paint(C.green);
export const yellow = paint(C.yellow);
export const blue = paint(C.blue);
export const magenta = paint(C.magenta);
export const cyan = paint(C.cyan);

/**
 * Section heading: a blank line, then a bold cyan title — the visual anchor
 * between the distinct phases of a publish run.
 */
export function section(title) {
  console.log(`\n${bold(cyan(title))}`);
}

/** First 12 chars of a 64-char hash, enough to eyeball equality. */
export function shortHash(hash) {
  return hash ? hash.slice(0, 12) : '(none)';
}

const quiet = process.argv.includes('--quiet');
const verbose = process.argv.includes('--verbose');

/** Log a line unless --quiet is passed. */
export function info(...args) {
  if (!quiet) console.log(...args);
}

/** Log a line only with --verbose (per-file zip listings, etc.). */
export function detail(...args) {
  if (!quiet && verbose) console.log(dim(args.join(' ')));
}

export function success(...args) {
  if (!quiet) console.log(green(args.join(' ')));
}

export function warn(...args) {
  if (!quiet) console.warn(yellow(args.join(' ')));
}

export function error(...args) {
  console.error(red(args.join(' ')));
}

export {quiet, verbose};
