#!/usr/bin/env bash
# Installs and supervises the separately built OOTD owner preview beside
# Archtree on this single instance, as accepted by OOTD ADR 0002. OOTD ships its
# own pinned artifact; this hook only fetches, verifies, sandboxes and routes it.
#
# OOTD never delays or fails an Archtree deployment. Run as an Elastic Beanstalk
# hook, this script only installs itself and starts ootd-cohost-deploy.service
# without waiting, so OOTD's download, install, migration and health check stay
# outside EB's command timeout. That service (and the certificate timer) run it
# with OOTD_COHOST_FOREGROUND=1; a failure there keeps OOTD's previous release.
set -euo pipefail

if [[ "${1:-}" != '--inner' && "${OOTD_COHOST_FOREGROUND:-0}" == '1' ]]; then
  if "${BASH:-/bin/bash}" "${BASH_SOURCE[0]}" --inner; then
    exit 0
  fi
  printf '[ootd-cohost] ERROR: OOTD co-host configuration failed; OOTD keeps its previous release.\n'
  exit 1
fi

GET_CONFIG=${OOTD_COHOST_GET_CONFIG_BIN:-/opt/elasticbeanstalk/bin/get-config}
AWS=${OOTD_COHOST_AWS_BIN:-aws}
CERTBOT=${OOTD_COHOST_CERTBOT_BIN:-/opt/archtree-certbot/bin/certbot}
NGINX=${OOTD_COHOST_NGINX_BIN:-nginx}
SYSTEMCTL=${OOTD_COHOST_SYSTEMCTL_BIN:-systemctl}
SYSTEMD_RUN=${OOTD_COHOST_SYSTEMD_RUN_BIN:-systemd-run}
FLOCK=${OOTD_COHOST_FLOCK_BIN:-/usr/bin/flock}
CURL=${OOTD_COHOST_CURL_BIN:-curl}
UNZIP=${OOTD_COHOST_UNZIP_BIN:-unzip}
SHA256SUM=${OOTD_COHOST_SHA256SUM_BIN:-sha256sum}
CHOWN=${OOTD_COHOST_CHOWN_BIN:-chown}
ID=${OOTD_COHOST_ID_BIN:-id}
USERADD=${OOTD_COHOST_USERADD_BIN:-useradd}
SWAPON=${OOTD_COHOST_SWAPON_BIN:-swapon}
MKSWAP=${OOTD_COHOST_MKSWAP_BIN:-mkswap}
FALLOCATE=${OOTD_COHOST_FALLOCATE_BIN:-fallocate}
NODE=${OOTD_COHOST_NODE_BIN:-$(command -v node || true)}
NPM=${OOTD_COHOST_NPM_BIN:-$(command -v npm || true)}

ROOT=${OOTD_COHOST_ROOT:-/opt/ootd}
ETC_DIR=${OOTD_COHOST_ETC_DIR:-/etc/ootd}
STATE_DIR=${OOTD_COHOST_STATE_DIR:-/var/lib/ootd}
SYSTEMD_DIR=${OOTD_COHOST_SYSTEMD_DIR:-/etc/systemd/system}
NGINX_CONFIG=${OOTD_COHOST_NGINX_CONFIG_PATH:-/etc/nginx/conf.d/ootd-cohost.conf}
ACME_ROOT=${OOTD_COHOST_ACME_ROOT:-/var/www/archtree-acme}
CERT_ROOT=${OOTD_COHOST_CERT_ROOT:-/etc/letsencrypt/live}
SWAP_FILE=${OOTD_COHOST_SWAP_FILE:-/var/swap/ootd-cohost.swap}
FSTAB=${OOTD_COHOST_FSTAB:-/etc/fstab}
LOCK_FILE=${OOTD_COHOST_LOCK_FILE:-/var/lock/ootd-cohost.lock}
INSTALL_PATH=${OOTD_COHOST_INSTALL_PATH:-/usr/local/sbin/ootd-cohost}
HEALTH_ATTEMPTS=${OOTD_COHOST_HEALTH_ATTEMPTS:-30}
HEALTH_DELAY=${OOTD_COHOST_HEALTH_DELAY_SECONDS:-2}
MODE=${OOTD_COHOST_MODE:-deploy}

