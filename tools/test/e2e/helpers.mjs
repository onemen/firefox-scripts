#!/usr/bin/env node
/** E2E shared helpers — puppeteer launch, assertions, screenshot, process utils. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

// ── Assertion counters ────────────────────────────────────────────────────

/** @returns {{passed: number; failed: number}} */
export function createCounter() {
  return {passed: 0, failed: 0};
}

/** @param {{passed: number; failed: number}} counter */
export function check(counter, ok, label, detail = '') {
  if (ok) {
    counter.passed++;
    console.log(`  PASS: ${label}`);
  } else {
    counter.failed++;
    console.error(`  FAIL: ${label}${detail ? ' — ' + detail : ''}`);
  }
}

/** Print summary line and return whether all checks passed. */
export function summary(counter) {
  const total = counter.passed + counter.failed;
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Results: ${counter.passed}/${total} passed`);
  console.log(`${'='.repeat(60)}`);
  return counter.failed === 0;
}

// ── Puppeteer ──────────────────────────────────────────────────────────────

/**
 * Launch Firefox via puppeteer-core + WebDriver BiDi.
 *
 * @param {string} binary - absolute path to Firefox executable
 * @param {string} profileDir - userDataDir (temp profile)
 * @param {{headless?: boolean}} opts
 * @returns {Promise<import('puppeteer-core').Browser>}
 */
export async function launchFirefox(
  binary,
  profileDir,
  {headless = false, extraPrefsFirefox = {}} = {}
) {
  const puppeteer = await import('puppeteer-core');
  return puppeteer.launch({
    browser: 'firefox',
    executablePath: binary,
    userDataDir: profileDir,
    headless,
    protocol: 'webDriverBiDi',
    // Puppeteer overwrites user.js with its own preferences before launch
    // (createProfile -> syncPreferences), so any prefs the caller needs must
    // be injected through this option — a caller-written user.js would be
    // silently replaced and never reach Firefox.
    extraPrefsFirefox,
    args: ['-no-remote', '-remote-allow-system-access'],
  });
}

/**
 * Mirror the Firefox process stdout/stderr into the test log — autoconfig and
 * startup JS errors surface there.
 */
export function attachProcessLogging(browser, label = 'ff') {
  const proc = browser.process?.();
  if (!proc?.stdout || !proc?.stderr) return;
  const pipe = (stream, name) => {
    stream.setEncoding('utf8');
    let buf = '';
    stream.on('data', chunk => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (line.trim()) console.log(`  [${label}:${name}] ${line}`);
      }
    });
  };
  pipe(proc.stdout, 'out');
  pipe(proc.stderr, 'err');
}

/**
 * Poll browser.pages() for a page whose url starts with `prefix`.
 *
 * @param {import('puppeteer-core').Browser} browser
 * @param {string} prefix - URL prefix to match
 * @param {number} [timeoutMs=15000] — the updater scheduler runs at startup, so
 *   a tab that has not appeared in ~15 s will not appear. Default is `15000`
 * @returns {Promise<import('puppeteer-core').Page | null>}
 */
export async function findPageByUrl(browser, prefix, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastProgressLog = 0;
  while (Date.now() < deadline) {
    try {
      const pages = await browser.pages();
      if (Date.now() - lastProgressLog > 15_000) {
        console.log(
          `  [diag] polling pages: ${pages.length} open [${pages.map(p => p.url()).join(' | ')}]`
        );
        lastProgressLog = Date.now();
      }
      const page = pages.find(p => {
        try {
          return p.url().startsWith(prefix);
        } catch {
          return false;
        }
      });
      if (page) return page;
    } catch (err) {
      // browser not ready yet — but log repeated attach failures
      if (Date.now() - lastProgressLog > 15_000) {
        console.log(`  [diag] pages() threw: ${err.message}`);
        lastProgressLog = Date.now();
      }
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return null;
}

/**
 * Poll `page.evaluate(condition)` until it returns true or timeout.
 *
 * @param {import('puppeteer-core').Page} page
 * @param {() => boolean} condition
 * @param {number} timeoutMs
 * @param {string} label
 * @returns {Promise<boolean>}
 */
export async function waitForCondition(page, condition, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await page.evaluate(condition)) return true;
    } catch {
      // page mid-navigation
    }
    await new Promise(r => setTimeout(r, 500));
  }
  console.warn(`  ⚠ timed out waiting for: ${label}`);
  return false;
}

/**
 * Take a screenshot of a chrome:// page via drawWindow (BiDi cannot capture
 * privileged contexts via captureScreenshot).
 *
 * @param {import('puppeteer-core').Page} page
 * @param {string} outPath - absolute path to write PNG
 * @returns {Promise<boolean>} success
 */
export async function screenshotPrivileged(page, outPath) {
  try {
    const dataUrl = await page.evaluate(() => {
      const win = window;
      const canvas = win.document.createElementNS('http://www.w3.org/1999/xhtml', 'canvas');
      canvas.width = win.innerWidth;
      canvas.height = win.innerHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawWindow(win, 0, 0, win.innerWidth, win.innerHeight, 'rgb(255,255,255)');
      return canvas.toDataURL('image/png');
    });
    fs.mkdirSync(path.dirname(outPath), {recursive: true});
    fs.writeFileSync(outPath, Buffer.from(dataUrl.split(',')[1], 'base64'));
    return true;
  } catch (err) {
    console.warn(`  (screenshot unavailable: ${err.message})`);
    return false;
  }
}

// ── Process / temp helpers ─────────────────────────────────────────────────

/** Create a temp directory and return its path. */
export function tempDir(prefix = 'fxs-e2e') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-'));
}

/** Delete a directory tree recursively (best-effort, no throw). */
export function rmDir(dir) {
  try {
    fs.rmSync(dir, {recursive: true, force: true});
  } catch {
    // ignore
  }
}

/** Wait for process exit with a timeout; returns exit info or null. */
export function waitForProcessExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      // Try to get current status before timeout
      if (child.exitCode !== null) {
        resolve({code: child.exitCode, signal: child.signalCode});
      } else {
        reject(new Error('Process did not exit within timeout'));
      }
    }, timeoutMs);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({code, signal});
    });
    child.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
