import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(new URL('..', import.meta.url).pathname);
const configureHook = path.join(
  repositoryRoot,
  '.platform/hooks/postdeploy/01_configure_https.sh'
);
const timerHook = path.join(
  repositoryRoot,
  '.platform/hooks/postdeploy/02_install_certbot_timer.sh'
);
const configurationHook = path.join(
  repositoryRoot,
  '.platform/confighooks/postdeploy/01_configure_https.sh'
);

const writeExecutable = async (filePath: string, lines: string[]) => {
  await writeFile(filePath, `${lines.join('\n')}\n`, 'utf8');
  await chmod(filePath, 0o755);
};

/** Builds isolated command and filesystem dependencies for the platform hooks. */
const createHookFixture = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'archtree-https-hook-'));
  const bin = path.join(root, 'bin');
  const certRoot = path.join(root, 'certificates');
  const acmeRoot = path.join(root, 'acme');
  const nginxConfig = path.join(root, 'nginx', 'archtree-managed-https.conf');
  const certbotLog = path.join(root, 'certbot.log');
  const getConfigLog = path.join(root, 'get-config.log');
  const nginxLog = path.join(root, 'nginx.log');
  const systemctlLog = path.join(root, 'systemctl.log');
  const flockLog = path.join(root, 'flock.log');
  const readyMarker = path.join(root, 'state', 'certificate-ready');
  const lockFile = path.join(root, 'lock', 'configure-https.lock');
  await mkdir(bin, { recursive: true });

  const certbot = path.join(bin, 'certbot');
  const getConfig = path.join(bin, 'get-config');
  const nginx = path.join(bin, 'nginx');
  const systemctl = path.join(bin, 'systemctl');
  const flock = path.join(bin, 'flock');

  await writeExecutable(certbot, [
    '#!/usr/bin/env bash',
    'set -eu',
    'printf \'%s\\n\' "$*" >>"${ARCHTREE_TEST_CERTBOT_LOG}"',
    'if [[ "$1" == "renew" ]]; then',
    '  exit "${ARCHTREE_TEST_RENEW_STATUS:-0}"',
    'fi',
    'if [[ "${ARCHTREE_TEST_ISSUE_STATUS:-0}" != "0" ]]; then',
    '  exit "${ARCHTREE_TEST_ISSUE_STATUS}"',
    'fi',
    'install -d -m 0755 "${ARCHTREE_CERT_ROOT}/${ARCHTREE_TEST_DOMAIN}"',
    'printf \'certificate\\n\' >"${ARCHTREE_CERT_ROOT}/${ARCHTREE_TEST_DOMAIN}/fullchain.pem"',
    'printf \'private-key\\n\' >"${ARCHTREE_CERT_ROOT}/${ARCHTREE_TEST_DOMAIN}/privkey.pem"'
  ]);
  await writeExecutable(getConfig, [
    '#!/usr/bin/env bash',
    'set -eu',
    'printf \'%s\\n\' "$*" >>"${ARCHTREE_TEST_GET_CONFIG_LOG}"',
    '[[ "$1" == "environment" && "$2" == "-k" ]]',
    'case "$3" in',
    '  HTTPS_DOMAIN) printf \'%s\' "${ARCHTREE_TEST_DOMAIN}" ;;',
    '  ACME_EMAIL) printf \'%s\' "${ARCHTREE_TEST_EMAIL}" ;;',
    '  *) exit 1 ;;',
    'esac'
  ]);
  await writeExecutable(nginx, [
    '#!/usr/bin/env bash',
    'set -eu',
    'printf \'%s\\n\' "$*" >>"${ARCHTREE_TEST_NGINX_LOG}"',
    'exit "${ARCHTREE_TEST_NGINX_STATUS:-0}"'
  ]);
  await writeExecutable(systemctl, [
    '#!/usr/bin/env bash',
    'set -eu',
    'printf \'%s\\n\' "$*" >>"${ARCHTREE_TEST_SYSTEMCTL_LOG}"',
    'if [[ "$1" == "reload" ]]; then',
    '  exit "${ARCHTREE_TEST_SYSTEMCTL_RELOAD_STATUS:-0}"',
    'fi'
  ]);
  await writeExecutable(flock, [
    '#!/usr/bin/env bash',
    'set -eu',
    'printf \'%s\\n\' "$*" >>"${ARCHTREE_TEST_FLOCK_LOG}"',
    'exit "${ARCHTREE_TEST_FLOCK_STATUS:-0}"'
  ]);

  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    ARCHTREE_CERTBOT_BIN: certbot,
    ARCHTREE_GET_CONFIG_BIN: getConfig,
    ARCHTREE_NGINX_BIN: nginx,
    ARCHTREE_SYSTEMCTL_BIN: systemctl,
    ARCHTREE_FLOCK_BIN: flock,
    ARCHTREE_NGINX_CONFIG_PATH: nginxConfig,
    ARCHTREE_ACME_ROOT: acmeRoot,
    ARCHTREE_CERT_ROOT: certRoot,
    ARCHTREE_HTTPS_READY_MARKER: readyMarker,
    ARCHTREE_HTTPS_LOCK_FILE: lockFile,
    ARCHTREE_TEST_DOMAIN: 'kashewt.com',
    ARCHTREE_TEST_EMAIL: 'ops@example.com',
    ARCHTREE_TEST_CERTBOT_LOG: certbotLog,
    ARCHTREE_TEST_GET_CONFIG_LOG: getConfigLog,
    ARCHTREE_TEST_NGINX_LOG: nginxLog,
    ARCHTREE_TEST_SYSTEMCTL_LOG: systemctlLog,
    ARCHTREE_TEST_FLOCK_LOG: flockLog
  };
  delete environment.HTTPS_DOMAIN;
  delete environment.ACME_EMAIL;

  return {
    root,
    certRoot,
    nginxConfig,
    certbotLog,
    getConfigLog,
    systemctlLog,
    flockLog,
    readyMarker,
    systemctl,
    environment
  };
};

