Puppeteer-core Firefox updater UI test

Requirements

- Node (use project pnpm)
- pnpm installed

Install From repository root:

pnpm add -D puppeteer-core

Run Close all Firefox instances and run:

node test/e2e/updater/puppeteer/firefox-updater-test.mjs "C:\\path\\to\\profile"
"C:\\path\\to\\firefox.exe"

Notes

- The script writes a user.js in the profile to set
  user_pref("extensions.firefox-scripts.lastUpdateTabShown", false);
- Puppeteer with Firefox is experimental — ensure your Firefox binary is compatible. If you have
  issues, consider using your existing firefoxPuppeteer helper.