SERVICE_USER=ootd
WEB_PORT=3100
ENV_FILE="${ETC_DIR}/runtime.env"
RELEASES="${ROOT}/releases"
CURRENT="${ROOT}/current"
# EC2 instance metadata (IPv4 and IPv6). Denying it keeps Archtree's
# instance-profile credentials out of every OOTD process.
IMDS_DENY='169.254.169.254 fd00:ec2::254'

# Bounded CLI jobs from OOTD's runbook: unit name, script, systemd calendar.
JOB_NAMES=(generation-jobs account-deletions assets-reconcile ops-audit)
JOB_SCRIPTS=(
  scripts/process-generation-jobs.ts
  scripts/process-account-deletions.ts
  scripts/reconcile-assets.ts
  scripts/audit-operations.ts
)
JOB_CALENDARS=('*:0/2' '*:0/10' '*:7/30' '*-*-* 04:23:00')

log() {
  printf '[ootd-cohost] %s\n' "$*"
}

# Hooks do not inherit Elastic Beanstalk environment properties, so read the
# authoritative value when it is absent from the process environment.
environment_value() {
  local name=$1
  local value
  value=$(printenv "${name}" 2>/dev/null || true)
  if [[ -n "${value}" ]]; then
    printf '%s' "${value}"
    return 0
  fi
  if [[ -x "${GET_CONFIG}" ]]; then
    "${GET_CONFIG}" environment -k "${name}" 2>/dev/null || true
  fi
}

valid_domain() {
  [[ "$1" =~ ^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$ ]]
}

acquire_lock() {
  install -d -m 0755 "$(dirname "${LOCK_FILE}")"
  if [[ ! -x "${FLOCK}" ]]; then
    log "The required flock executable is unavailable; refusing concurrent configuration."
    return 1
  fi
  exec 8>"${LOCK_FILE}"
  if ! "${FLOCK}" -n 8; then
    log "Another OOTD co-host run is active; leaving it to complete."
    exit 0
  fi
}

