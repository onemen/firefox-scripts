import js from '@eslint/js';
import markdown from '@eslint/markdown';
import eslintConfigPrettier from 'eslint-config-prettier';
import mozilla from 'eslint-plugin-mozilla';
import security from 'eslint-plugin-security';
import {defineConfig} from 'eslint/config';
import globals from 'globals';

// Shared JS language + rule set: browser/Firefox-script globals and the repo's
// core lint rules.  Applied to real .js files AND to JS fenced code blocks in
// Markdown (surfaced by @eslint/markdown as `**/*.md/*.js` virtual files), so
// documentation snippets follow the same rules as the code they describe.
const jsBase = {
  plugins: {js, security},
  extends: ['js/recommended'],
  languageOptions: {
    globals: {
      ...globals.browser,
      ...globals.es2024,
      ...mozilla.environments['browser-window'].globals,
      ...mozilla.environments.specific.globals,
      // firefox scripts globals
      BOOTSTRAP_REASONS: 'readonly',
      Blocklist: 'readonly',
      ChromeManifest: 'readonly',
      ConsoleAPI: 'readonly',
      getNameFromRDF: 'readonly',
      InstallRDF: 'readonly',
      Management: 'readonly',
      USE_RDFNS_ATTR: 'readonly',
      _uc: 'readonly',
      logger: 'readonly',
      lockPref: 'readonly',
      pref: 'readonly',
      RDF_R: 'readonly',
      UC: 'readonly',
      xPref: 'readonly',
      IOUtils: 'readonly',
      PathUtils: 'readonly',
    },
  },
  rules: {
    'no-unused-vars': [
      'error',
      {
        vars: 'all',
        args: 'after-used',
        argsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        ignoreRestSiblings: true,
        varsIgnorePattern: '^ignored',
      },
    ],
    'no-var': 'error',
    'prefer-const': 'error',

    // Security: catch suspicious patterns (eval, unsafe regex, shell usage).
    // Most are warn — the repo's publish tools legitimately shell out, and
    // flagged lines are reviewed individually (see docs/security.md).
    'security/detect-eval-with-expression': 'error',
    'security/detect-unsafe-regex': 'error',
    'security/detect-non-literal-regexp': 'warn',
    'security/detect-child-process': 'warn',
    'security/detect-possible-timing-attacks': 'warn',
  },
};

export default defineConfig([
  {
    name: 'global-ignore',
    ignores: [
      '.github',
      // Build outputs and generated artifacts (gitignored at the repo level).
      'dist/',
      'lib/',
      'coverage/',
      'logs/',
      '.vscode',
      '**/*local*/**',
      '**/*local*.*',
      '**/*.d.ts',
      '**/@types/**',
    ],
  },
  {
    name: 'js',
    files: ['**/*.{js,mjs,cjs}'],
    ...jsBase,
  },

  // Markdown: recommended lint rules (structure, links, headings) and fenced
  // code-block extraction so snippets are linted as real code.
  {
    name: 'markdown',
    files: ['**/*.md'],
    plugins: {markdown},
    extends: ['markdown/recommended'],
    language: 'markdown/gfm',
  },
  {
    name: 'markdown-processor',
    files: ['**/*.md'],
    plugins: {markdown},
    processor: 'markdown/markdown',
  },
  {
    name: 'markdown-code-blocks',
    files: ['**/*.md/**/*.{js,mjs,cjs}'],
    ...jsBase,
  },

  // core/fx-folder is Firefox config/pref-scripts distributed as-is: variable
  // names are part of the user-facing API surface and unused bindings are by
  // design (e.g. config.js guards). Leave the files untouched — disable the
  // rules that would otherwise flag or autofix them.
  {
    name: 'fx-folder',
    files: ['core/fx-folder/**/*.{js,mjs,cjs}'],
    rules: {
      'no-unused-vars': 'off',
      'no-empty': 'off',
      'no-var': 'off',
    },
  },

  eslintConfigPrettier, // Add at the end to disable formatting rules

  // Node scripts (publish pipeline, generators) — add Node globals
  // (process/__dirname/import.meta) on top of the shared jsBase rules; the
  // browser globals above still apply (flat-config globals merge), which is
  // harmless for these files. All jsBase rules (no-unused-vars, prefer-const,
  // etc.) apply to installer/ and tools/ exactly as everywhere else.
  {
    name: 'node-scripts',
    files: [
      'tools/**/*.{js,mjs,cjs}',
      'test/**/*.{js,mjs,cjs}',
      'installer/**/*.{js,mjs,cjs}',
      'config/**/*.{js,mjs,cjs}',
    ],
    languageOptions: {
      globals: globals.node,
    },
  },
]);
