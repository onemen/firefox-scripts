import {defineHastPlugin} from 'satteri';

// Anchor handling for the docs site's markdown (after the tabmixplus-docs
// pattern): external links open in a new tab, and root-relative hrefs are
// prefixed with the site's `base` (`/firefox-scripts`), because Astro does
// not rewrite root-absolute links found in Markdown/MDX content. Source
// pages still use relative links (guarded by internalLinks.test.mjs); this
// plugin is the build-time backstop for whatever slips through, plus the
// raw HTML anchors the source gate cannot see.
export function createExternalLinksPlugin(baseUrl) {
  return defineHastPlugin({
    name: 'external-links',
    element: {
      filter: ['a'],
      visit(node, ctx) {
        const href = node.properties?.href;
        if (!href) return;

        const normalizedBase = baseUrl.replace(/\/$/, '');

        const isExternal = href.startsWith('http://') || href.startsWith('https://');

        if (isExternal) {
          ctx.setProperty(node, 'target', '_blank');
          ctx.setProperty(node, 'rel', 'nofollow');
          return;
        }

        if (!href.startsWith('#')) {
          const prefix = href.startsWith('/') ? '' : '/';
          ctx.setProperty(node, 'href', normalizedBase + prefix + href);
        }
      },
    },
  });
}