# Reads and validates the non-secret Elastic Beanstalk properties. Secrets
# never live in these properties because Archtree's process receives them.
read_settings() {
  DOMAIN=$(environment_value OOTD_COHOST_DOMAIN)
  ARTIFACT_URI=$(environment_value OOTD_COHOST_ARTIFACT_S3_URI)
  ARTIFACT_SHA256=$(environment_value OOTD_COHOST_ARTIFACT_SHA256)
  SECRET_ID=$(environment_value OOTD_COHOST_SECRET_ID)
  REGION=$(environment_value OOTD_COHOST_AWS_REGION)
  MEMORY_MAX=$(environment_value OOTD_COHOST_MEMORY_MAX)
  SWAP_MIB=$(environment_value OOTD_COHOST_SWAP_MIB)
  EMAIL=$(environment_value ACME_EMAIL)
  REGION=${REGION:-us-east-1}
  MEMORY_MAX=${MEMORY_MAX:-320M}
  SWAP_MIB=${SWAP_MIB:-1024}

  local invalid=()
  valid_domain "${DOMAIN}" || invalid+=(OOTD_COHOST_DOMAIN)
  [[ "${ARTIFACT_URI}" =~ ^s3://[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]/[A-Za-z0-9._/-]+\.zip$ ]] \
    || invalid+=(OOTD_COHOST_ARTIFACT_S3_URI)
  [[ "${ARTIFACT_SHA256}" =~ ^[0-9a-f]{64}$ ]] || invalid+=(OOTD_COHOST_ARTIFACT_SHA256)
  [[ "${SECRET_ID}" =~ ^[A-Za-z0-9/_+=.@:-]+$ && "${#SECRET_ID}" -le 512 ]] \
    || invalid+=(OOTD_COHOST_SECRET_ID)
  [[ "${REGION}" =~ ^[a-z]{2}(-gov)?-[a-z]+-[0-9]+$ ]] || invalid+=(OOTD_COHOST_AWS_REGION)
  [[ "${MEMORY_MAX}" =~ ^[1-9][0-9]{1,4}M$ ]] || invalid+=(OOTD_COHOST_MEMORY_MAX)
  [[ "${SWAP_MIB}" =~ ^(0|[1-9][0-9]{2,4})$ ]] || invalid+=(OOTD_COHOST_SWAP_MIB)
  if [[ "${#invalid[@]}" -gt 0 ]]; then
    log "Missing or invalid properties: ${invalid[*]}."
    return 1
  fi
  if [[ ! -x "${NODE}" || ! -x "${NPM}" ]]; then
    log "The platform Node.js runtime is unavailable."
    return 1
  fi
}

# A modest swap file turns transient memory peaks on the shared 1 GiB host into
# slower responses instead of the kernel OOM killer choosing a process.
ensure_swap() {
  if [[ "${SWAP_MIB}" == '0' ]]; then
    return 0
  fi
  if "${SWAPON}" --show=NAME --noheadings 2>/dev/null | grep -Fxq "${SWAP_FILE}"; then
    return 0
  fi
  # Archtree's prebuild hook normally provides swap already; add OOTD's file
  # only when the active total is below the requested size.
  local active_bytes
  active_bytes=$("${SWAPON}" --show=SIZE --bytes --noheadings 2>/dev/null | awk '{ total += $1 } END { print total + 0 }')
  # A swap file's usable size is one page short of its file size.
  if (( active_bytes >= (SWAP_MIB - 1) * 1048576 )); then
    return 0
  fi
  if [[ ! -f "${SWAP_FILE}" ]]; then
    install -d -m 0700 "$(dirname "${SWAP_FILE}")"
    "${FALLOCATE}" -l "${SWAP_MIB}M" "${SWAP_FILE}"
    chmod 0600 "${SWAP_FILE}"
    "${MKSWAP}" "${SWAP_FILE}" >/dev/null
  fi
  "${SWAPON}" "${SWAP_FILE}"
  if ! grep -Fq "${SWAP_FILE} " "${FSTAB}" 2>/dev/null; then
    printf '%s none swap defaults,nofail 0 0\n' "${SWAP_FILE}" >>"${FSTAB}"
  fi
}

ensure_service_user() {
  if ! "${ID}" -u "${SERVICE_USER}" >/dev/null 2>&1; then
    "${USERADD}" --system --user-group --no-create-home \
      --home-dir "${STATE_DIR}" --shell /sbin/nologin "${SERVICE_USER}"
  fi
  install -d -m 0750 "${STATE_DIR}"
  "${CHOWN}" "${SERVICE_USER}:${SERVICE_USER}" "${STATE_DIR}"
}

# Converts the Secrets Manager JSON object into a root-only systemd
# EnvironmentFile. Values are single-quoted, so systemd performs no escape or
# variable processing; keys systemd units own are rejected. Errors name keys only.
write_runtime_environment() {
  local secret_json candidate
  install -d -m 0700 "${ETC_DIR}"
  secret_json=$(mktemp "${ETC_DIR}/secret.XXXXXX")
  candidate=$(mktemp "${ETC_DIR}/runtime.env.XXXXXX")
  chmod 0600 "${secret_json}" "${candidate}"
  if ! "${AWS}" secretsmanager get-secret-value --region "${REGION}" \
      --secret-id "${SECRET_ID}" --query SecretString --output text >"${secret_json}"; then
    rm -f "${secret_json}" "${candidate}"
    log "The OOTD runtime secret could not be read."
    return 1
  fi
  if ! "${NODE}" - "${secret_json}" "${DOMAIN}" >"${candidate}" <<'JS'
const fs = require('node:fs');
const [secretPath, domain] = process.argv.slice(2);
const fail = (message) => { console.error(`[ootd-cohost] ${message}`); process.exit(1); };
let input;
try { input = JSON.parse(fs.readFileSync(secretPath, 'utf8')); } catch { fail('The runtime secret is not JSON.'); }
if (!input || typeof input !== 'object' || Array.isArray(input)) fail('The runtime secret must be a JSON object.');
const reserved = new Set([
  'AWS_EC2_METADATA_DISABLED', 'HOME', 'HOSTNAME', 'MALLOC_ARENA_MAX',
  'NODE_ENV', 'NODE_OPTIONS', 'PATH', 'PORT',
]);
const lines = [];
for (const [key, value] of Object.entries(input)) {
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(key)) fail('The runtime secret contains an invalid key.');
  if (reserved.has(key)) fail(`The runtime secret may not set ${key}.`);
  if (typeof value !== 'string' || /[\0\r\n']/.test(value)) fail(`The runtime secret value for ${key} is not a single-line string without single quotes.`);
  lines.push(`${key}='${value}'`);
}
for (const key of ['APP_ENV', 'APP_ORIGIN', 'DB_CONN_STRING', 'DB_NAME', 'OOTD_OWNER_PREVIEW_ACCOUNT_IDS']) {
  if (!(key in input)) fail(`The runtime secret is missing ${key}.`);
}
if (input.APP_ORIGIN !== `https://${domain}`) fail('APP_ORIGIN must equal the co-host HTTPS origin.');
process.stdout.write(`${lines.join('\n')}\n`);
JS
  then
    rm -f "${secret_json}" "${candidate}"
    return 1
  fi
  rm -f "${secret_json}"
  mv -f "${candidate}" "${ENV_FILE}"
}

# Downloads, verifies and prepares one immutable release directory named by
# its artifact digest. A prepared release is reused on later runs.
install_release() {
  local release="${RELEASES}/${ARTIFACT_SHA256}"
  local staging archive actual
  RELEASE_DIR="${release}"
  if [[ -f "${release}/.ootd-cohost-ready" ]]; then
    # Releases prepared before this mode was set are repaired in place.
    chmod 0755 "${release}"
    return 0
  fi
  install -d -m 0755 "${RELEASES}"
  rm -rf "${release}"
  staging=$(mktemp -d "${RELEASES}/.staging.XXXXXX")
  # mktemp creates a root-only 0700 directory; the `ootd` user must be able to
  # enter the release (read-only) to run migrations and the web service.
  chmod 0755 "${staging}"
  archive="${staging}.zip"
  if ! "${AWS}" s3 cp --region "${REGION}" --only-show-errors "${ARTIFACT_URI}" "${archive}"; then
    rm -rf "${staging}" "${archive}"
    log "The pinned OOTD artifact could not be downloaded."
    return 1
  fi
  actual=$("${SHA256SUM}" "${archive}" | cut -d ' ' -f 1)
  if [[ "${actual}" != "${ARTIFACT_SHA256}" ]]; then
    rm -rf "${staging}" "${archive}"
    log "The downloaded OOTD artifact digest does not match OOTD_COHOST_ARTIFACT_SHA256."
    return 1
  fi
  if ! "${UNZIP}" -q "${archive}" -d "${staging}"; then
    rm -rf "${staging}" "${archive}"
    log "The OOTD artifact could not be extracted."
    return 1
  fi
  rm -f "${archive}"
  if [[ ! -f "${staging}/.next/standalone/server.js" || ! -f "${staging}/package-lock.json" ]]; then
    rm -rf "${staging}"
    log "The OOTD artifact does not contain the standalone runtime and lock file."
    return 1
  fi
  # The web process uses the traced standalone runtime; the root production
  # install exists only for the bounded tsx CLI jobs. Lifecycle scripts stay off.
  if ! (cd "${staging}" && HOME="${STATE_DIR}" npm_config_cache="${STATE_DIR}/.npm-install" \
      "${NPM}" ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error); then
    rm -rf "${staging}"
    log "OOTD production dependencies could not be installed."
    return 1
  fi
  install -d -m 0750 "${staging}/.next/standalone/.next/cache"
  "${CHOWN}" -R "${SERVICE_USER}:${SERVICE_USER}" "${staging}/.next/standalone/.next/cache"
  touch "${staging}/.ootd-cohost-ready"
  mv "${staging}" "${release}"
}

# Runs one bounded OOTD command under the same user and metadata denial as the
# web service, so migrations cannot reach Archtree's instance credentials.
run_sandboxed() {
  local unit=$1
  local directory=$2
  shift 2
  "${SYSTEMD_RUN}" --quiet --wait --pipe --collect \
    --unit="${unit}" \
    --uid="${SERVICE_USER}" --gid="${SERVICE_USER}" \
    --property=EnvironmentFile="${ENV_FILE}" \
    --property=WorkingDirectory="${directory}" \
    --property=IPAddressDeny="${IMDS_DENY}" \
    --property=RuntimeMaxSec=300 \
    --property=MemoryMax=384M \
    --setenv=NODE_ENV=production \
    --setenv=AWS_EC2_METADATA_DISABLED=true \
    --setenv=HOME="${STATE_DIR}" \
    "$@"
}

migrate_release() {
  if [[ -f "${RELEASE_DIR}/.ootd-cohost-migrated" ]]; then
    return 0
  fi
  if ! run_sandboxed "ootd-migrate-${ARTIFACT_SHA256:0:12}" "${RELEASE_DIR}" \
      "${NODE}" --conditions=react-server --import tsx scripts/migrate.ts; then
    log "OOTD migration failed; the previous release remains active."
    return 1
  fi
  touch "${RELEASE_DIR}/.ootd-cohost-migrated"
}

# Shared sandbox for the web service and jobs. ProtectSystem leaves only the
# release cache and OOTD state writable; the env file stays root-readable only.
write_sandbox_directives() {
  cat <<EOF
User=${SERVICE_USER}
Group=${SERVICE_USER}
EnvironmentFile=${ENV_FILE}
Environment=NODE_ENV=production
Environment=AWS_EC2_METADATA_DISABLED=true
Environment=MALLOC_ARENA_MAX=2
Environment=HOME=${STATE_DIR}
IPAddressDeny=${IMDS_DENY}
NoNewPrivileges=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=${RELEASES} ${STATE_DIR}
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes
UMask=0077
EOF
}

write_units() {
  local index name
  install -d -m 0755 "${SYSTEMD_DIR}"
  {
    cat <<EOF
# Managed by the OOTD co-host hook in Archtree's Elastic Beanstalk bundle.
[Unit]
Description=OOTD owner preview web process (co-hosted beside Archtree)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${CURRENT}
EOF
    write_sandbox_directives
    cat <<EOF
Environment=PORT=${WEB_PORT}
Environment=HOSTNAME=127.0.0.1
Environment=NODE_OPTIONS=--max-old-space-size=192
ExecStart=${NODE} .next/standalone/server.js
Restart=on-failure
RestartSec=5s
MemoryMax=${MEMORY_MAX}
TasksMax=128

[Install]
WantedBy=multi-user.target
EOF
  } >"${SYSTEMD_DIR}/ootd-web.service"

  for index in "${!JOB_NAMES[@]}"; do
    name=${JOB_NAMES[${index}]}
    {
      cat <<EOF
# Managed by the OOTD co-host hook in Archtree's Elastic Beanstalk bundle.
[Unit]
Description=OOTD bounded ${name} pass
After=network-online.target ootd-web.service
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=${CURRENT}
EOF
      write_sandbox_directives
      cat <<EOF
ExecStart=${NODE} --conditions=react-server --import tsx ${JOB_SCRIPTS[${index}]}
RuntimeMaxSec=600
MemoryMax=256M
TasksMax=64
EOF
    } >"${SYSTEMD_DIR}/ootd-${name}.service"
    cat >"${SYSTEMD_DIR}/ootd-${name}.timer" <<EOF
# Managed by the OOTD co-host hook in Archtree's Elastic Beanstalk bundle.
[Unit]
Description=Schedule the OOTD ${name} pass

[Timer]
OnCalendar=${JOB_CALENDARS[${index}]}
RandomizedDelaySec=20s
Persistent=true

[Install]
WantedBy=timers.target
EOF
  done

  cat >"${SYSTEMD_DIR}/ootd-cohost-certificate.service" <<EOF
# Managed by the OOTD co-host hook in Archtree's Elastic Beanstalk bundle.
[Unit]
Description=Retry the OOTD co-host TLS certificate until it exists
After=network-online.target nginx.service
Wants=network-online.target
ConditionPathExists=!${CERT_ROOT}/${DOMAIN}/fullchain.pem

[Service]
Type=oneshot
Environment=OOTD_COHOST_FOREGROUND=1
Environment=OOTD_COHOST_MODE=certificate
ExecStart=${INSTALL_PATH}
EOF
  cat >"${SYSTEMD_DIR}/ootd-cohost-certificate.timer" <<'EOF'
# Managed by the OOTD co-host hook in Archtree's Elastic Beanstalk bundle.
[Unit]
Description=Retry OOTD co-host TLS issuance hourly

[Timer]
OnActiveSec=5min
OnCalendar=hourly
RandomizedDelaySec=5min
Persistent=true

[Install]
WantedBy=timers.target
EOF
  "${SYSTEMCTL}" daemon-reload
}

wait_for_health() {
  local attempt
  for ((attempt = 1; attempt <= HEALTH_ATTEMPTS; attempt += 1)); do
    if "${CURL}" -fsS -m 3 -o /dev/null "http://127.0.0.1:${WEB_PORT}/api/health"; then
      return 0
    fi
    sleep "${HEALTH_DELAY}"
  done
  return 1
}

point_current_at() {
  ln -sfn "$1" "${CURRENT}.next"
  mv -Tf "${CURRENT}.next" "${CURRENT}"
}

# Switches to the verified release and rolls back to the previous one when the
# new process does not become healthy.
activate_release() {
  local previous=''
  if [[ -L "${CURRENT}" ]]; then
    previous=$(readlink "${CURRENT}")
  fi
  point_current_at "${RELEASE_DIR}"
  "${SYSTEMCTL}" enable ootd-web.service >/dev/null
  "${SYSTEMCTL}" restart ootd-web.service
  if wait_for_health; then
    log "OOTD release ${ARTIFACT_SHA256:0:12} is healthy."
    return 0
  fi
  if [[ -n "${previous}" && "${previous}" != "${RELEASE_DIR}" && -d "${previous}" ]]; then
    log "OOTD release ${ARTIFACT_SHA256:0:12} failed its health check; restoring the previous release."
    point_current_at "${previous}"
    "${SYSTEMCTL}" restart ootd-web.service || true
  else
    log "OOTD release ${ARTIFACT_SHA256:0:12} failed its health check and no previous release exists."
  fi
  return 1
}

enable_timers() {
  local name
  for name in "${JOB_NAMES[@]}"; do
    "${SYSTEMCTL}" enable --now "ootd-${name}.timer" >/dev/null
  done
}

# Keeps the active and immediately previous digest directories only.
prune_releases() {
  local keep_current keep_previous entry
  keep_current=$(readlink "${CURRENT}" 2>/dev/null || true)
  keep_previous=${1:-}
  for entry in "${RELEASES}"/*; do
    [[ -d "${entry}" ]] || continue
    [[ "$(basename "${entry}")" =~ ^[0-9a-f]{64}$ ]] || continue
    if [[ "${entry}" != "${keep_current}" && "${entry}" != "${keep_previous}" ]]; then
      rm -rf "${entry}"
    fi
  done
}

# Activates an Nginx candidate only after validation, restoring the previous
# bytes when validation or reload fails.
activate_nginx_config() {
  local candidate=$1
  local backup=''
  if [[ -e "${NGINX_CONFIG}" ]]; then
    backup=$(mktemp "${NGINX_CONFIG}.backup.XXXXXX")
    cp -p "${NGINX_CONFIG}" "${backup}"
  fi
  mv -f "${candidate}" "${NGINX_CONFIG}"
  if "${NGINX}" -t && "${SYSTEMCTL}" reload nginx; then
    [[ -z "${backup}" ]] || rm -f "${backup}"
    return 0
  fi
  log "Nginx rejected the OOTD configuration; restoring the previous configuration."
  if [[ -n "${backup}" ]]; then
    mv -f "${backup}" "${NGINX_CONFIG}"
  else
    rm -f "${NGINX_CONFIG}"
  fi
  if "${NGINX}" -t; then
    "${SYSTEMCTL}" reload nginx || true
  fi
  return 1
}

write_nginx_config() {
  local tls=$1
  local candidate
  install -d -m 0755 "$(dirname "${NGINX_CONFIG}")"
  candidate=$(mktemp "${NGINX_CONFIG}.tmp.XXXXXX")
  chmod 0644 "${candidate}"
  {
    cat <<EOF
# Managed by the OOTD co-host hook in Archtree's Elastic Beanstalk bundle.
server {
    listen 80;
    server_name ${DOMAIN};

    location ^~ /.well-known/acme-challenge/ {
        root ${ACME_ROOT};
        default_type text/plain;
        try_files \$uri =404;
    }

EOF
    if [[ "${tls}" == '1' ]]; then
      cat <<EOF
    location / {
        return 308 https://\$host\$request_uri;
    }
}

server {
    listen 443 ssl;
    http2 on;
    server_name ${DOMAIN};

    ssl_certificate ${CERT_ROOT}/${DOMAIN}/fullchain.pem;
    ssl_certificate_key ${CERT_ROOT}/${DOMAIN}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:OotdTLS:2m;
    ssl_session_timeout 1d;
    ssl_session_tickets off;

    # OOTD's streaming limit (12 MiB plus multipart overhead) stays
    # authoritative, and private image bytes are not buffered to disk.
    client_max_body_size 13m;

    location / {
        proxy_pass http://127.0.0.1:${WEB_PORT};
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_request_buffering off;
        proxy_read_timeout 90s;
        proxy_send_timeout 90s;
    }
}
EOF
    else
      # Before a certificate exists OOTD is not proxied: its login and Secure
      # session cookie require HTTPS.
      cat <<'EOF'
    location / {
        return 503;
    }
}
EOF
    fi
  } >"${candidate}"
  activate_nginx_config "${candidate}"
}

certificate_ready() {
  [[ -s "${CERT_ROOT}/${DOMAIN}/fullchain.pem" && -s "${CERT_ROOT}/${DOMAIN}/privkey.pem" ]]
}

# Routes the OOTD host name. Renewal needs no OOTD timer: Archtree's renewal
# runs `certbot renew` for every lineage and then reloads Nginx.
configure_routing() {
  if certificate_ready; then
    write_nginx_config 1
    return
  fi
  write_nginx_config 0
  if [[ ! "${EMAIL}" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]; then
    log "ACME_EMAIL is unset or invalid; OOTD HTTPS issuance is pending."
    return 0
  fi
  if [[ ! -x "${CERTBOT}" ]]; then
    log "Certbot is unavailable; OOTD HTTPS issuance is pending."
    return 0
  fi
  install -d -m 0755 "${ACME_ROOT}/.well-known/acme-challenge"
  if ! "${CERTBOT}" certonly --non-interactive --agree-tos --email "${EMAIL}" \
      --webroot --webroot-path "${ACME_ROOT}" \
      --domain "${DOMAIN}" --cert-name "${DOMAIN}" --keep-until-expiring; then
    log "OOTD certificate issuance is pending; the hourly retry timer will try again."
    return 0
  fi
  if certificate_ready; then
    write_nginx_config 1
  fi
}

# Explicitly disabling the co-host stops OOTD and removes its route and
# secrets file while preserving releases for a later re-enable.
disable_cohost() {
  local name
  if [[ ! -e "${SYSTEMD_DIR}/ootd-web.service" && ! -e "${NGINX_CONFIG}" ]]; then
    return 0
  fi
  for name in "${JOB_NAMES[@]}"; do
    "${SYSTEMCTL}" disable --now "ootd-${name}.timer" >/dev/null 2>&1 || true
  done
  "${SYSTEMCTL}" disable --now ootd-cohost-certificate.timer >/dev/null 2>&1 || true
  "${SYSTEMCTL}" disable --now ootd-web.service >/dev/null 2>&1 || true
  if [[ -e "${NGINX_CONFIG}" ]]; then
    rm -f "${NGINX_CONFIG}"
    if "${NGINX}" -t; then
      "${SYSTEMCTL}" reload nginx || true
    fi
  fi
  rm -f "${ENV_FILE}"
  log "OOTD co-host is disabled; releases are retained."
}

main() {
  case "${MODE}" in
    deploy|certificate) ;;
    *)
      log "Unsupported mode: ${MODE}"
      return 1
      ;;
  esac
  acquire_lock

  if [[ "$(environment_value OOTD_COHOST_ENABLED)" != 'true' ]]; then
    disable_cohost
    return 0
  fi
  read_settings

  if [[ "${MODE}" == 'certificate' ]]; then
    configure_routing
    return 0
  fi

  ensure_swap
  ensure_service_user
  write_runtime_environment
  install_release
  migrate_release
  write_units

  local previous
  previous=$(readlink "${CURRENT}" 2>/dev/null || true)
  if [[ "${previous}" == "${RELEASE_DIR}" ]]; then
    "${SYSTEMCTL}" enable ootd-web.service >/dev/null
    # Restart so a changed runtime secret or unit takes effect.
    "${SYSTEMCTL}" restart ootd-web.service
    wait_for_health || { log "The current OOTD release is not healthy."; return 1; }
  else
    activate_release
  fi
  enable_timers
  "${SYSTEMCTL}" enable ootd-cohost-certificate.timer >/dev/null
  "${SYSTEMCTL}" restart ootd-cohost-certificate.timer
  configure_routing
  prune_releases "${previous}"
}

# Elastic Beanstalk entry point: hand the work to a systemd unit and return.
# It runs in a negated condition where errexit is off, so each step checks.
schedule_background_deploy() {
  install -d -m 0755 "$(dirname "${INSTALL_PATH}")" "${SYSTEMD_DIR}" || return 1
  # A configuration deployment runs the installed copy; never copy it onto itself.
  if [[ ! "${BASH_SOURCE[0]}" -ef "${INSTALL_PATH}" ]]; then
    install -m 0755 "${BASH_SOURCE[0]}" "${INSTALL_PATH}" || return 1
  fi
  cat >"${SYSTEMD_DIR}/ootd-cohost-deploy.service" <<EOF || return 1
# Managed by the OOTD co-host hook in Archtree's Elastic Beanstalk bundle.
[Unit]
Description=Install, migrate and activate the pinned OOTD co-host release
After=network-online.target nginx.service
Wants=network-online.target

[Service]
Type=oneshot
Environment=OOTD_COHOST_FOREGROUND=1
Environment=OOTD_COHOST_MODE=deploy
ExecStart=${INSTALL_PATH}
TimeoutStartSec=30min
EOF
  "${SYSTEMCTL}" daemon-reload || return 1
  "${SYSTEMCTL}" start --no-block ootd-cohost-deploy.service || return 1
  log "Started ootd-cohost-deploy.service; follow it with journalctl -u ootd-cohost-deploy."
}

if [[ "${1:-}" == '--inner' ]]; then
  main
elif ! schedule_background_deploy; then
  log "ERROR: the OOTD co-host deployment could not be scheduled; Archtree is unaffected."
fi
