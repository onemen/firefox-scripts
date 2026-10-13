import {satteri} from '@astrojs/markdown-satteri';
import starlight from '@astrojs/starlight';
import {defineConfig} from 'astro/config';
import {createExternalLinksPlugin} from './src/utils/satteriExternalLinks.mjs';

// The site is served from the repo's own GitHub Pages project site, at the
// artifact branch's ROOT (ADR 0046): https://onemen.github.io/firefox-scripts/.
// The release artifacts (utils.zip, hashes.json, the installer binaries) live
// as siblings of this build output on the gh-pages branch, so `base` is the
// project path, never `/firefox-scripts/docs`.
const base = '/firefox-scripts';

// https://starlight.astro.build/reference/configuration/
export const starlightConfig = {
  title: 'Firefox Scripts',
  description:
    'Install and keep Firefox-family browser scripts up to date, and run legacy extensions such as TabMixPlus.',
  favicon: '/favicon.svg',
  logo: {
    src: './src/assets/favicon.svg',
  },
  social: [
    {
      icon: 'github',
      label: 'GitHub',
      href: 'https://github.com/onemen/firefox-scripts',
    },
  ],
  editLink: {
    baseUrl: 'https://github.com/onemen/firefox-scripts/edit/main/docs-site/',
  },
  lastUpdated: true,
  components: {
    Head: './src/components/Head.astro',
    SocialIcons: './src/components/SocialIcons.astro',
  },
  // Download is not here: it lives in the header bar (SocialIcons), one
  // click away from every page, like tabmixplus-docs.
  sidebar: [
    {label: 'Installation', link: '/installation'},
    {
      label: 'How it works',
      collapsed: false,
      items: [
        {
          label: 'Installer & auto-updater',
          link: '/how-it-works/installer-updater',
        },
        {
          label: 'Configuration files (config.js)',
          link: '/how-it-works/config-js',
        },
        {label: 'BootstrapLoader.js', link: '/how-it-works/bootstrap-loader'},
        {label: 'userChrome.js', link: '/how-it-works/userchrome-js'},
        {
          label: 'Writing your own .uc.js',
          link: '/how-it-works/writing-uc-js',
        },
      ],
    },
    {label: 'Why we need it', link: '/introduction'},
    {label: 'FAQ', link: '/faq'},
    {label: 'Troubleshooting', link: '/troubleshooting'},
  ],
  customCss: ['./src/styles/custom.css'],
  defaultLocale: 'en',
};

export default defineConfig({
  site: process.env.CI ? 'https://onemen.github.io' : 'http://localhost:4321',
  base,
  compressHTML: true,
  // Satteri markdown (after tabmixplus-docs): smartypants off so `--`,
  // `...` and quotes in CLI flags and pref names stay literal, plus the
  // external-links plugin above as the build-time backstop for hrefs.
  markdown: {
    processor: satteri({
      features: {smartypants: false},
      hastPlugins: [createExternalLinksPlugin(base)],
    }),
  },
  trailingSlash: 'always',
  // The landing page IS installation.mdx: there is no index.mdx copy, so /
  // redirects there. The static build emits this as a meta-refresh page,
  // which GitHub Pages serves fine. The target spells out `base` because
  // Astro does not prepend it to redirect targets (verified in dist/).
  redirects: {
    '/': `${base}/installation/`,
  },
  integrations: [starlight(starlightConfig)],
});
