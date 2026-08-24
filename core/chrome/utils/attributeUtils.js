/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

'use strict';

/* eslint-disable no-unused-vars -- consumed via loadSubScript (userChrome.js)
   and evaluated by the unit test; there are no in-file references. */

/**
 * Pure attribute helpers shared by userChrome.js createElement and its unit
 * tests (tools/test/unit/attributeUtils.test.mjs evaluates this same file in
 * Node with a mock DOM). No imports, no Services — everything is passed in.
 */

/**
 * Firefox 149+ (bug 2008041) evaluates boolean attributes by PRESENCE rather
 * than value: `checked="false"` is still treated as checked.
 *
 * The change is a Gecko change, so the gate reads appinfo.platformVersion (the
 * Gecko version) instead of appinfo.version: some Firefox-family forks
 * (LibreWolf, Waterfox, Floorp, Zen) put their own release number in `version`,
 * while `platformVersion` always tracks the Gecko code this build is made from.
 * A build made from Gecko >= 149 has the new behavior no matter what its brand
 * version says.
 *
 * @param {{platformVersion?: string}} appinfo - Services.appinfo (or a mock)
 * @returns {boolean}
 */
function isFirefox149Plus(appinfo) {
  const major = parseInt(String(appinfo && appinfo.platformVersion), 10);
  return Number.isInteger(major) && major >= 149;
}

/**
 * Apply one attribute honoring the bug 2008041 semantics for the build.
 *
 * - ff149 (new behavior): boolean / 'true' / 'false' values become presence-based
 *   via toggleAttribute — toggleAttribute(name, false) REMOVES the attribute,
 *   which is what "unchecked" means there.
 * - pre-149 (legacy behavior): every value goes through setAttribute, exactly as
 *   the old code always did.
 *
 * @param {{setAttribute: Function; toggleAttribute: Function}} el
 * @param {string} name
 * @param {any} value
 * @param {boolean} ff149
 */
function applyAttribute(el, name, value, ff149) {
  if (ff149 && (typeof value === 'boolean' || value === 'true' || value === 'false')) {
    el.toggleAttribute(name, value === true || value === 'true');
  } else {
    el.setAttribute(name, value);
  }
}
