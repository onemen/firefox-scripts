// test/unit/installer/webUiSandbox.test.mjs — the shared harness's own
// contract (test/shared/webUiSandbox.mjs).
//
// The installer-tab suites are only as trustworthy as the DOM they run against.
// The harness used to auto-create a blank element for any selector the tab
// asked for, which meant a selector that matches nothing in production still
// "worked" in a test — the fragment wrote its state to one stub and read it
// back from another.  These cases pin the replacement: the DOM is built from
// the shipped installer/web/index.html, and a selector either resolves to the
// real node or to null.

import {test} from 'node:test';
import assert from 'node:assert/strict';

import {loadWebUi} from '../../shared/webUiSandbox.mjs';

test('ids ship with the classes and attributes the markup gives them', () => {
  const ui = loadWebUi();

  assert.equal(ui.element('browser-list').className, 'browser-list');
  assert.equal(ui.element('update-banner').className, 'update-banner');
  assert.equal(ui.element('link-download-fx').tagName, 'A');
  assert.equal(ui.element('btn-self-update').tagName, 'BUTTON');
  // The download anchors ship with the placeholder href, which is what
  // wireDownloadLink's dead-link guard reads back.
  assert.equal(ui.element('link-download-utils').getAttribute('href'), '#');
  // Inline style comes from the markup, not from a fresh object.
  assert.equal(ui.element('network-error-banner').style.display, 'none');
});

test('`hidden` is read from the markup, not assumed', () => {
  const ui = loadWebUi();

  // Both elements ship hidden; neither is revealed by loading the tab.
  assert.equal(ui.element('build-banner').hidden, true);
  assert.equal(ui.element('download-error').hidden, true);
  // …and reveal/clear it the way the tab does.
  ui.element('download-error').hidden = false;
  assert.equal(ui.element('download-error').hidden, false);
  ui.element('download-error').hidden = true;
  assert.equal(ui.element('download-error').hidden, true);
});

test('structure is real: the list lives in <main>, the app in <body>', () => {
  const ui = loadWebUi();

  assert.equal(ui.element('browser-list').parentNode.tagName, 'MAIN');
  assert.equal(ui.find('.app-container').parentNode.tagName, 'BODY');
  assert.ok(ui.element('browser-list').contains(ui.find('.browser-list')));
});

test('an unknown id is null and is recorded, so markup drift is visible', () => {
  const ui = loadWebUi();

  assert.equal(ui.element('no-such-element'), null);
  assert.deepEqual(ui.missingIds, [], 'a fresh load asks for nothing');

  // Going through the tab's own helper is what populates the list: a real
  // getElementById miss, which in production means every `if (!el) return`
  // guard in the fragment really does fire.
  assert.equal(ui.ctx.qs('no-such-element'), null);
  assert.deepEqual(ui.missingIds, ['no-such-element']);
});

test('a selector that matches nothing returns null instead of a phantom stub', () => {
  const ui = loadWebUi();

  assert.equal(ui.find('.browser-card'), null, 'no cards before a render');
  assert.equal(ui.find('.browser-card[data-binary-key="nope"]'), null);
  assert.deepEqual(ui.findAll('.chk-component'), []);
  assert.equal(ui.element('browser-list').querySelector('.card-progress'), null);
});

test('`:scope > x` matches a direct child only', () => {
  const ui = loadWebUi();
  const list = ui.element('browser-list');

  // Nested deeper than a direct child: must NOT match.
  const wrapper = ui.createElement('div');
  wrapper.innerHTML = '<div class="success-banner">nested</div>';
  list.appendChild(wrapper);
  assert.equal(list.querySelectorAll(':scope > .success-banner').length, 0);

  const banner = ui.createElement('div');
  banner.className = 'success-banner';
  list.appendChild(banner);
  const found = list.querySelectorAll(':scope > .success-banner');
  assert.equal(found.length, 1);
  assert.equal(found[0], banner);
});

test('a compound attribute selector resolves the element the tab wrote', () => {
  const ui = loadWebUi();
  const list = ui.element('browser-list');
  const card = ui.createElement('div');
  card.className = 'browser-card';
  card.setAttribute('data-binary-key', 'C__Program_Files_firefox_exe');
  list.appendChild(card);

  assert.equal(ui.find('.browser-card[data-binary-key="C__Program_Files_firefox_exe"]'), card);
  // …and a different key does not.
  assert.equal(ui.find('.browser-card[data-binary-key="other"]'), null);

  // Class matching is exact-token, not substring: `.browser-card` must not
  // match an element whose only class is `browser-card-header` (the real
  // markup has both, and conflating them would hide a renamed class).
  const header = ui.createElement('div');
  header.className = 'browser-card-header';
  list.appendChild(header);
  assert.equal(ui.find('.browser-card-header'), header);
  assert.equal(ui.findAll('.browser-card').length, 1);
  assert.equal(ui.findAll('.browser-card').includes(header), false);
});

test('innerHTML assignments become real children, not opaque strings', () => {
  const ui = loadWebUi();
  const list = ui.element('browser-list');

  list.innerHTML =
    '<div class="card-progress">' +
    '  <div class="card-progress-bar-fill" style="width:0%"></div>' +
    '  <span class="card-progress-step">Preparing...</span>' +
    '</div>';

  const progress = list.querySelector('.card-progress');
  assert.ok(progress, 'the injected wrapper is queryable');
  assert.equal(ui.text(progress.querySelector('.card-progress-step')), 'Preparing...');
  assert.equal(progress.querySelector('.card-progress-bar-fill').style.width, '0%');
  assert.equal(list.children.length, 1, 'replaced, not appended to');

  // Assigning again drops the previous tree.
  list.innerHTML = '<div class="empty-state"><h3>No Browsers Detected</h3></div>';
  assert.equal(list.querySelector('.card-progress'), null);
  assert.equal(ui.text(list.querySelector('.empty-state')), 'No Browsers Detected');
});

test('re-keying or clearing an id stops the old one resolving', () => {
  const ui = loadWebUi();
  const badge = ui.createElement('span');
  ui.element('browser-list').appendChild(badge);

  // The tab assigns ids after createElement, so a stale entry would answer
  // getElementById for a node that no longer carries that id.
  badge.id = 'badge-utils-0';
  assert.equal(ui.ctx.qs('badge-utils-0'), badge);
  badge.id = 'badge-utils-1';
  assert.equal(ui.element('badge-utils-0'), null, 'old id no longer resolves');
  assert.equal(ui.element('badge-utils-1'), badge);
  badge.removeAttribute('id');
  assert.equal(ui.element('badge-utils-1'), null);
});

test('the shipped markup parses into the elements the tab expects', () => {
  const ui = loadWebUi();

  // A representative slice of the selectors the fragments use (the full list
  // is the reason querySelector exists at all); each must resolve against the
  // markup index.html ships, or the tab is querying something that is not there.
  for (const selector of ['.app-container', '#browser-list']) {
    assert.ok(ui.find(selector), selector);
  }
  assert.equal(ui.findAll('a.download-link').length, 2, 'both manual download anchors');
  assert.equal(ui.findAll('.update-banner-content').length, 1);
  assert.deepEqual(ui.missingIds, []);
});
