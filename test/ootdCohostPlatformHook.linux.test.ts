import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const hook = path.join(repositoryRoot, '.platform/hooks/postdeploy/03_cohost_ootd.sh');
const configurationHook = path.join(repositoryRoot, '.platform/confighooks/postdeploy/03_cohost_ootd.sh');

const domain = 'ootd.kashewt.com';
const secretValues = {
  APP_ENV: 'production',
  APP_ORIGIN: `https://${domain}`,
  DB_CONN_STRING: 'mongodb+srv://ootd-user:s3cr3t-db-password@cluster.example/',
  DB_NAME: 'ootd',
  OOTD_OWNER_PREVIEW_ACCOUNT_IDS: 'owner-1',
  OPENAI_API_KEY: 'sk-test-secret-value-that-must-not-be-logged'
};

const writeExecutable = async (filePath: string, lines: string[]) => {
  await writeFile(filePath, `${lines.join('\n')}\n`, 'utf8');
  await chmod(filePath, 0o755);
};

const exists = async (filePath: string) => {
  try {
    await lstat(filePath);
    return true;
  } catch {
    return false;
  }
};

const readOptional = async (filePath: string) => (await exists(filePath) ? readFile(filePath, 'utf8') : '');

/** Builds fake host commands and an isolated filesystem for one OOTD co-host run. */
const createFixture = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ootd-cohost-hook-'));
  const bin = path.join(root, 'bin');
  const logs = path.join(root, 'logs');
  const artifactTree = path.join(root, 'artifact-tree');
  const certRoot = path.join(root, 'certificates');
  await mkdir(bin, { recursive: true });
  await mkdir(logs, { recursive: true });
  await mkdir(path.join(artifactTree, '.next/standalone'), { recursive: true });
  await writeFile(path.join(artifactTree, '.next/standalone/server.js'), '// server\n');
  await writeFile(path.join(artifactTree, 'package-lock.json'), '{}\n');

  const artifact = path.join(root, 'ootd-release.zip');
  await writeFile(artifact, 'artifact bytes\n');
  const artifactSha256 = createHash('sha256').update('artifact bytes\n').digest('hex');
  const secretFile = path.join(root, 'secret.json');
  await writeFile(secretFile, JSON.stringify(secretValues));

  const logLine = (name: string) => `printf '%s\\n' "$*" >>"${path.join(logs, name)}"`;
  await writeExecutable(path.join(bin, 'aws'), [
    '#!/usr/bin/env bash',
    'set -eu',
    logLine('aws.log'),
    'if [[ "$1" == "secretsmanager" ]]; then cat "${OOTD_TEST_SECRET_FILE}"; exit 0; fi',
    'if [[ "$1" == "s3" ]]; then cp "${OOTD_TEST_ARTIFACT}" "${@: -1}"; exit "${OOTD_TEST_S3_STATUS:-0}"; fi',
    'exit 1'
  ]);
  await writeExecutable(path.join(bin, 'sha256sum'), [
    '#!/usr/bin/env bash',
    'set -eu',
    `"${process.execPath}" -e 'const h=require("node:crypto").createHash("sha256");h.update(require("node:fs").readFileSync(process.argv[1]));console.log(h.digest("hex")+"  "+process.argv[1])' "$1"`
  ]);
  await writeExecutable(path.join(bin, 'unzip'), [
    '#!/usr/bin/env bash',
    'set -eu',
    logLine('unzip.log'),
    'cp -R "${OOTD_TEST_ARTIFACT_TREE}/." "${@: -1}"'
  ]);
  await writeExecutable(path.join(bin, 'npm'), [
    '#!/usr/bin/env bash',
    'set -eu',
    'printf \'%s|%s\\n\' "$PWD" "$*" >>"${OOTD_TEST_LOGS}/npm.log"',
    'mkdir -p node_modules'
  ]);
  await writeExecutable(path.join(bin, 'systemd-run'), [
    '#!/usr/bin/env bash',
    'set -eu',
    logLine('systemd-run.log'),
    'exit "${OOTD_TEST_MIGRATE_STATUS:-0}"'
  ]);
  await writeExecutable(path.join(bin, 'systemctl'), [
    '#!/usr/bin/env bash',
    'set -eu',
    logLine('systemctl.log'),
    'if [[ "$1" == "start" ]]; then exit "${OOTD_TEST_START_STATUS:-0}"; fi'
  ]);
  await writeExecutable(path.join(bin, 'curl'), [
    '#!/usr/bin/env bash',
    'set -eu',
    logLine('curl.log'),
    'exit "${OOTD_TEST_HEALTH_STATUS:-0}"'
  ]);
  await writeExecutable(path.join(bin, 'nginx'), [
    '#!/usr/bin/env bash',
    'set -eu',
    logLine('nginx.log'),
    'exit "${OOTD_TEST_NGINX_STATUS:-0}"'
  ]);
  await writeExecutable(path.join(bin, 'certbot'), [
    '#!/usr/bin/env bash',
    'set -eu',
    logLine('certbot.log'),
    'if [[ "${OOTD_TEST_ISSUE_STATUS:-0}" != "0" ]]; then exit "${OOTD_TEST_ISSUE_STATUS}"; fi',
    `install -d "${certRoot}/${domain}"`,
    `printf 'certificate\\n' >"${certRoot}/${domain}/fullchain.pem"`,
    `printf 'key\\n' >"${certRoot}/${domain}/privkey.pem"`
  ]);
  await writeExecutable(path.join(bin, 'get-config'), [
    '#!/usr/bin/env bash',
    'set -eu',
    '[[ "$1" == "environment" && "$2" == "-k" ]]',
    'case "$3" in ACME_EMAIL) printf \'ops@example.com\' ;; *) exit 1 ;; esac'
  ]);
  for (const name of ['flock', 'chown', 'id', 'useradd', 'mkswap']) {
    await writeExecutable(path.join(bin, name), ['#!/usr/bin/env bash', logLine(`${name}.log`)]);
  }
  await writeExecutable(path.join(bin, 'swapon'), ['#!/usr/bin/env bash', logLine('swapon.log')]);
  await writeExecutable(path.join(bin, 'fallocate'), ['#!/usr/bin/env bash', logLine('fallocate.log'), 'touch "${@: -1}"']);

  const optRoot = path.join(root, 'opt-ootd');
  const environment: NodeJS.ProcessEnv = {
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    HOME: root,
    OOTD_COHOST_GET_CONFIG_BIN: path.join(bin, 'get-config'),
    OOTD_COHOST_AWS_BIN: path.join(bin, 'aws'),
    OOTD_COHOST_CERTBOT_BIN: path.join(bin, 'certbot'),
    OOTD_COHOST_NGINX_BIN: path.join(bin, 'nginx'),
    OOTD_COHOST_SYSTEMCTL_BIN: path.join(bin, 'systemctl'),
    OOTD_COHOST_SYSTEMD_RUN_BIN: path.join(bin, 'systemd-run'),
    OOTD_COHOST_FLOCK_BIN: path.join(bin, 'flock'),
    OOTD_COHOST_CURL_BIN: path.join(bin, 'curl'),
    OOTD_COHOST_UNZIP_BIN: path.join(bin, 'unzip'),
    OOTD_COHOST_SHA256SUM_BIN: path.join(bin, 'sha256sum'),
    OOTD_COHOST_CHOWN_BIN: path.join(bin, 'chown'),
    OOTD_COHOST_ID_BIN: path.join(bin, 'id'),
    OOTD_COHOST_USERADD_BIN: path.join(bin, 'useradd'),
    OOTD_COHOST_SWAPON_BIN: path.join(bin, 'swapon'),
    OOTD_COHOST_MKSWAP_BIN: path.join(bin, 'mkswap'),
    OOTD_COHOST_FALLOCATE_BIN: path.join(bin, 'fallocate'),
    OOTD_COHOST_NODE_BIN: process.execPath,
    OOTD_COHOST_NPM_BIN: path.join(bin, 'npm'),
    OOTD_COHOST_ROOT: optRoot,
    OOTD_COHOST_ETC_DIR: path.join(root, 'etc-ootd'),
    OOTD_COHOST_STATE_DIR: path.join(root, 'state'),
    OOTD_COHOST_SYSTEMD_DIR: path.join(root, 'systemd'),
    OOTD_COHOST_NGINX_CONFIG_PATH: path.join(root, 'nginx', 'ootd-cohost.conf'),
    OOTD_COHOST_ACME_ROOT: path.join(root, 'acme'),
    OOTD_COHOST_CERT_ROOT: certRoot,
    OOTD_COHOST_SWAP_FILE: path.join(root, 'swap', 'ootd.swap'),
    OOTD_COHOST_FSTAB: path.join(root, 'fstab'),
    OOTD_COHOST_LOCK_FILE: path.join(root, 'lock', 'ootd.lock'),
    OOTD_COHOST_INSTALL_PATH: path.join(root, 'sbin', 'ootd-cohost'),
    OOTD_COHOST_HEALTH_ATTEMPTS: '2',
    OOTD_COHOST_HEALTH_DELAY_SECONDS: '0',
    OOTD_COHOST_ENABLED: 'true',
    OOTD_COHOST_DOMAIN: domain,
    OOTD_COHOST_ARTIFACT_S3_URI: 's3://ootd-artifacts-example/releases/ootd.zip',
    OOTD_COHOST_ARTIFACT_SHA256: artifactSha256,
    OOTD_COHOST_SECRET_ID: 'ootd/preview/runtime',
    OOTD_TEST_SECRET_FILE: secretFile,
    OOTD_TEST_ARTIFACT: artifact,
    OOTD_TEST_ARTIFACT_TREE: artifactTree,
    OOTD_TEST_LOGS: logs
  };

  const run = (extra: NodeJS.ProcessEnv = {}, script = hook) =>
    execFileAsync('/bin/bash', [script], { env: { ...environment, OOTD_COHOST_FOREGROUND: '1', ...extra } });
  const log = (name: string) => readOptional(path.join(logs, name));
  return {
    root,
    optRoot,
    environment,
    artifactSha256,
    secretFile,
    run,
    log,
    release: path.join(optRoot, 'releases', artifactSha256),
    current: path.join(optRoot, 'current'),
    envFile: path.join(root, 'etc-ootd', 'runtime.env'),
    nginxConfig: path.join(root, 'nginx', 'ootd-cohost.conf'),
    systemdDir: path.join(root, 'systemd')
  };
};

