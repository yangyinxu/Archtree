#!/usr/bin/env bash
set -euo pipefail

CERTBOT=${ARCHTREE_CERTBOT_BIN:-/opt/archtree-certbot/bin/certbot}
GET_CONFIG=${ARCHTREE_GET_CONFIG_BIN:-/opt/elasticbeanstalk/bin/get-config}
NGINX=${ARCHTREE_NGINX_BIN:-nginx}
SYSTEMCTL=${ARCHTREE_SYSTEMCTL_BIN:-systemctl}
FLOCK=${ARCHTREE_FLOCK_BIN:-/usr/bin/flock}
LIVE_CONFIG=${ARCHTREE_NGINX_CONFIG_PATH:-/etc/nginx/conf.d/archtree-managed-https.conf}
ACME_ROOT=${ARCHTREE_ACME_ROOT:-/var/www/archtree-acme}
CERT_ROOT=${ARCHTREE_CERT_ROOT:-/etc/letsencrypt/live}
READY_MARKER=${ARCHTREE_HTTPS_READY_MARKER:-/var/lib/archtree-https/certificate-ready}
LOCK_FILE=${ARCHTREE_HTTPS_LOCK_FILE:-/var/lock/archtree-configure-https.lock}
MODE=${ARCHTREE_HTTPS_MODE:-deploy}

log() {
  printf '[archtree-https] %s\n' "$*"
}

# Timed systemd maintenance does not inherit application properties, so read
# the authoritative Elastic Beanstalk value when it is absent from the hook.
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
  if ! install -d -m 0755 "$(dirname "${LOCK_FILE}")"; then
    log "The HTTPS lock directory could not be prepared."
    return 1
  fi
  if [[ ! -x "${FLOCK}" ]]; then
    log "The required flock executable is unavailable; refusing concurrent HTTPS configuration."
    return 1
  fi
  if ! exec 9>"${LOCK_FILE}"; then
    log "The HTTPS lock file could not be opened."
    return 1
  fi
  if ! "${FLOCK}" -n 9; then
    log "Another HTTPS configuration attempt is active; leaving it to complete."
    return 2
  fi
}

build_config_candidate() {
  local temporary_config
  if ! install -d -m 0755 "$(dirname "${LIVE_CONFIG}")"; then
    log "The Nginx configuration directory could not be prepared."
    return 1
  fi
  if ! temporary_config=$(mktemp "${LIVE_CONFIG}.tmp.XXXXXX"); then
    log "A temporary Nginx candidate could not be created."
    return 1
  fi
  if ! cat >"${temporary_config}"; then
    rm -f "${temporary_config}"
    log "The Nginx candidate could not be written."
    return 1
  fi
  if ! chmod 0644 "${temporary_config}"; then
    rm -f "${temporary_config}"
    log "The Nginx candidate permissions could not be set."
    return 1
  fi
  printf '%s' "${temporary_config}"
}

# Never leave an invalid candidate in Nginx's live include directory. Restore
# and reload the previous bytes whenever validation or activation fails.
activate_config() {
  local candidate_config=$1
  local backup_config=''
  local had_live_config=0
  if [[ -e "${LIVE_CONFIG}" ]]; then
    had_live_config=1
    if ! backup_config=$(mktemp "${LIVE_CONFIG}.backup.XXXXXX"); then
      rm -f "${candidate_config}"
      log "The live Nginx configuration could not be backed up."
      return 1
    fi
    if ! cp -p "${LIVE_CONFIG}" "${backup_config}"; then
      rm -f "${candidate_config}" "${backup_config}"
      log "The live Nginx configuration could not be copied for rollback."
      return 1
    fi
  fi

  if ! mv -f "${candidate_config}" "${LIVE_CONFIG}"; then
    if [[ -n "${backup_config}" ]]; then
      rm -f "${backup_config}"
    fi
    log "The Nginx candidate could not be activated."
    return 1
  fi
  if "${NGINX}" -t && "${SYSTEMCTL}" reload nginx; then
    if [[ -n "${backup_config}" ]]; then
      if ! rm -f "${backup_config}"; then
        log "The obsolete Nginx rollback copy could not be removed."
      fi
    fi
    return 0
  fi

  log "Nginx rejected the candidate configuration; restoring the previous configuration."
  if [[ "${had_live_config}" == '1' ]]; then
    if ! mv -f "${backup_config}" "${LIVE_CONFIG}"; then
      log "The previous Nginx configuration could not be restored."
      return 1
    fi
  else
    if ! rm -f "${LIVE_CONFIG}"; then
      log "The rejected Nginx configuration could not be removed."
      return 1
    fi
  fi
  if "${NGINX}" -t; then
    if ! "${SYSTEMCTL}" reload nginx; then
      log "The previous Nginx configuration was restored but could not be reloaded."
    fi
  else
    log "The previous Nginx configuration was restored but does not validate."
  fi
  return 1
}

