import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** Keeps local checks on the same supported major as the production runtime. */
export const assertNodeRuntime = (version = process.versions.node) => {
  if (Number(version.split('.')[0]) !== 24) {
    throw new Error(`Archtree requires Node.js 24.x; found ${version}. See docs/development-environment.md.`);
  }
};

/** Checks the isolated-test daemon without loading application configuration. */
export const assertMongoRuntime = (binary = process.env.MONGOD_BINARY || 'mongod') => {
  try {
    const version = execFileSync(binary, ['--version'], {
      encoding: 'utf8', timeout: 10_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
    if (!/^db version v\d+\./m.test(version)) throw new Error('Unexpected daemon version response.');
    return version.match(/^db version (v[^\r\n]+)/m)[1];
  } catch {
    throw new Error('MongoDB test daemon is unavailable. Install MongoDB Community 8.0.12 and add its bin directory to PATH, or set MONGOD_BINARY to the mongod executable. No application database is used. See docs/development-environment.md.');
  }
};

/** Linux deployment checks must never silently pass on an unsupported host. */
export const assertLinuxRuntime = (platform = process.platform) => {
  if (platform !== 'linux') {
    throw new Error('This release check requires Linux (Ubuntu 24.04 CI or WSL). Use npm test for cross-platform development checks.');
  }
  execFileSync('/bin/bash', ['--version'], { stdio: 'ignore', timeout: 10_000 });
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const flags = process.argv.slice(2);
    if (flags.some(flag => !['--mongo', '--linux'].includes(flag))) throw new Error('Usage: node scripts/check-runtime.mjs [--mongo] [--linux]');
    assertNodeRuntime();
    console.log(`Node.js ${process.versions.node} (${process.platform}/${process.arch}): supported`);
    if (flags.includes('--mongo')) console.log(`Isolated MongoDB test daemon ${assertMongoRuntime()}: available`);
    if (flags.includes('--linux')) {
      assertLinuxRuntime();
      console.log('Linux release checks: available');
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
