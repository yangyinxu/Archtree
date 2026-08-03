import { execFileSync } from 'node:child_process';
import {
  access,
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile
} from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const defaultOutputDirectory = path.join(repositoryRoot, 'elastic-beanstalk-artifact');
const artifactMarkerName = '.archtree-eb-artifact';
const artifactMarkerContents = 'archtree-eb-artifact-v1\n';

const artifactEntries = [
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'src',
  'web/package.json',
  'web/dist',
  '.platform',
  '.ebextensions'
];

const forbiddenComponents = new Set([
  'node_modules',
  'test-results',
  'playwright-report',
  'coverage',
  '.nyc_output'
]);

const forbiddenCredentialNames = new Set([
  '.envrc',
  '.npmrc',
  'credentials',
  'credentials.json',
  'id_ed25519',
  'id_rsa'
]);

const forbiddenCredentialExtensions = new Set([
  '.key',
  '.p12',
  '.pem',
  '.pfx'
]);

const expectedRootEntries = new Set([
  '.ebextensions',
  '.platform',
  artifactMarkerName,
  'RELEASE.json',
  'package-lock.json',
  'package.json',
  'src',
  'tsconfig.json',
  'web'
]);

/** Locks destructive replacement to the dedicated, marker-owned staging directory. */
const assertSafeOutputDirectory = async (sourceRoot, outputDirectory) => {
  const requiredOutputDirectory = path.join(sourceRoot, 'elastic-beanstalk-artifact');
  if (outputDirectory !== requiredOutputDirectory) {
    throw new Error(`Deployment staging is restricted to: ${requiredOutputDirectory}`);
  }

  try {
    const outputStats = await lstat(outputDirectory);
    if (outputStats.isSymbolicLink()) {
      throw new Error(`Refusing to replace a symbolic-link output directory: ${outputDirectory}`);
    }
    if (!outputStats.isDirectory()) {
      throw new Error(`Refusing to replace a non-directory artifact target: ${outputDirectory}`);
    }
    const marker = await readFile(path.join(outputDirectory, artifactMarkerName), 'utf8');
    if (marker !== artifactMarkerContents) {
      throw new Error(`Refusing to replace an unowned artifact directory: ${outputDirectory}`);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    try {
      await access(outputDirectory, fsConstants.F_OK);
      throw new Error(`Refusing to replace an unowned artifact directory: ${outputDirectory}`);
    } catch (accessError) {
      if (accessError?.code !== 'ENOENT') throw accessError;
    }
  }
};

/** Resolves a bounded, non-secret release identity from CI metadata or Git. */
const releaseMetadata = (sourceRoot, environment) => {
  let commitSha = environment.CODEBUILD_RESOLVED_SOURCE_VERSION
    || environment.GITHUB_SHA
    || '';
  if (!commitSha) {
    try {
      const worktreeStatus = execFileSync(
        'git',
        ['status', '--porcelain', '--untracked-files=all'],
        {
          cwd: sourceRoot,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore']
        }
      ).trim();
      if (worktreeStatus) {
        throw new Error('Commit local changes before staging a release artifact.');
      }
      commitSha = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: sourceRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim();
    } catch (error) {
      if (error instanceof Error && error.message.includes('Commit local changes')) throw error;
      throw new Error('A commit SHA is required to identify the deployment artifact.');
    }
  }

  if (!/^[0-9a-f]{7,64}$/i.test(commitSha)) {
    throw new Error('Deployment artifact commit SHA must contain 7–64 hexadecimal characters.');
  }

  const buildId = environment.CODEBUILD_BUILD_ID
    || (environment.GITHUB_RUN_ID
      ? `github-${environment.GITHUB_RUN_ID}-${environment.GITHUB_RUN_ATTEMPT || '1'}`
      : 'local');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(buildId)) {
    throw new Error('Deployment artifact build ID contains unsupported characters.');
  }

  return {
    schemaVersion: 1,
    commitSha: commitSha.toLowerCase(),
    buildId
  };
};

const requireRegularFile = async (filePath, label) => {
  let stats;
  try {
    stats = await lstat(filePath);
  } catch {
    throw new Error(`${label} is missing: ${filePath}`);
  }
  if (!stats.isFile()) throw new Error(`${label} must be a regular file: ${filePath}`);
  if (stats.size === 0) throw new Error(`${label} must not be empty: ${filePath}`);
};

