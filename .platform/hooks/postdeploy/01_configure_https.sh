#!/usr/bin/env bash
set -u

CERTBOT=/opt/archtree-certbot/bin/certbot
DOMAIN=${HTTPS_DOMAIN:-}
EMAIL=${ACME_EMAIL:-}
LIVE_CONFIG=/etc/nginx/conf.d/archtree-managed-https.conf
ACME_ROOT=/var/www/archtree-acme
CERT_ROOT=/etc/letsencrypt/live

log() {
  printf '[archtree-https] %s\n' "$*"
}

valid_domain() {
  [[ "$1" =~ ^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$ ]]
}

write_challenge_config() {
  cat >"${LIVE_CONFIG}" <<EOF
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
}

write_tls_config() {
  cat >"${LIVE_CONFIG}" <<EOF
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
}

reload_nginx() {
  if nginx -t; then
    systemctl reload nginx
    return 0
  fi
  log "Nginx configuration validation failed; HTTPS was not activated."
  return 1
}

if ! valid_domain "${DOMAIN}"; then
  log "HTTPS_DOMAIN is unset or invalid; leaving the existing HTTP endpoint unchanged."
  exit 0
fi

if [[ ! "${EMAIL}" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]; then
  log "ACME_EMAIL is unset or invalid; leaving the existing HTTP endpoint unchanged."
  exit 0
fi

install -d -m 0755 "${ACME_ROOT}/.well-known/acme-challenge"

if [[ -s "${CERT_ROOT}/${DOMAIN}/fullchain.pem" && -s "${CERT_ROOT}/${DOMAIN}/privkey.pem" ]]; then
  write_tls_config
  reload_nginx
  exit $?
fi

# Serve the HTTP-01 challenge before requesting a certificate. A failed request
# is non-fatal because a newly-created Route 53 record may still be propagating.
write_challenge_config
if ! reload_nginx; then
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
  log "Certificate issuance is pending; HTTP remains available for a later deployment or retry."
  exit 0
fi

write_tls_config
reload_nginx
