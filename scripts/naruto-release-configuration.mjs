import {appendFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

/** Accepts an immutable source identity, never a branch, tag, abbreviated hash or shell expression. */
export const narutoReleaseConfiguration = ({sourceCommit, eventName, ref} = {}) => {
  if (sourceCommit === undefined || sourceCommit === '') return {enabled: false, commit: ''};
  if (typeof sourceCommit !== 'string' || !/^[a-f0-9]{40}$/i.test(sourceCommit)) {
    throw new Error('NARUTO_SOURCE_COMMIT must be a complete 40-character hexadecimal commit SHA.');
  }
  if (eventName !== 'push' || ref !== 'refs/heads/main') return {enabled: false, commit: ''};
  return {enabled: true, commit: sourceCommit.toLowerCase()};
};

/** Writes only validated, non-secret values to the runner's step-output file. */
export const writeNarutoReleaseConfiguration = async (environment = process.env) => {
  const result = narutoReleaseConfiguration({sourceCommit: environment.NARUTO_SOURCE_COMMIT,
    eventName: environment.GITHUB_EVENT_NAME, ref: environment.GITHUB_REF});
  if (!environment.GITHUB_OUTPUT) throw new Error('GitHub step output is required for release configuration.');
  await appendFile(environment.GITHUB_OUTPUT, `enabled=${result.enabled}\ncommit=${result.commit}\n`);
  return result;
};

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  writeNarutoReleaseConfiguration().then(result => console.log(result.enabled
    ? 'The release includes the pinned Naruto source.' : 'The release does not include Naruto.'))
    .catch(error => {console.error(error.message); process.exitCode = 1;});
}
