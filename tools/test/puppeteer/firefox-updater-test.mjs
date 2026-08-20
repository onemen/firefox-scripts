#!/usr/bin/env node
/**
 * Puppeteer-core test for firefox-scripts updater UI. Uses puppeteer-core with
 * product: 'firefox'.
 *
 * Usage: node firefox-updater-test.mjs "C:\path\to\profile"
 * [path-to-firefox-exe]
 *
 * Install (from repo root): pnpm install --filter . --workspace-root pnpm add
 * -D puppeteer-core@latest
 *
 * Note: Close all Firefox instances before running because the script launches
 * Firefox with the given profile.
 */
import fs from 'fs';
import path from 'path';
import {launch} from 'puppeteer-core';

const profile =
  process.argv[2] ||
  'C:\\Users\\Hadar\\AppData\\Roaming\\Mozilla\\Firefox\\Profiles\\v2vhx5hz.test-tabmix-developer-edition';
const firefoxExe =
  process.argv[3] ||
  process.env.FIREFOX_BINARY ||
  'C:\\Users\\Hadar\\AppData\\Local\\Firefox Developer Edition\\firefox.exe'; // optional

if (!fs.existsSync(profile)) {
  console.error('ERROR: profile path not found:', profile);
  process.exit(2);
}

// Ensure the pref extensions.firefox-scripts.lastUpdateTabShown is false by
// writing a user.js in the profile directory (will override prefs.js on startup).
try {
  const userjs = path.join(profile, 'user.js');
  const prefLine = `user_pref("extensions.firefox-scripts.lastUpdateTabShown", false);\n`;
  let existing = '';
  if (fs.existsSync(userjs)) {
    existing = fs.readFileSync(userjs, 'utf8');
  }
  if (!existing.includes('extensions.firefox-scripts.lastUpdateTabShown')) {
    fs.appendFileSync(userjs, prefLine, 'utf8');
    console.log('Wrote pref to', userjs);
  } else {
    // replace existing value
    const replaced = existing.replace(
      /user_pref\("extensions.firefox-scripts.lastUpdateTabShown",\s*(true|false)\);/,
      'user_pref("extensions.firefox-scripts.lastUpdateTabShown", false);'
    );
    fs.writeFileSync(userjs, replaced, 'utf8');
    console.log('Updated pref in', userjs);
  }
} catch (e) {
  console.error('Failed to write user.js pref:', e);
}

(async () => {
  console.log('Launching Firefox with profile:', profile);
  const launchOptions = {
    browser: 'firefox',
    executablePath:
      firefoxExe || 'C:\\Users\\Hadar\\AppData\\Local\\Firefox Developer Edition\\firefox.exe',
    userDataDir: profile,
    headless: true,
    protocol: 'webDriverBiDi',
  };

  let browser;
  try {
    browser = await launch(launchOptions);
  } catch (err) {
    console.error('Failed to launch puppeteer-core (Firefox):', err);
    console.error(
      'Hints: ensure puppeteer-core is installed and no Firefox instance is running using the profile.'
    );
    process.exit(1);
  }

  const pages = await browser.pages();
  const page = pages.length ? pages[0] : await browser.newPage();

  page.on('console', msg => console.log('PAGE LOG>', msg.text()));
  page.on('pageerror', err => console.error('PAGE ERROR>', err));

  const url = 'chrome://firefox-scripts/content/scriptsUpdater.xhtml';
  console.log('Attempting to navigate to', url);

  try {
    await page.goto(url, {waitUntil: 'networkidle2', timeout: 30000});
  } catch (err) {
    // Some remote protocols disallow direct navigation to chrome:// URIs.
    // Fallback: relaunch Firefox with -chrome <url> to open the privileged page.
    console.warn(
      'Direct navigation failed, will relaunch with -chrome fallback:',
      err && err.message ? err.message : err
    );
    try {
      await browser.close();
    } catch {
      // ignore
    }

    console.log('Relaunching Firefox with -chrome', url);
    const launchOptions2 = {
      browser: 'firefox',
      executablePath:
        firefoxExe || 'C:\\Users\\Hadar\\AppData\\Local\\Firefox Developer Edition\\firefox.exe',
      userDataDir: profile,
      headless: false,
      protocol: 'webDriverBiDi',
      args: ['-chrome', url],
    };
    try {
      browser = await launch(launchOptions2);
    } catch (err2) {
      console.error('Relaunch failed:', err2);
      process.exit(1);
    }

    // give browser a moment to create the chrome window
    await new Promise(r => setTimeout(r, 2000));
  }

  try {
    const pages2 = await browser.pages();
    const page2 = pages2.length ? pages2[0] : await browser.newPage();

    const html = await page2.content();
    console.log('Loaded page, HTML length:', html.length);

    const out = path.resolve(process.cwd(), 'updater-page.html');
    fs.writeFileSync(out, html, 'utf8');
    console.log('Saved page HTML to', out);

    const shot = path.resolve(process.cwd(), 'updater-page.png');
    await page2.screenshot({path: shot, fullPage: true});
    console.log('Saved screenshot to', shot);
  } catch (err3) {
    console.error('Capture after launch failed:', err3);
  } finally {
    try {
      await browser.close();
    } catch {
      /* browser already closed */
    }
    console.log('Done.');
  }
})();