test('retries a failed first issuance and activates TLS after recovery', async (t) => {
  const fixture = await createHookFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const firstAttempt = await execFileAsync('/bin/bash', [configureHook], {
    env: { ...fixture.environment, ARCHTREE_TEST_ISSUE_STATUS: '1' }
  });
  assert.match(firstAttempt.stdout, /scheduled bootstrap retry/i);
  const challengeConfig = await readFile(fixture.nginxConfig, 'utf8');
  assert.match(challengeConfig, /\.well-known\/acme-challenge/);
  assert.match(challengeConfig, /proxy_pass http:\/\/127\.0\.0\.1:8080/);
  assert.doesNotMatch(challengeConfig, /listen 443/);

  await execFileAsync('/bin/bash', [configureHook], {
    env: { ...fixture.environment, ARCHTREE_HTTPS_MODE: 'bootstrap' }
  });
  const tlsConfig = await readFile(fixture.nginxConfig, 'utf8');
  assert.match(tlsConfig, /listen 443 ssl/);
  assert.match(tlsConfig, /return 308 https:\/\/\$host\$request_uri/);
  assert.match(tlsConfig, /certificates\/kashewt\.com\/fullchain\.pem/);
  assert.match(await readFile(fixture.getConfigLog, 'utf8'), /environment -k HTTPS_DOMAIN/);
  assert.match(await readFile(fixture.certbotLog, 'utf8'), /certonly .*--domain kashewt\.com/);
  assert.equal(await readFile(fixture.readyMarker, 'utf8'), '');
});