const runFailure = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as { code: number; stdout: string; stderr: string };
  }
  assert.fail('the co-host run should fail');
};

test('the Elastic Beanstalk hook only schedules the background deployment', async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const result = await fixture.run({ OOTD_COHOST_FOREGROUND: '' });
  assert.match(result.stdout, /Started ootd-cohost-deploy\.service/);
  const unit = await readFile(path.join(fixture.systemdDir, 'ootd-cohost-deploy.service'), 'utf8');
  assert.match(unit, /Environment=OOTD_COHOST_FOREGROUND=1/);
  assert.match(unit, new RegExp(`ExecStart=${fixture.environment.OOTD_COHOST_INSTALL_PATH}`));
  assert.match(await fixture.log('systemctl.log'), /start --no-block ootd-cohost-deploy\.service/);
  // No download, install or migration happens inside Elastic Beanstalk's command timeout.
  assert.equal(await fixture.log('aws.log'), '');
  assert.equal(await fixture.log('systemd-run.log'), '');
  assert.equal((await stat(fixture.environment.OOTD_COHOST_INSTALL_PATH!)).mode & 0o111, 0o111);

  const blocked = await fixture.run({ OOTD_COHOST_FOREGROUND: '', OOTD_TEST_START_STATUS: '1' });
  assert.match(blocked.stdout, /could not be scheduled; Archtree is unaffected/);
});

