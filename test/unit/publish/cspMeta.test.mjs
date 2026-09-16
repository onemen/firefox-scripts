// test/unit/publish/cspMeta.test.mjs — pins the Content-Security-Policy meta
// declared on the two shipped HTML surfaces (the audit's P3: neither page
// declared a CSP, so both ran under the browser default).
//
// The policies are deliberately closed:
// - installer page (installer/web/index.html): strictly same-origin — one
//   external stylesheet, one external script, same-origin logos, fetches to
//   /api/* (ADR 0010 token model).
// - updater tab (tools/publish/remote-ui/updater.html): scripts/CSS/images
//   come only from its own chrome://firefox-scripts package; package
//   downloads (zips, helper, installer) go through the privileged Downloads
//   API — not the document — so no connect-src for remote hosts is needed.
//
// These tests fail when someone adds an inline script, a new external host,
// or drops the meta — i.e. when the page's load surface drifts away from the
// policy written here.

import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {test} from 'node:test';

const ROOT = join(import.meta.dirname, '..', '..', '..');

const INSTALLER_HTML = readFileSync(join(ROOT, 'installer/web/index.html'), 'utf8');
const UPDATER_HTML = readFileSync(join(ROOT, 'tools/publish/remote-ui/updater.html'), 'utf8');

/** Extract the policy string from the CSP meta tag of an HTML document. */
function cspOf(html, label) {
  const m = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/);
  assert.ok(m, `${label}: CSP meta tag is present`);
  return m[1];
}

function directive(policy, key) {
  for (const part of policy.split(';')) {
    const trimmed = part.trim();
    const sep = trimmed.indexOf(' ');
    if (sep === -1) continue;
    if (trimmed.slice(0, sep) !== key) continue;
    return trimmed.slice(sep + 1).trim();
  }
  return null;
}

test('installer page: CSP is present and strictly same-origin', () => {
  const policy = cspOf(INSTALLER_HTML, 'installer page');

  assert.equal(
    directive(policy, 'default-src'),
    "'self'",
    'default-src pins everything else to same-origin'
  );
  assert.equal(
    directive(policy, 'script-src'),
    "'self'",
    'scripts load only from the page origin (/script.js) — no inline, no eval'
  );
  assert.equal(
    directive(policy, 'style-src'),
    "'self'",
    'styles load only from the page origin (/style.css)'
  );
  assert.equal(
    directive(policy, 'img-src'),
    "'self'",
    'logos are same-origin static assets under /logos/'
  );
  assert.equal(
    directive(policy, 'connect-src'),
    "'self'",
    'API calls are same-origin /api/* (ADR 0010 session-token model)'
  );
  assert.equal(directive(policy, 'object-src'), "'none'", 'no plugin content');
  assert.equal(directive(policy, 'base-uri'), "'none'", 'no base-tag hijack');
  assert.equal(
    directive(policy, 'frame-ancestors'),
    null,
    'frame-ancestors is meta-ignored by spec (CSP3) — keeping it would imply false protection'
  );
  assert.equal(directive(policy, 'form-action'), "'none'", 'no form targets');
});

test('updater tab: CSP locks content to its own chrome:// package', () => {
  const policy = cspOf(UPDATER_HTML, 'updater tab');

  assert.equal(directive(policy, 'default-src'), "'none'", 'deny-by-default baseline');
  assert.match(
    directive(policy, 'script-src'),
    /chrome:\/\/firefox-scripts/,
    'scripts load only from the updater package (updater.js, updater-ui.js)'
  );
  assert.match(
    directive(policy, 'style-src'),
    /chrome:\/\/firefox-scripts/,
    'the generated updater.css ships in the same package'
  );
  assert.match(
    directive(policy, 'img-src'),
    /chrome:\/\/firefox-scripts/,
    'logos ship in the same package (logos/*.png, favicon.svg)'
  );
  assert.equal(
    directive(policy, 'connect-src'),
    "'none'",
    'no document-level network: package downloads go through the privileged Downloads API'
  );
  assert.equal(directive(policy, 'object-src'), "'none'", 'no plugin content');
  assert.equal(directive(policy, 'base-uri'), "'none'", 'no base-tag hijack');
  assert.equal(
    directive(policy, 'frame-ancestors'),
    null,
    'frame-ancestors is meta-ignored by spec (CSP3) — chrome pages cannot be embedded regardless'
  );
});

test('both pages stay free of inline handlers and inline scripts the CSP would block', () => {
  for (const [label, html] of [
    ['installer page', INSTALLER_HTML],
    ['updater tab', UPDATER_HTML],
  ]) {
    assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), `${label}: no inline <script> blocks`);
    assert.ok(
      !/\son(load|click|change|input|submit|error)\s*=\s*["']?/i.test(html),
      `${label}: no inline event handlers`
    );
  }
});

test('no script-src allows unsafe-inline or unsafe-eval on either page', () => {
  for (const [label, html] of [
    ['installer page', INSTALLER_HTML],
    ['updater tab', UPDATER_HTML],
  ]) {
    const policy = cspOf(html, label);
    const scriptSrc = directive(policy, 'script-src') || directive(policy, 'default-src');
    assert.ok(scriptSrc, `${label}: script-src or default-src is declared`);
    assert.ok(
      !/unsafe-inline|unsafe-eval/.test(policy),
      `${label}: no unsafe-inline / unsafe-eval anywhere in the policy`
    );
  }
});
