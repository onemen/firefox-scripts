import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

import js from '@eslint/js';
import markdown from '@eslint/markdown';
import eslintConfigPrettier from 'eslint-config-prettier';
import security from 'eslint-plugin-security';
import {defineConfig} from 'eslint/config';
import globals from 'globals';

// Third-party skills (SKILL.md frontmatter `metadata.github-repo`, ADR 0022)
// are linted never — derived here at config-load so this list cannot drift
// from the installed skills. config/ is one level down, hence the ../ climb.
// The classification reuses the watchdog's frontmatter parser (the same
// source of truth `tools/sync-skill-gates.mjs` and the CI drift check use),
// rather than a whole-file regex that a prose mention of "github-repo:" could
// fool. Missing/unparseable SKILL.md → treated as authored (linted).
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let thirdPartySkills = [];
try {
  const watchdogUrl = pathToFileURL(path.join(repoRoot, 'tools', 'skills-watchdog.mjs')).href;
  const {loadInventory} = await import(watchdogUrl);
  thirdPartySkills = loadInventory(repoRoot).map(i => `**/.agents/skills/${i.skill}`);
} catch (err) {
  // Config must load even if the tool tree is unavailable (rare: partial
  // checkout). Fail open to linting everything except the known set.
  console.error(`eslint config: skill classification unavailable (${err.message})`);
}

// Deep-import only the two environments this repo uses instead of loading the
// whole plugin: `eslint-plugin-mozilla`'s index eagerly imports all 58 rules,
// none of which are enabled here. No "exports" map in the package, so deep
// imports are supported (they are small, self-contained modules).
import mozillaBrowserWindow from 'eslint-plugin-mozilla/lib/environments/browser-window.mjs';
import mozillaSpecific from 'eslint-plugin-mozilla/lib/environments/specific.mjs';

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
      ...mozillaBrowserWindow.globals,
      ...mozillaSpecific.globals,
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
      // Third-party agent skills — upstream style, never linted (ADR 0022).
      // Derived above from SKILL.md frontmatter; a new third-party skill is
      // ignored automatically. (config/-anchored ignores need the **/ prefix
      // to match at the repo root.)
      // Build outputs and generated artifacts (gitignored at the repo level).
      'dist/',
      'lib/',
      'coverage/',
      'logs/',
      '.vscode',
      '**/*local*/**',
      '**/*local*.*',
      ...thirdPartySkills,
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