test('the configuration hook delegates to the installed configurator without failing Archtree', async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const missing = await execFileAsync('/bin/bash', [configurationHook], {
    env: { ...fixture.environment, OOTD_COHOST_SOURCE: path.join(fixture.root, 'missing.sh') }
  });
  assert.match(missing.stdout, /unavailable; skipping/);

  await fixture.run({ OOTD_COHOST_FOREGROUND: '' });
  const delegated = await execFileAsync('/bin/bash', [configurationHook], { env: fixture.environment });
  assert.match(delegated.stdout, /Started ootd-cohost-deploy\.service/);
});

test('installs a verified release, sandboxes it and routes HTTPS after issuance', async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const result = await fixture.run();
  for (const value of Object.values(secretValues).filter(value => value.length > 12)) {
    assert.equal(result.stdout.includes(value), false);
    assert.equal(result.stderr.includes(value), false);
  }
  assert.equal(await readlink(fixture.current), fixture.release);
  assert.ok(await exists(path.join(fixture.release, '.ootd-cohost-ready')));
  assert.ok(await exists(path.join(fixture.release, '.ootd-cohost-migrated')));

  const envFile = await readFile(fixture.envFile, 'utf8');
  assert.equal((await stat(fixture.envFile)).mode & 0o777, 0o600);
  assert.match(envFile, /^DB_NAME='ootd'$/m);
  assert.match(envFile, /^OPENAI_API_KEY='sk-test-secret-value-that-must-not-be-logged'$/m);

  assert.match(await fixture.log('npm.log'), /ci --omit=dev --ignore-scripts/);
  const migration = await fixture.log('systemd-run.log');
  assert.match(migration, /--uid=ootd --gid=ootd/);
  assert.match(migration, /--property=IPAddressDeny=169\.254\.169\.254 fd00:ec2::254/);
  assert.match(migration, /--setenv=AWS_EC2_METADATA_DISABLED=true/);
  assert.match(migration, /scripts\/migrate\.ts/);

  const web = await readFile(path.join(fixture.systemdDir, 'ootd-web.service'), 'utf8');
  for (const directive of [
    'User=ootd',
    `EnvironmentFile=${fixture.envFile}`,
    'IPAddressDeny=169.254.169.254 fd00:ec2::254',
    'Environment=AWS_EC2_METADATA_DISABLED=true',
    'Environment=HOSTNAME=127.0.0.1',
    'Environment=PORT=3100',
    'MemoryMax=320M',
    'ProtectSystem=strict',
    'NoNewPrivileges=yes'
  ]) {
    assert.ok(web.split('\n').includes(directive), `ootd-web.service must contain ${directive}`);
  }
  for (const job of ['generation-jobs', 'account-deletions', 'assets-reconcile', 'ops-audit']) {
    const unit = await readFile(path.join(fixture.systemdDir, `ootd-${job}.service`), 'utf8');
    assert.match(unit, /^IPAddressDeny=169\.254\.169\.254 fd00:ec2::254$/m);
    assert.match(unit, /^User=ootd$/m);
    assert.ok(await exists(path.join(fixture.systemdDir, `ootd-${job}.timer`)));
  }
  const systemctl = await fixture.log('systemctl.log');
  assert.match(systemctl, /restart ootd-web\.service/);
  assert.match(systemctl, /enable --now ootd-generation-jobs\.timer/);
  assert.match(systemctl, /reload nginx/);

  const nginx = await readFile(fixture.nginxConfig, 'utf8');
  assert.match(nginx, new RegExp(`server_name ${domain.replace(/\./g, '\\.')};`));
  assert.match(nginx, /listen 443 ssl;/);
  assert.match(nginx, /proxy_pass http:\/\/127\.0\.0\.1:3100;/);
  assert.match(nginx, /client_max_body_size 13m;/);
  assert.match(nginx, /proxy_request_buffering off;/);
  assert.doesNotMatch(nginx, /127\.0\.0\.1:8080/);
  assert.match(await fixture.log('certbot.log'), /certonly .*--domain ootd\.kashewt\.com --cert-name ootd\.kashewt\.com/);
  assert.match(await readFile(fixture.environment.OOTD_COHOST_FSTAB!, 'utf8'), /ootd\.swap none swap defaults,nofail/);
});

