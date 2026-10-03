// test/shared/webUiMarkup.mjs — tolerant HTML handling for the web-UI harness.
//
// Two jobs, both small enough to read in one sitting:
//   * parseAttrs() reads an HTML attribute string (hand-rolled: an attribute
//     pattern needs alternation inside an optional group, which is exactly the
//     shape eslint's security plugin refuses as a potential ReDoS);
//   * tokenizeMarkup()/parseHtml() turn a markup string into element stubs, and
//     serialize() turns them back.
//
// Both are needed because the render path injects markup as strings — badges,
// the progress bar, the open-folder buttons — rather than building elements,
// so `innerHTML` assignments have to become real nodes.

const NAME_CHAR = /[-a-zA-Z0-9_:.]/;
const WS = /\s/;

/**
 * Parse an HTML attribute string into a Map (lowercased names). Hand-rolled
 * rather than regex-driven: an attribute pattern needs alternation inside an
 * optional group, which is exactly the shape eslint's security plugin (rightly)
 * refuses as a potential ReDoS.
 */
function parseAttrs(source) {
  const attrs = new Map();
  if (!source) return attrs;
  let i = 0;
  const n = source.length;
  while (i < n) {
    while (i < n && (WS.test(source[i]) || source[i] === '/')) i++;
    const nameStart = i;
    while (i < n && NAME_CHAR.test(source[i])) i++;
    if (i === nameStart) {
      i++;
      continue;
    }
    const name = source.slice(nameStart, i).toLowerCase();
    while (i < n && WS.test(source[i])) i++;
    if (source[i] !== '=') {
      attrs.set(name, '');
      continue;
    }
    i++;
    while (i < n && WS.test(source[i])) i++;
    const quote = source[i];
    if (quote === '"' || quote === "'") {
      const end = source.indexOf(quote, i + 1);
      attrs.set(name, decodeEntities(source.slice(i + 1, end === -1 ? n : end)));
      i = end === -1 ? n : end + 1;
    } else {
      const start = i;
      while (i < n && source[i] !== '>' && !WS.test(source[i])) i++;
      attrs.set(name, decodeEntities(source.slice(start, i)));
    }
  }
  return attrs;
}

const ENTITIES = {
  'amp': '&',
  'lt': '<',
  'gt': '>',
  'quot': '"',
  '#39': "'",
  'apos': "'",
  'nbsp': ' ',
};

/**
 * Minimal entity decode — enough for the em-dashes and ampersands the tab
 * emits.
 */
function decodeEntities(s) {
  return String(s).replace(/&(#\d+|#x[0-9a-fA-F]+|\w+);/g, (whole, name) => {
    if (Object.prototype.hasOwnProperty.call(ENTITIES, name)) return ENTITIES[name];
    if (name[0] === '#') {
      const code = name[1] === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return whole;
  });
}

/* ========================================================================
 * Tolerant HTML parser — for `innerHTML = '…'`, which is how the render path
 * injects badges, the progress bar and the open-folder buttons.
 * ======================================================================== */

const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
  // SVG children the icons use — self-closed in the tab's icon constants.
  'path',
  'polyline',
  'circle',
  'line',
  'rect',
]);

/**
 * Split markup into `{type: 'text'|'open'|'close'}` tokens. Hand-rolled for the
 * same reason as parseAttrs: tag scanning needs quote-aware alternation inside
 * a repeated group, which the security plugin flags as ReDoS-prone. Quote-aware
 * means an attribute value may legally contain '>'.
 */
function tokenizeMarkup(html) {
  const tokens = [];
  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      tokens.push({type: 'text', value: html.slice(i)});
      break;
    }
    if (lt > i) tokens.push({type: 'text', value: html.slice(i, lt)});
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (html[lt + 1] === '!' || html[lt + 1] === '?') {
      const end = html.indexOf('>', lt);
      i = end === -1 ? n : end + 1;
      continue;
    }
    let j = lt + 1;
    let quote = null;
    while (j < n) {
      const ch = html[j];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        break;
      }
      j++;
    }
    const inner = html.slice(lt + 1, j);
    i = j + 1;
    if (inner[0] === '/') {
      tokens.push({type: 'close', name: inner.slice(1).trim()});
      continue;
    }
    const open = /^([a-zA-Z][a-zA-Z0-9:_-]*)/.exec(inner);
    if (!open) continue;
    tokens.push({type: 'open', name: open[1], attrs: inner.slice(open[1].length)});
  }
  return tokens;
}

/**
 * Parse `html` into element stubs under a detached root. Whitespace-only text
 * between tags is dropped so `text()` reads like the rendered UI rather than
 * like the source indentation.
 */
export function parseHtml(html, factory) {
  const root = factory('div');
  const stack = [root];
  const top = () => stack[stack.length - 1];
  for (const token of tokenizeMarkup(String(html))) {
    if (token.type === 'text') {
      if (token.value.trim()) top().appendChild(factory('#text', decodeEntities(token.value)));
      continue;
    }
    if (token.type === 'close') {
      // Pop to the matching open tag, tolerating unclosed children.
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tagName === token.name.toUpperCase()) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const selfClosing = /\/\s*$/.test(token.attrs) || VOID_TAGS.has(token.name.toLowerCase());
    const el = factory(token.name, parseAttrs(token.attrs));
    top().appendChild(el);
    if (!selfClosing) stack.push(el);
  }
  return root;
}

/** Serialize an element tree back to HTML (assertions and debugging). */
export function serialize(node) {
  if (node.nodeType === 3) return node.data;
  const attrs = [];
  for (const [name, value] of node.attributes) {
    attrs.push(value === '' ? ` ${name}` : ` ${name}="${value}"`);
  }
  const inner = node.childNodes.map(serialize).join('');
  if (VOID_TAGS.has(node.tagName.toLowerCase()))
    return `<${node.tagName.toLowerCase()}${attrs.join('')}>`;
  return `<${node.tagName.toLowerCase()}${attrs.join('')}>${inner}</${node.tagName.toLowerCase()}>`;
}
