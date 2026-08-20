// Git hygiene helpers shared by the publish CLIs.

import {execSync} from 'child_process';
import {REPO_ROOT} from './publishCommon.mjs';

/**
 * Refuse to run when the worktree is dirty. Publish scripts regenerate the
 * untracked generated files (_config.h, resources.h, updater-config.sys.mjs) on
 * demand with the current mode's URLs; a clean start keeps the publish decision
 * (and the dev-build-<id> branch identity) based on a committed tree.
 */
export function assertCleanWorktree() {
  let out;
  try {
    out = execSync('git status --porcelain', {cwd: REPO_ROOT, encoding: 'utf8'}).trim();
  } catch (error) {
    throw new Error(`Failed to read git status: ${error.message}`, {cause: error});
  }
  if (out) {
    throw new Error(
      'Worktree is not clean — refusing to run.\n' +
        'Publish scripts require a committed tree (the publish decision and the\n' +
        'dev-build-<id> branch identity are commit-based). Commit or stash first.\n' +
        'Current changes:\n' +
        out
          .split('\n')
          .slice(0, 12)
          .map(l => `  ${l}`)
          .join('\n')
    );
  }
}
