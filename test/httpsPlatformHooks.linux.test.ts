import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
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

type NginxBlock = { header: string; body: string };

/**
 * Splits one nesting level of a generated Nginx config into its blocks. The
 * generated configs contain no quoted braces, so brace depth is sufficient.
 */
const nginxBlocks = (config: string): NginxBlock[] => {
  const source = config.replace(/#.*$/gm, '');
  const blocks: NginxBlock[] = [];
  let depth = 0;
  let headerStart = 0;
  let bodyStart = 0;
  let header = '';
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '{') {
      if (depth === 0) {
        header = source.slice(headerStart, index).trim().replace(/\s+/g, ' ');
        bodyStart = index + 1;
      }
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        blocks.push({ header, body: source.slice(bodyStart, index) });
        headerStart = index + 1;
      }
    } else if (character === ';' && depth === 0) {
      headerStart = index + 1;
    }
  }
  assert.equal(depth, 0, 'generated Nginx braces must balance');
  return blocks;
};

/** Lists the simple directives of a block body, ignoring nested blocks. */
const nginxDirectives = (body: string): string[] => {
  let flat = body.replace(/#.*$/gm, '');
  while (/\{[^{}]*\}/.test(flat)) flat = flat.replace(/[^;{}]*\{[^{}]*\}/g, '');
  return flat.split(';').map(value => value.trim().replace(/\s+/g, ' ')).filter(Boolean);
};

/** Seeds the live certificate that the hook treats as ready. */
const seedCertificate = async (certRoot: string) => {
  const liveCertificate = path.join(certRoot, 'kashewt.com');
  await mkdir(liveCertificate, { recursive: true });
  await writeFile(path.join(liveCertificate, 'fullchain.pem'), 'certificate\n');
  await writeFile(path.join(liveCertificate, 'privkey.pem'), 'private-key\n');
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
    nginxLog,
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
  // Room sockets require HTTPS, so the temporary HTTP server never tunnels upgrades.
  assert.doesNotMatch(challengeConfig, /Upgrade|connection_upgrade/i);

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

test('forwards WebSocket upgrades from the HTTPS server without changing ordinary proxying', async (t) => {
  const fixture = await createHookFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await seedCertificate(fixture.certRoot);

  await execFileAsync('/bin/bash', [configureHook], { env: fixture.environment });
  const tlsConfig = await readFile(fixture.nginxConfig, 'utf8');
  const [upgradeMap, httpServer, httpsServer, ...unexpected] = nginxBlocks(tlsConfig);
  assert.deepEqual(unexpected, []);

  // The map must sit at http level, beside the server blocks, under a name no platform map shares.
  assert.equal(upgradeMap?.header, 'map $http_upgrade $archtree_connection_upgrade');
  assert.deepEqual(nginxDirectives(upgradeMap.body), ['default ""', 'websocket upgrade']);
  assert.doesNotMatch(tlsConfig, /\$connection_upgrade\b/);

  // Port 80 only serves ACME challenges and redirects; it never proxies a socket in TLS mode.
  assert.equal(httpServer?.header, 'server');
  assert.deepEqual(
    nginxBlocks(httpServer.body).map(block => block.header),
    ['location ^~ /.well-known/acme-challenge/', 'location /']
  );
  assert.deepEqual(nginxDirectives(nginxBlocks(httpServer.body)[1].body), ['return 308 https://$host$request_uri']);

  assert.equal(httpsServer?.header, 'server');
  const httpsDirectives = nginxDirectives(httpsServer.body);
  assert.ok(httpsDirectives.includes('listen 443 ssl'));
  assert.ok(httpsDirectives.includes('http2 on'));
  const httpsLocations = nginxBlocks(httpsServer.body);
  assert.deepEqual(httpsLocations.map(block => block.header), ['location /']);
  const proxy = nginxDirectives(httpsLocations[0].body);

  // HTTP/1.1 plus explicit hop-by-hop headers let Node's 'upgrade' listener answer 101.
  assert.ok(proxy.includes('proxy_pass http://127.0.0.1:8080'));
  assert.ok(proxy.includes('proxy_http_version 1.1'));
  assert.deepEqual(
    proxy.filter(directive => /^proxy_set_header (upgrade|connection) /i.test(directive)),
    ['proxy_set_header Upgrade $http_upgrade', 'proxy_set_header Connection $archtree_connection_upgrade']
  );
  // The same-origin Host/protocol contract the gateway checks is unchanged.
  assert.ok(proxy.includes('proxy_set_header Host $host'));
  assert.ok(proxy.includes('proxy_set_header X-Forwarded-Proto https'));
  // Subprotocol (room-v1 name plus ticket) and Origin must pass through untouched in both directions.
  assert.deepEqual(
    proxy.filter(directive => /sec-websocket|origin|proxy_hide_header|proxy_pass_request_headers/i.test(directive)),
    []
  );
  // Idle limits must stay far above the 5 s room ping and the gateway's 16 s silence eviction.
  for (const name of ['proxy_read_timeout', 'proxy_send_timeout']) {
    const values = proxy.filter(directive => directive.startsWith(`${name} `));
    assert.equal(values.length, 1, `${name} must be set once`);
    const seconds = Number(/^\S+ (\d+)s$/.exec(values[0])?.[1]);
    assert.ok(seconds >= 60, `${name} must leave room sockets open between pings`);
  }
});

test('the next deploy replaces an active pre-WebSocket TLS config in place', async (t) => {
  const fixture = await createHookFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await seedCertificate(fixture.certRoot);
  await mkdir(path.dirname(fixture.nginxConfig), { recursive: true });
  await writeFile(fixture.nginxConfig, [
    'server {',
    '    listen 443 ssl;',
    '    location / {',
    '        proxy_http_version 1.1;',
    '        proxy_set_header Connection "";',
    '    }',
    '}',
    ''
  ].join('\n'));

  await execFileAsync('/bin/bash', [configureHook], { env: fixture.environment });
  const tlsConfig = await readFile(fixture.nginxConfig, 'utf8');
  assert.match(tlsConfig, /proxy_set_header Connection \$archtree_connection_upgrade;/);
  assert.doesNotMatch(tlsConfig, /proxy_set_header Connection "";/);
  // Existing instances keep their certificate: no issuance, only validate and reload.
  await assert.rejects(readFile(fixture.certbotLog), { code: 'ENOENT' });
  assert.equal(await readFile(fixture.nginxLog, 'utf8'), '-t\n');
  assert.equal(await readFile(fixture.systemctlLog, 'utf8'), 'reload nginx\n');
  assert.equal(await readFile(fixture.readyMarker, 'utf8'), '');
});

test('preserves active TLS when a maintenance renewal fails', async (t) => {
  const fixture = await createHookFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await seedCertificate(fixture.certRoot);

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
  await seedCertificate(fixture.certRoot);

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
  await seedCertificate(fixture.certRoot);
  await mkdir(path.dirname(fixture.nginxConfig), { recursive: true });
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
  for (const hook of [
    configurationHook,
    path.join(repositoryRoot, '.platform/hooks/prebuild/01_install_certbot.sh'),
    configureHook,
    timerHook
  ]) await execFileAsync('/bin/bash', ['-n', hook]);
});