const safeDistPath = (distRoot, filename) => {
  if (typeof filename !== 'string' || filename.length === 0 || filename.includes('\\')) {
    throw new Error('Vite manifest contains an invalid emitted filename.');
  }
  const resolved = path.resolve(distRoot, filename);
  const relative = path.relative(distRoot, resolved);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Vite manifest filename escapes web/dist: ${filename}`);
  }
  return resolved;
};

const emittedFilesForChunk = (chunk) => {
  if (!chunk || typeof chunk !== 'object' || Array.isArray(chunk)) return [];
  const files = [];
  if (chunk.file !== undefined) {
    if (typeof chunk.file !== 'string') {
      throw new Error('Vite manifest chunk file must be a string.');
    }
    files.push(chunk.file);
  }
  for (const field of ['css', 'assets']) {
    if (chunk[field] === undefined) continue;
    if (!Array.isArray(chunk[field]) || chunk[field].some((item) => typeof item !== 'string')) {
      throw new Error(`Vite manifest chunk ${field} must be an array of strings.`);
    }
    files.push(...chunk[field]);
  }
  return files;
};

const listTreeEntries = async (directory) => {
  const discoveredEntries = [];
  const visit = async (currentDirectory) => {
    const entries = await readdir(currentDirectory, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(currentDirectory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Deployment artifacts cannot contain symbolic links: ${entryPath}`);
      }
      if (entry.isDirectory()) {
        discoveredEntries.push({ path: entryPath, type: 'directory' });
        await visit(entryPath);
      } else if (entry.isFile()) {
        discoveredEntries.push({ path: entryPath, type: 'file' });
      } else {
        throw new Error(`Deployment artifacts require regular files: ${entryPath}`);
      }
    }
  };
  await visit(directory);
  return discoveredEntries;
};

const listFiles = async (directory) => {
  const entries = await listTreeEntries(directory);
  return entries.filter((entry) => entry.type === 'file').map((entry) => entry.path);
};

/** Validates Vite's production index, manifest, and every emitted hashed asset. */
const validateListenerDistribution = async (artifactRoot) => {
  const distRoot = path.join(artifactRoot, 'web', 'dist');
  const indexPath = path.join(distRoot, 'index.html');
  const manifestPath = path.join(distRoot, '.vite', 'manifest.json');
  await requireRegularFile(indexPath, 'Listener production index');
  await requireRegularFile(manifestPath, 'Listener Vite manifest');

  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch {
    throw new Error('Listener Vite manifest must contain valid JSON.');
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('Listener Vite manifest must be an object.');
  }

  const entryChunk = manifest['index.html'];
  if (!entryChunk || typeof entryChunk !== 'object' || entryChunk.isEntry !== true) {
    throw new Error('Listener Vite manifest must identify index.html as an entry.');
  }
  if (typeof entryChunk.file !== 'string') {
    throw new Error('Listener Vite manifest index entry must reference an emitted file.');
  }

  const referencedAssets = new Set();
  for (const chunk of Object.values(manifest)) {
    for (const filename of emittedFilesForChunk(chunk)) {
      const assetPath = safeDistPath(distRoot, filename);
      await requireRegularFile(assetPath, 'Vite manifest asset');
      const relativeAsset = path.relative(distRoot, assetPath).split(path.sep).join('/');
      if (!relativeAsset.startsWith('assets/')) {
        throw new Error(`Vite emitted files must remain under web/dist/assets: ${filename}`);
      }
      const basename = path.posix.basename(relativeAsset);
      if (!/-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/.test(basename)) {
        throw new Error(`Vite emitted asset is not content-hashed: ${filename}`);
      }
      referencedAssets.add(relativeAsset);
    }
  }
  if (referencedAssets.size === 0) {
    throw new Error('Listener Vite manifest does not reference any emitted assets.');
  }

  const physicalAssetsRoot = path.join(distRoot, 'assets');
  const physicalAssets = await listFiles(physicalAssetsRoot);
  for (const assetPath of physicalAssets) {
    const relativeAsset = path.relative(distRoot, assetPath).split(path.sep).join('/');
    if (!referencedAssets.has(relativeAsset)) {
      throw new Error(`Listener distribution contains an unmanifested asset: ${relativeAsset}`);
    }
  }
  if (physicalAssets.length !== referencedAssets.size) {
    throw new Error('Listener Vite manifest and physical asset counts do not match.');
  }

  const allowedFiles = new Set([
    'index.html',
    '.vite/manifest.json',
    ...referencedAssets
  ]);
  for (const entry of await listTreeEntries(distRoot)) {
    const relative = path.relative(distRoot, entry.path).split(path.sep).join('/');
    if (entry.type === 'directory') {
      if (relative !== '.vite' && relative !== 'assets' && !relative.startsWith('assets/')) {
        throw new Error(`Listener distribution contains an unexpected directory: ${relative}`);
      }
    } else if (!allowedFiles.has(relative)) {
      throw new Error(`Listener distribution contains an unexpected file: ${relative}`);
    }
  }

  const indexHtml = await readFile(indexPath, 'utf8');
  const directEntryAssets = [
    entryChunk.file,
    ...(Array.isArray(entryChunk.css) ? entryChunk.css : [])
  ];
  for (const filename of directEntryAssets) {
    if (!indexHtml.includes(`/listen/${filename}`)) {
      throw new Error(`Listener index does not reference its entry asset: ${filename}`);
    }
  }
};

