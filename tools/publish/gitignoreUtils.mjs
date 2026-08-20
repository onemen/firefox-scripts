import fs from 'fs';
import {minimatch} from 'minimatch';
import path from 'path';

/** Parse gitignore patterns from a file */
export function parseGitignore(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  return content
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(line => {
      const isNegation = line.startsWith('!');
      const pattern = isNegation ? line.slice(1) : line;
      return {pattern, isNegation};
    });
}

/**
 * Load and combine all applicable gitignore patterns
 *
 * @param {string} sourceDir - The directory being processed
 * @param {string[]} gitignoreFiles - Paths to .gitignore files to load
 * @param {string[]} customPatterns - Additional patterns to ignore
 */
export function loadAllGitignorePatterns(sourceDir, gitignoreFiles, customPatterns = []) {
  const patterns = [];

  for (const filePath of gitignoreFiles) {
    if (fs.existsSync(filePath)) {
      patterns.push(...parseGitignore(filePath));
    }
  }

  if (customPatterns.length > 0) {
    patterns.push(...customPatterns.map(pattern => ({pattern, isNegation: false})));
  }

  patterns.push({pattern: '.git', isNegation: false});

  return patterns;
}

/** Check if a file should be ignored */
export function shouldIgnore(filePath, patterns, baseDir) {
  const relativePath = path.relative(baseDir, filePath).replace(/\\/g, '/');
  const fileName = path.basename(filePath);

  for (const {pattern, isNegation} of patterns) {
    let matchPattern = pattern;

    if (matchPattern.endsWith('/')) {
      matchPattern = matchPattern.slice(0, -1);
      if (relativePath.startsWith(matchPattern + '/') || relativePath === matchPattern) {
        return !isNegation;
      }
    }

    if (minimatch(relativePath, matchPattern) || minimatch(fileName, matchPattern)) {
      return !isNegation;
    }

    if (matchPattern.includes('**')) {
      if (minimatch(relativePath, matchPattern)) {
        return !isNegation;
      }
    }
  }

  return false;
}

/**
 * Get all files recursively, respecting gitignore
 *
 * @param {string} dir - Directory to scan
 * @param {Array} patterns - Gitignore patterns
 * @param {string} baseDir - Base directory for relative path calculation
 * @param {string[]} includeSubfolders - If non-empty, only include these
 *   top-level subfolders
 */
export function getAllFiles(dir, patterns, baseDir, includeSubfolders = []) {
  const files = [];
  const entries = fs.readdirSync(dir, {withFileTypes: true});

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (dir === baseDir && entry.isDirectory()) {
      if (includeSubfolders.length > 0 && !includeSubfolders.includes(entry.name)) {
        continue;
      }
    }

    if (shouldIgnore(fullPath, patterns, baseDir)) {
      continue;
    }

    if (entry.isDirectory()) {
      files.push(...getAllFiles(fullPath, patterns, baseDir, includeSubfolders));
    } else {
      files.push(fullPath);
    }
  }

  return files;
}
