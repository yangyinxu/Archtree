import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat, writeFile } from 'node:fs/promises';

export const releaseRepository = 'yangyinxu/Archtree';
export const releaseWorkflow = '.github/workflows/finitude-web-release.yml';
export const releaseGates = ['unit', 'build', 'e2e_typecheck', 'social', 'integration', 'browser', 'staging'];
export const maximumArchiveBytes = 512 * 1024 * 1024;

/** Hashes bounded archives without holding another complete copy in memory. */
export const archiveDigest = async file => {
  const metadata = await stat(file);
  if (!metadata.isFile() || metadata.size < 1 || metadata.size > maximumArchiveBytes) throw new Error('Release archive size is invalid.');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
};

/** Validates full source and CI identities; abbreviated or user-selected references are not promotion identities. */
export const releaseIdentity = ({ commitSha, runId, runAttempt }) => {
  if (!/^[a-f0-9]{40}$/.test(commitSha ?? '') || !/^[1-9][0-9]{0,19}$/.test(String(runId ?? ''))
    || !/^[1-9][0-9]{0,5}$/.test(String(runAttempt ?? ''))) throw new Error('Release identity is invalid.');
  return { commitSha, runId: String(runId), runAttempt: String(runAttempt) };
};

export const releaseArtifactName = identity => {
  const { commitSha, runId, runAttempt } = releaseIdentity(identity);
  return `archtree-eb-${commitSha}-${runId}-${runAttempt}`;
};

/** A sidecar is created only after every required gate completed successfully in the current workflow attempt. */
export const writeReleaseProvenance = async ({ bundlePath, outputPath, environment = process.env }) => {
  const identity = releaseIdentity({ commitSha: environment.GITHUB_SHA, runId: environment.GITHUB_RUN_ID, runAttempt: environment.GITHUB_RUN_ATTEMPT });
  if (environment.GITHUB_REPOSITORY !== releaseRepository || environment.GITHUB_WORKFLOW !== 'Finitude Web release gate') {
    throw new Error('Release provenance requires the trusted repository workflow.');
  }
  for (const gate of releaseGates) {
    if (environment[`RELEASE_${gate.toUpperCase()}_RESULT`] !== 'success') throw new Error(`Required release gate did not pass: ${gate}.`);
  }
  const provenance = { schemaVersion: 1, repository: releaseRepository, workflow: releaseWorkflow,
    ...identity, gates: releaseGates, bundleSha256: await archiveDigest(bundlePath) };
  await writeFile(outputPath, `${JSON.stringify(provenance, null, 2)}\n`, { flag: 'wx' });
  return provenance;
};

/** Binds the downloaded sidecar to server-verified GitHub metadata and all required gate names. */
export const validateReleaseProvenance = (provenance, expected) => {
  const identity = releaseIdentity(expected);
  if (!provenance || provenance.schemaVersion !== 1 || provenance.repository !== releaseRepository
    || provenance.workflow !== releaseWorkflow || provenance.commitSha !== identity.commitSha
    || provenance.runId !== identity.runId || provenance.runAttempt !== identity.runAttempt
    || JSON.stringify(provenance.gates) !== JSON.stringify(releaseGates)
    || !/^[a-f0-9]{64}$/.test(provenance.bundleSha256 ?? '')
    || Object.keys(provenance).sort().join(',') !== 'bundleSha256,commitSha,gates,repository,runAttempt,runId,schemaVersion,workflow') {
    throw new Error('Release provenance does not match the successful gate.');
  }
  return provenance;
};
