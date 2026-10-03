// test/shared/webUiSelector.mjs — the CSS selector subset the installer
// fragments actually use.
//
// The call sites are enumerable and closed: a tag, `.class`, `#id`, `[attr]`
// and `[attr="v"]`, compounds of those, the descendant and `>` combinators,
// and a leading `:scope`. That is the whole surface — so this is a matcher for
// those forms, not a CSS engine. Anything richer would be untested code.
//
// parseSelector/parseCompound are hand-rolled for the same reason the markup
// parser is: an optional quoted value inside a bracket group is the shape the
// security plugin rejects as ReDoS-prone.

/**
 * Split `sel` into `{tokens, scoped}`: `tokens` is `[{compound, combinator}]`
 * where `combinator` is how that step is reached from the previous one (' ' or
 * '>'; `null` for the first). A leading `:scope` is reported through `scoped`
 * rather than kept as a compound, and a leading `>` lands on the first token so
 * `:scope > .success-banner` can be anchored on the query's own element.
 */
export function parseSelector(sel) {
  let s = String(sel).trim();
  let scoped = false;
  if (/^:scope\b/.test(s)) {
    scoped = true;
    s = s.replace(/^:scope\b/, '').trim();
  }
  const tokens = [];
  let pending = null;
  while (s.length) {
    let m;
    if ((m = /^\s*>\s*/.exec(s))) {
      pending = '>';
      s = s.slice(m[0].length);
    } else if ((m = /^\s+/.exec(s))) {
      pending = pending || ' ';
      s = s.slice(m[0].length);
    } else if ((m = /^[^\s>]+/.exec(s))) {
      tokens.push({compound: m[0], combinator: pending || (tokens.length ? ' ' : null)});
      pending = null;
      s = s.slice(m[0].length);
    } else {
      s = s.slice(1);
    }
  }
  return {tokens, scoped};
} /**
 * Split a compound selector (`.a.b[attr="v"]#id span`) into its parts. Also
 * hand-rolled: attribute selectors need an optional quoted value inside a
 * bracket group, the same shape the security plugin rejects as ReDoS-prone.
 */
function parseCompound(compound) {
  const parts = {tag: null, classes: [], id: null, attrs: []};
  let i = 0;
  while (i < compound.length) {
    const ch = compound[i];
    if (ch === '*') {
      i++;
    } else if (ch === '.' || ch === '#') {
      let j = i + 1;
      while (j < compound.length && /[-\w]/.test(compound[j])) j++;
      if (ch === '.') parts.classes.push(compound.slice(i + 1, j));
      else parts.id = compound.slice(i + 1, j);
      i = j;
    } else if (ch === '[') {
      const close = compound.indexOf(']', i);
      const body = compound.slice(i + 1, close === -1 ? compound.length : close);
      const eq = body.indexOf('=');
      if (eq === -1) {
        parts.attrs.push({name: body.trim(), value: null});
      } else {
        const lhs = body.slice(0, eq).trim();
        let value = body.slice(eq + 1).trim();
        const first = value[0];
        if ((first === '"' || first === "'") && value.endsWith(first)) value = value.slice(1, -1);
        parts.attrs.push({name: lhs.replace(/[~|^$*]$/, ''), value});
      }
      i = close === -1 ? compound.length : close + 1;
    } else {
      let j = i;
      while (j < compound.length && /[a-zA-Z0-9-]/.test(compound[j])) j++;
      if (j === i) {
        i++;
        continue;
      }
      parts.tag = compound.slice(i, j);
      i = j;
    }
  }
  return parts;
}

/** Match one compound selector against an element. */
function matchesCompound(el, compound) {
  if (!el || el.nodeType !== 1) return false;
  const parts = typeof compound === 'string' ? parseCompound(compound) : compound;
  if (parts.tag && el.tagName !== parts.tag.toUpperCase()) return false;
  if (parts.id !== null && el.getAttribute('id') !== parts.id) return false;
  for (const cls of parts.classes) {
    if (!el.classList.contains(cls)) return false;
  }
  for (const attr of parts.attrs) {
    const actual = el.getAttribute(attr.name);
    if (actual === null) return false;
    if (attr.value !== null && actual !== attr.value) return false;
  }
  return true;
}

/** Match a parsed selector chain against `el`, walking right to left. */
export function matchesSteps(el, steps) {
  if (!steps || !steps.length || !el || el.nodeType !== 1) return false;
  if (!matchesCompound(el, steps[steps.length - 1].compound)) return false;
  let node = el;
  for (let i = steps.length - 1; i > 0; i--) {
    const combinator = steps[i].combinator;
    const compound = steps[i - 1].compound;
    let parent = node.parentNode;
    if (combinator === '>') {
      if (!parent || !matchesCompound(parent, compound)) return false;
      node = parent;
    } else {
      while (parent && !matchesCompound(parent, compound)) parent = parent.parentNode;
      if (!parent) return false;
      node = parent;
    }
  }
  return true;
}
