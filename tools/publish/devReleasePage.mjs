// devReleasePage.mjs — dev release page rendering (ADR 0026).
//
// Library-only so unit tests can import it without dragging in upload.mjs
// (whose top-level main() runs the whole publish flow).

import {REPO_OWNER, REPO_NAME} from './paths.js';

/**
 * Render the dev release page's title + body. Without a note the title is the
 * bare dev-build branch; `--note="<label>"` turns the page into an RC-style
 * announcement: the label leads the title and body, and the test-build warning
 *
 * - provenance ride along either way (the warning is what the existing
 *   dev-build-main-* users need on the page they already visit).
 *
 * @param {{
 *   note: string;
 *   shortSha: string;
 *   date: string;
 *   devBranch: string;
 * }} p
 * @returns {{title: string; body: string}}
 */
export function renderDevRelease({note, shortSha, date, devBranch}) {
  const title = note ? `${devBranch} — ${note}` : devBranch;
  const body = [
    ...(note ? [note, ''] : []),
    '⚠️ Test build — for testing only; not for daily use. It never auto-updates to',
    'the stable channel, and its updater stops working when this branch is deleted.',
    `For daily use, install the [latest stable](https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/latest) instead.`,
    '',
    `Built from: [${shortSha}](https://github.com/${REPO_OWNER}/${REPO_NAME}/commit/${shortSha}) on ${date}`,
    `Files are on the [${devBranch}](https://github.com/${REPO_OWNER}/${REPO_NAME}/tree/${devBranch}) branch.`,
  ].join('\n');
  return {title, body};
}
