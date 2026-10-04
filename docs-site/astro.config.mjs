import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

// The site is served from the repo's own GitHub Pages project site, at the
// artifact branch's ROOT (ADR 0038): https://onemen.github.io/firefox-scripts/.
// The release artifacts (utils.zip, hashes.json, the installer binaries) live
// as siblings of this build output on the gh-pages branch, so `base` is the
// project path — never `/firefox-scripts/docs`.
const base = "/firefox-scripts";

// https://starlight.astro.build/reference/configuration/
export const starlightConfig = {
  title: "Firefox Scripts",
  description:
    "Install and keep Firefox-family browser scripts up to date — and run legacy extensions such as TabMixPlus.",
  favicon: "/favicon.svg",
  logo: {
    src: "./src/assets/favicon.svg",
  },
  social: [
    {
      icon: "github",
      label: "GitHub",
      href: "https://github.com/onemen/firefox-scripts",
    },
  ],
  editLink: {
    baseUrl: "https://github.com/onemen/firefox-scripts/edit/main/docs-site/",
  },
  lastUpdated: true,
  sidebar: [
    { label: "Introduction", link: "/introduction" },
    { label: "Installation", link: "/installation" },
    { label: "Download", link: "/download" },
    {
      label: "How it works",
      collapsed: false,
      items: [
        {
          label: "Configuration files (config.js)",
          link: "/how-it-works/config-js",
        },
        { label: "BootstrapLoader.js", link: "/how-it-works/bootstrap-loader" },
        { label: "userChrome.js", link: "/how-it-works/userchrome-js" },
        {
          label: "Writing your own .uc.js",
          link: "/how-it-works/writing-uc-js",
        },
      ],
    },
    { label: "FAQ", link: "/faq" },
    { label: "Troubleshooting", link: "/troubleshooting" },
  ],
  customCss: ["./src/styles/custom.css"],
  defaultLocale: "en",
};

export default defineConfig({
  site: process.env.CI ? "https://onemen.github.io" : "http://localhost:4321",
  base,
  compressHTML: true,
  trailingSlash: "always",
  integrations: [starlight(starlightConfig)],
});
