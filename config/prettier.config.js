/** @type {import('prettier').Config} */
export default {
  arrowParens: 'avoid',
  bracketSpacing: false,
  endOfLine: 'lf',
  htmlWhitespaceSensitivity: 'css',
  insertPragma: false,
  printWidth: 100,
  proseWrap: 'always',
  quoteProps: 'consistent',
  requirePragma: false,
  semi: true,
  singleQuote: true,
  tabWidth: 2,
  trailingComma: 'es5',
  useTabs: false,
  experimentalTernaries: true,
  // prettier-plugin-astro formats the docs-site components in the same pass.
  // Its version must stay compatible with the Astro version in
  // docs-site/package.json (separate lockfile, no tool enforces this).
  plugins: ['prettier-plugin-jsdoc', 'prettier-plugin-astro'],
  jsdocCapitalizeDescription: false,
  jsdocPrintWidth: 80,
};
