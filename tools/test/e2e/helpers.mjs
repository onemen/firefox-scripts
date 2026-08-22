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
export async function launchFirefox(binary, profileDir, {headless = false} = {}) {
  const puppeteer = await import('puppeteer-core');
  return puppeteer.launch({
    browser: 'firefox',
    executablePath: binary,
    userDataDir: profileDir,
    headless,
    protocol: 'webDriverBiDi',
    // GreD and chrome-manifest files are rewritten between scenarios. Purge
    // startup caches so each fresh profile observes the current fixture.
    args: ['-no-remote', '-remote-allow-system-access', '-purgecaches'],
  });
}

/**
 * Poll browser.pages() for a page whose url starts with `prefix`.
 *
 * @param {import('puppeteer-core').Browser} browser
 * @param {string} prefix - URL prefix to match
 * @param {number} [timeoutMs=90000] Default is `90000`
 * @returns {Promise<import('puppeteer-core').Page | null>}
 */
export async function findPageByUrl(browser, prefix, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const pages = await browser.pages();
      const page = pages.find(p => {
        try {
          return p.url().startsWith(prefix);
        } catch {
          return false;
        }
      });
      if (page) return page;
    } catch {
      // browser not ready yet
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
