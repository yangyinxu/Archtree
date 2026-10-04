import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const writeFixtureFile = async (root: string, relativePath: string, contents: string) => {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, 'utf8');
};

/** Adds only the generated guide assets for a specific clean release identity. */
export const writeEngineeringFixture = async (root: string, commit = 'a'.repeat(40)) => {
  const html = '<link rel="stylesheet" href="/engineering/guide.css"><script defer src="/engineering/guide.js"></script>';
  await writeFixtureFile(root, 'engineering/dist/index.html', html);
  await writeFixtureFile(root, 'engineering/dist/system/map/index.html', html);
  await writeFixtureFile(root, 'engineering/dist/guide.css', 'body { color: black; }');
  await writeFixtureFile(root, 'engineering/dist/guide.js', '"use strict";');
  await writeFixtureFile(root, 'engineering/dist/manifest.json', JSON.stringify({ schemaVersion: 1,
    revision: { commit, dirty: false }, sourceDigest: 'd'.repeat(64),
    pages: [{ slug: '', title: 'Engineering', description: 'Overview', file: 'index.html' },
      { slug: 'system/map', title: 'System map', description: 'Boundaries', file: 'system/map/index.html' }],
    assets: ['guide.css', 'guide.js'] }));
};

/** Creates the minimum source tree accepted by the deployment allowlist. */
export const createSourceFixture = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'archtree-eb-source-'));
  await writeFixtureFile(root, 'package.json', '{"name":"fixture","workspaces":["web"]}\n');
  await writeFixtureFile(root, 'package-lock.json', '{"name":"fixture","lockfileVersion":3}\n');
  await writeFixtureFile(root, 'tsconfig.json', '{}\n');
  await writeFixtureFile(root, 'src/app.ts', 'export const app = true;\n');
  await writeFixtureFile(root, 'localization/generated/manifest.json', '{"schemaVersion":1}\n');
  await writeFixtureFile(root, 'web/package.json', '{"name":"fixture-web"}\n');
  await writeFixtureFile(
    root,
    'web/dist/index.html',
    '<script type="module" src="/finitude/assets/index-AbCd1234.js"></script>'
      + '<link rel="stylesheet" href="/finitude/assets/index-XyZ_5678.css">\n'
  );
  await writeFixtureFile(
    root,
    'web/dist/.vite/manifest.json',
    `${JSON.stringify({
      'index.html': {
        file: 'assets/index-AbCd1234.js',
        css: ['assets/index-XyZ_5678.css'],
        assets: ['assets/logo-Qwer1234.webp'],
        isEntry: true
      }
    })}\n`
  );
  await writeFixtureFile(root, 'web/dist/assets/index-AbCd1234.js', 'console.log("fixture");\n');
  await writeFixtureFile(root, 'web/dist/assets/index-XyZ_5678.css', 'body { color: black; }\n');
  await writeFixtureFile(root, 'web/dist/assets/logo-Qwer1234.webp', 'fixture image\n');
  for (const hook of [
    '.platform/confighooks/postdeploy/01_configure_https.sh',
    '.platform/hooks/prebuild/01_install_certbot.sh',
    '.platform/hooks/prebuild/02_install_ffmpeg.sh',
    '.platform/hooks/postdeploy/01_configure_https.sh',
    '.platform/hooks/postdeploy/02_install_certbot_timer.sh'
  ]) {
    await writeFixtureFile(root, hook, '#!/usr/bin/env bash\n');
    await chmod(path.join(root, hook), 0o755);
  }
  await writeFixtureFile(root, '.platform/nginx/conf.d/fixture.conf', 'send_timeout 120s;\n');
  await writeFixtureFile(root, '.ebextensions/https-instance.config', 'Resources: {}\n');
  await writeFixtureFile(root, '.ebextensions/room-audio-decoder.config', 'option_settings: {}\n');
  await writeFixtureFile(root, '.ebextensions/social-capacity.config', 'option_settings: {}\n');
  await writeFixtureFile(root, 'README.md', 'must not be staged\n');
  await writeFixtureFile(root, '.gitignore', 'engineering/dist\nelastic-beanstalk-artifact\n');
  await writeEngineeringFixture(root);
  return root;
};
