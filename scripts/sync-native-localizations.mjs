import { copyFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeLocalizationArtifacts } from './build-localizations.mjs';

const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

const requireFile = async (filePath, label) => {
  let details;
  try {
    details = await stat(filePath);
  } catch {
    throw new Error(`${label} was not found at ${filePath}.`);
  }
  if (!details.isFile()) throw new Error(`${label} is not a file: ${filePath}.`);
};

/** Regenerates and pins the shared native manifest plus packaged US-English fallback. */
export const syncPackagedNativeLocalizations = async ({
  archtreeRoot = repositoryRoot,
  iosRoot,
  androidRoot
}) => {
  await requireFile(
    path.join(iosRoot, 'Finitude_iOS.xcodeproj', 'project.pbxproj'),
    'Finitude iOS project'
  );
  await requireFile(path.join(androidRoot, 'settings.gradle.kts'), 'Finitude Android project');
  await writeLocalizationArtifacts(archtreeRoot);

  const generatedRoot = path.join(archtreeRoot, 'localization', 'generated');
  const targets = [
    {
      directory: path.join(iosRoot, 'Finitude_iOS', 'Localization'),
      manifest: 'manifest.json',
      fallback: 'en-US.json'
    },
    {
      directory: path.join(androidRoot, 'app', 'src', 'main', 'assets', 'localization'),
      manifest: 'manifest.json',
      fallback: 'en-US.json'
    }
  ];

  for (const target of targets) {
    await mkdir(target.directory, { recursive: true });
    await copyFile(
      path.join(generatedRoot, 'manifest.json'),
      path.join(target.directory, target.manifest)
    );
    await copyFile(
      path.join(generatedRoot, 'bundles', 'en-US.json'),
      path.join(target.directory, target.fallback)
    );
  }
};

const argumentValue = (flag) => {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a path.`);
  return path.resolve(value);
};

const runCli = async () => {
  try {
    await syncPackagedNativeLocalizations({
      archtreeRoot: repositoryRoot,
      iosRoot: argumentValue('--ios-root')
        ?? path.resolve(repositoryRoot, '..', 'Finitude_iOS'),
      androidRoot: argumentValue('--android-root')
        ?? path.resolve(repositoryRoot, '..', 'Finitude_Android')
    });
    process.stdout.write('Synchronized Finitude iOS and Android localization fallbacks.\n');
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runCli();
}