test('preserves active TLS when a maintenance renewal fails', async (t) => {
  const fixture = await createHookFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const liveCertificate = path.join(fixture.certRoot, 'kashewt.com');
  await mkdir(liveCertificate, { recursive: true });
  await writeFile(path.join(liveCertificate, 'fullchain.pem'), 'certificate\n');
  await writeFile(path.join(liveCertificate, 'privkey.pem'), 'private-key\n');

  const result = await execFileAsync('/bin/bash', [configureHook], {
    env: {
      ...fixture.environment,
      ARCHTREE_HTTPS_MODE: 'maintenance',
      ARCHTREE_TEST_RENEW_STATUS: '1'
    }
  });
  assert.match(result.stdout, /preserving the existing certificate/i);
  assert.match(await readFile(fixture.nginxConfig, 'utf8'), /listen 443 ssl/);
  assert.match(await readFile(fixture.certbotLog, 'utf8'), /^renew --quiet/m);
  assert.doesNotMatch(await readFile(fixture.systemctlLog, 'utf8'), /disable/);
});

test('marks active TLS so systemd gates later bootstrap work', async (t) => {
  const fixture = await createHookFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const liveCertificate = path.join(fixture.certRoot, 'kashewt.com');
  await mkdir(liveCertificate, { recursive: true });
  await writeFile(path.join(liveCertificate, 'fullchain.pem'), 'certificate\n');
  await writeFile(path.join(liveCertificate, 'privkey.pem'), 'private-key\n');

  await execFileAsync('/bin/bash', [configureHook], {
    env: { ...fixture.environment, ARCHTREE_HTTPS_MODE: 'bootstrap' }
  });
  assert.equal(await readFile(fixture.readyMarker, 'utf8'), '');
  assert.doesNotMatch(await readFile(fixture.systemctlLog, 'utf8'), /disable/);
});

test('installs bootstrap and renewal systemd schedules against a stable script', async (t) => {
  const fixture = await createHookFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const systemdDirectory = path.join(fixture.root, 'systemd');
  const installedScript = path.join(fixture.root, 'sbin', 'archtree-configure-https');

  await execFileAsync('/bin/bash', [timerHook], {
    env: {
      ...fixture.environment,
      ARCHTREE_SYSTEMD_DIR: systemdDirectory,
      ARCHTREE_CONFIGURE_HTTPS_SOURCE: configureHook,
      ARCHTREE_CONFIGURE_HTTPS_INSTALL_PATH: installedScript
    }
  });

  assert.notEqual((await stat(installedScript)).mode & 0o111, 0);
  assert.match(
    await readFile(path.join(systemdDirectory, 'archtree-certbot-bootstrap.service'), 'utf8'),
    /ConditionPathExists=!.*certificate-ready[\s\S]*ARCHTREE_HTTPS_MODE=bootstrap[\s\S]*ExecStart=.*archtree-configure-https/
  );
  assert.match(
    await readFile(path.join(systemdDirectory, 'archtree-certbot-bootstrap.timer'), 'utf8'),
    /OnActiveSec=5min[\s\S]*OnCalendar=hourly/
  );
  assert.match(
    await readFile(path.join(systemdDirectory, 'archtree-certbot-renew.service'), 'utf8'),
    /ARCHTREE_HTTPS_MODE=maintenance/
  );
  assert.match(
    await readFile(path.join(systemdDirectory, 'archtree-certbot-renew.timer'), 'utf8'),
    /OnCalendar=\*-\*-\* 03,15:17:00/
  );
  const systemctlCalls = await readFile(fixture.systemctlLog, 'utf8');
  assert.match(systemctlCalls, /enable archtree-certbot-bootstrap\.timer/);
  assert.match(systemctlCalls, /restart archtree-certbot-bootstrap\.timer/);
  assert.match(systemctlCalls, /restart archtree-certbot-renew\.timer/);
});

test('maintenance obtains a missing first certificate instead of calling renew', async (t) => {
  const fixture = await createHookFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  await execFileAsync('/bin/bash', [configureHook], {
    env: { ...fixture.environment, ARCHTREE_HTTPS_MODE: 'maintenance' }
  });
  const certbotCalls = await readFile(fixture.certbotLog, 'utf8');
  assert.match(certbotCalls, /^certonly /m);
  assert.doesNotMatch(certbotCalls, /^renew /m);
  assert.match(await readFile(fixture.nginxConfig, 'utf8'), /listen 443 ssl/);
});

