// Library-only module: GitHub release-asset helpers used by upload.mjs.  There
// is no standalone entry — all publication happens through `upload` /
// `upload:local` so zips, binaries, Pages and the hash manifest are pushed
// together in one consistent flow.

import fs from 'fs';
import {RELEASE_NAME, REPO_OWNER, REPO_NAME} from './paths.js';
import {bold, dim, green} from './log.mjs';

/** Get the release for a tag name (default: the configured RELEASE_NAME). */
export async function getRelease(octokit, tagName = RELEASE_NAME) {
  try {
    const {data: releases} = await octokit.repos.listReleases({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      per_page: 100,
    });

    const release = releases.find(r => r.tag_name === tagName);
    return release || null;
  } catch (error) {
    throw new Error(`Failed to get release: ${error.message}`, {cause: error});
  }
}

/** Get a release by tag, creating it (at `commitish`) when it does not exist. */
export async function getOrCreateRelease(
  octokit,
  tagName,
  {name, body, commitish, prerelease} = {}
) {
  const existing = await getRelease(octokit, tagName);
  if (existing) {
    // Keep an existing dev release marked as pre-release even if it was
    // created by an older run that forgot the flag.
    if (prerelease && !existing.prerelease) {
      await octokit.repos.updateRelease({
        owner: REPO_OWNER,
        repo: REPO_NAME,
        release_id: existing.id,
        prerelease: true,
      });
    }
    return existing;
  }
  const {data: release} = await octokit.repos.createRelease({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    tag_name: tagName,
    target_commitish: commitish || 'main',
    name: name || tagName,
    body: body || '',
    prerelease: !!prerelease,
  });
  console.log(green(`+ release ${tagName}`));
  return release;
}

/** Delete existing asset if it exists */
export async function deleteExistingAsset(octokit, releaseId, assetName) {
  try {
    const {data: assets} = await octokit.repos.listReleaseAssets({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      release_id: releaseId,
    });

    const existingAsset = assets.find(a => a.name === assetName);
    if (existingAsset) {
      console.log(dim(`  - ${assetName}  replacing existing release asset`));
      await octokit.repos.deleteReleaseAsset({
        owner: REPO_OWNER,
        repo: REPO_NAME,
        asset_id: existingAsset.id,
      });
    }
  } catch (error) {
    throw new Error(`Failed to delete existing asset: ${error.message}`, {cause: error});
  }
}

/** Upload asset to release */
export async function uploadAsset(octokit, releaseId, filePath, assetName) {
  try {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const fileData = fs.readFileSync(filePath);
    const fileSize = fs.statSync(filePath).size;

    const {data: asset} = await octokit.repos.uploadReleaseAsset({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      release_id: releaseId,
      name: assetName,
      data: fileData,
    });

    console.log(
      `  ${green('+')} ${bold(assetName)}  ${(fileSize / 1024).toFixed(1)} KB` +
        dim(` → ${asset.browser_download_url}`)
    );
    return asset;
  } catch (error) {
    throw new Error(`Failed to upload asset: ${error.message}`, {cause: error});
  }
}