const validateForbiddenPaths = async (artifactRoot) => {
  for (const { path: entryPath } of await listTreeEntries(artifactRoot)) {
    const relative = path.relative(artifactRoot, entryPath);
    const components = relative.split(path.sep);
    for (const component of components) {
      if (forbiddenComponents.has(component)) {
        throw new Error(`Deployment artifact contains forbidden path component: ${relative}`);
      }
      if (component === '.env' || component.startsWith('.env.')) {
        throw new Error(`Deployment artifact contains an environment file: ${relative}`);
      }
      const normalizedComponent = component.toLowerCase();
      if (forbiddenCredentialNames.has(normalizedComponent)
        || forbiddenCredentialExtensions.has(path.extname(normalizedComponent))) {
        throw new Error(`Deployment artifact contains a credential file: ${relative}`);
      }
    }
  }
};

const validateExactLayout = async (artifactRoot) => {
  const rootEntries = new Set(await readdir(artifactRoot));
  if (rootEntries.size !== expectedRootEntries.size
    || [...rootEntries].some((entry) => !expectedRootEntries.has(entry))) {
    throw new Error(`Deployment artifact root does not match the explicit allowlist: ${[...rootEntries].sort().join(', ')}`);
  }

  const webEntries = (await readdir(path.join(artifactRoot, 'web'))).sort();
  if (webEntries.length !== 2 || webEntries[0] !== 'dist' || webEntries[1] !== 'package.json') {
    throw new Error(`Deployment artifact web directory is not allowlisted: ${webEntries.join(', ')}`);
  }
};

const validateHookPermissions = async (artifactRoot) => {
  const hooksRoot = path.join(artifactRoot, '.platform', 'hooks');
  const hooks = await listFiles(hooksRoot);
  if (hooks.length === 0) throw new Error('Elastic Beanstalk platform hooks are missing.');
  for (const hook of hooks) {
    const stats = await lstat(hook);
    if ((stats.mode & 0o111) === 0) {
      throw new Error(`Elastic Beanstalk platform hook is not executable: ${hook}`);
    }
  }
};

/** Stages and validates the exact root layout consumed by Elastic Beanstalk. */
export const stageElasticBeanstalkArtifact = async ({
  sourceRoot = repositoryRoot,
  outputDirectory = defaultOutputDirectory,
  environment = process.env
} = {}) => {
  const resolvedSourceRoot = path.resolve(sourceRoot);
  const resolvedOutputDirectory = path.resolve(resolvedSourceRoot, outputDirectory);
  await assertSafeOutputDirectory(resolvedSourceRoot, resolvedOutputDirectory);

  const temporaryDirectory = `${resolvedOutputDirectory}.tmp-${process.pid}-${randomUUID()}`;
  await mkdir(path.dirname(resolvedOutputDirectory), { recursive: true });

  try {
    await mkdir(temporaryDirectory, { recursive: true });
    for (const entry of artifactEntries) {
      const source = path.join(resolvedSourceRoot, entry);
      const destination = path.join(temporaryDirectory, entry);
      await access(source, fsConstants.R_OK);
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(source, destination, { recursive: true, errorOnExist: true });
    }

    const metadata = releaseMetadata(resolvedSourceRoot, environment);
    await writeFile(
      path.join(temporaryDirectory, artifactMarkerName),
      artifactMarkerContents,
      { encoding: 'utf8', mode: 0o644 }
    );
    await writeFile(
      path.join(temporaryDirectory, 'RELEASE.json'),
      `${JSON.stringify(metadata, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o644 }
    );

    await validateExactLayout(temporaryDirectory);
    await validateForbiddenPaths(temporaryDirectory);
    await validateListenerDistribution(temporaryDirectory);
    await validateHookPermissions(temporaryDirectory);

    await rm(resolvedOutputDirectory, { recursive: true, force: true });
    await rename(temporaryDirectory, resolvedOutputDirectory);

    return { outputDirectory: resolvedOutputDirectory, release: metadata };
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
};

const isMainModule = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMainModule) {
  if (process.argv.length > 2) {
    console.error('The Elastic Beanstalk staging directory is fixed and accepts no path argument.');
    process.exitCode = 1;
  } else stageElasticBeanstalkArtifact()
    .then(({ outputDirectory: stagedDirectory, release }) => {
      console.log(`Staged Elastic Beanstalk artifact ${release.commitSha} at ${stagedDirectory}`);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