test('restores the exact live Nginx config when a TLS candidate is invalid', async (t) => {
  const fixture = await createHookFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const liveCertificate = path.join(fixture.certRoot, 'kashewt.com');
  await mkdir(liveCertificate, { recursive: true });
  await mkdir(path.dirname(fixture.nginxConfig), { recursive: true });
  await writeFile(path.join(liveCertificate, 'fullchain.pem'), 'certificate\n');
  await writeFile(path.join(liveCertificate, 'privkey.pem'), 'private-key\n');
  const previousConfig = 'previous validated config\n';
  await writeFile(fixture.nginxConfig, previousConfig);

  await assert.rejects(execFileAsync('/bin/bash', [configureHook], {
    env: { ...fixture.environment, ARCHTREE_TEST_NGINX_STATUS: '1' }
  }));
  assert.equal(await readFile(fixture.nginxConfig, 'utf8'), previousConfig);
  await assert.rejects(readFile(fixture.readyMarker), { code: 'ENOENT' });
});

test('removes a rejected candidate when no prior Nginx config exists', async (t) => {
  const fixture = await createHookFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  await assert.rejects(execFileAsync('/bin/bash', [configureHook], {
    env: { ...fixture.environment, ARCHTREE_TEST_NGINX_STATUS: '1' }
  }));
  await assert.rejects(readFile(fixture.nginxConfig), { code: 'ENOENT' });
  await assert.rejects(readFile(fixture.certbotLog), { code: 'ENOENT' });
});

test('does not request a certificate when Nginx cannot reload the challenge', async (t) => {
  const fixture = await createHookFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  await assert.rejects(execFileAsync('/bin/bash', [configureHook], {
    env: { ...fixture.environment, ARCHTREE_TEST_SYSTEMCTL_RELOAD_STATUS: '1' }
  }));
  await assert.rejects(readFile(fixture.nginxConfig), { code: 'ENOENT' });
  await assert.rejects(readFile(fixture.certbotLog), { code: 'ENOENT' });
});

test('a contending invocation leaves the active configuration untouched', async (t) => {
  const fixture = await createHookFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await mkdir(path.dirname(fixture.nginxConfig), { recursive: true });
  const activeConfig = 'active TLS config\n';
  await writeFile(fixture.nginxConfig, activeConfig);

  const result = await execFileAsync('/bin/bash', [configureHook], {
    env: { ...fixture.environment, ARCHTREE_TEST_FLOCK_STATUS: '1' }
  });
  assert.match(result.stdout, /another HTTPS configuration attempt is active/i);
  assert.equal(await readFile(fixture.nginxConfig, 'utf8'), activeConfig);
  await assert.rejects(readFile(fixture.certbotLog), { code: 'ENOENT' });
});

test('configuration deployments rerun the stable HTTPS configurator', async (t) => {
  const fixture = await createHookFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const invocationLog = path.join(fixture.root, 'configuration-hook.log');
  const installedScript = path.join(fixture.root, 'archtree-configure-https');
  await writeExecutable(installedScript, [
    '#!/usr/bin/env bash',
    'set -eu',
    'printf \'%s\\n\' "${ARCHTREE_HTTPS_MODE}" >"${ARCHTREE_TEST_CONFIGURATION_LOG}"'
  ]);

  await execFileAsync('/bin/bash', [configurationHook], {
    env: {
      ...fixture.environment,
      ARCHTREE_CONFIGURE_HTTPS_INSTALL_PATH: installedScript,
      ARCHTREE_TEST_CONFIGURATION_LOG: invocationLog
    }
  });
  assert.equal(await readFile(invocationLog, 'utf8'), 'deploy\n');
});

test('platform hook scripts pass Bash syntax validation', async () => {
  await execFileAsync('/bin/bash', [
    '-n',
    configurationHook,
    path.join(repositoryRoot, '.platform/hooks/prebuild/01_install_certbot.sh'),
    configureHook,
    timerHook
  ]);
});
