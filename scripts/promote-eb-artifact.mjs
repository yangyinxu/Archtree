import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { archiveDigest, maximumArchiveBytes, releaseArtifactName, releaseIdentity,
  releaseRepository, releaseWorkflow, validateReleaseProvenance } from './release-provenance.mjs';
import { validateElasticBeanstalkArtifact } from './stage-eb-artifact.mjs';

const apiRoot = `https://api.github.com/repos/${releaseRepository}`;
const extractor = fileURLToPath(new URL('./extract-release-archive.py', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const validId = value => Number.isSafeInteger(value) && value > 0;
const parseJson = value => {
  try { return JSON.parse(value); } catch { throw new Error('Release metadata contains invalid JSON.'); }
};

/** Rejects PRs, forks, incomplete reruns and similarly named workflows before consulting their artifact. */
const validateRun = (run, commitSha) => {
  if (!run || !validId(run.id) || !validId(run.run_attempt) || run.head_sha !== commitSha
    || run.event !== 'push' || run.head_branch !== 'main' || run.path !== releaseWorkflow
    || run.repository?.full_name !== releaseRepository || run.head_repository?.full_name !== releaseRepository
    || !validId(run.repository.id) || run.repository.id !== run.head_repository.id
    || run.status !== 'completed' || run.conclusion !== 'success') {
    throw new Error('The exact main commit has no completed successful release gate. Retry after that gate succeeds.');
  }
  return releaseIdentity({ commitSha, runId: run.id, runAttempt: run.run_attempt });
};

/** Allows a source-triggered pipeline to wait for its concurrently running exact-SHA gate, with no success fallback. */
export const waitForSuccessfulReleaseRun = async ({ lookup, commitSha, waitSeconds,
  now = Date.now, sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  onWaiting = () => {} }) => {
  const deadline = now() + waitSeconds * 1_000;
  while (true) {
    const listing = await lookup();
    if (!Array.isArray(listing.workflow_runs) || !Number.isInteger(listing.total_count)
      || listing.total_count > 100 || listing.total_count < 0) throw new Error('Release workflow lookup is ambiguous.');
    const run = listing.workflow_runs.filter(value => value.head_sha === commitSha && validId(value.id))
      .sort((a, b) => b.id - a.id)[0];
    if (run?.status === 'completed') { validateRun(run, commitSha); return run; }
    if (run) {
      if (!['queued', 'in_progress', 'waiting', 'pending', 'requested'].includes(run.status)) throw new Error('Release workflow state is invalid.');
      // Validate source, workflow and event even while the trusted run is still waiting.
      validateRun({ ...run, status: 'completed', conclusion: 'success' }, commitSha);
    }
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error('The exact main commit has no completed successful release gate. Retry after that gate succeeds.');
    onWaiting();
    await sleep(Math.min(30_000, remaining));
  }
};

/** All HTTP reads are bounded, and neither provider error bodies nor signed download URLs reach logs. */
const responseBytes = async (response, limit) => {
  if (!response.ok || !response.body) throw new Error('GitHub release metadata could not be read.');
  const parts = []; let size = 0;
  for await (const part of response.body) {
    size += part.length;
    if (size > limit) throw new Error('GitHub release metadata exceeds its limit.');
    parts.push(part);
  }
  return Buffer.concat(parts);
};

/** Downloads the successful CI bundle; it never installs dependencies or rebuilds application bytes. */
export const promoteElasticBeanstalkArtifact = async ({ sourceRoot = repositoryRoot,
  environment = process.env, fetchImpl = fetch } = {}) => {
  const commitSha = environment.CODEBUILD_RESOLVED_SOURCE_VERSION;
  if (!/^[a-f0-9]{40}$/.test(commitSha ?? '')) throw new Error('Promotion requires CODEBUILD_RESOLVED_SOURCE_VERSION as a full commit SHA.');
  const root = path.resolve(sourceRoot);
  const outputDirectory = path.join(root, 'elastic-beanstalk-artifact');
  try { await lstat(outputDirectory); throw new Error('Promotion output already exists; use a clean build workspace.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
    ...(environment.GITHUB_ARTIFACT_TOKEN ? { Authorization: `Bearer ${environment.GITHUB_ARTIFACT_TOKEN}` } : {}) };
  const request = async (url, options) => {
    try { return await fetchImpl(url, options); }
    catch { throw new Error('GitHub release request failed. Check Actions read access and network availability.'); }
  };
  const api = async route => {
    const response = await request(`${apiRoot}${route}`, { headers, redirect: 'error', signal: AbortSignal.timeout(30_000) });
    try { return JSON.parse((await responseBytes(response, 2 * 1024 * 1024)).toString('utf8')); }
    catch { throw new Error('GitHub release metadata is unavailable or invalid.'); }
  };
  const waitSetting = environment.ARCHTREE_RELEASE_WAIT_SECONDS ?? '2100';
  if (!/^(0|[1-9][0-9]*)$/.test(waitSetting) || Number(waitSetting) > 3_600) throw new Error('ARCHTREE_RELEASE_WAIT_SECONDS must be an integer from 0 to 3600.');
  const run = await waitForSuccessfulReleaseRun({ commitSha, waitSeconds: Number(waitSetting),
    lookup: () => api(`/actions/workflows/finitude-web-release.yml/runs?head_sha=${commitSha}&event=push&per_page=100`),
    onWaiting: () => console.log('Waiting for the exact main commit release gate; no artifact is staged.') });
  const identity = validateRun(run, commitSha);
  const artifactListing = await api(`/actions/runs/${identity.runId}/artifacts?per_page=100`);
  if (!Array.isArray(artifactListing.artifacts) || artifactListing.total_count > 100) throw new Error('Release artifact lookup is ambiguous.');
  const matches = artifactListing.artifacts.filter(value => value.name === releaseArtifactName(identity));
  const artifact = matches[0];
  if (matches.length !== 1 || !validId(artifact.id) || artifact.expired !== false
    || !Number.isSafeInteger(artifact.size_in_bytes) || artifact.size_in_bytes < 1 || artifact.size_in_bytes > maximumArchiveBytes
    || !/^sha256:[a-f0-9]{64}$/.test(artifact.digest ?? '') || artifact.workflow_run?.id !== run.id
    || artifact.workflow_run?.head_sha !== commitSha || artifact.workflow_run?.head_branch !== 'main'
    || artifact.workflow_run?.repository_id !== run.repository.id || artifact.workflow_run?.head_repository_id !== run.repository.id) {
    throw new Error('A current, digest-bound artifact from the successful release attempt is required.');
  }
  const temporary = await mkdtemp(path.join(root, '.release-promotion-'));
  try {
    const redirect = await request(`${apiRoot}/actions/artifacts/${artifact.id}/zip`,
      { headers, redirect: 'manual', signal: AbortSignal.timeout(30_000) });
    let location;
    try { location = new URL(redirect.headers.get('location')); } catch { throw new Error('GitHub did not provide an artifact download.'); }
    if (redirect.status !== 302 || location.protocol !== 'https:' || location.username || location.password || location.port
      || !(location.hostname.endsWith('.blob.core.windows.net') || location.hostname.endsWith('.githubusercontent.com'))) {
      throw new Error('GitHub artifact download destination is invalid.');
    }
    // Never send the GitHub bearer credential to the signed storage URL, or follow further redirects.
    const download = await request(location.href, { redirect: 'error', signal: AbortSignal.timeout(120_000) });
    if (!download.ok || !download.body) throw new Error('GitHub artifact download failed.');
    const archivePath = path.join(temporary, 'github-artifact.zip');
    const file = await open(archivePath, 'wx'); const hash = createHash('sha256'); let size = 0;
    try {
      for await (const part of download.body) {
        size += part.length;
        if (size > maximumArchiveBytes) throw new Error('GitHub artifact download exceeds its limit.');
        hash.update(part); await file.writeFile(part);
      }
    } catch { throw new Error('GitHub artifact body could not be verified.'); }
    finally { await file.close(); }
    if (size !== artifact.size_in_bytes || `sha256:${hash.digest('hex')}` !== artifact.digest) throw new Error('GitHub artifact checksum mismatch.');
    const unpack = (archive, destination) => {
      try { execFileSync('python3', [extractor, archive, destination], { stdio: 'pipe', timeout: 120_000 }); }
      catch { throw new Error('Release archive extraction failed validation; Python 3 is required.'); }
    };
    const downloaded = path.join(temporary, 'downloaded'); unpack(archivePath, downloaded);
    const bundleName = `archtree-eb-${commitSha}.zip`;
    if (JSON.stringify((await readdir(downloaded)).sort()) !== JSON.stringify([bundleName, 'release-provenance.json'].sort())) {
      throw new Error('GitHub artifact contains unexpected files.');
    }
    const provenancePath = path.join(downloaded, 'release-provenance.json');
    if ((await lstat(provenancePath)).size > 16_384) throw new Error('Release provenance exceeds its limit.');
    const provenance = validateReleaseProvenance(parseJson(await readFile(provenancePath, 'utf8')), identity);
    const bundle = path.join(downloaded, bundleName);
    if (await archiveDigest(bundle) !== provenance.bundleSha256) throw new Error('Tested bundle checksum mismatch.');
    const candidate = path.join(temporary, 'candidate'); unpack(bundle, candidate);
    await validateElasticBeanstalkArtifact(candidate);
    const releasePath = path.join(candidate, 'RELEASE.json');
    if ((await lstat(releasePath)).size > 16_384) throw new Error('Bundle release identity exceeds its limit.');
    const release = parseJson(await readFile(releasePath, 'utf8'));
    if (!release || release.schemaVersion !== 1 || release.commitSha !== commitSha || release.buildId !== `github-${identity.runId}-${identity.runAttempt}`
      || Object.keys(release).sort().join(',') !== 'buildId,commitSha,schemaVersion') {
      throw new Error('Bundle RELEASE.json does not match the successful workflow attempt.');
    }
    const current = validateRun(await api(`/actions/runs/${identity.runId}`), commitSha);
    if (current.runAttempt !== identity.runAttempt) throw new Error('Release workflow changed during promotion.');
    await rename(candidate, outputDirectory);
    return { outputDirectory, release, artifactId: artifact.id, bundleSha256: provenance.bundleSha256 };
  } finally { await rm(temporary, { recursive: true, force: true }); }
};

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  promoteElasticBeanstalkArtifact()
    .then(result => console.log(JSON.stringify({ category: 'tested_release_promoted', ...result.release,
      artifactId: result.artifactId, bundleSha256: result.bundleSha256 })))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