test('rejects a digest mismatch before extraction or migration', async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const failure = await runFailure(fixture.run({ OOTD_COHOST_ARTIFACT_SHA256: 'a'.repeat(64) }));
  assert.match(failure.stdout, /digest does not match/);
  assert.equal(await fixture.log('unzip.log'), '');
  assert.equal(await fixture.log('systemd-run.log'), '');
  assert.equal(await exists(fixture.current), false);
});

test('rejects reserved or unsafe secret entries without echoing values', async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  await writeFile(fixture.secretFile, JSON.stringify({ ...secretValues, PORT: '9999' }));
  const reserved = await runFailure(fixture.run());
  assert.match(reserved.stderr, /may not set PORT/);
  assert.equal(await exists(fixture.envFile), false);

  await writeFile(fixture.secretFile, JSON.stringify({ ...secretValues, OOTD_CSRF_SECRET: "has'quote-secret-value" }));
  const quoted = await runFailure(fixture.run());
  assert.match(quoted.stderr, /OOTD_CSRF_SECRET/);
  assert.equal(quoted.stderr.includes("has'quote-secret-value"), false);

  await writeFile(fixture.secretFile, JSON.stringify({ ...secretValues, APP_ORIGIN: 'https://kashewt.com' }));
  const origin = await runFailure(fixture.run());
  assert.match(origin.stderr, /APP_ORIGIN must equal/);

  const { OOTD_OWNER_PREVIEW_ACCOUNT_IDS: _omitted, ...unrestricted } = secretValues;
  await writeFile(fixture.secretFile, JSON.stringify(unrestricted));
  const open = await runFailure(fixture.run());
  assert.match(open.stderr, /missing OOTD_OWNER_PREVIEW_ACCOUNT_IDS/);
});