write_challenge_config() {
  local candidate_config
  if ! candidate_config=$(build_config_candidate <<EOF
# Managed by Archtree's Elastic Beanstalk postdeploy hook.
server {
    listen 80;
    server_name ${DOMAIN};

    location ^~ /.well-known/acme-challenge/ {
        root ${ACME_ROOT};
        default_type text/plain;
        try_files \$uri =404;
    }

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF
  ); then
    return 1
  fi
  activate_config "${candidate_config}"
}

write_tls_config() {
  local candidate_config
  if ! candidate_config=$(build_config_candidate <<EOF
# Managed by Archtree's Elastic Beanstalk postdeploy hook.
server {
    listen 80;
    server_name ${DOMAIN};

    location ^~ /.well-known/acme-challenge/ {
        root ${ACME_ROOT};
        default_type text/plain;
        try_files \$uri =404;
    }

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
    ssl_session_cache shared:ArchtreeTLS:10m;
    ssl_session_timeout 1d;
    ssl_session_tickets off;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 120s;
        proxy_send_timeout 120s;
        client_max_body_size 1G;
    }
}
EOF
  ); then
    return 1
  fi
  activate_config "${candidate_config}"
}

certificate_ready() {
  [[ -s "${CERT_ROOT}/${DOMAIN}/fullchain.pem" && -s "${CERT_ROOT}/${DOMAIN}/privkey.pem" ]]
}

mark_ready() {
  if ! install -d -m 0755 "$(dirname "${READY_MARKER}")"; then
    log "The HTTPS readiness directory could not be prepared."
    return 1
  fi
  if ! touch "${READY_MARKER}"; then
    log "The HTTPS readiness marker could not be written."
    return 1
  fi
}

mark_not_ready() {
  if ! rm -f "${READY_MARKER}"; then
    log "The stale HTTPS readiness marker could not be removed."
    return 1
  fi
}

case "${MODE}" in
  deploy|bootstrap|maintenance) ;;
  *)
    log "Unsupported HTTPS maintenance mode: ${MODE}"
    exit 1
    ;;
esac

if acquire_lock; then
  :
else
  lock_status=$?
  if [[ "${lock_status}" == '2' ]]; then
    exit 0
  fi
  exit 1
fi

DOMAIN=$(environment_value HTTPS_DOMAIN)
EMAIL=$(environment_value ACME_EMAIL)

if ! valid_domain "${DOMAIN}"; then
  log "HTTPS_DOMAIN is unset or invalid; leaving the existing HTTP endpoint unchanged."
  exit 0
fi

if [[ ! "${EMAIL}" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]; then
  log "ACME_EMAIL is unset or invalid; leaving the existing HTTP endpoint unchanged."
  exit 0
fi

install -d -m 0755 "${ACME_ROOT}/.well-known/acme-challenge"

if certificate_ready; then
  if [[ "${MODE}" == 'maintenance' ]]; then
    if ! "${CERTBOT}" renew --quiet; then
      log "Certificate renewal failed; preserving the existing certificate and HTTPS configuration."
    fi
  fi
  if ! write_tls_config; then
    mark_not_ready
    exit 1
  fi
  mark_ready
  exit 0
fi

# Serve the HTTP-01 challenge before requesting a certificate. A failed request
# is non-fatal because the bootstrap timer retries transient issuance failures.
mark_not_ready
if ! write_challenge_config; then
  exit 1
fi

if [[ ! -x "${CERTBOT}" ]]; then
  log "Certbot is unavailable; HTTP remains available while bootstrap retry is pending."
  exit 0
fi

if ! "${CERTBOT}" certonly \
  --non-interactive \
  --agree-tos \
  --email "${EMAIL}" \
  --webroot \
  --webroot-path "${ACME_ROOT}" \
  --domain "${DOMAIN}" \
  --keep-until-expiring; then
  log "Certificate issuance is pending; HTTP remains available for the scheduled bootstrap retry."
  exit 0
fi

if ! certificate_ready; then
  log "Certbot completed without a usable certificate; bootstrap retry remains scheduled."
  exit 0
fi

if ! write_tls_config; then
  exit 1
fi
mark_ready
