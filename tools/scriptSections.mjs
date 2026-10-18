/**
 * tools/scriptSections.mjs: the ordered section list the `scripts` block in
 * package.json is grouped by.
 *
 * Two things have to agree on this list and neither can read it off the other:
 * the unit test that fails when a family is split (packageScripts.test.mjs) and
 * the generator that turns the block into docs/script-reference.md. A third
 * copy would be free to drift, which is the failure mode both exist to catch.
 *
 * The order is the one the developer docs walk through the work in.
 */

/**
 * Section name to the pattern its scripts match, in package.json order.
 *
 * @type {[string, RegExp][]}
 */
export const SCRIPT_SECTIONS = [
  ['lint', /^lint(:|$)/],
  ['format', /^format(:|$)/],
  ['test', /^(test(:|$)|e2e:)/],
  ['check', /^check:/],
  ['hooks', /^hooks:/],
  ['docs', /^docs:/],
  ['toolchain', /^toolchain:/],
  ['scan', /^scan:/],
  ['snapshot', /^snapshot:/],
  ['publish', /^publish:/],
  ['release', /^(release:|fetch:|dev-clean$)/],
  ['review', /^review:/],
  ['ci', /^ci:/],
];

/**
 * Which group a script name belongs to.
 *
 * @param {string} name the script name
 * @returns {string | undefined} the group name, or undefined when it matches
 *   none
 */
export function sectionOf(name) {
  return SCRIPT_SECTIONS.find(([, matches]) => matches.test(name))?.[0];
}