test('names invalid properties and never proceeds', async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const failure = await runFailure(fixture.run({
    OOTD_COHOST_ARTIFACT_S3_URI: 'https://example.com/ootd.zip',
    OOTD_COHOST_MEMORY_MAX: '2G'
  }));
  assert.match(failure.stdout, /OOTD_COHOST_ARTIFACT_S3_URI/);
  assert.match(failure.stdout, /OOTD_COHOST_MEMORY_MAX/);
  assert.equal(await fixture.log('aws.log'), '');
});

test('a failed migration keeps the previous release active', async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const previous = path.join(fixture.optRoot, 'releases', 'b'.repeat(64));
  await mkdir(previous, { recursive: true });
  await symlink(previous, fixture.current);

  const failure = await runFailure(fixture.run({ OOTD_TEST_MIGRATE_STATUS: '1' }));
  assert.match(failure.stdout, /migration failed; the previous release remains active/);
  assert.equal(await readlink(fixture.current), previous);
  assert.doesNotMatch(await fixture.log('systemctl.log'), /restart ootd-web/);
});

test('an unhealthy release rolls back to the previous release', async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const previous = path.join(fixture.optRoot, 'releases', 'c'.repeat(64));
  await mkdir(previous, { recursive: true });
  await symlink(previous, fixture.current);

  const failure = await runFailure(fixture.run({ OOTD_TEST_HEALTH_STATUS: '7' }));
  assert.match(failure.stdout, /failed its health check; restoring the previous release/);
  assert.equal(await readlink(fixture.current), previous);
  // The rejected release is kept for diagnosis and retried without reinstalling.
  assert.ok(await exists(path.join(fixture.release, '.ootd-cohost-ready')));
});

test('pending issuance serves only challenges, then the certificate mode activates HTTPS', async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const pending = await fixture.run({ OOTD_TEST_ISSUE_STATUS: '1' });
  assert.match(pending.stdout, /issuance is pending/);
  const challenge = await readFile(fixture.nginxConfig, 'utf8');
  assert.match(challenge, /\.well-known\/acme-challenge/);
  assert.match(challenge, /return 503;/);
  assert.doesNotMatch(challenge, /proxy_pass|listen 443/);
  const certificateUnit = await readFile(path.join(fixture.systemdDir, 'ootd-cohost-certificate.service'), 'utf8');
  assert.match(certificateUnit, /Environment=OOTD_COHOST_MODE=certificate/);
  assert.match(certificateUnit, /ConditionPathExists=!.*ootd\.kashewt\.com\/fullchain\.pem/);

  await fixture.run({ OOTD_COHOST_MODE: 'certificate' });
  assert.match(await readFile(fixture.nginxConfig, 'utf8'), /listen 443 ssl;/);
});

test('an Nginx rejection restores the previous OOTD route', async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await fixture.run({ OOTD_TEST_ISSUE_STATUS: '1' });
  const before = await readFile(fixture.nginxConfig, 'utf8');

  const failure = await runFailure(fixture.run({ OOTD_COHOST_MODE: 'certificate', OOTD_TEST_NGINX_STATUS: '1' }));
  assert.match(failure.stdout, /Nginx rejected the OOTD configuration/);
  assert.equal(await readFile(fixture.nginxConfig, 'utf8'), before);
});

test('disabling stops OOTD, removes its route and secrets, and keeps releases', async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await fixture.run();

  const result = await fixture.run({ OOTD_COHOST_ENABLED: 'false' });
  assert.match(result.stdout, /disabled; releases are retained/);
  assert.match(await fixture.log('systemctl.log'), /disable --now ootd-web\.service/);
  assert.equal(await exists(fixture.nginxConfig), false);
  assert.equal(await exists(fixture.envFile), false);
  assert.ok(await exists(fixture.release));
});
